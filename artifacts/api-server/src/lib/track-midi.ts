import { findPlayableInstrument } from "./scoring-agents.ts";

/**
 * Minimal, dependency-free Standard MIDI File encoder used for handing a
 * complete instrument part to a scoring agent and for project persistence.
 * Each call produces one self-contained SMF (format 0, one musical track).
 */
type ScoreForMidi = {
  tempo: number;
};

type TrackForMidi = {
  id: string;
  name?: string;
  instrument?: string;
  midiProgram?: number;
  regions: Array<{
    startBeat: number;
    notes: Array<{
      pitch: number;
      velocity: number;
      startBeat: number;
      durationBeats: number;
    }>;
  }>;
};

const TICKS_PER_BEAT = 480;

function chunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "ascii");
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function variableLength(value: number): Buffer {
  const bytes = [Math.max(0, Math.floor(value)) & 0x7f];
  let remaining = Math.max(0, Math.floor(value)) >>> 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return Buffer.from(bytes);
}

/**
 * Encodes a single score track as a real Standard MIDI file. Times are
 * converted from score beats at 480 PPQ; invalid individual notes are omitted
 * rather than making the persisted binary malformed.
 */
export function encodeTrackMidi(score: ScoreForMidi, track: TrackForMidi): Buffer {
  const tempo = Number.isFinite(score.tempo) && score.tempo > 0 ? score.tempo : 120;
  const instrument = findPlayableInstrument(track.instrument ?? "");
  const channel = instrument?.id === "modern-drum-kit" ? 9 : 0;
  const program = instrument?.midiProgram ?? track.midiProgram ?? 0;
  const trackName = Buffer.from((track.name || track.instrument || track.id).slice(0, 120), "utf8");
  const events: Array<{ tick: number; order: number; bytes: Buffer }> = [
    {
      tick: 0,
      order: 0,
      bytes: Buffer.concat([
        Buffer.from([0xff, 0x03]),
        variableLength(trackName.length),
        trackName,
      ]),
    },
    {
      tick: 0,
      order: 1,
      bytes: Buffer.from([
        0xff, 0x51, 0x03,
        (Math.round(60_000_000 / tempo) >>> 16) & 0xff,
        (Math.round(60_000_000 / tempo) >>> 8) & 0xff,
        Math.round(60_000_000 / tempo) & 0xff,
      ]),
    },
    {
      tick: 0,
      order: 2,
      bytes: Buffer.from([0xc0 | channel, Math.max(0, Math.min(127, Math.round(program)))]),
    },
  ];

  for (const region of track.regions) {
    for (const note of region.notes) {
      if (!Number.isFinite(note.pitch) || !Number.isFinite(note.velocity) ||
        !Number.isFinite(note.startBeat) || !Number.isFinite(note.durationBeats) ||
        note.durationBeats <= 0) continue;
      const start = Math.max(0, Math.round((region.startBeat + note.startBeat) * TICKS_PER_BEAT));
      const end = Math.max(start + 1, Math.round((region.startBeat + note.startBeat + note.durationBeats) * TICKS_PER_BEAT));
      const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)));
      // Note-offs sort before note-ons at the same tick, avoiding accidental
      // overlap when adjacent notes share a pitch.
      events.push({ tick: end, order: 3, bytes: Buffer.from([0x80 | channel, pitch, 0]) });
      events.push({ tick: start, order: 4, bytes: Buffer.from([0x90 | channel, pitch, velocity]) });
    }
  }

  events.sort((left, right) => left.tick - right.tick || left.order - right.order);
  let previousTick = 0;
  const trackBody: Buffer[] = [];
  for (const event of events) {
    trackBody.push(variableLength(event.tick - previousTick), event.bytes);
    previousTick = event.tick;
  }
  trackBody.push(Buffer.from([0x00, 0xff, 0x2f, 0x00]));

  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0); // format 0
  header.writeUInt16BE(1, 2); // one track
  header.writeUInt16BE(TICKS_PER_BEAT, 4);
  return Buffer.concat([chunk("MThd", header), chunk("MTrk", Buffer.concat(trackBody))]);
}