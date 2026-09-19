import { createHash, randomUUID } from "node:crypto";
import { findPlayableInstrument } from "./scoring-agents.ts";
import { encodeTrackMidi } from "./track-midi.ts";
import { screenMusicText } from "./ai-music-safety.ts";
import { isOwnedProjectObjectPath, ObjectNotFoundError } from "./objectStorage.ts";

export const MAX_ADVISER_SUGGESTIONS = 8;
export const MAX_SUGGESTION_INSTRUCTIONS = 4;
export const MAX_SUGGESTION_INSTRUCTION_LENGTH = 2_000;
export const MAX_ADVISORY_MIDI_NOTES = 512;
export const MAX_ADVISORY_MIDI_BYTES = 1_000_000;
const MIDI_TICKS_PER_BEAT = 480;

export type AdvisoryMidiClip = {
  tempo: number;
  durationBeats: number;
  notes: Array<{
    pitch: number;
    velocity: number;
    startBeat: number;
    durationBeats: number;
  }>;
};

export type AdvisoryMidiRef = {
  id: string;
  objectPath: string;
  sha256: string;
  label: string;
  alignment: { startBeat: number; durationBeats: number };
  targets: { trackIds: string[]; instrumentIds: string[]; instruments: string[] };
};

export type MaterializedAdvisoryMidi = AdvisoryMidiClip & {
  sourceRefId: string;
};

export type AdviserSuggestion = {
  id: string;
  label: string;
  instructions: string[];
  targetTrackIds: string[];
  instrumentId?: string;
  instrumentName?: string;
  /** Server-only until materializeAdvisoryMidiClip replaces it. */
  midiClip?: AdvisoryMidiClip;
  advisoryMidiRef?: AdvisoryMidiRef;
};

type ScoreLike = {
  tempo: number;
  durationBeats: number;
  tracks: Array<{ id: string; instrument?: string; regions?: unknown[] }>;
};

export class AdviserSuggestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdviserSuggestionValidationError";
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdviserSuggestionValidationError(`${field} must be non-empty text`);
  }
  const screened = screenMusicText(value.trim(), "");
  if (!screened || screened.length > max) {
    throw new AdviserSuggestionValidationError(`${field} exceeds its bounded text limit`);
  }
  return screened;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdviserSuggestionValidationError(`${field} must be finite`);
  }
  return value;
}

/**
 * Validate and canonicalize the optional adviser extension. The prose
 * consultation remains useful when this field is absent; malformed structured
 * material fails closed instead of being silently discarded.
 */
