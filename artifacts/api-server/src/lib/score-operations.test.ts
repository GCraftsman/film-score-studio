import assert from "node:assert/strict";
import test from "node:test";
import {
  hasDuplicateScoreIds,
  INVALID_SUMMARY_REASON,
  MAX_SUMMARY_LENGTH,
  translateScoreOperation,
  validateScoreOperations,
  validateScoreOperationsDetailed,
} from "./score-operations.ts";

const region = (id: string, notes: unknown[] = [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1, articulation: "sustain" }]) => ({
  id, name: id, startBeat: 0, durationBeats: 4, dynamics: "mf", articulation: "sustain", notes,
});
const score = {
  durationBeats: 16,
  tracks: [{ id: "track-1", regions: [{ id: "existing" }] }],
};
const add = (id: string, regionId: string, notes?: unknown[]) => ({
  id, type: "add-region", trackId: "track-1", summary: "add", region: region(regionId, notes),
});
const remove = (id: string, regionId: string) => ({
  id, type: "remove-region", trackId: "track-1", regionId, summary: "remove",
});

test("rejects empty note regions", () => {
  assert.deepEqual(validateScoreOperations(score, [add("op-1", "empty", [])]), []);
});

test("detects duplicate track IDs and globally duplicate region IDs", () => {
  assert.equal(hasDuplicateScoreIds({ ...score, tracks: [...score.tracks, { id: "track-1", regions: [] }] }), true);
  assert.equal(hasDuplicateScoreIds({
    ...score,
    tracks: [...score.tracks, { id: "track-2", regions: [{ id: "existing" }] }],
  }), true);
});

test("rejects duplicate operation and region IDs", () => {
  const result = validateScoreOperations(score, [
    add("same-op", "new-1"),
    add("same-op", "new-2"),
    add("op-3", "new-1"),
  ]);
  assert.deepEqual(result, []);
  assert.deepEqual(
    validateScoreOperationsDetailed(score, [
      add("same-op", "new-1"),
      add("same-op", "new-2"),
      add("op-3", "new-1"),
    ]).diagnostics.map((diagnostic) => ({
      index: diagnostic.index,
      code: diagnostic.code,
      duplicateId: diagnostic.duplicateId,
    })),
    [
      { index: 1, code: "duplicate-id", duplicateId: "same-op" },
      { index: 2, code: "duplicate-id", duplicateId: "new-1" },
    ],
  );
});

test("rejects cross-track collisions with existing and newly proposed region IDs", () => {
  const twoTrackScore = {
    ...score,
    tracks: [...score.tracks, { id: "track-2", regions: [{ id: "other-existing" }] }],
  };
  const result = validateScoreOperations(twoTrackScore, [
    add("op-1", "other-existing"),
    add("op-2", "new-shared"),
    { ...add("op-3", "new-shared"), trackId: "track-2" },
  ]);
  assert.deepEqual(result, []);
  const diagnostics = validateScoreOperationsDetailed(twoTrackScore, [
    add("op-1", "other-existing"),
    add("op-2", "new-shared"),
    { ...add("op-3", "new-shared"), trackId: "track-2" },
  ]).diagnostics;
  assert.equal(diagnostics[0]?.duplicateId, "other-existing");
  assert.equal(diagnostics[1]?.duplicateId, "new-shared");
});

test("rejects missing tracks and missing remove targets", () => {
  assert.deepEqual(validateScoreOperations(score, [
    { ...add("op-1", "new"), trackId: "missing" },
    remove("op-2", "missing"),
  ]), []);
});

test("evaluates add and remove operations in proposal order", () => {
  assert.deepEqual(
    validateScoreOperations(score, [add("op-1", "new"), remove("op-2", "new")]).map((operation) => operation.id),
    ["op-1", "op-2"],
  );
  assert.deepEqual(
    validateScoreOperations(score, [remove("op-1", "future"), add("op-2", "future")]).map((operation) => operation.id),
    [],
  );
  assert.deepEqual(
    validateScoreOperations(
      { ...score, tracks: [...score.tracks, { id: "track-2", regions: [] }] },
      [remove("op-3", "existing"), { ...add("op-4", "existing"), trackId: "track-2" }],
    ).map((operation) => operation.id),
    ["op-3", "op-4"],
  );
});

test("rejects a malformed sibling atomically instead of filtering valid music", () => {
  const proposed = [add("op-1", "new"), { ...add("op-2", "bad"), region: undefined }];
  const validation = validateScoreOperations(score, proposed);
  assert.deepEqual(validation, []);
  assert.equal(validation.diagnostics[0]?.index, 1);
  assert.equal(validation.diagnostics[0]?.code, "missing-field");
  assert.deepEqual(validateScoreOperationsDetailed(score, proposed).diagnostics, [{
    index: 1,
    code: "missing-field",
    reason: "required field missing",
    fields: ["region"],
  }]);
});

