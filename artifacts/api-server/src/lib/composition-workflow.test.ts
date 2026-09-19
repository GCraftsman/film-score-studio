import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyIntent,
  completeOperationsFromTruncatedJson,
  candidateRevision,
  createEvaluationFeedback,
  groundedAggregateEvaluationEvidence,
  groundedEvaluationEvidence,
  parseRequestedSectionLength,
  runCompositionWorkflow,
  scanTruncatedOperations,
  semanticMidiFingerprint,
  validateRequestedSectionLength,
  ADVISER_FEEDBACK_MAX_LENGTH,
  ADVISER_FEEDBACK_TARGET_LENGTH,
  SPECIALIST_FIRST_REPAIR_COMPLETION_TOKENS,
  SPECIALIST_INITIAL_COMPLETION_TOKENS,
  type ModelMessage,
  type RejectedAdviserTextDiagnostic,
  type ScoreValue,
  type WorkflowEvent,
  type WorkflowModel,
  WorkflowFailure,
} from "./composition-workflow.ts";
import { screenMusicText } from "./ai-music-safety.ts";

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
    async complete(messages, maxTokens) {
      const system = messages[0]?.content ?? "";
      if (system.includes("bounded structural repair") && !system.startsWith("You are Orchestrator.")) {
        assert.equal(maxTokens, 4_500);
      } else if (system.includes("read-all/edit-none") || system.includes("same bounded read-only")) {
        assert.equal(maxTokens, 3_500);
      }
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

test("parses explicit section lengths without mistaking bar locations for durations", () => {
  assert.equal(parseRequestedSectionLength("Write a 32bar intro in 4/4")?.durationBeats, 128);
  assert.equal(parseRequestedSectionLength("Replace the next 16 beats")?.durationBeats, 16);
  assert.equal(parseRequestedSectionLength("Make bar 4 louder")?.durationBeats, undefined);
  assert.match(
    parseRequestedSectionLength("Write 4 bars over 8 beats")?.diagnostic ?? "",
    /conflicting explicit section lengths/,
  );
});

test("validates generated section span while ignoring existing score padding and rests", () => {
  const existing = score();
  existing.tracks[0].regions.push({
    id: "padding", startBeat: 0, durationBeats: 16,
    notes: [{ pitch: 48, velocity: 60, startBeat: 0, durationBeats: 1 }],
  });
  const length = parseRequestedSectionLength("Write a 4-bar phrase in 4/4")!;
  const operation = add("four-bars");
  operation.region.durationBeats = 16;
  operation.region.notes[0].durationBeats = 1;
  validateRequestedSectionLength(existing, [operation], length);
  assert.throws(
    () => validateRequestedSectionLength(existing, [add("too-short")], length),
    /Requested section length mismatch/,
  );
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

test("passes the explicit requested section length to the writer and validates its span", async () => {
  let writerUser: Record<string, unknown> | undefined;
  const result = await runCompositionWorkflow(directInput(modelFor((system, user) => {
    if (system.includes("one track-owning instrument writer")) {
      writerUser = JSON.parse(user) as Record<string, unknown>;
      assert.match(system, /exactly 16 score beats/);
      const operation = add("four-bar-request");
      operation.region.durationBeats = 16;
      return { summary: "Wrote the requested four-bar phrase.", operations: [operation] };
    }
    throw new Error(`Unexpected prompt: ${system}`);
  }), {
    message: "Write a 4-bar phrase on the existing piano track track-1.",
    safeDirection: "Write an original 4-bar phrase on the existing piano track track-1.",
    originalMessage: "Write a 4-bar phrase on the existing piano track track-1.",
  }));
  assert.equal(result.status, "verified");
  assert.equal((writerUser?.requestedSectionLength as { durationBeats: number }).durationBeats, 16);
});

test("rejects a requested section span mismatch atomically", async () => {
  const initial = score();
  await assert.rejects(
    runCompositionWorkflow(directInput(modelFor(system => {
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Wrote a short phrase.", operations: [add("wrong-four-bar-length")] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), {
      score: initial,
      message: "Write a 4-bar phrase on the existing piano track track-1.",
      safeDirection: "Write an original 4-bar phrase on the existing piano track track-1.",
      originalMessage: "Write a 4-bar phrase on the existing piano track track-1.",
    })),
    /Requested section length mismatch/,
  );
  assert.equal(initial.tracks[0].regions.length, 0);
});

test("rejects a requested section longer than the existing score before generation", async () => {
  let modelCalls = 0;
  await assert.rejects(
    runCompositionWorkflow(directInput(modelFor(() => {
      modelCalls += 1;
      throw new Error("The writer must not run when requested length cannot fit.");
    }), {
      message: "Write a 32-bar intro on the existing piano track track-1.",
      safeDirection: "Write an original 32-bar intro on the existing piano track track-1.",
      originalMessage: "Write a 32-bar intro on the existing piano track track-1.",
    })),
    /existing score is only 16 beats long/,
  );
  assert.equal(modelCalls, 0);
});

test("does not shortcut an ambiguous instrument request and routes it through initial advisers", async () => {
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
  assert.deepEqual(calls, { initialAdvice: 2, review: 0, plan: 1, writer: 1 });
  assert.equal((planUser?.adviserAdvice as unknown[]).length, 2);
  assert.equal(result.events.some(event => event.stage === "existing-instrument-shortcut"), false);
  assert.equal(result.events.some(event => event.stage === "adviser-review"), false);
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

test("does not call a post-write reviewer, even when its legacy handler is forbidden", async () => {
  let writerCalls = 0;
  let adviserRepairCalls = 0;
  let reviewCalls = 0;
  const result = await runCompositionWorkflow({
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
          reviewCalls += 1;
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
    });
  assert.equal(result.status, "verified");
  assert.equal(writerCalls, 1, "forbidden review data must not trigger a writer refinement");
  assert.equal(adviserRepairCalls, 0, "non-empty review operations are terminal");
  assert.equal(reviewCalls, 0, "post-write adviser review is not part of the commit path");
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

test("compresses a 4001-character initial adviser insight instead of repeating it", async () => {
  const overlongInsight = "Use Cello for a low response; leave register space.".repeat(100).slice(0, 4000) + "x";
  assert.equal(overlongInsight.length, 4001);
  assert.ok(screenMusicText(overlongInsight, "").length > ADVISER_FEEDBACK_MAX_LENGTH);
  let initialAdviceCalls = 0;
  let repairCalls = 0;
  let reviewCalls = 0;
  let sawCompressionInstruction = false;
  let sawCatalogGrounding = false;
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("bounded structural repair")) {
        repairCalls += 1;
        sawCompressionInstruction ||= system.toLowerCase().includes(`compress it to the safety target of ${ADVISER_FEEDBACK_TARGET_LENGTH} characters or fewer`) &&
          system.includes("every independently identifiable actionable constraint");
        return { insight: "Use Cello for the low response, leave register space, and use restrained sustained dynamics." };
      }
      if (system.includes("read-all/edit-none")) {
        sawCatalogGrounding ||= system.includes("Upright Piano (keyboards, program 0)") &&
          system.includes("explicitly map it to the closest supported catalog instrument");
        initialAdviceCalls += 1;
        return initialAdviceCalls === 1
          ? { insight: overlongInsight }
          : { insight: "Keep the piano phrase spacious." };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a spacious piano phrase." }] };
      }
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Wrote a spacious piano phrase.", operations: [add("overlong-adviser-op")] };
      }
      if (system.includes("same bounded read-only")) {
        sawCatalogGrounding ||= system.includes("Violin (strings, program 40)") &&
          system.includes("achievable technique, articulation, register, dynamics, and texture");
        reviewCalls += 1;
        return { feedback: "The staged phrase is focused.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a spacious piano phrase.",
    safeDirection: "Write an original spacious piano phrase.",
    intent: "edit",
    history: [],
    score: score(),
  });
  assert.equal(result.status, "verified");
  assert.equal(initialAdviceCalls, 2);
  assert.equal(repairCalls, 1, "the overlength insight needs one bounded compression repair");
  assert.equal(reviewCalls, 0, "post-write adviser review is not called");
  assert.equal(sawCompressionInstruction, true);
  assert.equal(sawCatalogGrounding, true);
  assert.equal(result.consultations[0].insight.length <= ADVISER_FEEDBACK_MAX_LENGTH, true);
  assert.equal(result.consultations[0].insight.length <= ADVISER_FEEDBACK_TARGET_LENGTH, true);
  assert.equal(ADVISER_FEEDBACK_TARGET_LENGTH < ADVISER_FEEDBACK_MAX_LENGTH, true);
  assert.notEqual(result.consultations[0].insight, overlongInsight);
});

test("accepts the live 505-character orchestral insight below the hard ceiling", async () => {
  const liveInsight = "Heroic orchestral build at 80 BPM: Start sparse with high-register violin and flute carrying the melody over alternating major/minor triads on upright piano and cello. Gradually layer in French horn and trombone for richer mid-register harmonies, add string ensemble for sustained texture, then introduce timpani and modern drum kit for rhythmic drive. Build rising register, denser voicings, and dynamics from piano to fortissimo across 64 bars, culminating in full ensemble grandeur and victorious mood.";
  assert.equal(liveInsight.length, 505);
  let initialAdviceCalls = 0;
  let repairCalls = 0;
  let sawCompressionInstruction = false;
  const rejected: RejectedAdviserTextDiagnostic[] = [];
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("bounded structural repair")) {
        repairCalls += 1;
        sawCompressionInstruction ||= system.toLowerCase().includes(`compress it to the safety target of ${ADVISER_FEEDBACK_TARGET_LENGTH} characters or fewer`);
        return { insight: "Build a sparse orchestral rise with clear register space and restrained dynamics." };
      }
      if (system.includes("read-all/edit-none")) {
        initialAdviceCalls += 1;
        return initialAdviceCalls === 1
          ? { insight: liveInsight }
          : { insight: "Keep the phrase spacious." };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a spacious piano phrase." }] };
      }
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Wrote a spacious piano phrase.", operations: [add("live-overlength-op")] };
      }
      if (system.includes("same bounded read-only")) {
        return { feedback: "The staged phrase is focused.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a spacious piano phrase.",
    safeDirection: "Write an original spacious piano phrase.",
    intent: "edit",
    history: [],
    score: score(),
    onRejectedAdviserText: diagnostic => rejected.push(diagnostic),
  });
  assert.equal(result.status, "verified");
  assert.equal(initialAdviceCalls, 2);
  assert.equal(repairCalls, 0);
  assert.equal(sawCompressionInstruction, false);
  assert.deepEqual(rejected, []);
  assert.equal(result.consultations[0].insight, liveInsight);
  assert.equal(result.consultations[0].insight.length <= ADVISER_FEEDBACK_MAX_LENGTH, true);
});

test("does not request post-write review feedback or refinement", async () => {
  const overlongFeedback = `${"Keep the register intimate and leave room for the cadence. ".repeat(100)}x`;
  assert.ok(screenMusicText(overlongFeedback, "").length > ADVISER_FEEDBACK_MAX_LENGTH);
  let reviewCalls = 0;
  let writerCalls = 0;
  let repairCalls = 0;
  let preservedDecision = false;
  let sawTarget = false;
  const result = await runCompositionWorkflow({
    model: modelFor((system, user) => {
      if (system.includes("bounded structural repair")) {
        repairCalls += 1;
        sawTarget ||= system.toLowerCase().includes(`compress it to the safety target of ${ADVISER_FEEDBACK_TARGET_LENGTH} characters or fewer`);
        const repairContext = JSON.parse(user) as { priorResponse?: Record<string, unknown> };
        const prior = repairContext.priorResponse;
        preservedDecision = prior?.needsRefinement === true &&
          JSON.stringify(prior.affectedTrackIds) === JSON.stringify(["track-1"]) &&
          JSON.stringify(prior.expectedConstraints) === JSON.stringify(["Keep the register intimate."]);
        return {
          feedback: "Keep the register intimate and leave room for the final cadence.",
          needsRefinement: true,
          affectedTrackIds: ["track-1"],
          expectedConstraints: ["Keep the register intimate."],
        };
      }
      if (system.includes("read-all/edit-none")) return { insight: "Keep the phrase spacious." };
      if (system.includes("Convert the read-only adviser advice")) {
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a spacious piano phrase." }] };
      }
      if (system.includes("one track-owning instrument writer")) {
        writerCalls += 1;
        return {
          summary: writerCalls === 1 ? "Wrote a spacious piano phrase." : "Refined the spacious piano phrase.",
          operations: [add(`review-overlength-${writerCalls}`)],
        };
      }
      if (system.includes("same bounded read-only")) {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            feedback: overlongFeedback,
            needsRefinement: true,
            affectedTrackIds: ["track-1"],
            expectedConstraints: ["Keep the register intimate."],
          };
        }
        if (reviewCalls === 2) {
          return { feedback: "The staged phrase is focused.", needsRefinement: false, affectedTrackIds: [] };
        }
        return { feedback: "The refined phrase is accepted.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a spacious piano phrase.",
    safeDirection: "Write an original spacious piano phrase.",
    intent: "edit",
    history: [],
    score: score(),
  });
  assert.equal(result.status, "verified");
  assert.equal(repairCalls, 0);
  assert.equal(reviewCalls, 0, "post-write adviser review is not called");
  assert.equal(writerCalls, 1);
  assert.equal(sawTarget, false);
  assert.equal(preservedDecision, false);
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

async function runAdviserRejectedTextScenario(initialInsight: unknown): Promise<RejectedAdviserTextDiagnostic[]> {
  let initialAdviceCalls = 0;
  let writerCalls = 0;
  const rejected: RejectedAdviserTextDiagnostic[] = [];
  await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("bounded structural repair")) {
        if (typeof initialInsight === "string" && initialInsight.trim() && !screenMusicText(initialInsight, "")) {
          assert.match(system, /Rewrite the rejected text as unquoted neutral musical instructions/);
          assert.match(system, /do not repeat it verbatim/);
          assert.doesNotMatch(system, /Preserve the exact existing actionable advice/);
        }
        return { insight: "Keep the phrase sparse and focused." };
      }
      if (system.includes("read-all/edit-none")) {
        initialAdviceCalls += 1;
        return initialAdviceCalls === 1 ? { insight: initialInsight } : { insight: "Keep the phrase sparse and focused." };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a sparse focused phrase." }] };
      }
      if (system.includes("one track-owning instrument writer")) {
        writerCalls += 1;
        return { summary: "Wrote a sparse focused phrase.", operations: [add(`diagnostic-op-${writerCalls}`)] };
      }
      if (system.includes("same bounded read-only")) {
        return { feedback: "The staged phrase is focused.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a sparse focused phrase.",
    safeDirection: "Write an original sparse focused phrase.",
    intent: "edit",
    history: [],
    score: score(),
    workflowId: "workflow-diagnostic-test",
    requestId: "request-diagnostic-test",
    onRejectedAdviserText: diagnostic => rejected.push(diagnostic),
  });
  return rejected;
}

test("reports bounded raw adviser text only for a safety-screen-empty failure", async () => {
  const rawUnsafeInsight = `This resembles Famous Composer ${"x".repeat(5200)}`;
  const rejected = await runAdviserRejectedTextScenario(rawUnsafeInsight);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.text, rawUnsafeInsight.slice(0, 5000));
  assert.equal(rejected[0]?.originalLength, rawUnsafeInsight.length);
  assert.equal(rejected[0]?.truncated, true);
  assert.deepEqual(
    { agent: rejected[0]?.agent, phase: rejected[0]?.phase, field: rejected[0]?.field, attempt: rejected[0]?.attempt },
    { agent: "Contemporary Cinematic", phase: "initial", field: "insight", attempt: "initial" },
  );
  assert.equal(rejected[0]?.workflowId, "workflow-diagnostic-test");
  assert.equal(rejected[0]?.requestId, "request-diagnostic-test");
});

test("does not report rejected adviser text for ordinary invalid-field, overlength, or valid responses", async () => {
  const invalidField = await runAdviserRejectedTextScenario(42);
  const overlength = await runAdviserRejectedTextScenario("Use quiet strings and low brass. ".repeat(20));
  const valid = await runAdviserRejectedTextScenario("Use quiet strings and low brass.");
  assert.deepEqual(invalidField, []);
  assert.deepEqual(overlength, []);
  assert.deepEqual(valid, []);
});

test("does not invoke a malformed post-write reviewer", async () => {
  const events: WorkflowEvent[] = [];
  let reviewCalls = 0;
  const result = await runCompositionWorkflow({
      model: modelFor(system => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) {
          return { summary: "Wrote a line.", operations: [add("malformed-review")] };
        }
        if (system.includes("same bounded read-only")) {
          reviewCalls += 1;
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
    });
  assert.equal(result.status, "verified");
  assert.equal(reviewCalls, 0);
  assert.equal(events.filter(event => event.stage === "evaluation-rejected").length, 0);
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
          requiresPlayableMaterial: true,
        }
        : {
          trackInstructions: [
            { trackId: "track-add-cello", instruction: "Write the approved low cello answer." },
          ],
          membershipProposals: [],
          requiresPlayableMaterial: true,
        };
    }
    if (system.includes("one track-owning instrument writer")) {
      writerCalls += 1;
      const assignedTrackId = JSON.parse(user).assignedTrackId as string;
      return {
        summary: "Added a quiet answer.",
        operations: [add(`resume-op-${writerCalls}`, `resume-region-${writerCalls}`, assignedTrackId)],
      };
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

test("repairs a membership plan missing requiresPlayableMaterial without changing its decision", async () => {
  let planCalls = 0;
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("read-all/edit-none")) {
        return { insight: "Keep the requested phrase sparse and leave register space." };
      }
      if (system.includes("bounded structural repair")) {
        planCalls += 1;
        return {
          membershipProposals: [{
            id: "add-cello", action: "add", instrument: "Cello",
            summary: "Add a cello option.", reason: "A low response may be useful.",
          }],
          requiresPlayableMaterial: true,
        };
      }
      if (system.includes("Convert the read-only adviser advice")) {
        planCalls += 1;
        const membership = [{
          id: "add-cello", action: "add", instrument: "Cello",
          summary: "Add a cello option.", reason: "A low response may be useful.",
        }];
        return planCalls === 1
          ? { membershipProposals: membership }
          : { membershipProposals: membership, requiresPlayableMaterial: true };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Develop the source into an original answer.",
    safeDirection: "Develop an original answer.",
    intent: "edit",
    selectedStyle: "Sparse original chamber writing.",
    history: [{ role: "user", content: "Develop the source." }],
    sourceMidi: [],
    score: score(),
  });
  assert.equal(result.status, "discussion");
  assert.equal(planCalls, 2);
  assert.equal(result.approvalContext?.requiresPlayableMaterial, true);
  assert.ok(result.events.some(event => event.stage === "plan-format-repair"));
});

test("keeps approved playable additions valid without a post-write refinement gate", async () => {
  let planCalls = 0;
  let writerCalls = 0;
  let reviewCalls = 0;
  const initialScore = score();
  const model = modelFor((system, user) => {
    if (system.includes("read-all/edit-none")) {
      return { insight: "Keep the requested phrase sparse and leave register space." };
    }
    if (system.includes("Convert the read-only adviser advice")) {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          membershipProposals: [{
            id: "add-cello", action: "add", instrument: "Cello",
            summary: "Add a cello option.", reason: "A low response may be useful.",
          }],
          requiresPlayableMaterial: true,
        };
      }
      return {
        trackInstructions: [
          { trackId: "track-1", instruction: "Write the existing piano answer." },
          { trackId: "track-add-cello", instruction: "Write the approved low cello answer." },
        ],
        membershipProposals: [],
        requiresPlayableMaterial: true,
      };
    }
    if (system.includes("one track-owning instrument writer")) {
      writerCalls += 1;
      const assignedTrackId = JSON.parse(user).assignedTrackId as string;
      const refining = system.includes("one permitted refinement");
      if (refining) {
        return {
          summary: "Removed the cello region during refinement.",
          operations: [{
            id: "remove-cello-region",
            type: "remove-region",
            trackId: assignedTrackId,
            regionId: "cello-initial-region",
            summary: "Remove the cello region.",
          }],
        };
      }
      return {
        summary: "Wrote an approved track answer.",
        operations: [add(
          assignedTrackId === "track-add-cello" ? "cello-initial" : "existing-initial",
          assignedTrackId === "track-add-cello" ? "cello-initial-region" : "existing-initial-region",
          assignedTrackId,
        )],
      };
    }
    if (system.includes("same bounded read-only")) {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          feedback: "The approved cello answer needs one bounded correction.",
          needsRefinement: true,
          affectedTrackIds: ["track-add-cello"],
          expectedConstraints: ["Keep the approved cello answer playable."],
        };
      }
      return { feedback: "The staged candidate is focused.", needsRefinement: false, affectedTrackIds: [] };
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
    score: initialScore,
  });
  assert.equal(paused.status, "discussion");
  const events: WorkflowEvent[] = [];
  const resumed = await runCompositionWorkflow({
      model,
      message: "Approve the proposed membership and continue.",
      safeDirection: "Develop an original answer.",
      intent: "edit",
      history: [],
      sourceMidi: [],
      score: initialScore,
      approvedTrackProposals: paused.trackProposals,
      approvalContext: paused.approvalContext,
      onEvent: event => events.push(event),
    });
  assert.equal(resumed.status, "verified");
  assert.equal(writerCalls, 2, "only the initial approved writer batch runs");
  assert.equal(reviewCalls, 0, "post-write advisers are not called");
  assert.equal(initialScore.tracks[0].regions.length, 0, "the workflow remains atomic until the client applies verified operations");
  assert.ok(events.some(event => event.stage === "technical-validation"));
  assert.ok(events.some(event => event.stage === "verified"));
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

test("commits the original track-owner output without post-write refinement", async () => {
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
  assert.equal(reviewCalls, 0, "post-write advisers are not called");
  assert.equal(writerRequests.length, 1);
  assert.doesNotMatch(writerRequests[0].system, /one permitted refinement/);
  assert.equal(writerRequests[0].user.assignedTrackId, "track-1");
  assert.equal(result.events.some(event => event.stage === "instrument-refinement"), false);
});

test("does not spend review-repair budget when the candidate is structurally valid", async () => {
  let reviewCalls = 0;
  let repairCalls = 0;
  let writerCalls = 0;
  const result = await runCompositionWorkflow({
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
    });
  assert.equal(result.status, "verified");
  assert.equal(reviewCalls, 0);
  assert.equal(repairCalls, 0);
  assert.equal(writerCalls, 1);
});

test("does not let an uncalled reviewer veto a valid candidate with an unsupported track", async () => {
  let reviewCalls = 0;
  const result = await runCompositionWorkflow({
      model: modelFor(system => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) {
          return { summary: "Wrote a line.", operations: [add("line")] };
        }
        if (system.includes("same bounded read-only")) {
          reviewCalls += 1;
          return { feedback: "Refine an unsupported track.", needsRefinement: true, affectedTrackIds: ["track-2"] };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused piano line.",
      safeDirection: "Write an original focused piano line.",
      intent: "edit",
      history: [],
      score: score(),
    });
  assert.equal(result.status, "verified");
  assert.equal(reviewCalls, 0);
});

test("does not let an uncalled reviewer veto a valid candidate without an affected track", async () => {
  let reviewCalls = 0;
  const result = await runCompositionWorkflow({
      model: modelFor(system => {
        if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
        if (system.includes("Convert the read-only adviser advice")) {
          return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
        }
        if (system.includes("one track-owning instrument writer")) return { summary: "Wrote a line.", operations: [add("line")] };
        if (system.includes("same bounded read-only")) {
          reviewCalls += 1;
          return { feedback: "Refine the unsupported detail.", needsRefinement: true, affectedTrackIds: [] };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }),
      message: "Write a focused piano line.",
      safeDirection: "Write an original focused piano line.",
      intent: "edit",
      history: [],
      score: score(),
    });
  assert.equal(result.status, "verified");
  assert.equal(reviewCalls, 0);
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

test("writer contract uses valid enum samples and fails closed after one unsuccessful musical regeneration", async () => {
  const original = score();
  const malformed = add("bad-dynamics");
  malformed.region.dynamics = "pp|p|mp|mf|f|ff";
  let repairCalls = 0;
  let regenerationCalls = 0;
  await assert.rejects(
    runCompositionWorkflow(directInput(modelFor(system => {
      if (system.includes("one track-owning instrument writer")) {
        assert.match(system, /"dynamics":"mf"/);
        assert.doesNotMatch(system, /"dynamics":"pp\|p\|mp\|mf\|f\|ff"/);
        assert.match(system, /must be exactly one of: pp, p, mp, mf, f, ff/);
        return { summary: "Invalid dynamics example.", operations: [malformed] };
      }
      if (system.includes("bounded structural format repair")) {
        repairCalls += 1;
        return {
          summary: "Unsafe musical rewrite.",
          operations: [{
            ...malformed,
            region: {
              ...malformed.region,
              dynamics: "mf",
              notes: [{ ...malformed.region.notes[0], pitch: 72, startBeat: 1 }],
            },
          }],
        };
      }
      if (system.includes("single authorized bounded musical regeneration")) {
        regenerationCalls += 1;
        return { summary: "Still invalid dynamics.", operations: [malformed] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), { score: original })),
    /invalid schema value/,
  );
  assert.equal(repairCalls, 0);
  assert.equal(regenerationCalls, 1);
  assert.deepEqual(original, score());
});

test("bounded regeneration fixes timing and invalid note values while preserving context and valid siblings", async () => {
  for (const defect of ["region", "note", "pitch", "velocity", "articulation"]) {
    const original = score();
    const valid = add("valid-sibling");
    const broken = add("invalid-sibling");
    if (defect === "region") broken.region.durationBeats = 17;
    if (defect === "note") broken.region.notes[0].startBeat = 3;
    if (defect === "pitch") broken.region.notes[0].pitch = 200;
    if (defect === "velocity") broken.region.notes[0].velocity = 0;
    if (defect === "articulation") broken.region.articulation = "unsupported";
    let regenerations = 0;
    const events: WorkflowEvent[] = [];
    const result = await runCompositionWorkflow(directInput(modelFor((system, user) => {
      assert.match(system, /IMPORTANT — BEFORE RESPONDING/);
      if (system.includes("one track-owning instrument writer")) {
        assert.match(system, /This score ends at beat 16/);
        assert.match(system, /REGION-RELATIVE/);
        return { summary: "Two phrases.", operations: [valid, broken] };
      }
      if (system.includes("single authorized bounded musical regeneration")) {
        regenerations += 1;
        const context = JSON.parse(user);
        assert.equal(context.originalContext.assignedTrackId, "track-1");
        assert.equal(context.originalContext.selectedStyle, "Original sparse chamber writing.");
        assert.equal(context.completeScore.durationBeats, 16);
        return { summary: "Two valid phrases.", operations: [valid, add("invalid-sibling")] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), { score: original, selectedStyle: "Original sparse chamber writing.", onEvent: event => events.push(event) }));
    assert.equal(result.status, "verified", defect);
    assert.equal(regenerations, 1, defect);
    assert.ok(events.some(event => event.code === "musical-regeneration" && event.outcome === "recovered"));
    assert.deepEqual(original, score());
  }
});

test("musical regeneration rejects changed valid siblings, dropped operations, foreign-track targets, and forbidden fields", async () => {
  for (const defect of ["changed-sibling", "dropped", "foreign-track", "membership"]) {
    const original = score();
    original.tracks.push({ ...original.tracks[0], id: "track-2", name: "Flute", instrument: "Flute", midiProgram: 73, regions: [] });
    const valid = add("valid");
    const broken = add("broken");
    broken.region.durationBeats = 17;
    let regenerations = 0;
    await assert.rejects(runCompositionWorkflow(directInput(modelFor(system => {
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Two phrases.", operations: [valid, broken] };
      }
      if (system.includes("single authorized bounded musical regeneration")) {
        regenerations += 1;
        const replacement = add("broken");
        const sibling = structuredClone(valid);
        if (defect === "changed-sibling") sibling.region.notes[0].pitch += 1;
        if (defect === "foreign-track") replacement.trackId = "track-2";
        return { summary: "Invalid replacement.", operations: defect === "dropped" ? [replacement] : [sibling, replacement],
          ...(defect === "membership" ? { membershipProposals: [{ action: "delete", trackId: "track-2" }] } : {}) };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), { score: original })), /valid sibling|operation count|outside its server-assigned track|forbidden fields/);
    assert.equal(regenerations, 1);
    assert.equal(original.tracks[0].regions.length, 0);
    assert.equal(original.tracks[1].regions.length, 0);
  }
});

test("musical regeneration is shared across writers and does not partially commit on exhaustion", async () => {
  const original = score();
  original.tracks.push({ ...original.tracks[0], id: "track-2", name: "Flute", instrument: "Flute", midiProgram: 73, regions: [] });
  let regenerations = 0;
  let writers = 0;
  await assert.rejects(runCompositionWorkflow({
    ...directInput(modelFor((system, user) => {
      if (system.includes("read-all/edit-none")) return { insight: "Use two restrained phrases." };
      if (system.includes("Convert the read-only adviser advice")) return { trackInstructions: [
        { trackId: "track-1", instruction: "Write a restrained piano phrase." },
        { trackId: "track-2", instruction: "Write a restrained flute phrase." },
      ], membershipProposals: [], requiresPlayableMaterial: true };
      if (system.includes("one track-owning instrument writer")) {
        writers += 1;
        const operation = add(`phrase-${writers}`, `phrase-${writers}`, JSON.parse(user).assignedTrackId);
        operation.region.durationBeats = 17;
        return { summary: "Invalid phrase.", operations: [operation] };
      }
      if (system.includes("single authorized bounded musical regeneration")) {
        regenerations += 1;
        return { summary: "Valid phrase.", operations: [add("phrase-1")] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    })),
    score: original,
    message: "Write a duet.",
    safeDirection: "Write an original duet.",
  }), /cannot be structurally repaired without regenerating musical content/);
  assert.equal(writers, 2);
  assert.equal(regenerations, 1);
  assert.ok(original.tracks.every(track => track.regions.length === 0));
});

test("an eligible musical defect cannot authorize rewriting a structurally invalid sibling", async () => {
  const brokenTiming = add("bad-timing");
  brokenTiming.region.durationBeats = 17;
  const structural = add("missing-name") as Record<string, any>;
  delete structural.region.name;
  let regenerations = 0;
  await assert.rejects(runCompositionWorkflow(directInput(modelFor(system => {
    if (system.includes("one track-owning instrument writer")) {
      return { summary: "Mixed defects.", operations: [brokenTiming, structural] };
    }
    if (system.includes("single authorized bounded musical regeneration")) {
      regenerations += 1;
      return { summary: "Unauthorized rewrite.", operations: [add("bad-timing"), add("missing-name")] };
    }
    throw new Error(`Unexpected prompt: ${system}`);
  }))), /cannot be structurally repaired without regenerating musical content/);
  assert.equal(regenerations, 0);
});

test("writer repair cannot invent a whole region or substitute an operation target", async () => {
  const cases = [
    {
      name: "missing region",
      operation: {
        id: "missing-region",
        type: "add-region",
        trackId: "track-1",
        summary: "Missing musical payload",
      },
    },
    {
      name: "invalid target",
      operation: add("wrong-target", "wrong-target", "unknown-track"),
    },
  ];
  for (const failureCase of cases) {
    const original = score();
    let repairCalls = 0;
    await assert.rejects(
      runCompositionWorkflow(directInput(modelFor(system => {
        if (system.includes("one track-owning instrument writer")) {
          return { summary: failureCase.name, operations: [failureCase.operation] };
        }
        if (system.includes("bounded structural format repair")) {
          repairCalls += 1;
          return { summary: "Unsafe replacement.", operations: [add("replacement")] };
        }
        throw new Error(`Unexpected prompt: ${system}`);
      }), { score: original })),
      /cannot be structurally repaired without regenerating musical content/,
    );
    assert.equal(repairCalls, 0, failureCase.name);
    assert.deepEqual(original, score(), failureCase.name);
  }
});

test("fails an incomplete operation batch before a repair can replace musical content", async () => {
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
        return { summary: "Unsafe replacement.", operations: [baseline, add(`unverified-${repairCalls}`)] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }), { score: original })),
    /cannot be structurally repaired without regenerating musical content/,
  );
  assert.equal(repairCalls, 0);
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
        assert.match(system, /Cello \(strings, program 42\)/);
        assert.match(system, /explicitly map it to the closest supported catalog instrument/);
        return {
          trackInstructions: [{ trackId: "track-1", instruction: "Leave space below the line." }],
          membershipProposals: [{
            id: "add-cello", action: "add", instrument: "Cello", role: "strings", midiProgram: 42,
            summary: "Add cello.", reason: "The requested low answer needs a cello.",
          }],
          requiresPlayableMaterial: true,
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

test("planner initial and repair prompts carry the shared timbre-mapping rule", async () => {
  let initialPlanPrompt = "";
  let repairPlanPrompt = "";
  let planCalls = 0;
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("Convert the read-only adviser advice")) {
        planCalls += 1;
        initialPlanPrompt = system;
        return { trackInstructions: "malformed" };
      }
      if (system.includes("single bounded structural repair")) {
        repairPlanPrompt = system;
        return { trackInstructions: [{ trackId: "track-1", instruction: "Write a focused line." }] };
      }
      if (system.includes("read-all/edit-none")) return { insight: "Keep the line focused." };
      if (system.includes("one track-owning instrument writer")) {
        return { summary: "Wrote a focused line.", operations: [add("planner-prompt-rule")] };
      }
      if (system.includes("same bounded read-only")) {
        return { feedback: "The staged line is accepted.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a focused piano line.",
    safeDirection: "Write an original focused piano line.",
    intent: "edit",
    history: [],
    score: score(),
  });
  assert.equal(result.status, "verified");
  assert.equal(planCalls, 1);
  assert.match(initialPlanPrompt, /explicitly map it to the closest supported catalog instrument/);
  assert.match(repairPlanPrompt, /explicitly map it to the closest supported catalog instrument/);
});

test("planner repair names every live track ID and preserves exact two-track ownership", async () => {
  const tracks = [
    { id: "track-violin", name: "Violin", instrument: "Violin", midiProgram: 40, regions: [] },
    { id: "track-piano", name: "Upright Piano", instrument: "Upright Piano", midiProgram: 0, regions: [] },
  ];
  const twoTrackScore = (): ScoreValue => ({ tempo: 120, durationBeats: 16, tracks });
  let repairPrompt = "";
  const result = await runCompositionWorkflow({
    model: modelFor((system) => {
      if (system.includes("Convert the read-only adviser advice")) {
        return {
          trackInstructions: [
            { trackId: "Violin", instruction: "Write the requested violin line." },
            { trackId: "Upright Piano", instruction: "Write the requested piano line." },
          ],
        };
      }
      if (system.includes("single bounded structural repair")) {
        repairPrompt = system;
        return {
          trackInstructions: [
            { trackId: "track-violin", instruction: "Write the requested violin line." },
            { trackId: "track-piano", instruction: "Write the requested piano line." },
          ],
        };
      }
      if (system.includes("read-all/edit-none")) return { insight: "Keep the arrangement focused." };
      if (system.includes("one track-owning instrument writer")) {
        const trackId = system.includes('assigned trackId "track-violin"') ? "track-violin" : "track-piano";
        return { summary: `Wrote the ${trackId} line.`, operations: [add(`repair-${trackId}`, `region-${trackId}`, trackId)] };
      }
      if (system.includes("same bounded read-only")) {
        return { feedback: "The staged material is accepted.", needsRefinement: false, affectedTrackIds: [] };
      }
      throw new Error(`Unexpected prompt: ${system}`);
    }),
    message: "Write a focused violin and piano cue.",
    safeDirection: "Write an original focused violin and piano cue.",
    intent: "edit",
    history: [],
    score: twoTrackScore(),
  });
  assert.equal(result.status, "verified");
  assert.match(repairPrompt, /AUTHORITATIVE CURRENT TRACK MAPPING/);
  assert.match(repairPrompt, /track-violin/);
  assert.match(repairPrompt, /track-piano/);
  assert.match(repairPrompt, /track-instruction-structure/);
  assert.doesNotMatch(repairPrompt, /"trackId":"existing track id"/);
  assert.deepEqual([...new Set(result.operations.map((operation) => operation.trackId))].sort(), ["track-piano", "track-violin"]);
  assert.equal(result.operations.length, 2);
});

test("a structurally valid candidate is committed without final adviser rejection", async () => {
  let writerCalls = 0;
  let reviews = 0;
  const result = await runCompositionWorkflow({
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
    });
  assert.equal(result.status, "verified");
  assert.equal(writerCalls, 1);
  assert.equal(reviews, 0);
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