export function normalizeAdviserSuggestions(
  value: unknown,
  score: ScoreLike,
  options: { omitInvalidOptionalMidiClip?: boolean } = {},
): AdviserSuggestion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ADVISER_SUGGESTIONS) {
    throw new AdviserSuggestionValidationError("adviser suggestions must be a bounded array");
  }
  const trackIds = new Set(score.tracks.map((track) => track.id));
  const seenIds = new Map<string, string>();
  const seenContent = new Set<string>();
  return value.flatMap((raw) => {
    const suggestion = object(raw);
    if (!suggestion) throw new AdviserSuggestionValidationError("adviser suggestion must be an object");
    const id = boundedText(suggestion.id, "suggestion id", 80);
    const label = boundedText(suggestion.label ?? suggestion.title, "suggestion label", 120);
    const rawInstructions = suggestion.instructions;
    if (!Array.isArray(rawInstructions) || rawInstructions.length === 0 || rawInstructions.length > MAX_SUGGESTION_INSTRUCTIONS) {
      throw new AdviserSuggestionValidationError("suggestion instructions must be a bounded array");
    }
    const instructions = rawInstructions.map((instruction, index) =>
      boundedText(instruction, `suggestion instruction ${index}`, MAX_SUGGESTION_INSTRUCTION_LENGTH));
    const targetTrackIds = suggestion.targetTrackIds === undefined
      ? []
      : suggestion.targetTrackIds;
    if (!Array.isArray(targetTrackIds) || targetTrackIds.length > 8 ||
      targetTrackIds.some((trackId) => typeof trackId !== "string" || !trackIds.has(trackId))) {
      throw new AdviserSuggestionValidationError("suggestion targetTrackIds must contain exact existing track ids");
    }
    const uniqueTrackIds = [...new Set(targetTrackIds as string[])];
    const instrumentInput = suggestion.instrumentId ?? suggestion.instrumentName ?? suggestion.instrument;
    let instrumentId: string | undefined;
    let instrumentName: string | undefined;
    if (instrumentInput !== undefined) {
      if (typeof instrumentInput !== "string") {
        throw new AdviserSuggestionValidationError("suggestion instrument must be a supported catalog id or name");
      }
      const playable = findPlayableInstrument(instrumentInput);
      if (!playable) throw new AdviserSuggestionValidationError("suggestion instrument is not in the supported catalog");
      instrumentId = playable.id;
      instrumentName = playable.name;
      if (suggestion.instrumentId !== undefined &&
        (suggestion.instrumentName !== undefined || suggestion.instrument !== undefined)) {
        const named = findPlayableInstrument(String(suggestion.instrumentName ?? suggestion.instrument));
        if (!named || named.id !== instrumentId) {
          throw new AdviserSuggestionValidationError("suggestion instrument id and name do not identify the same catalog instrument");
        }
      }
    }
    if (!uniqueTrackIds.length && !instrumentId) {
      throw new AdviserSuggestionValidationError("suggestion must target a track or supported instrument");
    }
    let midiClip: AdvisoryMidiClip | undefined;
    if (suggestion.midiClip !== undefined) {
      try {
        midiClip = validateAdvisoryMidiClip(suggestion.midiClip, score);
      } catch (error) {
        if (!(error instanceof AdviserSuggestionValidationError) || !options.omitInvalidOptionalMidiClip) {
          throw error;
        }
        // Advisory MIDI is optional and grants no score capability. Invalid
        // reference material is omitted rather than repaired or persisted;
        // the independently valid prose suggestion remains usable.
      }
    }
    // A clip is intentionally left as a validated payload here. It is only
    // encoded by persistAdvisoryMidiClip, never applied as score operations.
    const identity = JSON.stringify([id, label, uniqueTrackIds, instrumentId, instructions, midiClip]);
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      if (previous === identity) return [];
      throw new AdviserSuggestionValidationError("adviser suggestion ids must be stable and unique");
    }
    seenIds.set(id, identity);
    if (seenContent.has(identity)) return [];
    seenContent.add(identity);
    return [{
      id,
      label,
      instructions,
      targetTrackIds: uniqueTrackIds,
      ...(instrumentId ? { instrumentId, instrumentName } : {}),
      ...(midiClip !== undefined ? { midiClip: midiClip as AdvisoryMidiClip } : {}),
    }];
  });
}

export function validateAdvisoryMidiClip(value: unknown, score: Pick<ScoreLike, "tempo" | "durationBeats">): AdvisoryMidiClip {
  const clip = object(value);
  if (!clip) throw new AdviserSuggestionValidationError("advisory MIDI clip must be an object");
  const tempo = finite(clip.tempo, "MIDI clip tempo");
  const rawDurationBeats = clip.durationBeats ??
    (clip.durationMs !== undefined
      ? finite(clip.durationMs, "MIDI clip durationMs") * tempo / 60_000
      : undefined);
  const durationBeats = finite(rawDurationBeats, "MIDI clip durationBeats");
  if (tempo < 30 || tempo > 300 || durationBeats <= 0 || durationBeats > score.durationBeats || durationBeats > 512) {
    throw new AdviserSuggestionValidationError("advisory MIDI clip timing or tempo is outside bounds");
  }
  if (!Array.isArray(clip.notes) || clip.notes.length === 0 || clip.notes.length > MAX_ADVISORY_MIDI_NOTES) {
    throw new AdviserSuggestionValidationError("advisory MIDI clip notes are outside bounds");
  }
  const notes = clip.notes.map((raw, index) => {
    const note = object(raw);
    if (!note) throw new AdviserSuggestionValidationError(`advisory MIDI note ${index} is malformed`);
    const pitch = finite(note.pitch ?? note.note, `MIDI note ${index} pitch`);
    const velocity = finite(note.velocity, `MIDI note ${index} velocity`);
    const startBeat = note.startBeat !== undefined
      ? finite(note.startBeat, `MIDI note ${index} startBeat`)
      : finite(note.startMs, `MIDI note ${index} startMs`) * tempo / 60_000;
    const noteDuration = note.durationBeats !== undefined
      ? finite(note.durationBeats, `MIDI note ${index} durationBeats`)
      : finite(note.durationMs, `MIDI note ${index} durationMs`) * tempo / 60_000;
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127 ||
      !Number.isInteger(velocity) || velocity < 1 || velocity > 127 ||
      startBeat < 0 || noteDuration <= 0 || startBeat + noteDuration > durationBeats) {
      throw new AdviserSuggestionValidationError(`advisory MIDI note ${index} timing, pitch, or velocity is invalid`);
    }
    return { pitch, velocity, startBeat, durationBeats: noteDuration };
  });
  return { tempo, durationBeats, notes };
}