test("reports only bounded summary constraints for every invalid summary shape", () => {
  const oversizedSummary = `private-summary-${"x".repeat(MAX_SUMMARY_LENGTH + 40)}`;
  const invalidSummaries: Array<[string, unknown, string, number?]> = [
    ["null", null, "null"],
    ["number", 17, "number"],
    ["boolean", false, "boolean"],
    ["object", { notes: "private note content" }, "object"],
    ["array", ["private note content"], "array"],
    ["empty", "", "string", 0],
    ["too long", oversizedSummary, "string", MAX_SUMMARY_LENGTH + 1],
  ];

  for (const [label, summary, observedType, observedLength] of invalidSummaries) {
    const diagnostics = validateScoreOperationsDetailed(
      score,
      [{ ...add(`summary-${label}`, `region-${label}`), summary }],
    ).diagnostics;
    assert.deepEqual(diagnostics, [{
      index: 0,
      code: "invalid-field",
      reason: INVALID_SUMMARY_REASON,
      fields: ["summary"],
      observedType,
      ...(observedLength !== undefined ? { observedLength } : {}),
      maxLength: MAX_SUMMARY_LENGTH,
    }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-summary|private note content/);
  }
});

test("accepts a summary at the limit and rejects only the over-limit metadata", () => {
  const valid = { ...add("summary-limit", "region-limit"), summary: "x".repeat(MAX_SUMMARY_LENGTH) };
  assert.equal(validateScoreOperationsDetailed(score, [valid]).diagnostics.length, 0);

  const overLimit = { ...valid, summary: `${valid.summary}x` };
  const diagnostic = validateScoreOperationsDetailed(score, [overLimit]).diagnostics[0];
  assert.equal(diagnostic?.code, "invalid-field");
  assert.equal(diagnostic?.fields[0], "summary");
  assert.equal(diagnostic?.observedType, "string");
  assert.equal(diagnostic?.observedLength, MAX_SUMMARY_LENGTH + 1);
  assert.equal(diagnostic?.maxLength, MAX_SUMMARY_LENGTH);
});

test("a metadata-only summary repair preserves the complete musical operation", () => {
  const notes = [
    { pitch: 48, velocity: 73, startBeat: 0, durationBeats: 2, articulation: "sustain" },
    { pitch: 67, velocity: 91, startBeat: 2, durationBeats: 1, articulation: "legato" },
  ];
  const invalid = {
    ...add("summary-repair", "summary-repair-region", notes),
    summary: "",
  };
  const initialDiagnostic = validateScoreOperationsDetailed(score, [invalid]).diagnostics[0];
  assert.equal(initialDiagnostic?.reason, INVALID_SUMMARY_REASON);

  const repaired = { ...invalid, summary: "repaired summary" };
  const result = validateScoreOperationsDetailed(score, [repaired]);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual((result.operations[0]?.region as { notes: unknown[] }).notes, notes);
  assert.equal(result.operations[0]?.summary, "repaired summary");
});

test("reports target IDs, timing paths, and missing fields without music content", () => {
  const missingTarget = remove("op-1", "absent");
  const badTiming = {
    ...add("op-2", "late"),
    region: { ...add("unused", "late").region, startBeat: 15, durationBeats: 2 },
  };
  const missingField = { ...add("op-3", "missing"), summary: undefined };
  const diagnostics = validateScoreOperationsDetailed(score, [missingTarget, badTiming, missingField]).diagnostics;

  assert.equal(diagnostics[0]?.code, "missing-target");
  assert.equal(diagnostics[0]?.targetId, "absent");
  assert.match(diagnostics[0]?.reason ?? "", /target region ID/);
  assert.equal(diagnostics[1]?.code, "invalid-timing");
  assert.deepEqual(diagnostics[1]?.fields, ["region.startBeat", "region.durationBeats"]);
  assert.equal(diagnostics[2]?.code, "missing-field");
  assert.deepEqual(diagnostics[2]?.fields, ["summary"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /pitch|velocity|mf|late/);
});

test("translates the model operation shape without coercion or musical fallbacks", () => {
  const source = {
    ...add("op-1", "new"),
    ignoredBySchema: "must not escape",
    region: {
      ...region("new"),
      notes: [{ ...region("new").notes[0], ignoredBySchema: "must not escape" }],
    },
  };
  assert.deepEqual(translateScoreOperation(source), {
    id: "op-1",
    type: "add-region",
    trackId: "track-1",
    summary: "add",
    region: {
      id: "new",
      name: "new",
      startBeat: 0,
      durationBeats: 4,
      dynamics: "mf",
      articulation: "sustain",
      notes: [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1, articulation: "sustain" }],
    },
  });
  assert.deepEqual(validateScoreOperationsDetailed(score, [{ ...source, id: 7 }]).diagnostics.map(({ code, fields }) => ({ code, fields })), [
    { code: "invalid-field", fields: ["id"] },
  ]);
});