import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyIntent,
  completeOperationsFromTruncatedJson,
  candidateRevision,
  createEvaluationFeedback,
  groundedAggregateEvaluationEvidence,
  groundedEvaluationEvidence,
  runCompositionWorkflow,
  scanTruncatedOperations,
  semanticMidiFingerprint,
  SPECIALIST_FIRST_REPAIR_COMPLETION_TOKENS,
  SPECIALIST_INITIAL_COMPLETION_TOKENS,
  type ModelMessage,
  type ScoreValue,
  type WorkflowEvent,
  type WorkflowModel,
  WorkflowFailure,
} from "./composition-workflow.ts";

const PIANO_AGENT = "Piano (instrument, track track-1)";

const score = (): ScoreValue => ({
  tempo: 120,
  durationBeats: 16,
  tracks: [{
    id: "track-1", name: "Piano", instrument: "Piano", midiProgram: 0, regions: [],
  }],
});

const add = (id: string, regionId = id, trackId = "track-1") => ({
  id,
  type: "add-region",
  trackId,
  summary: `Add ${regionId}`,
  region: {
    id: regionId,
    name: regionId,
    startBeat: 0,
    durationBeats: 2,
    dynamics: "mf",
    articulation: "sustain",
    notes: [{
      pitch: 60,
      velocity: 80,
      startBeat: 0,
      durationBeats: 1,
      articulation: "sustain",
    }],
  },
});

function modelFor(handler: (system: string, user: string, messages: ModelMessage[]) => unknown): WorkflowModel {
  return {
    async complete(messages) {
      const output = handler(messages[0]?.content ?? "", messages.at(-1)?.content ?? "", messages);
      return typeof output === "string" ? output : JSON.stringify(output);
    },
  };
}

function directInput(model: WorkflowModel, overrides: Partial<Parameters<typeof runCompositionWorkflow>[0]> = {}) {
  return {
    model,
    message: "Write a short answer on the existing piano track track-1.",
    safeDirection: "Write a short original answer on the existing piano track track-1.",
    intent: "edit" as const,
    history: [],
    score: score(),
    ...overrides,
  };
}

test("classifies semantic discussion without keyword routing", async () => {
  assert.equal(
    await classifyIntent(modelFor(() => ({ intent: "discussion" })), "Could you explain the current pacing?", []),
    "discussion",
  );
});

test("reports invalid semantic classification before terminal failure", async () => {
  const diagnostics: Array<{ code: string; stage: string; agent?: string }> = [];
  await assert.rejects(
    classifyIntent(
      modelFor(() => ({ intent: "unknown" })),
      "Classify this request safely",
      [],
      undefined,
      diagnostic => diagnostics.push({ code: diagnostic.code, stage: diagnostic.stage, agent: diagnostic.agent }),
    ),
    /could not classify the request safely/,
  );
  assert.deepEqual(diagnostics, [{ code: "invalid-intent", stage: "initial", agent: "Orchestrator" }]);
});

