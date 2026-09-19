import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalContextIntegrityError,
  signApprovalContext,
  verifyApprovalContext,
} from "./composition-approval-integrity.ts";

const projectId = "11111111-1111-1111-1111-111111111111";
const base = {
  originalMessage: "Write the approved part.",
  originalHistory: [],
  originalMidi: [],
  projectId,
  adviserRoster: [],
  adviserConsultations: [{
    agent: "Texture & Register",
    group: "concept" as const,
    question: "Advise the register.",
    insight: "Keep space around the entrance.",
    suggestions: [{
      id: "suggestion-1",
      label: "Bowed entrance",
      instructions: ["Use a restrained violin contour."],
      targetTrackIds: ["strings"],
      instrumentId: "violin",
      instrumentName: "Violin",
      advisoryMidiRef: {
        id: "22222222-2222-2222-2222-222222222222",
        objectPath: `/objects/projects/user_test/${projectId}/22222222-2222-2222-2222-222222222222`,
        sha256: "0".repeat(64),
        label: "Bowed entrance",
        alignment: { startBeat: 0, durationBeats: 2 },
        targets: { trackIds: ["strings"], instrumentIds: ["violin"], instruments: ["Violin"] },
      },
    }],
  }],
  consumedBudget: {
    adviserConsultationsUsed: 1,
    trackWriterRoundsUsed: 0,
    refinementRoundsUsed: 0,
    operationRepairAttemptsUsed: 0,
  },
};

test("project and immutable consultation refs are covered by approval signatures", () => {
  const score = { tempo: 120, durationBeats: 16, tracks: [{ id: "strings", regions: [] }] };
  const signed = signApprovalContext(base, "user_test", score, [{ id: "add-strings", action: "add" }]);
  const verified = verifyApprovalContext(signed, "user_test", score);
  assert.equal(verified.context.projectId, projectId);
  assert.equal(
    (verified.context.adviserConsultations[0] as { suggestions: Array<{ advisoryMidiRef: unknown }> }).suggestions[0].advisoryMidiRef !== undefined,
    true,
  );
  assert.throws(() => verifyApprovalContext({
    ...signed,
    projectId: "33333333-3333-3333-3333-333333333333",
  }, "user_test", score), ApprovalContextIntegrityError);
  assert.throws(() => verifyApprovalContext({
    ...signed,
    adviserConsultations: [{
      ...base.adviserConsultations[0],
      suggestions: [{ ...base.adviserConsultations[0].suggestions[0], advisoryMidiRef: { ...base.adviserConsultations[0].suggestions[0].advisoryMidiRef, sha256: "1".repeat(64) } }],
    }],
  }, "user_test", score), ApprovalContextIntegrityError);
});