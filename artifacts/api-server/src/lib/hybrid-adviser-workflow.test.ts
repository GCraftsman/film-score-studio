import assert from "node:assert/strict";
import test from "node:test";
import {
  runCompositionWorkflow,
  type ModelMessage,
  type ScoreValue,
  type WorkflowModel,
} from "./composition-workflow.ts";

const twoTrackScore = (): ScoreValue => ({
  tempo: 120,
  durationBeats: 16,
  tracks: [
    { id: "strings", instrument: "Violin", regions: [] },
    { id: "strings-2", instrument: "Violin", regions: [] },
    { id: "keys", instrument: "Piano", regions: [] },
  ],
});

const add = (id: string, trackId: string) => ({
  id,
  type: "add-region",
  trackId,
  summary: "Add an assigned-track phrase",
  region: {
    id: `${id}-region`,
    name: "advisory phrase",
    startBeat: 0,
    durationBeats: 2,
    dynamics: "mf",
    articulation: "sustain",
    notes: [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1, articulation: "sustain" }],
  },
});

test("structured advice and materialized MIDI route only to the matching writer", async () => {
  const writerUsers: Array<Record<string, unknown>> = [];
  const writerSystems: string[] = [];
  let adviceCalls = 0;
  let reviewCalls = 0;
  const model: WorkflowModel = {
    async complete(messages: ModelMessage[]) {
      const system = messages[0]?.content ?? "";
      const user = messages.at(-1)?.content ?? "";
      if (system.includes("read-all/edit-none")) {
        adviceCalls += 1;
        return JSON.stringify({
          insight: "Use a restrained entrance on the violin only.",
          suggestions: adviceCalls === 1 ? [
            {
              id: "violin-idea",
              label: "Bowed entrance",
              instructions: ["Keep the phrase light and within a comfortable violin register."],
              targetTrackIds: ["strings"],
              instrumentId: "violin",
              midiClip: {
                tempo: 120,
                durationBeats: 2,
                notes: [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1 }],
              },
            },
            {
              id: "invalid-target",
              label: "Invalid optional target",
              instructions: ["This optional sibling must not block the valid advice."],
              targetTrackIds: ["Violin"],
              instrumentId: "violin",
            },
          ] : [],
        });
      }
      if (system.includes("same bounded read-only")) {
        reviewCalls += 1;
        return JSON.stringify({
          feedback: reviewCalls === 1 ? "Give the violin line a more restrained contour." : "The candidate is clear.",
          needsRefinement: reviewCalls === 1,
          // Providers sometimes repeat the previously affected track while
          // explicitly accepting the refined candidate. The boolean remains
          // authoritative and the redundant IDs must not trigger a new round.
          affectedTrackIds: ["strings"],
          expectedConstraints: reviewCalls === 1 ? ["Keep the violin contour restrained."] : [],
        });
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return JSON.stringify({
          trackInstructions: [
            { trackId: "strings", instruction: "Write the violin entrance." },
            { trackId: "strings-2", instruction: "Write a separate second violin response." },
            { trackId: "keys", instruction: "Write a separate piano response." },
          ],
          membershipProposals: [],
        });
      }
      if (system.includes("one track-owning instrument writer")) {
        writerSystems.push(system);
        writerUsers.push(JSON.parse(user) as Record<string, unknown>);
        const assigned = (JSON.parse(user) as { assignedTrackId: string }).assignedTrackId;
        return JSON.stringify({ summary: "Wrote assigned material.", operations: [add(`op-${writerSystems.length}`, assigned)] });
      }
      throw new Error(`Unexpected hybrid workflow prompt: ${system}`);
    },
  };
  const result = await runCompositionWorkflow({
    model,
    message: "Write both assigned parts.",
    safeDirection: "Write both assigned parts.",
    intent: "edit",
    history: [],
    score: twoTrackScore(),
    projectId: "11111111-1111-4111-8111-111111111111",
    persistAdvisoryMidiClip: async () => ({
      id: "22222222-2222-4222-8222-222222222222",
      objectPath: "/objects/projects/user_test/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
      sha256: "0".repeat(64),
      label: "Bowed entrance",
      alignment: { startBeat: 0, durationBeats: 2 },
      targets: { trackIds: ["strings"], instrumentIds: ["violin"], instruments: ["Violin"] },
    }),
    loadAdvisoryMidiRef: async () => ({
      sourceRefId: "22222222-2222-4222-8222-222222222222",
      tempo: 120,
      durationBeats: 1,
      notes: [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1 }],
    }),
  });
  assert.equal(result.status, "verified");
  assert.equal(adviceCalls, 2);
  assert.equal(reviewCalls, 0, "post-write adviser review is not part of the commit path");
  const strings = writerUsers.find((user) => user.assignedTrackId === "strings")!;
  const secondStrings = writerUsers.find((user) => user.assignedTrackId === "strings-2")!;
  const keys = writerUsers.find((user) => user.assignedTrackId === "keys")!;
  assert.equal((strings.adviserSuggestions as unknown[]).length, 1);
  assert.equal((secondStrings.adviserSuggestions as unknown[]).length, 0);
  assert.equal((keys.adviserSuggestions as unknown[]).length, 0);
  assert.equal(((strings.adviserSuggestions as Array<Record<string, unknown>>)[0]).advisoryMidi !== undefined, true);
  assert.ok(writerUsers
    .filter((user) => user.assignedTrackId === "strings")
    .every((user) => (user.adviserSuggestions as unknown[]).length === 1));
  assert.ok(writerUsers
    .filter((user) => user.assignedTrackId === "strings-2")
    .every((user) => (user.adviserSuggestions as unknown[]).length === 0));
  assert.ok(writerSystems.every((system) => system.includes("expert on your instrument's range, articulation, and technique")));
  assert.ok(writerSystems.every((system) => system.includes("may adapt them and take liberties")));
  assert.equal(writerSystems.some((system) => system.includes("one permitted refinement")), false);
  assert.equal(result.operations.some((operation) => operation.type === "add-track"), false);
});