test("does not duplicate route-owned intent classification for discussion", async () => {
  const events: string[] = [];
  const result = await runCompositionWorkflow({
    model: modelFor(system => {
      if (system.includes("Answer discussion only")) return "The pacing leaves room for a measured release.";
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "How should the pacing resolve?",
    safeDirection: "Explain how the pacing should resolve.",
    intent: "discussion",
    history: [],
    score: score(),
    onEvent: event => events.push(event.stage),
  });
  assert.equal(result.status, "discussion");
  assert.deepEqual(events, []);
});

test("emits intent classification only when the workflow performs it", async () => {
  const events: string[] = [];
  const result = await runCompositionWorkflow({
    model: modelFor(system => {
      if (system.includes("Classify the composer's semantic intent")) return { intent: "discussion" };
      if (system.includes("Answer discussion only")) return "The pacing leaves room for a measured release.";
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "How should the pacing resolve?",
    safeDirection: "Explain how the pacing should resolve.",
    history: [],
    score: score(),
    onEvent: event => events.push(event.stage),
  });
  assert.equal(result.status, "discussion");
  assert.deepEqual(events, ["intent-classified"]);
});

test("MIDI semantic verification ignores region IDs and ordering but detects velocity changes", () => {
  const left = score();
  left.tracks[0].regions.push({
    id: "a", startBeat: 2, durationBeats: 1,
    notes: [{ pitch: 62, velocity: 70, startBeat: 0, durationBeats: 1 }],
  });
  const right = score();
  right.tracks[0].regions.push({
    id: "renamed", startBeat: 2, durationBeats: 1,
    notes: [{ pitch: 62, velocity: 70, startBeat: 0, durationBeats: 1 }],
  });
  assert.equal(semanticMidiFingerprint(left), semanticMidiFingerprint(right));
  right.tracks[0].regions[0].notes[0].velocity = 71;
  assert.notEqual(semanticMidiFingerprint(left), semanticMidiFingerprint(right));
});

test("grounded evaluation evidence never invents a fallback note for an unchanged candidate", () => {
  const original = score();
  original.tracks[0].regions.push({
    id: "existing-region", startBeat: 4, durationBeats: 2,
    notes: [{ pitch: 91, velocity: 44, startBeat: 0, durationBeats: 1 }],
  });
  const unchanged = JSON.parse(JSON.stringify(original)) as ScoreValue;
  const evidence = groundedEvaluationEvidence(original, unchanged);
  assert.equal(evidence, "No rendered MIDI difference was observed in the compared score copies.");
  assert.doesNotMatch(evidence, /pitch 91|existing-region/);
});

test("evaluation feedback keeps expected constraints separate from measured observations", () => {
  const original = score();
  const candidate = score();
  candidate.tracks[0].regions.push({
    id: "candidate-region", startBeat: 2, durationBeats: 2,
    notes: [{ pitch: 64, velocity: 73, startBeat: 0, durationBeats: 1 }],
  });
  const feedback = createEvaluationFeedback({
    kind: "musical-rejection",
    scope: "track",
    trackId: "track-1",
    original,
    candidate,
    reason: "Keep the register intimate.",
    expectedConstraints: ["Use an intimate register."],
  });
  assert.equal(feedback.scope, "track");
  assert.equal(feedback.trackId, "track-1");
  assert.equal(feedback.candidateRevision, candidateRevision(candidate));
  assert.deepEqual(feedback.expectedConstraints, ["Use an intimate register."]);
  assert.match(feedback.observedConstraints[0], /1 rendered note event\(s\) added/);
  assert.doesNotMatch(feedback.observedConstraints[0], /pitch|beat|duration|velocity/);
  assert.deepEqual(feedback.evidence, [groundedAggregateEvaluationEvidence(original, candidate)]);
  assert.doesNotMatch(feedback.evidence[0], /pitch|beat|duration|velocity/);
});

test("track rejection observations exclude unrelated writers while revision identifies the full candidate", () => {
  const original = score();
  original.tracks.push({ id: "unrelated-track", regions: [] });
  const candidate = structuredClone(original);
  candidate.tracks[0].regions.push({
    id: "rejected-region", startBeat: 0,
    notes: [{ pitch: 64, velocity: 73, startBeat: 0, durationBeats: 1 }],
  });
  candidate.tracks[1].regions.push({
    id: "unrelated-region", startBeat: 0,
    notes: Array.from({ length: 5 }, (_, index) => ({
      pitch: 70 + index, velocity: 80, startBeat: index, durationBeats: 1,
    })),
  });
  const feedback = createEvaluationFeedback({
    kind: "musical-rejection", scope: "track", trackId: "track-1",
    original, candidate, reason: "Keep the register intimate.",
  });
  assert.equal(feedback.candidateRevision, candidateRevision(candidate));
  for (const observation of [...feedback.observedConstraints, ...feedback.evidence]) {
    assert.match(observation, /1 rendered note event\(s\) added/);
    assert.match(observation, /track-1/);
    assert.doesNotMatch(observation, /unrelated|5 rendered|6 rendered/);
  }
});

test("recovers only root complete operation objects from mixed truncated JSON", () => {
  const nested = add("nested-fake");
  const complete = add("root-complete");
  const raw = [
    "{",
    `  "example": {"operations": [${JSON.stringify(nested)}]},`,
    '  "description": "literal \\"operations\\": [{\\"id\\":\\"string-fake\\"}]",',
    '  "operations": [',
    "    null,",
    '    "not an operation",',
    "    [null, {\"id\":\"nested-array-fake\"}],",
    `    ${JSON.stringify(complete)},`,
    '    {"id":"partial',
  ].join("\n");
  assert.deepEqual(completeOperationsFromTruncatedJson(raw), [complete]);
  assert.deepEqual(scanTruncatedOperations(raw), { operations: [complete], hasIncompleteValue: true });
});

test("uses the direct writer shortcut only for an explicitly identified existing track", async () => {
  let adviserOrchestratorCalls = 0;
  let writerCalls = 0;
  const result = await runCompositionWorkflow(directInput(modelFor((system, user) => {
    if (system.includes("read-all/edit-none") || system.includes("Convert the read-only adviser advice")) {
      adviserOrchestratorCalls += 1;
      throw new Error("an exact existing-track request must not consult advisers or plan");
    }
    if (system.includes("one track-owning instrument writer")) {
      writerCalls += 1;
      assert.equal(JSON.parse(user).assignedTrackId, "track-1");
      return { summary: "Added a short piano answer.", operations: [add("shortcut-op")] };
    }
    throw new Error(`Unexpected prompt: ${system}`);
  })));
  assert.equal(result.status, "verified");
  assert.equal(writerCalls, 1);
  assert.equal(adviserOrchestratorCalls, 0);
  assert.ok(result.events.some(event => event.stage === "existing-instrument-shortcut"));
  assert.ok(result.events.some(event => event.stage === "technical-validation"));
});

test("does not shortcut an ambiguous instrument request and routes it through advisers", async () => {
  const calls = { initialAdvice: 0, review: 0, plan: 0, writer: 0 };
  let planUser: Record<string, unknown> | undefined;
  const result = await runCompositionWorkflow({
    model: modelFor((system, user) => {
      if (system.includes("read-all/edit-none")) {
        calls.initialAdvice += 1;
        return { insight: "Keep the phrase sparse and leave register space." };
      }
      if (system.includes("same bounded read-only")) {
        calls.review += 1;
        return { feedback: "The staged line remains clear.", needsRefinement: false, affectedTrackIds: [] };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        calls.plan += 1;
        planUser = JSON.parse(user) as Record<string, unknown>;
        return {
          trackInstructions: [{ trackId: "track-1", instruction: "Write a quiet original piano phrase." }],
          membershipProposals: [],
        };
      }
      if (system.includes("one track-owning instrument writer")) {
        calls.writer += 1;
        return { summary: "Added a quiet piano phrase.", operations: [add("ambiguous-op")] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a quiet piano phrase.",
    safeDirection: "Write a quiet original piano phrase.",
    intent: "edit",
    history: [],
    score: score(),
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(calls, { initialAdvice: 2, review: 2, plan: 1, writer: 1 });
  assert.equal((planUser?.adviserAdvice as unknown[]).length, 2);
  assert.equal(result.events.some(event => event.stage === "existing-instrument-shortcut"), false);
});

test("rejects adviser initial responses that attempt forbidden write or membership fields", async () => {
  for (const forbidden of [
    { insight: "Keep the line focused.", operations: [add("forbidden-op")] },
    {
      insight: "Keep the line focused.",
      membershipProposals: [{ id: "forbidden-membership", action: "add", instrument: "Cello" }],
    },
    { insight: "Keep the line focused.", privateTrackFiles: ["/tmp/private.mid"] },
  ]) {
    let repairCalls = 0;
    await assert.rejects(
      runCompositionWorkflow({
        model: modelFor(system => {
          if (system.includes("bounded structural repair")) {
            repairCalls += 1;
            return { insight: "A repair must not run for a real write payload." };
          }
          if (system.includes("read-all/edit-none")) return forbidden;
          throw new Error(`Unexpected prompt: ${system}`);
        }),
        message: "Write a piano phrase.",
        safeDirection: "Write an original piano phrase.",
        intent: "edit",
        history: [],
        score: score(),
      }),
      /read-only adviser|forbidden|write capability|private/i,
    );
    assert.equal(repairCalls, 0, "non-empty adviser write or membership payloads are terminal");
  }
});

test("rejects reviewer responses that include forbidden write fields before refinement", async () => {
  let writerCalls = 0;
  let adviserRepairCalls = 0;
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor(system => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) {
          writerCalls += 1;
          return { summary: "Wrote a line.", operations: [add("review-forbidden")] };
        }
        if (system.includes("bounded structural repair")) {
          adviserRepairCalls += 1;
          return {
            feedback: "The cadence needs a gentler landing.",
            needsRefinement: false,
            affectedTrackIds: [],
          };
        }
        if (system.includes("same bounded read-only")) {
          return {
            feedback: "The cadence needs a gentler landing.",
            needsRefinement: false,
            affectedTrackIds: [],
            operations: [add("forbidden-review-operation")],
          };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused piano line.",
      safeDirection: "Write an original focused piano line.",
      intent: "edit",
      history: [],
      score: score(),
    }),
    /read-only adviser|forbidden|write capability/i,
  );
  assert.equal(writerCalls, 1, "forbidden review data must not trigger a writer refinement");
  assert.equal(adviserRepairCalls, 0, "non-empty review operations are terminal");
});

test("repairs a read-only adviser envelope that includes an empty operations array", async () => {
  let adviserRepairs = 0;
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("bounded structural repair")) {
        adviserRepairs += 1;
        if (system.includes('"feedback":"non-empty actionable feedback')) {
          return { feedback: "The staged line remains focused.", needsRefinement: false, affectedTrackIds: [] };
        }
        return { insight: "Keep the phrase sparse and leave register space." };
      }
      if (system.includes("read-all/edit-none")) {
        return { insight: "Keep the phrase sparse and leave register space.", operations: [] };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a sparse focused phrase." }] };
      }
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Wrote a sparse focused phrase.", operations: [add("adviser-repair-op")] };
      }
      if (system.includes("same bounded read-only")) {
        return { feedback: "The staged line remains focused.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a sparse focused phrase.",
    safeDirection: "Write an original sparse focused phrase.",
    intent: "edit",
    history: [],
    score: score(),
  });
  assert.equal(result.status, "verified");
  assert.equal(adviserRepairs, 2, "each initial adviser envelope gets at most one repair here");
  assert.ok(result.consultations.every(consultation => !consultation.insight.includes("operations")));
});

test("adviser structural repair preserves advice and reports only safe field diagnostics", async () => {
  const diagnostics: Array<{ code: string; fields?: string[]; reason: string }> = [];
  let repairCalls = 0;
  let initialAdviceCalls = 0;
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("bounded structural repair")) {
        repairCalls += 1;
        return { insight: "Keep the line focused." };
      }
      if (system.includes("read-all/edit-none")) {
        initialAdviceCalls += 1;
        return initialAdviceCalls === 1
          ? { insight: "Keep the line focused.", membershipProposals: [] }
          : { insight: "Keep the line focused." };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
      }
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Wrote a focused line.", operations: [add("safe-diagnostic-op")] };
      }
      if (system.includes("same bounded read-only")) {
        return { feedback: "The staged line is accepted.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a focused line.",
    safeDirection: "Write an original focused line.",
    intent: "edit",
    history: [],
    score: score(),
    onDiagnostic: diagnostic => diagnostics.push({
      code: diagnostic.code,
      fields: diagnostic.fields,
      reason: diagnostic.reason,
    }),
  });
  assert.equal(result.status, "verified");
  assert.equal(repairCalls, 1);
  assert.ok(diagnostics.some(diagnostic => diagnostic.code === "forbidden-field" && diagnostic.fields?.includes("membershipProposals")));
  assert.ok(diagnostics.every(diagnostic => !diagnostic.reason.includes("Keep the line focused.")));
});

test("never accepts empty read-only adviser feedback after bounded repairs", async () => {
  let repairCalls = 0;
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor((system) => {
        if (system.includes("bounded structural repair")) {
          repairCalls += 1;
          return { insight: "", operations: [] };
        }
        if (system.includes("read-all/edit-none")) return { insight: "" };
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused line.",
      safeDirection: "Write an original focused line.",
      intent: "edit",
      history: [],
      score: score(),
    }),
    /read-only adviser|feedback|advice/i,
  );
  assert.equal(repairCalls, 2);
});

test("classifies a malformed reviewer response separately from musical rejection", async () => {
  const events: WorkflowEvent[] = [];
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor(system => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) {
          return { summary: "Wrote a line.", operations: [add("malformed-review")] };
        }
        if (system.includes("same bounded read-only")) {
          return { feedback: "Refine the line.", needsRefinement: "yes", affectedTrackIds: ["track-1"] };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused piano line.",
      safeDirection: "Write an original focused piano line.",
      intent: "edit",
      history: [],
      score: score(),
      onEvent: event => events.push(event),
    }),
    /candidate review must explicitly state/,
  );
  assert.equal(events.filter(event => event.stage === "evaluation-rejected").length, 1);
  assert.equal(events.find(event => event.stage === "evaluation-rejected")?.evaluationKind, "malformed");
  assert.ok(events.every(event => event.evaluationKind !== "musical-rejection"));
});

test("pauses membership changes before writers and resumes with preserved adviser context", async () => {
  let initialAdviceCalls = 0;
  let planCalls = 0;
  let writerCalls = 0;
  const model = modelFor((system, user) => {
    if (system.includes("read-all/edit-none")) {
      initialAdviceCalls += 1;
      return { insight: "Keep the requested phrase sparse and leave register space." };
    }
    if (system.includes("same bounded read-only")) {
      return { feedback: "The staged line is playable.", needsRefinement: false, affectedTrackIds: [] };
    }
    if (system.includes("Convert the read-only adviser advice")) {
      planCalls += 1;
      const context = JSON.parse(user) as Record<string, unknown>;
      if (planCalls === 2) assert.equal((context.adviserAdvice as unknown[]).length, 2);
      return planCalls === 1
        ? {
          trackInstructions: [{ trackId: "track-1", instruction: "Write a quiet piano answer." }],
          membershipProposals: [{
            id: "add-cello", action: "add", instrument: "Cello",
            summary: "Add a cello option.", reason: "A low response may be useful.",
          }],
        }
        : { trackInstructions: [{ trackId: "track-1", instruction: "Write a quiet piano answer." }], membershipProposals: [] };
    }
    if (system.includes("one track-owning instrument writer")) {
      writerCalls += 1;
      return { summary: "Added a quiet piano answer.", operations: [add("resume-op")] };
    }
    throw new Error(`Unexpected prompt: ${system}`);
  });
  const paused = await runCompositionWorkflow({
    model,
    message: "Develop the source into an original answer.",
    safeDirection: "Develop an original answer.",
    intent: "edit",
    selectedStyle: "Sparse original chamber writing.",
    history: [{ role: "user", content: "Develop the source." }],
    sourceMidi: [],
    score: score(),
  });
  assert.equal(paused.status, "discussion");
  assert.equal(writerCalls, 0);
  assert.equal(initialAdviceCalls, 2);
  assert.deepEqual(paused.trackProposals.map(proposal => proposal.action), ["add"]);
  assert.equal(paused.approvalContext?.consumedBudget.adviserConsultationsUsed, 2);

  const resumed = await runCompositionWorkflow({
    model,
    message: "Approve the proposed membership and continue.",
    safeDirection: "Develop an original answer.",
    intent: "edit",
    history: [],
    sourceMidi: [],
    score: score(),
    approvedTrackProposals: paused.trackProposals,
    approvalContext: paused.approvalContext,
  });
  assert.equal(resumed.status, "verified");
  assert.equal(initialAdviceCalls, 2, "continuation must not repeat original adviser consultation");
  assert.equal(writerCalls, 1);
  assert.deepEqual(resumed.trackProposals.map(proposal => proposal.action), ["add"]);
});

test("server-scoped writer rejects an otherwise valid cross-track operation", async () => {
  const twoTracks = score();
  twoTracks.tracks.push({ id: "track-2", name: "Violin", instrument: "Violin", midiProgram: 40, regions: [] });
  await assert.rejects(
    runCompositionWorkflow(directInput(modelFor(system => {
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Attempted another track.", operations: [add("cross-track", "cross-track", "track-2")] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), { score: twoTracks })),
    /outside its server-assigned track/,
  );
});

test("routes bounded refinement feedback only to the original affected track owner", async () => {
  const writerRequests: Array<{ system: string; user: Record<string, unknown> }> = [];
  let initialAdviceCalls = 0;
  let reviewCalls = 0;
  const result = await runCompositionWorkflow({
    model: modelFor((system, user) => {
      if (system.includes("read-all/edit-none")) {
        initialAdviceCalls += 1;
        return { insight: "Keep the line intimate." };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a quiet piano answer." }] };
      }
      if (system.includes("one track-owning instrument writer")) {
        const request = JSON.parse(user) as Record<string, unknown>;
        const refining = system.includes("one permitted refinement");
        writerRequests.push({ system, user: request });
        return {
          summary: refining ? "Refined the cadence." : "Wrote the first cadence.",
          operations: [add(refining ? "refinement-op" : "initial-op")],
        };
      }
      if (system.includes("same bounded read-only")) {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            feedback: "Give the final note a gentler landing.",
            needsRefinement: true,
            affectedTrackIds: ["track-1"],
            expectedConstraints: ["The final note should land gently."],
          };
        }
        if (reviewCalls === 2) {
          return {
            feedback: "Keep the register intimate.",
            needsRefinement: true,
            affectedTrackIds: ["track-1"],
            expectedConstraints: ["Keep the register intimate."],
          };
        }
        return { feedback: "The refined candidate now meets the request.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a quiet piano answer.",
    safeDirection: "Write an original quiet piano answer.",
    intent: "edit",
    history: [],
    score: score(),
  });
  assert.equal(result.status, "verified");
  assert.equal(initialAdviceCalls, 2);
  assert.equal(reviewCalls, 4, "the original advisers perform final read-only acceptance after refinement");
  assert.equal(writerRequests.length, 2, "all adviser feedback shares one bounded per-track refinement");
  assert.doesNotMatch(writerRequests[0].system, /one permitted refinement/);
  assert.match(writerRequests[1].system, /gentler landing/);
  assert.match(writerRequests[1].system, /register intimate/);
  assert.match(writerRequests[1].system, /Candidate revision: candidate-/);
  assert.ok(result.events.some(event =>
    event.stage === "evaluation-feedback" &&
    event.evaluationKind === "musical-rejection" &&
    event.trackId === "track-1" &&
    event.expectedConstraints?.includes("The final note should land gently."),
  ));
  assert.equal(writerRequests[1].user.assignedTrackId, "track-1");
  assert.ok(result.events.some(event => event.stage === "instrument-refinement"));
});

test("review repair cannot suppress a valid refinement decision or affected track", async () => {
  let reviewCalls = 0;
  let repairCalls = 0;
  let writerCalls = 0;
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor((system) => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line intimate." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a quiet piano answer." }] };
        }
        if (system.includes("one track-owning instrument writer")) {
          writerCalls += 1;
          return { summary: "Wrote the first cadence.", operations: [add("decision-baseline")] };
        }
        if (system.includes("bounded structural repair")) {
          repairCalls += 1;
          return {
            feedback: "Give the final note a gentler landing.",
            needsRefinement: false,
            affectedTrackIds: [],
          };
        }
        if (system.includes("same bounded read-only")) {
          reviewCalls += 1;
          return {
            feedback: "Give the final note a gentler landing.",
            needsRefinement: true,
            affectedTrackIds: ["track-1"],
            operations: [],
          };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a quiet piano answer.",
      safeDirection: "Write an original quiet piano answer.",
      intent: "edit",
      history: [],
      score: score(),
    }),
    /changed.*decision|read-only adviser|structural repair/i,
  );
  assert.equal(reviewCalls, 1);
  assert.equal(repairCalls, 2, "bounded repairs may reject changed decisions but never accept suppression");
  assert.equal(writerCalls, 1, "suppressed refinement must not start a writer");
});

test("fails closed when an adviser requests refinement without an original writer track", async () => {
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor(system => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) {
          return { summary: "Wrote a line.", operations: [add("line")] };
        }
        if (system.includes("same bounded read-only")) {
          return { feedback: "Refine an unsupported track.", needsRefinement: true, affectedTrackIds: ["track-2"] };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused piano line.",
      safeDirection: "Write an original focused piano line.",
      intent: "edit",
      history: [],
      score: score(),
    }),
    /invalid affected track/,
  );
});

