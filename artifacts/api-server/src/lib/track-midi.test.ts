import assert from "node:assert/strict";
import test from "node:test";
import { encodeTrackMidi } from "./track-midi.ts";

test("encodes one instrument track as a standalone Standard MIDI file", () => {
  const midi = encodeTrackMidi(
    { tempo: 120 },
    {
      id: "piano", name: "Piano", midiProgram: 0,
      regions: [{
        startBeat: 0,
        notes: [{ pitch: 60, velocity: 90, startBeat: 0, durationBeats: 1 }],
      }],
    },
  );
  assert.equal(midi.subarray(0, 4).toString("ascii"), "MThd");
  assert.equal(midi.readUInt16BE(8), 0);
  assert.equal(midi.readUInt16BE(10), 1);
  assert.equal(midi.subarray(14, 18).toString("ascii"), "MTrk");
  assert.ok(midi.includes(Buffer.from([0x90, 60, 90])));
  assert.ok(midi.includes(Buffer.from([0x80, 60, 0])));
});

test("uses a MIDI variable-length text length for long UTF-8 track names", () => {
  const midi = encodeTrackMidi(
    { tempo: 120 },
    { id: "long", name: "é".repeat(80), regions: [] },
  );
  const nameEvent = midi.indexOf(Buffer.from([0xff, 0x03]));
  assert.ok(nameEvent >= 0);
  // 80 × two-byte UTF-8 characters = 160, encoded as VLQ 0x81 0x20.
  assert.deepEqual([...midi.subarray(nameEvent + 2, nameEvent + 4)], [0x81, 0x20]);
});

test("exports drum-kit notes on General MIDI channel 10 with separate drum keys", () => {
  const midi = encodeTrackMidi({ tempo: 96 }, {
    id: "drums", instrument: "modern-drum-kit", midiProgram: 118,
    regions: [{ startBeat: 0, notes: [
      { pitch: 36, velocity: 100, startBeat: 0, durationBeats: 0.25 },
      { pitch: 38, velocity: 80, startBeat: 1, durationBeats: 0.25 },
    ] }],
  });
  assert.ok(midi.includes(Buffer.from([0xc9, 0])));
  assert.ok(midi.includes(Buffer.from([0x99, 36, 100])));
  assert.ok(midi.includes(Buffer.from([0x99, 38, 80])));
  assert.ok(midi.includes(Buffer.from([0x89, 36, 0])));
  assert.equal(midi.includes(Buffer.from([0x90, 36, 100])), false);
});