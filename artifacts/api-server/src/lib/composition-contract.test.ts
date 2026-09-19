import assert from "node:assert/strict";
import test from "node:test";
import {
  ComposeWithOrchestratorBody,
  ComposeWithOrchestratorResponse,
} from "../../../../lib/api-zod/src/generated/api.ts";
import {
  assertApprovedProposalSubset,
  accumulateApprovedMembershipProposals,
  consumeApprovalCheckpoint,
  reconcileNewMembershipProposals,
  signApprovalContext,
  suppressRejectedMembershipProposals,
  verifyApprovalContext,
} from "./composition-approval-integrity.ts";

const selectedStyle = "Minimal melody: Sparse single-line tune with occasional harmonic support, using gentle dynamics and a slow tempo to evoke calm introspection.";

function requestWith(selectedStyleValue: string) {
  return {
    message: "Continue the approved cue",
    phase: "instrument-approval" as const,
    selectedStyle: selectedStyleValue,
    midiSnippets: [],
    history: [],
    score: { tempo: 96, durationBeats: 64, tracks: [] },
  };
}

test("the complete selected style description is accepted by the server request schema", () => {
  const parsed = ComposeWithOrchestratorBody.safeParse(requestWith(selectedStyle));
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.selectedStyle, selectedStyle);
});

test("selected styles over the contract bound are rejected", () => {
  assert.equal(ComposeWithOrchestratorBody.safeParse(requestWith("x".repeat(5000))).success, true);
  assert.equal(ComposeWithOrchestratorBody.safeParse(requestWith("x".repeat(5001))).success, false);
  const response = {
    response: "Choose a scoring style.",
    workflow: "style-intake" as const,
    styleSuggestions: [],
    trackProposals: [],
    consultations: [],
    usageGuard: "bounded",
    operations: [],
  };
  assert.equal(ComposeWithOrchestratorResponse.safeParse({ ...response, selectedStyle: "x".repeat(5000) }).success, true);
  assert.equal(ComposeWithOrchestratorResponse.safeParse({ ...response, selectedStyle: "x".repeat(5001) }).success, false);
});

test("approval continuation contract preserves adviser context and never treats membership as automatic", () => {
  const approvalContext = {
    originalMessage: "Develop the attached melody.",
    originalHistory: [{ role: "user", content: "Develop the attached melody." }],
    originalMidi: [{
      id: "melody",
      tempo: 96,
      durationMs: 500,
      notes: [{ note: 60, velocity: 90, startMs: 0, durationMs: 250 }],
    }],
    requiresPlayableMaterial: true,
    adviserRoster: [{ agent: "Harmony & Voice Leading", group: "concept", question: "What supports the melody?" }],
    adviserConsultations: [{
      agent: "Harmony & Voice Leading",
      group: "concept",
      question: "What supports the melody?",
      insight: "Use a sparse contrary line.",
    }],
    consumedBudget: {
      adviserConsultationsUsed: 1,
      trackWriterRoundsUsed: 0,
      refinementRoundsUsed: 0,
      operationRepairAttemptsUsed: 1,
    },
    checkpointId: "db2a6a1a-4f3d-4a2c-9f99-9fd2d4b32bf2",
    offeredTrackProposals: [],
    declinedTrackProposals: [],
    accumulatedApprovedTrackProposals: [],
    signature: "a".repeat(64),
  };
  const request = ComposeWithOrchestratorBody.safeParse({
    ...requestWith(selectedStyle),
    approvedTrackProposalIds: ["add-cello", "remove-brass"],
    approvedTrackProposals: [{
      id: "add-cello", action: "add", instrument: "Cello", role: "strings",
      midiProgram: 42, summary: "Add cello", reason: "Carry the low answer.",
    }, {
      id: "remove-brass", action: "delete", trackId: "brass", instrument: "Horn", role: "brass",
      midiProgram: 60, summary: "Remove horn", reason: "Keep the cue intimate.",
    }],
    approvalContext,
  });
  assert.equal(request.success, true);
  if (request.success) {
    assert.equal(request.data.approvedTrackProposals?.length, 2);
    assert.equal(request.data.approvalContext?.adviserConsultations[0].insight, "Use a sparse contrary line.");
    assert.equal(request.data.approvalContext?.consumedBudget.operationRepairAttemptsUsed, 1);
  }
  assert.equal(ComposeWithOrchestratorBody.safeParse({
    ...requestWith(selectedStyle),
    approvalContext: { ...approvalContext, adviserRoster: Array(17).fill(approvalContext.adviserRoster[0]) },
  }).success, false);
});