test("fails closed when an adviser asks for refinement without an affected track", async () => {
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor(system => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) return { summary: "Wrote a line.", operations: [add("line")] };
        if (system.includes("same bounded read-only")) {
          return { feedback: "Refine the unsupported detail.", needsRefinement: true, affectedTrackIds: [] };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused piano line.",
      safeDirection: "Write an original focused piano line.",
      intent: "edit",
      history: [],
      score: score(),
    }),
    /without identifying an original writer track/,
  );
});

test("writer repair retains complete writer context and does not expose private copy paths", async () => {
  let initialWriterUser: Record<string, unknown> | undefined;
  let repairContext: Record<string, unknown> | undefined;
  const sourceMidi = [{ id: "source", tempo: 90, durationMs: 100, notes: [] }];
  const result = await runCompositionWorkflow(directInput(modelFor((system, user) => {
    if (system.includes("one track-owning instrument writer")) {
      initialWriterUser = JSON.parse(user) as Record<string, unknown>;
      assert.doesNotMatch(system, /private original MIDI copies/);
      return { summary: "Broken response.", operations: "not-an-array" };
    }
    if (system.includes("bounded structural format repair")) {
      repairContext = JSON.parse(user) as Record<string, unknown>;
      return { summary: "Repaired piano answer.", operations: [add("repair-op")] };
    }
    throw new Error(`Unexpected prompt: ${system}`);
  }), {
    selectedStyle: "Original sparse chamber writing.",
    history: [{ role: "user", content: "Keep it sparse." }],
    sourceMidi,
  }));
  assert.equal(result.status, "verified");
  assert.equal(initialWriterUser?.assignedTrackId, "track-1");
  assert.match(JSON.stringify(initialWriterUser?.completeSourceMidi), /source/);
  assert.doesNotMatch(JSON.stringify(initialWriterUser), /privateTrackFiles|privateTrackCopies/);
  assert.equal(repairContext?.assignedTrackId, "track-1");
  assert.equal(repairContext?.selectedStyle, "Original sparse chamber writing.");
  assert.ok(Array.isArray(repairContext?.originalWriterMessages));
  assert.match(JSON.stringify(repairContext?.completeSourceMidi), /source/);
});