test("advisory MIDI load failure is explicit and never yields score operations", async () => {
  const model: WorkflowModel = {
    async complete(messages: ModelMessage[]) {
      const system = messages[0]?.content ?? "";
      if (system.includes("read-all/edit-none")) {
        return JSON.stringify({
          insight: "Use the violin entrance.",
          suggestions: [{
            id: "violin-idea",
            label: "Bowed entrance",
            instructions: ["Use a quiet entrance."],
            targetTrackIds: ["strings"],
            instrumentId: "violin",
            midiClip: { tempo: 120, durationBeats: 2, notes: [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1 }] },
          }],
        });
      }
      if (system.includes("same bounded read-only")) {
        return JSON.stringify({ feedback: "The request is clear.", needsRefinement: false, affectedTrackIds: [] });
      }
      if (system.includes("Convert the read-only adviser advice")) {
        return JSON.stringify({
          trackInstructions: [{ trackId: "strings", instruction: "Write the violin part." }],
          membershipProposals: [],
        });
      }
      if (system.includes("one track-owning instrument writer")) {
        throw new Error("The workflow must stop before a writer can apply score operations.");
      }
      throw new Error(`Unexpected failure workflow prompt: ${system}`);
    },
  };
  await assert.rejects(() => runCompositionWorkflow({
    model,
    message: "Write the violin part.",
    safeDirection: "Write the violin part.",
    intent: "edit",
    history: [],
    score: twoTrackScore(),
    projectId: "11111111-1111-4111-8111-111111111111",
    persistAdvisoryMidiClip: async () => ({
      id: "22222222-2222-4222-8222-222222222222",
      objectPath: "/objects/projects/user_test/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
      sha256: "0".repeat(64),
      label: "Bowed entrance",
      alignment: { startBeat: 0, durationBeats: 2 },
      targets: { trackIds: ["strings"], instrumentIds: ["violin"], instruments: ["Violin"] },
    }),
    loadAdvisoryMidiRef: async () => {
      throw new Error("object missing");
    },
  }));
});

test("approval continuation cannot switch its signed project", async () => {
  const model: WorkflowModel = {
    async complete() {
      throw new Error("model must not run for a project switch");
    },
  };
  await assert.rejects(() => runCompositionWorkflow({
    model,
    message: "Continue",
    safeDirection: "Continue",
    intent: "edit",
    history: [],
    score: twoTrackScore(),
    projectId: "33333333-3333-4333-8333-333333333333",
    approvalContext: {
      originalMessage: "Write the part.",
      originalHistory: [],
      originalMidi: [],
      projectId: "11111111-1111-4111-8111-111111111111",
      adviserRoster: [],
      adviserConsultations: [],
      consumedBudget: {
        adviserConsultationsUsed: 0,
        trackWriterRoundsUsed: 0,
        refinementRoundsUsed: 0,
        operationRepairAttemptsUsed: 0,
      },
    },
  }), /cannot be changed/);
});