import assert from "node:assert/strict";
import test from "node:test";
import {
  findPlayableInstrument,
  fullMidiMaterial,
  getAgentRoster,
  getInstrumentAgents,
  instrumentAgentForTrack,
  midiMillisecondsToBeats,
  PLAYABLE_INSTRUMENTS,
} from "./scoring-agents.ts";

test("converts source MIDI milliseconds using the source BPM", () => {
  assert.equal(midiMillisecondsToBeats(500, 120), 1);
  assert.equal(midiMillisecondsToBeats(250, 60), 0.25);
});

test("creates instrument specialists only for supported actual tracks", () => {
  const tracks = [
    { id: "track-a", instrument: "Bass Clarinet", role: "woodwinds" },
    { id: "track-b", instrument: "Piano", role: "keyboards" },
  ];
  assert.deepEqual(getInstrumentAgents(tracks).map((agent) => agent.agent), ["Upright Piano"]);
  assert.equal(instrumentAgentForTrack(tracks[0]), undefined);
  assert.equal(instrumentAgentForTrack(tracks[1]), "Upright Piano");
  assert.doesNotMatch(getAgentRoster(tracks), /Bass Clarinet/);
  assert.match(getAgentRoster(tracks), /Upright Piano \(instrument, track track-b\)/);
});

test("catalogues only browser-playable proposal instruments", () => {
  assert.equal(findPlayableInstrument("Piano")?.name, "Upright Piano");
  assert.equal(findPlayableInstrument("String Ensemble")?.midiProgram, 48);
  assert.equal(findPlayableInstrument("violin")?.midiProgram, 40);
  assert.equal(findPlayableInstrument(89)?.id, "synth-pad");
  assert.equal(findPlayableInstrument("Bass Clarinet"), undefined);
  assert.equal(findPlayableInstrument("Digital Pluck"), undefined);
  assert.equal(findPlayableInstrument(118), undefined);
});

test("keeps the drum bank/program distinct from melodic program zero", () => {
  const piano = findPlayableInstrument("Piano");
  assert.deepEqual(piano?.soundfont, {
    bankId: "upright-piano-kw",
    bank: 128,
    program: 0,
  });
  const drums = findPlayableInstrument("modern-drum-kit");
  assert.equal(drums?.midiProgram, 0);
  assert.equal(drums?.soundfont.bank, 128);
  assert.equal(drums?.soundfont.program, 0);
  assert.equal(drums?.soundfont.isDrum, true);
});

test("retains exactly the licensed catalog entries", () => {
  const ids = [
    "piano", "string-ensemble", "violin", "cello", "french-horn", "trombone", "flute", "timpani",
    "synth-bass", "synth-lead", "synth-pad", "electric-keys", "electric-bass",
    "modern-drum-kit",
  ];
  assert.deepEqual(PLAYABLE_INSTRUMENTS.map((instrument) => instrument.id), ids);
});

test("serializes every MIDI event beyond the old thousand-note summary cap", () => {
  const notes = Array.from({ length: 1_001 }, (_, index) => ({
    note: 36 + (index % 48),
    velocity: 40 + (index % 80),
    startMs: index * 10,
    durationMs: 10,
  }));
  const snippet = {
    id: "long-take",
    tempo: 120,
    durationMs: 10_010,
    notes,
  };
  const material = JSON.parse(fullMidiMaterial([snippet])) as Array<{ notes: Array<{ note: number; startMs: number }> }>;
  assert.equal(material[0].notes.length, 1_001);
  assert.equal(material[0].notes[1_000].startMs, 10_000);
});