test("rejects an appended operation during structural writer repair without mutating the source score", async () => {
  const original = score();
  const baseline = add("baseline");
  let repairCalls = 0;
  await assert.rejects(
    runCompositionWorkflow(directInput(modelFor(system => {
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Malformed batch.", operations: [baseline, { type: "add-region" }] };
      }
      if (system.includes("bounded structural format repair")) {
        repairCalls += 1;
        return { summary: "Appended batch.", operations: [baseline, add(`unverified-${repairCalls}`)] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), { score: original })),
    /appended an unverified musical operation/,
  );
  assert.equal(repairCalls, 2);
  assert.deepEqual(original, score());
});

test("repairs malformed writer JSON with exactly the bounded replacement budget", async () => {
  const events: WorkflowEvent[] = [];
  let repairCalls = 0;
  const result = await runCompositionWorkflow(directInput(modelFor((system, user) => {
    if (system.includes("one track-owning instrument writer")) return "{this is not JSON";
    if (system.includes("bounded structural format repair")) {
      repairCalls += 1;
      const context = JSON.parse(user) as Record<string, unknown>;
      assert.equal(context.latestFailedResponse, "{this is not JSON");
      return { summary: "Fixed malformed JSON.", operations: [add("json-op")] };
    }
    throw new Error(`Unexpected prompt: ${system}`);
  }), { onEvent: event => events.push(event) }));
  assert.equal(result.status, "verified");
  assert.equal(repairCalls, 1);
  assert.equal(result.operations[0].id, "json-op");
  assert.ok(events.some(event => event.stage === "operation-format-repair" && event.attempt === "1/2"));
  assert.ok(events.some(event => event.stage === "operation-format-recovered" && event.attempt === "1/2"));
});

test("recovers a complete writer operation after provider token truncation without changing its musical content", async () => {
  const operation = add("truncated-op");
  const calls: number[] = [];
  let recoveryCalls = 0;
  const model: WorkflowModel = {
    complete: async () => {
      throw new Error("detailed completion should be preferred");
    },
    completeDetailed: async (messages, maxTokens) => {
      const system = messages[0]?.content ?? "";
      calls.push(maxTokens);
      if (system.includes("one track-owning instrument writer")) {
        return {
          content: JSON.stringify({ summary: "cut after complete operation", operations: [operation] }),
          metadata: { finishReason: "length", model: "test-model" },
        };
      }
      if (system.includes("provider-token-limit recovery")) {
        recoveryCalls += 1;
        return {
          content: JSON.stringify({ summary: "complete replacement", operations: [operation] }),
          metadata: { finishReason: "stop", model: "test-model" },
        };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    },
  };
  const result = await runCompositionWorkflow(directInput(model));
  assert.equal(result.status, "verified");
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(result.operations, [operation]);
  assert.deepEqual(calls, [SPECIALIST_INITIAL_COMPLETION_TOKENS, SPECIALIST_FIRST_REPAIR_COMPLETION_TOKENS]);
});

test("fails closed on an incomplete truncated operation tail without leaking it into events", async () => {
  const original = score();
  const secret = "SECRET_TRUNCATED_OPERATION";
  const complete = add("complete-prefix");
  const truncated = `{"summary":"partial","operations":[${JSON.stringify(complete)},{"id":"${secret}`;
  const events: WorkflowEvent[] = [];
  let recoveryCalls = 0;
  const model: WorkflowModel = {
    complete: async () => {
      throw new Error("detailed completion should be preferred");
    },
    completeDetailed: async messages => {
      const system = messages[0]?.content ?? "";
      if (system.includes("one track-owning instrument writer")) {
        return { content: truncated, metadata: { finishReason: "length", model: "test-model" } };
      }
      if (system.includes("provider-token-limit recovery")) {
        recoveryCalls += 1;
        return {
          content: JSON.stringify({ summary: "prefix only", operations: [complete] }),
          metadata: { finishReason: "stop", model: "test-model" },
        };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    },
  };
  await assert.rejects(
    runCompositionWorkflow(directInput(model, { score: original, onEvent: event => events.push(event) })),
    /incomplete operations tail/,
  );
  assert.equal(recoveryCalls, 1, "an incomplete visible tail fails closed after its bounded replacement check");
  assert.deepEqual(original, score());
  assert.ok(events.every(event => !event.message.includes(secret)));
});

test("does not invent a fallback when a track writer returns no playable operation", async () => {
  const events: WorkflowEvent[] = [];
  await assert.rejects(
    runCompositionWorkflow(directInput(modelFor(system => {
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "No material.", operations: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), { onEvent: event => events.push(event) })),
    /no playable operation/,
  );
  const rejection = events.find(event => event.stage === "evaluation-rejected");
  assert.equal(rejection?.evaluationKind, "no-musical-change");
  assert.equal(rejection?.evaluatorCategory, "no-op");
  assert.equal(rejection?.scope, "track");
  assert.deepEqual(rejection?.affectedScope, ["track", "track:track-1"]);
  assert.equal(rejection?.trackId, "track-1");
  assert.equal(rejection?.correctionOutcome, "not-attempted");
  assert.equal(rejection?.commitStatus, "not-committed");
  assert.deepEqual(rejection?.evidence, ["No rendered note difference was observed in the compared score copies."]);
  assert.equal(rejection?.observedConstraints?.[0], "No rendered note difference was observed in the compared score copies.");
  assert.doesNotMatch(rejection?.evidence?.join(" ") ?? "", /MIDI|pitch|beat|duration|velocity/);
});

test("planner sees the exact playable catalog and returns a supported proposal for approval", async () => {
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("read-all/edit-none")) return { insight: "A lower response can support the phrase." };
      if (system.includes("Convert the read-only adviser advice")) {
        assert.match(system, /"instrument":"Cello"/);
        return {
          trackInstructions: [{ trackId: "track-1", instruction: "Leave space below the line." }],
          membershipProposals: [{
            id: "add-cello", action: "add", instrument: "Cello", role: "strings", midiProgram: 42,
            summary: "Add cello.", reason: "The requested low answer needs a cello.",
          }],
        };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Add a lower answer.", safeDirection: "Add an original lower answer.",
    intent: "edit", history: [], score: score(),
  });
  assert.equal(result.status, "discussion");
  assert.deepEqual(result.trackProposals.map(proposal => proposal.instrument), ["Cello"]);
});

test("final adviser rejection after refinement fails without another writer round", async () => {
  let writerCalls = 0;
  let reviews = 0;
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor((system) => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) {
          writerCalls += 1;
          return { summary: "Wrote a line.", operations: [add(`writer-${writerCalls}`)] };
        }
        if (system.includes("same bounded read-only")) {
          reviews += 1;
          return {
            feedback: "A further change would be needed.",
            needsRefinement: true,
            affectedTrackIds: ["track-1"],
          };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused line.", safeDirection: "Write an original focused line.",
      intent: "edit", history: [], score: score(),
    }),
    /still require refinement after the one permitted writer round/,
  );
  assert.equal(writerCalls, 2);
  assert.equal(reviews, 4);
});

test("an approval resume with an exhausted shared repair pool cannot repair a malformed planner response", async () => {
  let calls = 0;
  await assert.rejects(
    runCompositionWorkflow({
      model: modelFor(() => {
        calls += 1;
        return { trackInstructions: "malformed" };
      }),
      message: "Continue the approved cue.",
      safeDirection: "Continue the original cue.",
      intent: "edit",
      history: [],
      sourceMidi: [],
      score: score(),
      approvalContext: {
        originalMessage: "Continue the approved cue.",
        originalHistory: [],
        originalMidi: [],
        adviserRoster: [
          { agent: "Contemporary Cinematic", group: "style", question: "What palette serves the cue?" },
          { agent: "Harmony & Voice Leading", group: "concept", question: "What supports the cue?" },
        ],
        adviserConsultations: [
          { agent: "Contemporary Cinematic", group: "style", question: "What palette serves the cue?", insight: "Stay sparse." },
          { agent: "Harmony & Voice Leading", group: "concept", question: "What supports the cue?", insight: "Use contrary motion." },
        ],
        consumedBudget: {
          adviserConsultationsUsed: 2,
          trackWriterRoundsUsed: 0,
          refinementRoundsUsed: 0,
          operationRepairAttemptsUsed: 2,
        },
      },
    }),
    /shared two-repair pool was exhausted/,
  );
  assert.equal(calls, 1, "no reset may buy another planner-repair call");
});