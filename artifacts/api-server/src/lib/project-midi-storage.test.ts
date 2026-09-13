import assert from "node:assert/strict";
import test from "node:test";
import { isOwnedProjectObjectPath, ObjectNotFoundError } from "./objectStorage.ts";
import {
  PROJECT_MIDI_METADATA_KEY,
  persistProjectMidiFiles,
  readProjectMidiMetadata,
  withProjectMidiMetadata,
} from "./project-midi-storage.ts";

const document = (tracks: unknown[]) => ({
  score: { tempo: 96, durationBeats: 64, tracks },
  scoreRevision: 1,
  messages: [],
  undoStack: [],
});

function track(id: string, regions: unknown[] = []) {
  return { id, name: id, instrument: id, midiProgram: 0, regions };
}

function fakeStorage() {
  const files = new Set<string>();
  const uploads: Array<{ path: string; bytes: Buffer }> = [];
  let nextId = 1;
  return {
    files,
    uploads,
    trackMidiObjectPath: (_owner: string, _project: string) => `/objects/projects/user_a/11111111-1111-1111-1111-111111111111/${String(nextId++).padStart(8, "0")}-0000-0000-0000-000000000000`,
    async upload(path: string, bytes: Buffer) {
      files.add(path);
      uploads.push({ path, bytes });
    },
    async getFile(path: string) {
      if (!files.has(path)) throw new ObjectNotFoundError();
      return {};
    },
  };
}

test("persists a separate MIDI object for every track, including empty tracks", async () => {
  const storage = fakeStorage();
  const metadata = await persistProjectMidiFiles({
    document: document([
      track("empty"),
      track("notes", [{
        startBeat: 0,
        notes: [{ pitch: 60, velocity: 90, startBeat: 0, durationBeats: 1 }],
      }]),
    ]),
    ownerId: "user_a",
    projectId: "11111111-1111-1111-1111-111111111111",
    storage,
  });

  assert.deepEqual(Object.keys(metadata).sort(), ["empty", "notes"]);
  assert.equal(storage.uploads.length, 2);
  assert.notEqual(metadata.empty.objectPath, metadata.notes.objectPath);
  assert.ok(storage.uploads.every(({ bytes }) => bytes.subarray(0, 4).toString("ascii") === "MThd"));
});

test("reuses an existing same-hash object only within the owner and project scope", async () => {
  const firstStorage = fakeStorage();
  const firstDocument = document([track("piano")]);
  const firstMetadata = await persistProjectMidiFiles({
    document: firstDocument,
    ownerId: "user_a",
    projectId: "11111111-1111-1111-1111-111111111111",
    storage: firstStorage,
  });
  assert.equal(isOwnedProjectObjectPath(
    firstMetadata.piano.objectPath,
    "user_a",
    "11111111-1111-1111-1111-111111111111",
  ), true);
  assert.equal(isOwnedProjectObjectPath(
    firstMetadata.piano.objectPath,
    "user_b",
    "11111111-1111-1111-1111-111111111111",
  ), false);
  assert.equal(isOwnedProjectObjectPath(
    firstMetadata.piano.objectPath,
    "user_a",
    "22222222-2222-2222-2222-222222222222",
  ), false);
  const secondStorage = fakeStorage();
  for (const path of Object.values(firstMetadata).map((entry) => entry.objectPath)) secondStorage.files.add(path);
  const secondMetadata = await persistProjectMidiFiles({
    document: withProjectMidiMetadata(firstDocument, firstMetadata),
    previousDocument: withProjectMidiMetadata(firstDocument, firstMetadata),
    ownerId: "user_a",
    projectId: "11111111-1111-1111-1111-111111111111",
    storage: secondStorage,
  });
  assert.deepEqual(secondMetadata, firstMetadata);
  assert.equal(secondStorage.uploads.length, 0);

  const foreignMetadata = {
    ...firstMetadata,
    piano: {
      ...firstMetadata.piano,
      objectPath: firstMetadata.piano.objectPath.replace("/user_a/", "/user_b/"),
    },
  };
  const foreignStorage = fakeStorage();
  const foreign = await persistProjectMidiFiles({
    document: firstDocument,
    previousDocument: withProjectMidiMetadata(firstDocument, foreignMetadata),
    ownerId: "user_a",
    projectId: "11111111-1111-1111-1111-111111111111",
    storage: foreignStorage,
  });
  assert.equal(foreignStorage.uploads.length, 1);
  assert.notEqual(foreign.piano.objectPath, foreignMetadata.piano.objectPath);
});

test("metadata helper preserves future document fields", () => {
  const original = { ...document([]), futureField: { enabled: true } };
  const next = withProjectMidiMetadata(original, {});
  assert.deepEqual(next.futureField, original.futureField);
  assert.deepEqual(readProjectMidiMetadata(next), {});
  assert.ok(PROJECT_MIDI_METADATA_KEY in next);
});