export function validateAdvisoryMidiRef(value: unknown): AdvisoryMidiRef {
  const ref = object(value);
  if (!ref || typeof ref.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref.id) ||
    typeof ref.objectPath !== "string" || !ref.objectPath || ref.objectPath.length > 1_500 ||
    !/^\/objects\/projects\/[A-Za-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.objectPath) ||
    typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    typeof ref.label !== "string" || !ref.label) {
    throw new AdviserSuggestionValidationError("advisory MIDI reference is malformed");
  }
  const alignment = object(ref.alignment);
  const targets = object(ref.targets);
  const alignmentStart = alignment && typeof alignment.startBeat === "number" ? alignment.startBeat : NaN;
  const alignmentDuration = alignment && typeof alignment.durationBeats === "number" ? alignment.durationBeats : NaN;
  if (!alignment || !Number.isFinite(alignmentStart) || !Number.isFinite(alignmentDuration) ||
    alignmentStart < 0 || alignmentStart > 512 || alignmentDuration <= 0 || alignmentDuration > 512 ||
    !targets || !Array.isArray(targets.trackIds) || !Array.isArray(targets.instrumentIds) ||
    !Array.isArray(targets.instruments) ||
    targets.trackIds.length > 8 || targets.instrumentIds.length > 2 || targets.instruments.length > 2 ||
    targets.trackIds.some((item) => typeof item === "string" && item.length > 400) ||
    targets.instrumentIds.some((item) => typeof item === "string" && item.length > 400) ||
    targets.instruments.some((item) => typeof item === "string" && item.length > 600) ||
    [...targets.trackIds, ...targets.instrumentIds, ...targets.instruments].some((item) => typeof item !== "string" || !item)) {
    throw new AdviserSuggestionValidationError("advisory MIDI reference alignment or targets are malformed");
  }
  const canonicalInstruments = targets.instrumentIds.map((id) => findPlayableInstrument(id));
  const canonicalNames = targets.instruments.map((name) => findPlayableInstrument(name));
  if (canonicalInstruments.some((instrument) => !instrument) ||
    canonicalNames.some((instrument) => !instrument) ||
    (canonicalInstruments.length > 0 && canonicalNames.length > 0 &&
      canonicalInstruments.length !== canonicalNames.length) ||
    canonicalInstruments.some((instrument, index) =>
      Boolean(canonicalNames[index]) && canonicalNames[index]!.id !== instrument!.id)) {
    throw new AdviserSuggestionValidationError("advisory MIDI reference has unsupported or mismatched target instruments");
  }
  return {
    id: ref.id,
    objectPath: ref.objectPath,
    sha256: ref.sha256,
    label: boundedText(ref.label, "advisory MIDI reference label", 120),
    alignment: {
      startBeat: alignmentStart,
      durationBeats: alignmentDuration,
    },
    targets: {
      trackIds: targets.trackIds.filter((id): id is string => typeof id === "string"),
      instrumentIds: targets.instrumentIds as string[],
      instruments: targets.instruments as string[],
    },
  };
}

function readUInt32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new AdviserSuggestionValidationError("advisory MIDI object is truncated");
  return bytes.readUInt32BE(offset);
}