test("server-signed approval checkpoints bind the composer, exact score, and offered proposals", () => {
  const previous = process.env.COMPOSITION_APPROVAL_HMAC_SECRET;
  process.env.COMPOSITION_APPROVAL_HMAC_SECRET = "test-only-approval-signing-secret";
  const score = {
    tempo: 96,
    durationBeats: 64,
    tracks: [{ id: "piano", name: "Piano", role: "melody", instrument: "Piano", midiProgram: 0, regions: [] }],
  };
  const offered = [{
    id: "add-cello", action: "add", instrument: "Cello", role: "strings",
    midiProgram: 42, summary: "Add cello", reason: "Carry the low answer.",
  }];
  const context = signApprovalContext({
    originalMessage: "Develop the attached melody.",
    originalHistory: [{ role: "user", content: "Develop the attached melody." }],
    originalMidi: [],
    adviserRoster: [{ agent: "Harmony & Voice Leading", group: "concept", question: "What supports the melody?" }],
    adviserConsultations: [],
    consumedBudget: {
      adviserConsultationsUsed: 1,
      trackWriterRoundsUsed: 0,
      refinementRoundsUsed: 0,
      operationRepairAttemptsUsed: 0,
    },
  }, "user_123", score, offered, [{
    id: "previous-add-violin", action: "add", instrument: "Violin", role: "strings",
    midiProgram: 40, summary: "Add violin", reason: "A prior alternate was declined.",
  }]);
  try {
    const verified = verifyApprovalContext(context, "user_123", score);
    assert.deepEqual(verified.context.consumedBudget, context.consumedBudget);
    assert.equal(verified.declinedTrackProposals[0]?.id, "previous-add-violin");
    assert.deepEqual(verified.accumulatedApprovedTrackProposals, []);
    assertApprovedProposalSubset(offered, ["add-cello"], verified.offeredTrackProposals);
    assert.throws(
      () => verifyApprovalContext(context, "other_user", score),
      /checkpoint could not be verified/,
    );
    assert.throws(
      () => verifyApprovalContext(context, "user_123", { ...score, durationBeats: 65 }),
      /checkpoint could not be verified/,
    );
    assert.throws(
      () => assertApprovedProposalSubset([{ ...offered[0], instrument: "Violin" }], ["add-cello"], verified.offeredTrackProposals),
      /no longer matches/,
    );
  } finally {
    if (previous === undefined) delete process.env.COMPOSITION_APPROVAL_HMAC_SECRET;
    else process.env.COMPOSITION_APPROVAL_HMAC_SECRET = previous;
  }
});

test("approval checkpoints are atomically single-use and partial approvals suppress declined members", async () => {
  let claimed = false;
  const claim = async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  };
  const concurrent = await Promise.allSettled([
    consumeApprovalCheckpoint(claim),
    consumeApprovalCheckpoint(claim),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);

  const offered = [
    { id: "add-cello", action: "add", instrument: "Cello" },
    { id: "add-violin", action: "add", instrument: "Violin" },
  ];
  const continuation = suppressRejectedMembershipProposals(
    offered,
    [offered[0]],
  );
  assert.deepEqual(continuation.allowed, [offered[1]]);
  assert.deepEqual(continuation.suppressed, [offered[0]]);
  const cumulative = accumulateApprovedMembershipProposals(
    [offered[1]],
    [{ id: "remove-brass", action: "delete", trackId: "brass", instrument: "Horn" }],
  );
  assert.deepEqual(cumulative.map((proposal) => (proposal as { id: string }).id), ["add-violin", "remove-brass"]);
});

test("chained membership reissues semantic ID collisions without reopening exact prior approvals", () => {
  const approved = [{ id: "proposal-1", action: "add", instrument: "Cello", role: "strings", midiProgram: 42 }];
  const reconciled = reconcileNewMembershipProposals([
    { ...approved[0] },
    { id: "proposal-1", action: "delete", trackId: "brass", instrument: "Horn", role: "brass", midiProgram: 60 },
  ], approved) as Array<{ id: string; action: string; instrument: string }>;

  // The byte-for-byte canonical reissue is already authorized and suppressed.
  assert.equal(reconciled.length, 1);
  // The different deletion remains a new decision with an ID that can safely
  // be accumulated after its approval.
  assert.equal(reconciled[0]?.action, "delete");
  assert.equal(reconciled[0]?.instrument, "Horn");
  assert.notEqual(reconciled[0]?.id, approved[0]?.id);
  assert.equal(
    accumulateApprovedMembershipProposals(approved, reconciled).length,
    2,
  );
});