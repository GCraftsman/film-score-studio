import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  AdviserSuggestionValidationError,
  loadAdvisoryMidiRef,
  normalizeAdviserSuggestions,
  parseAdvisoryMidi,
  persistAdvisoryMidiClip,
  validateAdvisoryMidiRef,
  type AdviserSuggestion,
} from "./adviser-suggestions.ts";
import { ObjectNotFoundError } from "./objectStorage.ts";

const ownerId = "user_test";
const projectId = "11111111-1111-4111-8111-111111111111";
const score = {
  tempo: 120,
  durationBeats: 16,
  tracks: [{ id: "strings", instrument: "Violin", regions: [] }],
};

function storage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    trackMidiObjectPath(owner: string, project: string, id = "22222222-2222-4222-8222-222222222222") {
      return `/objects/projects/${owner}/${project}/${id}`;
    },
    async upload(path: string, bytes: Buffer) {
      objects.set(path, Buffer.from(bytes));
    },
    async getFile(path: string) {
      if (!objects.has(path)) throw new ObjectNotFoundError();
      return path;
    },
    async download(file: unknown) {
      return new Response(objects.get(String(file))!);
    },
  };
}

function suggestion(): AdviserSuggestion {
  return {
    id: "strings-idea",
    label: "Bowed entrance",
    instructions: ["Use a restrained rising phrase in the upper register."],
    targetTrackIds: ["strings"],
    instrumentId: "violin",
    instrumentName: "Violin",
  };
}

test("adviser clips become real SMF bytes and load only from their signed owner/project", async () => {
  const objectStorage = storage();
  const ref = await persistAdvisoryMidiClip({
    ownerId,
    projectId,
    suggestion: suggestion(),
    clip: {
      tempo: 120,
      durationBeats: 2,
      notes: [{ pitch: 60, velocity: 90, startBeat: 0, durationBeats: 1 }],
    },
    score,
    storage: objectStorage,
  });
  const bytes = objectStorage.objects.get(ref.objectPath)!;
  assert.equal(bytes.toString("ascii", 0, 4), "MThd");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256);
  const loaded = await loadAdvisoryMidiRef({
    ownerId,
    projectId,
    ref,
    storage: objectStorage,
  });
  assert.equal(loaded.sourceRefId, ref.id);
  assert.equal(loaded.notes[0].pitch, 60);
  assert.equal(parseAdvisoryMidi(bytes).notes.length, 1);
});

test("adviser clips reject empty or malformed notes before any persistence", () => {
  assert.throws(() => normalizeAdviserSuggestions([{
    ...suggestion(),
    midiClip: { tempo: 120, durationBeats: 2, notes: [] },
  }], score), AdviserSuggestionValidationError);
  assert.throws(() => normalizeAdviserSuggestions([{
    ...suggestion(),
    midiClip: { tempo: 120, durationBeats: 2, notes: [{ pitch: 200, velocity: 90, startBeat: 0, durationBeats: 1 }] },
  }], score), AdviserSuggestionValidationError);
  const proseOnly = normalizeAdviserSuggestions([{
    ...suggestion(),
    midiClip: { tempo: 120, durationBeats: 2, notes: [{ pitch: 200, velocity: 90, startBeat: 0, durationBeats: 1 }] },
  }], score, { omitInvalidOptionalMidiClip: true });
  assert.equal(proseOnly.length, 1);
  assert.equal(proseOnly[0].midiClip, undefined);
});

test("adviser object loading denies project escape and hash mismatch", async () => {
  const objectStorage = storage();
  const ref = await persistAdvisoryMidiClip({
    ownerId,
    projectId,
    suggestion: suggestion(),
    clip: { tempo: 120, durationBeats: 2, notes: [{ pitch: 60, velocity: 90, startBeat: 0, durationBeats: 1 }] },
    score,
    storage: objectStorage,
  });
  await assert.rejects(() => loadAdvisoryMidiRef({
    ownerId: "user_other",
    projectId,
    ref,
    storage: objectStorage,
  }), AdviserSuggestionValidationError);
  await assert.rejects(() => loadAdvisoryMidiRef({
    ownerId,
    projectId,
    ref: { ...ref, sha256: "0".repeat(64) },
    storage: objectStorage,
  }), AdviserSuggestionValidationError);
  await assert.rejects(() => loadAdvisoryMidiRef({
    ownerId,
    projectId,
    ref: { ...ref, objectPath: "/objects/projects/user_other/" + projectId + "/22222222-2222-4222-8222-222222222222" },
    storage: objectStorage,
  }), AdviserSuggestionValidationError);
  const missing = storage();
  await assert.rejects(() => loadAdvisoryMidiRef({
    ownerId,
    projectId,
    ref,
    storage: missing,
  }), AdviserSuggestionValidationError);
  const badHttp = storage();
  const originalDownload = badHttp.download;
  badHttp.download = async () => new Response(null, { status: 503 });
  const persisted = await persistAdvisoryMidiClip({
    ownerId,
    projectId,
    suggestion: suggestion(),
    clip: { tempo: 120, durationBeats: 2, notes: [{ pitch: 60, velocity: 90, startBeat: 0, durationBeats: 1 }] },
    score,
    storage: badHttp,
  });
  await assert.rejects(() => loadAdvisoryMidiRef({
    ownerId,
    projectId,
    ref: persisted,
    storage: badHttp,
  }), AdviserSuggestionValidationError);
  badHttp.download = originalDownload;
});

test("advisory refs enforce UUID, bounded lengths, canonical targets, and array limits", () => {
  const valid = {
    id: "not-a-uuid",
    objectPath: `/objects/projects/${ownerId}/${projectId}/22222222-2222-4222-8222-222222222222`,
    sha256: "0".repeat(64),
    label: "x",
    alignment: { startBeat: 0, durationBeats: 1 },
    targets: { trackIds: ["strings"], instrumentIds: ["not-catalog"], instruments: [] },
  };
  for (const ref of [
    valid,
    { ...valid, id: "22222222-2222-4222-8222-222222222222", objectPath: `${valid.objectPath}${"x".repeat(301)}` },
    { ...valid, id: "22222222-2222-4222-8222-222222222222", targets: { ...valid.targets, trackIds: Array.from({ length: 9 }, () => "strings") } },
    { ...valid, id: "22222222-2222-4222-8222-222222222222", targets: { trackIds: ["strings"], instrumentIds: ["violin"], instruments: ["Flute"] } },
  ]) {
    assert.throws(() => validateAdvisoryMidiRef(ref), AdviserSuggestionValidationError);
  }
});