function readVarLen(bytes: Buffer, state: { offset: number }): number {
  let value = 0;
  for (let count = 0; count < 4; count += 1) {
    if (state.offset >= bytes.length) throw new AdviserSuggestionValidationError("advisory MIDI object has a truncated timing value");
    const byte = bytes[state.offset++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new AdviserSuggestionValidationError("advisory MIDI timing value is too large");
}

/** Parse only the bounded SMF subset emitted by encodeTrackMidi. */
export function parseAdvisoryMidi(bytes: Buffer, refId = "advisory"): MaterializedAdvisoryMidi {
  if (bytes.length < 22 || bytes.length > MAX_ADVISORY_MIDI_BYTES ||
    bytes.toString("ascii", 0, 4) !== "MThd") {
    throw new AdviserSuggestionValidationError("advisory MIDI object is not a bounded Standard MIDI File");
  }
  const headerLength = readUInt32(bytes, 4);
  if (headerLength < 6 || 8 + headerLength > bytes.length) throw new AdviserSuggestionValidationError("advisory MIDI header is malformed");
  const format = bytes.readUInt16BE(8);
  const trackCount = bytes.readUInt16BE(10);
  const division = bytes.readUInt16BE(12);
  if (format > 1 || trackCount < 1 || trackCount > 2 || division !== MIDI_TICKS_PER_BEAT ||
    bytes.toString("ascii", 8 + headerLength, 12 + headerLength) !== "MTrk") {
    throw new AdviserSuggestionValidationError("advisory MIDI header uses unsupported timing or track layout");
  }
  const trackOffset = 8 + headerLength;
  const trackLength = readUInt32(bytes, trackOffset + 4);
  const start = trackOffset + 8;
  const end = start + trackLength;
  if (end > bytes.length) throw new AdviserSuggestionValidationError("advisory MIDI track is truncated");
  const state = { offset: start };
  const active = new Map<string, { pitch: number; velocity: number; tick: number }[]>();
  const notes: AdvisoryMidiClip["notes"] = [];
  let tick = 0;
  let tempo = 120;
  while (state.offset < end) {
    tick += readVarLen(bytes, state);
    if (state.offset >= end) throw new AdviserSuggestionValidationError("advisory MIDI event is truncated");
    let status = bytes[state.offset++];
    if (status < 0x80) {
      // Running status is intentionally unsupported for a bounded, server
      // generated object; accepting it would broaden the parser surface.
      throw new AdviserSuggestionValidationError("advisory MIDI running status is unsupported");
    }
    if (status === 0xff) {
      if (state.offset >= end) throw new AdviserSuggestionValidationError("advisory MIDI meta event is truncated");
      const meta = bytes[state.offset++];
      const length = readVarLen(bytes, state);
      if (state.offset + length > end) throw new AdviserSuggestionValidationError("advisory MIDI meta event exceeds track bounds");
      if (meta === 0x51 && length === 3) {
        const micros = (bytes[state.offset] << 16) | (bytes[state.offset + 1] << 8) | bytes[state.offset + 2];
        if (micros > 0) tempo = Math.round(60_000_000 / micros);
      }
      state.offset += length;
      if (meta === 0x2f) break;
      continue;
    }
    const kind = status & 0xf0;
    if (kind === 0xc0 || kind === 0xd0) {
      if (state.offset >= end) throw new AdviserSuggestionValidationError("advisory MIDI channel event is truncated");
      state.offset += 1;
      continue;
    }
    if (state.offset + 2 > end || (kind !== 0x80 && kind !== 0x90 && kind !== 0xa0 && kind !== 0xb0 && kind !== 0xe0)) {
      throw new AdviserSuggestionValidationError("advisory MIDI contains an unsupported channel event");
    }
    const pitch = bytes[state.offset++];
    const value = bytes[state.offset++];
    if (kind === 0x90 && value > 0) {
      const key = `${status & 0x0f}:${pitch}`;
      const queue = active.get(key) ?? [];
      queue.push({ pitch, velocity: value, tick });
      active.set(key, queue);
    } else if (kind === 0x80 || (kind === 0x90 && value === 0)) {
      const key = `${status & 0x0f}:${pitch}`;
      const queue = active.get(key);
      const started = queue?.shift();
      if (!started || tick <= started.tick) throw new AdviserSuggestionValidationError("advisory MIDI note timing is malformed");
      notes.push({
        pitch: started.pitch,
        velocity: started.velocity,
        startBeat: started.tick / MIDI_TICKS_PER_BEAT,
        durationBeats: (tick - started.tick) / MIDI_TICKS_PER_BEAT,
      });
      if (notes.length > MAX_ADVISORY_MIDI_NOTES) throw new AdviserSuggestionValidationError("advisory MIDI contains too many notes");
    }
  }
  if ([...active.values()].some((queue) => queue.length > 0)) {
    throw new AdviserSuggestionValidationError("advisory MIDI contains an unterminated note");
  }
  if (!notes.length) throw new AdviserSuggestionValidationError("advisory MIDI contains no notes");
  const durationBeats = Math.max(...notes.map((note) => note.startBeat + note.durationBeats));
  if (!Number.isFinite(durationBeats) || durationBeats <= 0 || durationBeats > 512 || tempo < 30 || tempo > 300) {
    throw new AdviserSuggestionValidationError("advisory MIDI timing or tempo is outside bounds");
  }
  return { sourceRefId: refId, tempo, durationBeats, notes };
}

export type AdvisoryMidiStorage = {
  trackMidiObjectPath(ownerId: string, projectId: string, objectId?: string): string;
  upload(objectPath: string, bytes: Buffer, contentType: string): Promise<void>;
  getFile?: (objectPath: string) => Promise<unknown>;
  download?: (file: unknown) => Promise<Response>;
};

export async function loadAdvisoryMidiRef(input: {
  ownerId: string;
  projectId: string;
  ref: AdvisoryMidiRef;
  storage: Pick<AdvisoryMidiStorage, "getFile" | "download">;
}): Promise<MaterializedAdvisoryMidi> {
  const ref = validateAdvisoryMidiRef(input.ref);
  if (!isOwnedProjectObjectPath(ref.objectPath, input.ownerId, input.projectId)) {
    throw new AdviserSuggestionValidationError("advisory MIDI object is outside the authenticated project");
  }
  if (!input.storage.getFile || !input.storage.download) {
    throw new AdviserSuggestionValidationError("advisory MIDI object storage loader is unavailable");
  }
  let file: unknown;
  try {
    file = await input.storage.getFile(ref.objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new AdviserSuggestionValidationError("advisory MIDI object no longer exists");
    }
    throw new AdviserSuggestionValidationError("advisory MIDI object could not be opened");
  }
  const response = await input.storage.download(file);
  if (!response.ok) throw new AdviserSuggestionValidationError("advisory MIDI object could not be downloaded");
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== ref.sha256) throw new AdviserSuggestionValidationError("advisory MIDI object hash did not match its signed reference");
  return parseAdvisoryMidi(bytes, ref.id);
}

/**
 * Persist an advisory clip as a private project object. The returned ref is
 * opaque to clients and is not a score track or a score operation.
 */
export async function persistAdvisoryMidiClip(input: {
  ownerId: string;
  projectId: string;
  suggestion: AdviserSuggestion;
  clip: unknown;
  score: ScoreLike;
  storage: AdvisoryMidiStorage;
}): Promise<AdvisoryMidiRef> {
  const clip = validateAdvisoryMidiClip(input.clip, input.score);
  const targetTrack = input.score.tracks.find((track) => input.suggestion.targetTrackIds.includes(track.id));
  const playable = findPlayableInstrument(input.suggestion.instrumentId ?? targetTrack?.instrument ?? "");
  const bytes = encodeTrackMidi(
    { tempo: clip.tempo },
    {
      id: `advisory-${input.suggestion.id}`,
      name: input.suggestion.label,
      instrument: playable?.name,
      midiProgram: playable?.midiProgram,
      regions: [{ startBeat: 0, notes: clip.notes }],
    },
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = randomUUID();
  const objectPath = input.storage.trackMidiObjectPath(input.ownerId, input.projectId, id);
  await input.storage.upload(objectPath, bytes, "audio/midi");
  return {
    id,
    objectPath,
    sha256,
    label: input.suggestion.label,
    alignment: { startBeat: 0, durationBeats: clip.durationBeats },
    targets: {
      trackIds: [...input.suggestion.targetTrackIds],
      instrumentIds: input.suggestion.instrumentId ? [input.suggestion.instrumentId] : [],
      instruments: input.suggestion.instrumentName ? [input.suggestion.instrumentName] : [],
    },
  };
}