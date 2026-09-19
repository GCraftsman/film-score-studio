import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  AI_MUSIC_SAFETY_POLICY,
  screenMusicText,
} from "../../../artifacts/api-server/src/lib/ai-music-safety.ts";
import {
  CHAT_MAX_ATTEMPTS,
  parseRetryAfter,
  providerRequestTimeoutMs,
  retryDelayMs,
  xaiLaunchLimiter,
} from "../../../artifacts/api-server/src/lib/chat-limiter.ts";
import {
  candidateRevision,
  runCompositionWorkflow,
  semanticMidiFingerprint,
  type ModelMessage,
  type ScoreValue,
  type WorkflowModel,
} from "../../../artifacts/api-server/src/lib/composition-workflow.ts";
import {
  normalizeAdviserSuggestions,
  type AdviserSuggestion,
  type AdvisoryMidiClip,
  type MaterializedAdvisoryMidi,
  type AdvisoryMidiRef,
} from "../../../artifacts/api-server/src/lib/adviser-suggestions.ts";
import {
  findPlayableInstrument,
  fullMidiMaterial,
  playableInstrumentCatalogPrompt,
} from "../../../artifacts/api-server/src/lib/scoring-agents.ts";
import { encodeTrackMidi } from "../../../artifacts/api-server/src/lib/track-midi.ts";
import { validateScoreOperations } from "../../../artifacts/api-server/src/lib/score-operations.ts";
import {
  safeProviderMetadata,
  throwForCompletionFailure,
  type ModelCompletion,
  type ProviderCompletionMetadata,
} from "../../../artifacts/api-server/src/lib/model-diagnostics.ts";

/**
 * This directory is an experiment-only copy/adapter. It is deliberately not
 * imported by the compose route and never receives a saved project or project
 * identifier. The current arm calls the existing adviser-first workflow; the
 * consolidated arm is implemented below so the production workflow remains
 * unchanged.
 */

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "baseline.json");
const lockPath = join(here, "run-lock.json");
const outcomePath = join(here, "outcome.json");
const callsPath = join(here, "call-metrics.json");
const currentEventsPath = join(here, "events-current.json");
const orchestratorEventsPath = join(here, "events-orchestrator.json");
const currentCandidatePath = join(here, "candidate-current.json");
const orchestratorCandidatePath = join(here, "candidate-orchestrator.json");
const currentApprovedPath = join(here, "approved-current.json");
const orchestratorApprovedPath = join(here, "approved-orchestrator.json");
const reportPath = join(here, "report.md");
const midiPath = join(here, "midi");
const privateMidiPath = join(here, "private-midi");
const sourceFreezePath = join(here, "source-freeze.json");
const sourceSnapshotPath = join(here, "experiment.executed.ts");
const skillDirectory = join(here, "skills");
const offlineFixturePath = join(here, "offline-fixture.json");
const productionHashesPath = join(here, "production-module-hashes.json");

const BAR_BEATS = 4;
const INTRO_BARS = 64;
const INTRO_BEATS = BAR_BEATS * INTRO_BARS;
const TEMPO = 72;
const MAX_REGION_BEATS = 128;
const MAX_NOTES_PER_REGION = 512;
const MAX_OPERATIONS = 60;
const LARGE_CONTEXT_COMPLETION_TOKENS = 16_000;
/**
 * These strings intentionally mirror the production constants in
 * composition-workflow.ts. The final adapter sends both to score-writing
 * instrument agents instead of the prior abbreviated "canonical operation
 * objects" wording.
 */
const PRODUCTION_IMPORTANT_AGENT_CHECKLIST = `
IMPORTANT — BEFORE RESPONDING, verify every applicable constraint below. Do not print this checklist or claim validation substitutes for server verification.
1. Follow the composer's requested scope, complete source MIDI, selected style, assigned instruction, and any refinement feedback. Preserve source performance and actionable constraints; do not silently shorten, omit, or replace them.
2. Respect your role: advisers may inspect all tracks but cannot write executable score edits or membership changes. Instrument writers edit ONLY their assigned track. Only Orchestrator coordinates writers and requests explicit approval for adding/removing tracks. Never treat advice as approval.
3. Use original neutral musical language, not named references, quoted titles, or imitation requests. Use supported catalog instruments and achievable techniques; explicitly map creative timbres to supported instruments.
4. Return exactly the requested JSON contract with all required fields, correct types, allowed enum values, valid IDs and targets, bounded arrays and strings, and no forbidden fields. Finish the entire response; never return partial MIDI or placeholder/no-op edits.
5. If returning MIDI, verify ALL notes and regions: finite timing, valid integer pitch/velocity, valid dynamics/articulation, correct beat coordinate system, allowed counts, duration containment, track ownership, and exact existing removal targets. Check every event, not just the first. Ensure requested playable additions contain real playable material.
6. During structural repair preserve musical content exactly. Only an explicitly authorized bounded musical regeneration may change invalid musical content; preserve valid siblings and immutable review decisions. Never hide a failed constraint by dropping an operation.
`;
const PRODUCTION_OPERATION_JSON_SCHEMA = `When your response contains an "operations" field, it MUST be an array. Every array item MUST exactly be one of:
{"id":"unique-operation-id","type":"add-region","trackId":"existing-track-id","summary":"original edit","region":{"id":"unique-region-id","name":"original cue region","startBeat":0,"durationBeats":4,"dynamics":"mf","articulation":"sustain","notes":[{"pitch":60,"velocity":80,"startBeat":0,"durationBeats":1,"articulation":"sustain"}]}}
or {"id":"existing-operation-id","type":"remove-region","trackId":"existing-track-id","regionId":"existing-region-id","summary":"original edit"}.
Every operation "id" is mandatory, and every add-region "region.id" is mandatory. Use non-empty unique IDs within this response; never omit, reuse, or write placeholder values such as "optional-operation-id" or "optional-new-region-id". IDs are metadata, not musical identity, so repairing a duplicate or placeholder ID means replacing only that ID with a fresh unique ID while preserving the operation's type, target, region, and notes. Remove-region always requires the exact provided existing trackId and regionId; never invent, rename, or substitute a target.
Every operation summary is required, must be a non-empty string, and must be no longer than 1200 characters. This is a structural contract, not prose: do not use edits, changes, addRegion, removeRegion, or any envelope other than operations. Never invent music, notes, targets, or fallback edits to fill an omitted field. Never drop an operation because a sibling is malformed; repair the cited field in the complete response or fail closed.
The JSON example contains valid sample values, not pipe-separated alternatives. Region dynamics must be exactly one of: pp, p, mp, mf, f, ff. Region and note articulation must be exactly one of: sustain, legato, staccato, marcato, tremolo, pizzicato. Never put a list such as "pp|p|mp|mf|f|ff" into a JSON field.
Notes use region-relative, zero-based beat offsets; regions use score-relative, zero-based beat offsets. Four bars in 4/4 means 16 beats, not four beats. Every note startBeat + durationBeats must be <= its region.durationBeats; every region startBeat + durationBeats must be <= score.durationBeats. Use existing track IDs exactly. All displayed fields are required, including note articulation. Notes and regions must fit their durations.`;
const PRODUCTION_WRITER_CONTRACT = `${PRODUCTION_OPERATION_JSON_SCHEMA}\n${PRODUCTION_IMPORTANT_AGENT_CHECKLIST}`;
const SPARSE_WRITING_RULES = [
  "Write sparse playable material with intentional rests; do not fill every beat.",
  "Use 2-4 added regions per retained track, each <=128 beats, and make the last added region reach the 256-beat section end.",
  "Use a small number of notes per phrase and leave rests between phrases so the response remains manageable while the section span reaches the final beat.",
].join(" ");

/**
 * Both arms receive this exact direction. In particular, the segment-size
 * requirements are not only a hidden validator detail: they are in the
 * explicit neutral user direction and are repeated in the consolidated
 * writer prompt.
 */
const SEGMENT_RULES = [
  `The intro is exactly ${INTRO_BARS} bars in 4/4, or ${INTRO_BEATS} score beats.`,
  `Because one region may be at most ${MAX_REGION_BEATS} beats, split every track's full passage into multiple score-relative regions; two 128-beat regions per track is the recommended layout, with smaller regions allowed.`,
  `Every region may contain at most ${MAX_NOTES_PER_REGION} notes, every region startBeat must be <=512, and the complete response may contain at most ${MAX_OPERATIONS} operations.`,
  "Notes use region-relative startBeat values; each region and note must remain inside its declared duration. Do not shorten the 256-beat request to fit one region; sparse rests are allowed, but playable material must span from the opening to the final section beat.",
].join(" ");

const request = {
  message: [
    "Write an original, neutral cinematic film-score intro with no named references, titles, quoted material, or imitation language.",
    "It must be a complete 64-bar introduction in 4/4 (exactly 256 beats) with a restrained, gradually widening arc: a quiet opening, a clear central lift, and a resolved but open handoff at the end.",
    "Retain every pre-existing track and its existing regions. Use only the existing playable catalog tracks (Piano, String Ensemble, and French Horn); do not add, delete, rename, or remap tracks.",
    "Develop new, original material on every retained track while preserving the existing opening material. Use achievable range, articulation, dynamics, and transparent orchestration rather than a named composer's sound.",
    SEGMENT_RULES,
    "The final candidate must span the full 256-beat intro with real playable notes; sparse rests are allowed and continuous sound coverage is not required. Keep the writing sparse enough to remain legible, vary register and density across the arc, and leave the last phrase suitable for a later cue transition.",
    SPARSE_WRITING_RULES,
  ].join(" "),
  safeDirection: "",
  selectedStyle: "Original neutral cinematic",
};
request.safeDirection = request.message;

type AnyRecord = Record<string, unknown>;
type ArmName = "current-adviser-first" | "consolidated-orchestrator";
type CallStage =
  | "model-discovery"
  | "skill-style"
  | "skill-concept"
  | "orchestrator-plan"
  | "instrument-writer"
  | "orchestrator-verification"
  | "shared-evaluator"
  | "current-workflow";

type CallMetric = {
  arm: ArmName | "shared" | "provider";
  stage: CallStage;
  agent?: string;
  attempt: number;
  maxTokens?: number;
  inputChars: number;
  inputBytes: number;
  messageChars: number;
  messageBytes: number;
  outputChars?: number;
  outputBytes?: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerTotalTokens?: number;
  finishReason?: string;
  providerModel?: string;
  providerRequestId?: string;
  transportAttempts?: number;
  wallMs: number;
  status: "success" | "error";
  errorCode?: string;
  error?: string;
  writerPromptHasSegmentBounds?: boolean;
  promptHasCompleteScore?: boolean;
  promptHasCompleteSourceMidi?: boolean;
  loadedSkillKeys?: string[];
};

type OfflineResponder = (input: {
  arm: CallMetric["arm"];
  stage: CallStage;
  messages: ModelMessage[];
  maxTokens: number;
  score?: ScoreValue;
  sourceMidi?: AnyRecord[];
}) => Promise<ModelCompletion>;

type RepairBudget = { used: number; max: number };

type ModelLimits = {
  selectedModel: string;
  selectedMetadata: AnyRecord;
  contextLimitTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  observedMaxInputChars: number;
  observedMaxInputBytes: number;
  observedMaxMessageChars: number;
  observedMaxMessageBytes: number;
};

type PrivateMidiRecord = {
  arm: ArmName;
  stage: string;
  suggestionId: string;
  label: string;
  path: string;
  bytes: number;
  sha256: string;
  durationBeats: number;
  noteCount: number;
  targets: string[];
};

type ArmResult = {
  arm: ArmName;
  status: "verified" | "failed";
  approved: boolean;
  startedAt: string;
  completedAt: string;
  wallMs: number;
  model?: string;
  workflow?: AnyRecord;
  candidate?: ScoreValue;
  candidateScorePath?: string;
  approvedScorePath?: string;
  operations: AnyRecord[];
  events: unknown[];
  errors: Array<{ code?: string; message: string }>;
  repairs: number;
  privateMidi: PrivateMidiRecord[];
  advisoryMidiLoads?: number;
  writerAttempts?: number;
  writerRepairAttempts?: number;
  writerRepairLimit?: number;
  objectiveRubric?: ObjectiveRubric;
  selfVerification?: AnyRecord;
  baselineUnchanged: boolean;
  writerPromptChecks: {
    writerCalls: number;
    callsWithSegmentBounds: number;
    allWriterCallsHadSegmentBounds: boolean;
    note: string;
  };
};

type ObjectiveRubric = {
  pass: boolean;
  failures: string[];
  baselineUnchangedBeforeApply: boolean;
  retainedMembership: boolean;
  playableCatalogMembership: boolean;
  retainedRegionsPreserved: boolean;
  operationOwnership: boolean;
  allOperationsValidated: boolean;
  segmentBounds: boolean;
  durationBeats: number;
  sectionStartBeat: number;
  sectionEndBeat: number;
  sectionSpanBeats: number;
  actualMaxNoteEndBeat: number;
  coverageBeats: number;
  coverageFraction: number;
  coverageDensityBeats: number;
  coverageDensityFraction: number;
  barsWithAnyNote: number;
  noteCount: number;
  tracksWithNotes: string[];
  tracksWithNewMaterial: string[];
  allRetainedTracksHaveNewMaterial: boolean;
  semanticChanged: boolean;
  fullSectionSpan: boolean;
};

type ProviderModel = {
  id: string;
  limits: ModelLimits;
};

type SkillDocuments = {
  style: string;
  concept: string;
  verification: string;
};

class ProviderCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderCallError";
    this.code = code;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function errorInfo(error: unknown): { code?: string; message: string } {
  if (error instanceof ProviderCallError) return { code: error.code, message: error.message };
  if (error && typeof error === "object" && "diagnostic" in error) {
    const diagnostic = (error as { diagnostic?: AnyRecord }).diagnostic;
    if (diagnostic && typeof diagnostic.reason === "string") {
      return { code: typeof diagnostic.code === "string" ? diagnostic.code : undefined, message: diagnostic.reason };
    }
  }
  return {
    message: screenMusicText(
      error instanceof Error ? error.message : String(error),
      "The isolated experiment failed before a verified score candidate was available.",
    ).slice(0, 800),
  };
}

function sanitizeModelMetadata(value: unknown): AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as AnyRecord;
  const allowed = [
    "id",
    "name",
    "context_length",
    "contextLength",
    "max_context_length",
    "maxContextLength",
    "max_input_tokens",
    "maxInputTokens",
    "max_output_tokens",
    "maxOutputTokens",
    "max_completion_tokens",
    "maxCompletionTokens",
    "input_token_limit",
    "output_token_limit",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

function extractLimit(metadata: AnyRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function makeExistingRegion(
  trackId: string,
  regionId: string,
  pitches: number[],
): AnyRecord & { id: string; startBeat: number; durationBeats: number; notes: AnyRecord[] } {
  return {
    id: regionId,
    name: `Pre-existing ${trackId} opening`,
    startBeat: 0,
    durationBeats: 16,
    dynamics: "mp",
    articulation: "legato",
    notes: pitches.map((pitch, index) => ({
      pitch,
      velocity: 58 + (index % 3) * 4,
      startBeat: index * 2,
      durationBeats: 1.5,
      articulation: "legato",
    })),
  };
}

function makeBaseline(): ScoreValue {
  return {
    tempo: TEMPO,
    durationBeats: INTRO_BEATS,
    tracks: [
      {
        id: "track-piano",
        name: "Piano",
        instrument: "Piano",
        role: "keyboards",
        midiProgram: 0,
        regions: [makeExistingRegion("track-piano", "region-piano-opening", [60, 62, 64, 67, 65, 64, 62, 60])],
      },
      {
        id: "track-strings",
        name: "String Ensemble",
        instrument: "String Ensemble",
        role: "strings",
        midiProgram: 48,
        regions: [makeExistingRegion("track-strings", "region-strings-opening", [48, 55, 60, 55, 50, 57, 62, 57])],
      },
      {
        id: "track-horn",
        name: "French Horn",
        instrument: "French Horn",
        role: "brass",
        midiProgram: 60,
        regions: [makeExistingRegion("track-horn", "region-horn-opening", [43, 46, 50, 48, 43, 46, 50, 48])],
      },
    ],
  };
}

function makeSourceMidi(score: ScoreValue): AnyRecord[] {
  return score.tracks.map((track) => {
    const notes = track.regions.flatMap((region) => region.notes.map((note) => ({
      note: note.pitch,
      velocity: note.velocity,
      startMs: (region.startBeat + note.startBeat) * 60_000 / score.tempo,
      durationMs: note.durationBeats * 60_000 / score.tempo,
    })));
    return {
      id: `source-${track.id}`,
      tempo: score.tempo,
      durationMs: score.durationBeats * 60_000 / score.tempo,
      notes,
    };
  });
}

function applyOperations(score: ScoreValue, operations: AnyRecord[]): ScoreValue {
  const next = clone(score);
  for (const operation of operations) {
    const track = next.tracks.find((candidate) => candidate.id === operation.trackId);
    if (!track) throw new Error(`Operation targeted missing track ${String(operation.trackId)}.`);
    if (operation.type === "remove-region") {
      track.regions = track.regions.filter((region) => region.id !== operation.regionId);
    } else if (operation.type === "add-region") {
      track.regions.push(clone(operation.region as ScoreValue["tracks"][number]["regions"][number]));
    } else {
      throw new Error(`Unsupported operation type ${String(operation.type)}.`);
    }
  }
  return next;
}

function notes(score: ScoreValue): Array<{
  trackId: string;
  pitch: number;
  velocity: number;
  startBeat: number;
  durationBeats: number;
}> {
  return score.tracks.flatMap((track) => track.regions.flatMap((region) => region.notes.map((note) => ({
    trackId: track.id,
    pitch: note.pitch,
    velocity: note.velocity,
    startBeat: region.startBeat + note.startBeat,
    durationBeats: note.durationBeats,
  }))));
}

function coverage(score: ScoreValue): {
  minStart: number;
  maxEnd: number;
  span: number;
  coveredBeats: number;
  fraction: number;
  barsWithAnyNote: number;
} {
  const renderedNotes = notes(score);
  const intervals = renderedNotes
    .map((note) => [Math.max(0, note.startBeat), Math.min(score.durationBeats, note.startBeat + note.durationBeats)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let end = 0;
  const merged: Array<[number, number]> = [];
  for (const interval of intervals) {
    if (!merged.length || interval[0] > merged[merged.length - 1][1]) {
      merged.push([interval[0], interval[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], interval[1]);
    }
  }
  for (const [start, finish] of merged) {
    covered += finish - start;
    end = Math.max(end, finish);
  }
  const bars = new Set<number>();
  for (const note of notes(score)) {
    const first = Math.floor(note.startBeat / BAR_BEATS);
    const last = Math.floor(Math.max(note.startBeat, note.startBeat + note.durationBeats - Number.EPSILON) / BAR_BEATS);
    for (let bar = first; bar <= last; bar += 1) bars.add(bar);
  }
  return {
    minStart: renderedNotes.length ? Math.min(...renderedNotes.map((note) => Math.max(0, note.startBeat))) : 0,
    maxEnd: end,
    span: renderedNotes.length ? Math.max(0, end - Math.min(...renderedNotes.map((note) => Math.max(0, note.startBeat)))) : 0,
    coveredBeats: covered,
    fraction: score.durationBeats > 0 ? covered / score.durationBeats : 0,
    barsWithAnyNote: bars.size,
  };
}

function tracksWithNewMaterial(baseline: ScoreValue, candidate: ScoreValue): string[] {
  const baselineCounts = new Map<string, number>();
  for (const note of notes(baseline)) {
    const key = `${note.trackId}|${note.pitch}|${note.velocity}|${note.startBeat}|${note.durationBeats}`;
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
  }
  const candidateCounts = new Map<string, number>();
  const candidateTrackForKey = new Map<string, string>();
  for (const note of notes(candidate)) {
    const key = `${note.trackId}|${note.pitch}|${note.velocity}|${note.startBeat}|${note.durationBeats}`;
    candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
    candidateTrackForKey.set(key, note.trackId);
  }
  const changed = new Set<string>();
  for (const [key, count] of candidateCounts) {
    if (count > (baselineCounts.get(key) ?? 0)) {
      const trackId = candidateTrackForKey.get(key);
      if (trackId) changed.add(trackId);
    }
  }
  return [...changed].sort();
}

function retainedMembership(baseline: ScoreValue, candidate: ScoreValue): boolean {
  return stable(baseline.tracks.map((track) => ({
    id: track.id,
    instrument: track.instrument,
    midiProgram: track.midiProgram,
    role: track.role,
  }))) === stable(candidate.tracks.map((track) => ({
    id: track.id,
    instrument: track.instrument,
    midiProgram: track.midiProgram,
    role: track.role,
  })));
}

function retainedRegionsPreserved(baseline: ScoreValue, candidate: ScoreValue): boolean {
  return baseline.tracks.every((track) => track.regions.every((region) => {
    const candidateTrack = candidate.tracks.find((item) => item.id === track.id);
    const found = candidateTrack?.regions.find((item) => item.id === region.id);
    return found !== undefined && stable(found) === stable(region);
  }));
}

function catalogMembership(score: ScoreValue): boolean {
  return score.tracks.every((track) => {
    const playable = findPlayableInstrument(track.instrument ?? "");
    return Boolean(playable && playable.midiProgram === track.midiProgram);
  });
}

function operationOwnership(
  operations: AnyRecord[],
  score: ScoreValue,
): boolean {
  const tracks = new Set(score.tracks.map((track) => track.id));
  return operations.every((operation) => tracks.has(String(operation.trackId)));
}

function segmentBounds(score: ScoreValue): boolean {
  return score.durationBeats === INTRO_BEATS &&
    score.tracks.every((track) => track.regions.every((region) => {
      const duration = Number(region.durationBeats ?? 0);
      return region.startBeat >= 0 &&
        region.startBeat <= 512 &&
        duration > 0 &&
        duration <= MAX_REGION_BEATS &&
        region.startBeat + duration <= score.durationBeats &&
        region.notes.length <= MAX_NOTES_PER_REGION &&
        region.notes.every((note) =>
          Number.isInteger(note.pitch) &&
          note.pitch >= 0 &&
          note.pitch <= 127 &&
          Number.isInteger(note.velocity) &&
          note.velocity >= 1 &&
          note.velocity <= 127 &&
          note.startBeat >= 0 &&
          note.durationBeats > 0 &&
          note.startBeat + note.durationBeats <= duration,
        );
    }));
}

function evaluateObjective(
  baseline: ScoreValue,
  candidate: ScoreValue | undefined,
  operations: AnyRecord[],
  baselineUnchangedBeforeApply: boolean,
): ObjectiveRubric {
  if (!candidate) {
    return {
      pass: false,
      failures: ["No safely applied candidate score was available."],
      baselineUnchangedBeforeApply,
      retainedMembership: false,
      playableCatalogMembership: false,
      retainedRegionsPreserved: false,
      operationOwnership: false,
      allOperationsValidated: false,
      segmentBounds: false,
      durationBeats: 0,
      sectionStartBeat: 0,
      sectionEndBeat: 0,
      sectionSpanBeats: 0,
      actualMaxNoteEndBeat: 0,
      coverageBeats: 0,
      coverageFraction: 0,
      coverageDensityBeats: 0,
      coverageDensityFraction: 0,
      barsWithAnyNote: 0,
      noteCount: 0,
      tracksWithNotes: [],
      tracksWithNewMaterial: [],
      allRetainedTracksHaveNewMaterial: false,
      semanticChanged: false,
      fullSectionSpan: false,
    };
  }
  const timing = coverage(candidate);
  const membership = retainedMembership(baseline, candidate);
  const catalog = catalogMembership(candidate);
  const regions = retainedRegionsPreserved(baseline, candidate);
  const ownership = operationOwnership(operations, baseline);
  const validated = validateScoreOperations(baseline, operations);
  const diagnostics = (validated as unknown as { diagnostics?: unknown[] }).diagnostics ?? [];
  const operationValid = diagnostics.length === 0 && validated.length === operations.length && operations.length > 0;
  const bounded = segmentBounds(candidate) && operations.length <= MAX_OPERATIONS;
  const changed = semanticMidiFingerprint(baseline) !== semanticMidiFingerprint(candidate);
  const newTracks = tracksWithNewMaterial(baseline, candidate);
  const allTracksChanged = baseline.tracks.every((track) => newTracks.includes(track.id));
  const fullSectionSpan = timing.minStart <= 0 && timing.maxEnd >= INTRO_BEATS;
  const failures = [
    baselineUnchangedBeforeApply ? "" : "The baseline copy changed before apply.",
    membership ? "" : "Track membership or track identity changed.",
    catalog ? "" : "A track does not resolve to the playable catalog with its declared program.",
    regions ? "" : "A pre-existing region was changed or removed.",
    ownership ? "" : "An operation targeted a track outside the retained baseline tracks.",
    operationValid ? "" : "Returned operations did not pass atomic score-operation validation.",
    bounded ? "" : "Region, note, operation-count, or duration bounds failed.",
    changed ? "" : "The candidate has no rendered MIDI semantic change.",
    fullSectionSpan ? "" : `The candidate section span is ${timing.minStart.toFixed(2)}-${timing.maxEnd.toFixed(2)}, not the full 0-${INTRO_BEATS} beat section.`,
    allTracksChanged ? "" : `New material is missing from retained tracks: ${baseline.tracks.filter((track) => !newTracks.includes(track.id)).map((track) => track.id).join(", ")}.`,
  ].filter(Boolean);
  return {
    pass: failures.length === 0,
    failures,
    baselineUnchangedBeforeApply,
    retainedMembership: membership,
    playableCatalogMembership: catalog,
    retainedRegionsPreserved: regions,
    operationOwnership: ownership,
    allOperationsValidated: operationValid,
    segmentBounds: bounded,
    durationBeats: candidate.durationBeats,
    sectionStartBeat: timing.minStart,
    sectionEndBeat: timing.maxEnd,
    sectionSpanBeats: timing.span,
    actualMaxNoteEndBeat: timing.maxEnd,
    coverageBeats: timing.coveredBeats,
    coverageFraction: timing.fraction,
    coverageDensityBeats: timing.coveredBeats,
    coverageDensityFraction: timing.fraction,
    barsWithAnyNote: timing.barsWithAnyNote,
    noteCount: notes(candidate).length,
    tracksWithNotes: candidate.tracks.filter((track) => track.regions.some((region) => region.notes.length > 0)).map((track) => track.id),
    tracksWithNewMaterial: newTracks,
    allRetainedTracksHaveNewMaterial: allTracksChanged,
    semanticChanged: changed,
    fullSectionSpan,
  };
}

function runFixtures(): AnyRecord {
  const fixtureOperations: AnyRecord[] = baselineFixtureTracks().map((track, index) => ({
    id: `fixture-add-${index}`,
    type: "add-region",
    trackId: track.id,
    summary: "Sparse end-span fixture material.",
    region: {
      id: `fixture-region-${index}`,
      name: "Fixture sparse end span",
      startBeat: 128,
      durationBeats: 128,
      dynamics: "mp",
      articulation: "legato",
      notes: [
        { pitch: 60 + index, velocity: 64, startBeat: 0, durationBeats: 1, articulation: "legato" },
        { pitch: 67 + index, velocity: 68, startBeat: 127, durationBeats: 1, articulation: "legato" },
      ],
    },
  }));
  const baseline = makeBaseline();
  const sparseCandidate = applyOperations(baseline, fixtureOperations);
  const sparseRubric = evaluateObjective(baseline, sparseCandidate, fixtureOperations, true);
  const missingTrackCandidate = applyOperations(baseline, fixtureOperations.slice(0, 2));
  const missingTrackRubric = evaluateObjective(baseline, missingTrackCandidate, fixtureOperations.slice(0, 2), true);
  let refusalCode = "";
  let emptyRefusalCode = "";
  let nonStopCode = "";
  try {
    throwForCompletionFailure({
      content: "{}",
      metadata: safeProviderMetadata({ finishReason: "refusal" }),
    });
  } catch (error) {
    refusalCode = error && typeof error === "object" && "diagnostic" in error
      ? String((error as { diagnostic?: AnyRecord }).diagnostic?.code ?? "")
      : "";
  }
  try {
    throwForCompletionFailure({
      content: "",
      metadata: safeProviderMetadata({ finishReason: "refusal" }),
    });
  } catch (error) {
    emptyRefusalCode = error && typeof error === "object" && "diagnostic" in error
      ? String((error as { diagnostic?: AnyRecord }).diagnostic?.code ?? "")
      : "";
  }
  try {
    throwForCompletionFailure({
      content: "{}",
      metadata: safeProviderMetadata({ finishReason: "length" }),
    });
  } catch (error) {
    nonStopCode = error && typeof error === "object" && "diagnostic" in error
      ? String((error as { diagnostic?: AnyRecord }).diagnostic?.code ?? "")
      : "";
  }
  const checks = {
    sparseRestsDoNotFailSectionSpan: sparseRubric.pass &&
      sparseRubric.sectionSpanBeats === INTRO_BEATS &&
      sparseRubric.coverageDensityFraction < 1,
    everyRetainedTrackNeedsNewMaterial: !missingTrackRubric.pass &&
      missingTrackRubric.failures.some((failure) => /New material is missing/.test(failure)),
    refusalFailsClosed: refusalCode === "provider-refusal",
    emptyRefusalFailsClosed: emptyRefusalCode === "provider-refusal",
    nonStopFailsClosed: nonStopCode === "provider-token-limit",
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`Objective/refusal fixture failed: ${JSON.stringify(checks)}`);
  }
  return {
    checks,
    sparseRubric,
    missingTrackRubric,
    refusalCode,
    emptyRefusalCode,
    nonStopCode,
  };
}

function syntheticOperation(trackId: string): AnyRecord {
  const safeTrack = trackId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    id: `offline-operation-${safeTrack}`,
    type: "add-region",
    trackId,
    summary: "Offline fixture sparse full-section continuation.",
    region: {
      id: `offline-region-${safeTrack}`,
      name: "Offline fixture continuation",
      startBeat: 128,
      durationBeats: 128,
      dynamics: "mf",
      articulation: "legato",
      notes: [
        { pitch: 60, velocity: 72, startBeat: 0, durationBeats: 1, articulation: "legato" },
        { pitch: 67, velocity: 76, startBeat: 127, durationBeats: 1, articulation: "legato" },
      ],
    },
  };
}

function syntheticSuggestions(score: ScoreValue): AnyRecord[] {
  return score.tracks.map((track, index) => {
    const playable = findPlayableInstrument(track.instrument ?? "");
    return {
      id: `offline-advice-${index}`,
      label: `Offline guidance ${index}`,
      instructions: ["Use a sparse continuation with an intentional late-section handoff."],
      targetTrackIds: [track.id],
      instrumentId: playable?.id,
      instrumentName: playable?.name,
      midiClip: {
        tempo: 72,
        durationBeats: 4,
        notes: [{ pitch: 60 + index, velocity: 68, startBeat: 0, durationBeats: 1 }],
      },
    };
  });
}

function parseSyntheticUser(messages: ModelMessage[]): AnyRecord {
  const content = [...messages].reverse().find((message) => message.role === "user")?.content ?? "{}";
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as AnyRecord : {};
  } catch {
    return {};
  }
}

function syntheticResponder(): OfflineResponder {
  return async ({ stage, messages, score }) => {
    const context = parseSyntheticUser(messages);
    const activeScore = score ?? makeBaseline();
    const systemText = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    const review = /candidate review|staged candidate against|final acceptance/i.test(systemText);
    let payload: AnyRecord;
    if ((stage === "skill-style" || stage === "skill-concept") && review) {
      payload = {
        feedback: "The staged candidate satisfies the requested sparse span and retained-track constraints.",
        needsRefinement: false,
        affectedTrackIds: [],
        expectedConstraints: ["Preserve every retained track and span the complete section."],
      };
    } else if (stage === "skill-style" || stage === "skill-concept") {
      payload = {
        insight: "Use a sparse, neutral continuation with a clear late-section handoff.",
        suggestions: syntheticSuggestions(activeScore),
      };
    } else if (stage === "orchestrator-plan") {
      payload = {
        trackInstructions: activeScore.tracks.map((track) => ({
          trackId: track.id,
          instruction: "Add sparse original material on this retained track in a late 128-beat region reaching the section end.",
        })),
        membershipProposals: [],
        requiresPlayableMaterial: true,
        privateMidiSuggestions: [],
      };
    } else if (stage === "instrument-writer") {
      const trackId = typeof context.assignedTrackId === "string"
        ? context.assignedTrackId
        : activeScore.tracks[0]?.id;
      payload = {
        summary: "Sparse offline instrument-writer continuation applied.",
        operations: [syntheticOperation(String(trackId))],
      };
    } else if (stage === "orchestrator-verification") {
      payload = {
        pass: true,
        reason: "Synthetic verification confirms the complete span and retained-track additions.",
        checks: {
          duration: true,
          sectionSpan: true,
          newMaterialPerTrack: true,
          membership: true,
          ownership: true,
          segments: true,
          originalRegions: true,
        },
      };
    } else if (stage === "shared-evaluator") {
      const candidateInputs = Array.isArray(context.candidates) ? context.candidates as AnyRecord[] : [];
      payload = {
        candidates: ["candidate-1", "candidate-2"].map((id) => {
          const available = candidateInputs.find((candidate) => candidate.id === id)?.available === true;
          return {
            id,
            available,
            pass: available,
            reason: available ? "Offline candidate passes the shared rubric." : "Candidate unavailable; no pass is asserted.",
            violations: available ? [] : ["Candidate was unavailable."],
          };
        }),
        rubric: "Same offline rubric applied blindly to both candidates.",
      };
    } else {
      payload = { insight: "Offline synthetic response." };
    }
    return {
      content: JSON.stringify(payload),
      metadata: safeProviderMetadata({
        finishReason: "stop",
        model: "offline-synthetic",
        providerRequestId: `offline-${stage}`,
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }),
    };
  };
}

function invalidOperationDiagnosticFixture(baseline: ScoreValue): AnyRecord {
  try {
    validateOperationsPayload({
      summary: "Invalid fixture operation",
      operations: [{ id: "offline-invalid", type: "add-region", trackId: "track-piano", summary: "missing region" }],
    }, baseline, "track-piano");
    return { pass: false, diagnosticFeedback: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pass: /Production diagnostic/.test(message) && /missing-field/.test(message) && /region/.test(message),
      diagnosticFeedback: message,
    };
  }
}

async function runOfflineEndToEndFixture(): Promise<AnyRecord> {
  await mkdir(privateMidiPath, { recursive: true });
  await mkdir(midiPath, { recursive: true });
  const baseline = makeBaseline();
  const sourceMidi = makeSourceMidi(baseline);
  const model: ProviderModel = {
    id: "offline-synthetic",
    limits: {
      selectedModel: "offline-synthetic",
      selectedMetadata: { id: "offline-synthetic" },
      observedMaxInputChars: 0,
      observedMaxInputBytes: 0,
      observedMaxMessageChars: 0,
      observedMaxMessageBytes: 0,
    },
  };
  const calls: CallMetric[] = [];
  const responder = syntheticResponder();
  const skills = await loadSkillDocuments();
  const current = await runCurrentArm({} as ReplitConnectors, model, baseline, sourceMidi, calls, responder);
  const consolidated = await runConsolidatedArm({} as ReplitConnectors, model, baseline, sourceMidi, calls, skills, responder);
  const shared = await runSharedEvaluator({} as ReplitConnectors, model, baseline, current, consolidated, calls, responder);
  const invalidOperation = invalidOperationDiagnosticFixture(baseline);
  const consolidatedCalls = calls.filter((call) => call.arm === "consolidated-orchestrator");
  const skillContextProgression = {
    style: consolidatedCalls.some((call) => call.stage === "skill-style" && stable(call.loadedSkillKeys) === stable(["style"])),
    concept: consolidatedCalls.some((call) => call.stage === "skill-concept" && stable(call.loadedSkillKeys) === stable(["concept", "style"])),
    plan: consolidatedCalls.some((call) => call.stage === "orchestrator-plan" && stable(call.loadedSkillKeys) === stable(["concept", "style"])),
    writers: consolidatedCalls.filter((call) => call.stage === "instrument-writer").length > 0 &&
      consolidatedCalls.filter((call) => call.stage === "instrument-writer").every((call) => stable(call.loadedSkillKeys) === stable(["concept", "style"])),
    verification: consolidatedCalls.some((call) => call.stage === "orchestrator-verification" &&
      stable(call.loadedSkillKeys) === stable(["concept", "style", "verification"])),
  };
  let verifierNegativeGate = false;
  try {
    validateVerificationPayload({
      pass: true,
      reason: "inconsistent",
      checks: {
        duration: true,
        sectionSpan: false,
        newMaterialPerTrack: true,
        membership: true,
        ownership: true,
        segments: true,
        originalRegions: true,
      },
    });
  } catch {
    verifierNegativeGate = true;
  }
  let evaluatorNegativeGate = false;
  try {
    validateEvaluatorPayload({
      candidates: [
        { id: "candidate-1", available: false, pass: true, reason: "invalid", violations: [] },
        { id: "candidate-2", available: false, pass: false, reason: "unavailable", violations: ["unavailable"] },
      ],
      rubric: "negative gate",
    }, [false, false]);
  } catch {
    evaluatorNegativeGate = true;
  }
  const checks = {
    currentArmCompleted: current.candidate !== undefined && current.objectiveRubric?.pass === true,
    consolidatedArmCompleted: consolidated.candidate !== undefined && consolidated.objectiveRubric?.pass === true,
    currentConsultationRefsLoaded: current.privateMidi.length > 0 && (current.advisoryMidiLoads ?? 0) > 0,
    consolidatedTargetedRefsDereferenced: consolidated.privateMidi.length > 0 && (consolidated.advisoryMidiLoads ?? 0) > 0,
    consolidatedOrchestratorVerificationCompleted: consolidated.selfVerification?.pass === true,
    sharedEvaluatorCompleted: shared.status === "verified",
    sharedWriterRepairPoolBounded: (consolidated.writerRepairAttempts ?? 0) <= (consolidated.writerRepairLimit ?? 0) &&
      (consolidated.writerRepairLimit ?? 0) === 2,
    incrementalSkillDocuments: Object.values(skillContextProgression).every(Boolean),
    verifierBooleanConsistencyGate: verifierNegativeGate,
    evaluatorUnavailableFalseGate: evaluatorNegativeGate,
    writerIdentitiesAreInstrumentAgents: calls.filter((call) => call.stage === "instrument-writer").length > 0 &&
      calls.filter((call) => call.stage === "instrument-writer").every((call) =>
        !/Orchestrator.*writer subroutine/i.test(call.agent ?? "") &&
        (/\binstrument\b/i.test(call.agent ?? "") || /Instrument Writer/.test(call.agent ?? ""))),
    invalidOperationProvidesSpecificDiagnostic: invalidOperation.pass,
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`Offline end-to-end fixture failed: ${JSON.stringify({ checks, currentErrors: current.errors, consolidatedErrors: consolidated.errors, consolidatedEvents: consolidated.events, calls: calls.map((call) => ({ stage: call.stage, agent: call.agent, status: call.status, error: call.error })) })}`);
  }
  return {
    mode: "offline-end-to-end",
    syntheticModel: model.id,
    checks,
    current: { status: current.status, objective: current.objectiveRubric, privateMidi: current.privateMidi.length, advisoryMidiLoads: current.advisoryMidiLoads ?? 0 },
    consolidated: {
      status: consolidated.status,
      objective: consolidated.objectiveRubric,
      verification: consolidated.selfVerification,
      privateMidi: consolidated.privateMidi.length,
      advisoryMidiLoads: consolidated.advisoryMidiLoads ?? 0,
      writerAttempts: consolidated.writerAttempts ?? 0,
      writerRepairAttempts: consolidated.writerRepairAttempts ?? 0,
      writerRepairLimit: consolidated.writerRepairLimit ?? 0,
    },
    shared,
    invalidOperation,
    skillContextProgression,
    callCount: calls.length,
    calls,
  };
}

function baselineFixtureTracks(): ScoreValue["tracks"] {
  return makeBaseline().tracks;
}

function stageFromMessages(messages: ModelMessage[]): CallStage {
  const text = messages.map((message) => message.content).join("\n");
  if (/read-only .*style|style adviser/i.test(text)) return "skill-style";
  if (/read-only .*concept|concept adviser/i.test(text)) return "skill-concept";
  if (/one track-owning instrument writer|assignedTrackId/i.test(text)) return "instrument-writer";
  if (/post-hoc|independent evaluator/i.test(text)) return "shared-evaluator";
  if (/verification verdict|verify the complete/i.test(text)) return "orchestrator-verification";
  if (/trackInstructions|adviser advice/i.test(text)) return "orchestrator-plan";
  return "current-workflow";
}

function hasCompleteContext(messages: ModelMessage[], score: ScoreValue, sourceMidi: AnyRecord[]): {
  score: boolean;
  sourceMidi: boolean;
} {
  const text = messages.map((message) => message.content).join("\n");
  return {
    score: text.includes(stable(score)),
    sourceMidi: text.includes(stable(sourceMidi)) || text.includes(fullMidiMaterial(sourceMidi as never)),
  };
}

function loadedSkillKeys(messages: ModelMessage[]): string[] {
  const user = [...messages].reverse().find((message) => message.role === "user")?.content;
  if (!user) return [];
  try {
    const parsed = JSON.parse(user) as AnyRecord;
    const docs = parsed.loadedSkillDocuments;
    return docs && typeof docs === "object" && !Array.isArray(docs) ? Object.keys(docs).sort() : [];
  } catch {
    return [];
  }
}

async function providerCompletion(
  connectors: ReplitConnectors,
  model: string,
  arm: CallMetric["arm"],
  messages: ModelMessage[],
  maxTokens: number,
  calls: CallMetric[],
  score?: ScoreValue,
  sourceMidi?: AnyRecord[],
  forcedStage?: CallStage,
  offlineResponder?: OfflineResponder,
  callAttempt = 1,
): Promise<ModelCompletion> {
  const stage = forcedStage ?? stageFromMessages(messages);
  const completeMessages: ModelMessage[] = [{ role: "system", content: AI_MUSIC_SAFETY_POLICY }, ...messages];
  const body = JSON.stringify({
    model,
    messages: completeMessages,
    temperature: 0.45,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
  });
  const metric: CallMetric = {
    arm,
    stage,
    agent: completeMessages.find((message) => message.role === "system" && /You are /.test(message.content))?.content.match(/You are ([^.]+)/)?.[1],
    attempt: callAttempt,
    maxTokens,
    inputChars: body.length,
    inputBytes: bytes(body),
    messageChars: completeMessages.reduce((total, message) => total + message.content.length, 0),
    messageBytes: completeMessages.reduce((total, message) => total + bytes(message.content), 0),
    wallMs: 0,
    status: "error",
    ...((stage === "instrument-writer" || stage === "current-workflow")
      ? {
        writerPromptHasSegmentBounds: body.includes(`${MAX_REGION_BEATS} beats`) &&
          body.includes(`${MAX_NOTES_PER_REGION} notes`) &&
          (body.includes(`${MAX_OPERATIONS}-operation`) || body.includes(`${MAX_OPERATIONS} operations`)),
      }
      : {}),
    ...(score && sourceMidi ? {
      promptHasCompleteScore: hasCompleteContext(messages, score, sourceMidi).score,
      promptHasCompleteSourceMidi: hasCompleteContext(messages, score, sourceMidi).sourceMidi,
    } : {}),
    loadedSkillKeys: loadedSkillKeys(messages),
  };
  const started = Date.now();
  let transportAttempts = 0;
  try {
    if (offlineResponder) {
      const completion = await offlineResponder({
        arm,
        stage,
        messages: completeMessages,
        maxTokens,
        score,
        sourceMidi,
      });
      const metadata = safeProviderMetadata(completion.metadata);
      const content = completion.content;
      metric.outputChars = content.length;
      metric.outputBytes = bytes(content);
      metric.providerInputTokens = metadata?.usage?.promptTokens;
      metric.providerOutputTokens = metadata?.usage?.completionTokens;
      metric.providerTotalTokens = metadata?.usage?.totalTokens;
      metric.finishReason = metadata?.finishReason;
      metric.providerModel = metadata?.model ?? "offline-synthetic";
      metric.providerRequestId = metadata?.providerRequestId;
      metric.transportAttempts = 0;
      metric.wallMs = Date.now() - started;
      metric.status = metadata?.finishReason && metadata.finishReason !== "stop" ? "error" : "success";
      if (metric.status === "error") {
        metric.errorCode = metadata?.finishReason === "length" ? "provider-token-limit" : "provider-finish-reason";
        metric.error = `Synthetic model finished the response with ${metadata?.finishReason}.`;
      }
      calls.push(metric);
      return { content, metadata };
    }
    const proxyFetch = connectors.createProxyFetch("xai");
    let response: Response | undefined;
    for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt += 1) {
      transportAttempts = attempt;
      response = await xaiLaunchLimiter.schedule(() => proxyFetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(providerRequestTimeoutMs(maxTokens)),
      }));
      if (response.ok) break;
      await response.arrayBuffer();
      if (response.status === 429 && attempt < CHAT_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(
          resolve,
          retryDelayMs(attempt, parseRetryAfter(response?.headers.get("retry-after") ?? null)),
        ));
        continue;
      }
      throw new ProviderCallError(`http-${response.status}`, `xAI completion failed with HTTP ${response.status}.`);
    }
    if (!response?.ok) throw new ProviderCallError("provider-empty-response", "xAI returned no response.");
    const responsePayload = await response.json() as {
      id?: unknown;
      model?: unknown;
      usage?: unknown;
      choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
    };
    const choice = responsePayload.choices?.[0];
    const metadata = safeProviderMetadata({
      finishReason: choice?.message?.refusal ? "refusal" : choice?.finish_reason,
      usage: responsePayload.usage,
      model: responsePayload.model ?? model,
      providerRequestId: response.headers.get("x-request-id") ??
        response.headers.get("request-id") ??
        response.headers.get("xai-request-id") ??
        responsePayload.id,
    });
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    metric.outputChars = content.length;
    metric.outputBytes = bytes(content);
    metric.providerInputTokens = metadata?.usage?.promptTokens;
    metric.providerOutputTokens = metadata?.usage?.completionTokens;
    metric.providerTotalTokens = metadata?.usage?.totalTokens;
    metric.finishReason = metadata?.finishReason;
    metric.providerModel = metadata?.model;
    metric.providerRequestId = metadata?.providerRequestId;
    metric.transportAttempts = transportAttempts;
    metric.wallMs = Date.now() - started;
    if (metadata?.finishReason && metadata.finishReason !== "stop") {
      metric.status = "error";
      metric.errorCode = metadata.finishReason === "length" ? "provider-token-limit" : "provider-finish-reason";
      metric.error = `xAI finished the response with ${metadata.finishReason}; no incomplete JSON was accepted.`;
    }
    if (choice?.message?.refusal) {
      metric.status = "error";
      metric.errorCode = "provider-refusal";
      metric.error = "xAI refused this isolated completion.";
      calls.push(metric);
      return { content, metadata };
    }
    if (!content.trim()) throw new ProviderCallError("empty-completion", "xAI returned an empty completion.");
    if (!metric.errorCode) {
      metric.status = "success";
    }
    calls.push(metric);
    return { content, metadata };
  } catch (error) {
    metric.transportAttempts = transportAttempts || undefined;
    metric.wallMs = Date.now() - started;
    const info = errorInfo(error);
    metric.errorCode = info.code;
    metric.error = info.message;
    calls.push(metric);
    throw error;
  }
}

async function discoverModel(
  connectors: ReplitConnectors,
  calls: CallMetric[],
): Promise<ProviderModel> {
  const metric: CallMetric = {
    arm: "provider",
    stage: "model-discovery",
    attempt: 1,
    inputChars: 0,
    inputBytes: 0,
    messageChars: 0,
    messageBytes: 0,
    wallMs: 0,
    status: "error",
  };
  const started = Date.now();
  try {
    const response = await xaiLaunchLimiter.schedule(() =>
      connectors.proxy("xai", "/v1/language-models", { method: "GET" }),
    );
    if (!response.ok) {
      await response.arrayBuffer();
      throw new ProviderCallError(`http-${response.status}`, `xAI model discovery failed with HTTP ${response.status}.`);
    }
    const raw = await response.arrayBuffer();
    metric.outputBytes = raw.byteLength;
    metric.outputChars = raw.byteLength;
    const payload = JSON.parse(Buffer.from(raw).toString("utf8")) as {
      models?: Array<AnyRecord>;
      data?: Array<AnyRecord>;
    };
    const models = payload.models ?? payload.data ?? [];
    const selected = models.find((candidate) => typeof candidate.id === "string" && candidate.id.includes("grok-4") && candidate.id.includes("fast"))
      ?? models.find((candidate) => typeof candidate.id === "string" && candidate.id.includes("grok-4"))
      ?? models[0];
    if (!selected || typeof selected.id !== "string") {
      throw new ProviderCallError("model-not-found", "xAI returned no usable language model.");
    }
    const metadata = sanitizeModelMetadata(selected);
    const limits: ModelLimits = {
      selectedModel: selected.id,
      selectedMetadata: metadata,
      contextLimitTokens: extractLimit(metadata, ["context_length", "contextLength", "max_context_length", "maxContextLength"]),
      maxInputTokens: extractLimit(metadata, ["max_input_tokens", "maxInputTokens", "input_token_limit"]),
      maxOutputTokens: extractLimit(metadata, ["max_output_tokens", "maxOutputTokens", "max_completion_tokens", "maxCompletionTokens", "output_token_limit"]),
      observedMaxInputChars: 0,
      observedMaxInputBytes: 0,
      observedMaxMessageChars: 0,
      observedMaxMessageBytes: 0,
    };
    metric.providerModel = selected.id;
    metric.wallMs = Date.now() - started;
    metric.status = "success";
    calls.push(metric);
    return { id: selected.id, limits };
  } catch (error) {
    metric.wallMs = Date.now() - started;
    const info = errorInfo(error);
    metric.errorCode = info.code;
    metric.error = info.message;
    calls.push(metric);
    throw error;
  }
}

function parseObject(content: string): AnyRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The provider returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The provider returned a JSON value that was not an object.");
  }
  return parsed as AnyRecord;
}

async function requestJson(
  args: {
    connectors: ReplitConnectors;
    model: string;
    arm: ArmName | "shared";
    stage: CallStage;
    agent: string;
    system: string;
    user: AnyRecord;
    maxTokens: number;
    calls: CallMetric[];
    score?: ScoreValue;
    sourceMidi?: AnyRecord[];
    validate: (payload: AnyRecord) => void;
    maxRepairs?: number;
    repairBudget?: RepairBudget;
    repairLabel?: string;
    offlineResponder?: OfflineResponder;
  },
): Promise<{ payload: AnyRecord; repairs: number }> {
  let priorResponse = "";
  let failure = "";
  const configuredRepairs = args.maxRepairs ?? 1;
  const availableRepairs = args.repairBudget
    ? Math.min(configuredRepairs, Math.max(0, args.repairBudget.max - args.repairBudget.used))
    : configuredRepairs;
  const maxAttempts = 1 + availableRepairs;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const repairAttempt = attempt > 0 ? (args.repairBudget?.used ?? attempt) : 0;
    const repairLimit = args.repairBudget?.max ?? configuredRepairs;
    const system = attempt === 0
      ? args.system
      : `${args.system}\nThis is bounded structural repair attempt ${repairAttempt}/${repairLimit}${args.repairLabel ? ` in the ${args.repairLabel}` : ""} for the same response. Preserve the musical intention and every valid decision; repair only the JSON contract. Do not shorten the score or omit any source MIDI. Validator failure: ${failure}`;
    const user = attempt === 0
      ? args.user
      : { ...args.user, priorResponse, repairAttempt: `${repairAttempt}/${repairLimit}`, validatorFailure: failure };
    try {
      const completion = await providerCompletion(
        args.connectors,
        args.model,
        args.arm,
        [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
        args.maxTokens,
        args.calls,
        args.score,
        args.sourceMidi,
        args.stage,
        args.offlineResponder,
        attempt + 1,
      );
      priorResponse = completion.content;
      try {
        throwForCompletionFailure(completion);
      } catch (error) {
        failure = error instanceof Error
          ? error.message
          : "The provider returned a non-success completion; return a complete replacement.";
        if (attempt >= maxAttempts - 1) throw error;
        if (args.repairBudget) args.repairBudget.used += 1;
        continue;
      }
      const payload = parseObject(completion.content);
      args.validate(payload);
      return { payload, repairs: attempt };
    } catch (error) {
      if (error instanceof ProviderCallError) throw error;
      failure = error instanceof Error ? error.message : "The response failed the experiment validator.";
      if (attempt >= maxAttempts - 1) throw error;
      if (args.repairBudget) args.repairBudget.used += 1;
      priorResponse = priorResponse || "";
    }
  }
  throw new Error("The bounded response repair loop ended unexpectedly.");
}

function sourceContext(score: ScoreValue, sourceMidi: AnyRecord[]): AnyRecord {
  return {
    completeScore: score,
    completeSourceMidi: sourceMidi,
    supportedCatalog: playableInstrumentCatalogPrompt(),
    request,
    segmentRules: SEGMENT_RULES,
  };
}

async function loadSkillDocuments(): Promise<SkillDocuments> {
  const [style, concept, verification] = await Promise.all([
    readFile(join(skillDirectory, "style.md"), "utf8"),
    readFile(join(skillDirectory, "concept.md"), "utf8"),
    readFile(join(skillDirectory, "verification.md"), "utf8"),
  ]);
  return { style, concept, verification };
}

async function verifyFrozenSource(): Promise<AnyRecord> {
  const [current, frozen, metadataRaw, hashesRaw] = await Promise.all([
    readFile(join(here, "experiment.ts")),
    readFile(sourceSnapshotPath),
    readFile(sourceFreezePath, "utf8"),
    readFile(productionHashesPath, "utf8"),
  ]);
  const currentSha256 = sha256(current);
  const frozenSha256 = sha256(frozen);
  const metadata = JSON.parse(metadataRaw) as AnyRecord;
  const productionHashes = JSON.parse(hashesRaw) as { modules?: Array<{ path?: unknown; sha256?: unknown }> };
  if (currentSha256 !== frozenSha256 || metadata.sha256 !== frozenSha256) {
    throw new Error("Executed source freeze does not match experiment.ts; refusing to launch.");
  }
  if (!Array.isArray(productionHashes.modules) || productionHashes.modules.length === 0) {
    throw new Error("Production module hash manifest is missing; refusing to launch.");
  }
  for (const module of productionHashes.modules) {
    if (typeof module.path !== "string" || typeof module.sha256 !== "string") {
      throw new Error("Production module hash manifest is malformed; refusing to launch.");
    }
    const moduleBytes = await readFile(join(here, "../../..", module.path));
    if (sha256(moduleBytes) !== module.sha256) {
      throw new Error(`Imported production module hash changed: ${module.path}; refusing to launch.`);
    }
  }
  return {
    ...metadata,
    sha256: frozenSha256,
    bytes: frozen.byteLength,
    currentSourceSha256: currentSha256,
    productionModuleHashesVerified: true,
    productionModuleHashesPath: "production-module-hashes.json",
  };
}

function validateSkillPayload(payload: AnyRecord, score: ScoreValue): AdviserSuggestion[] {
  if (typeof payload.insight !== "string" || !payload.insight.trim()) {
    throw new Error("The on-demand skill did not return actionable insight.");
  }
  return normalizeAdviserSuggestions(payload.suggestions, score, { omitInvalidOptionalMidiClip: true });
}

function validatePlanPayload(payload: AnyRecord, score: ScoreValue): AdviserSuggestion[] {
  const forbidden = ["operations", "membershipProposals", "trackProposals", "instrumentNeeds", "trackChanges", "edits"]
    .filter((key) => Array.isArray(payload[key]) && (payload[key] as unknown[]).length > 0);
  if (forbidden.length) throw new Error(`The consolidated Orchestrator plan attempted forbidden capability: ${forbidden.join(", ")}.`);
  if (!Array.isArray(payload.trackInstructions) || payload.trackInstructions.length !== score.tracks.length) {
    throw new Error("The consolidated Orchestrator plan must assign exactly one writer instruction to every retained track.");
  }
  const ids = new Set<string>();
  for (const raw of payload.trackInstructions) {
    if (!raw || typeof raw !== "object") throw new Error("A consolidated track instruction was malformed.");
    const item = raw as AnyRecord;
    const trackId = typeof item.trackId === "string" ? item.trackId : "";
    const instruction = typeof item.instruction === "string" ? screenMusicText(item.instruction, "") : "";
    if (!trackId || ids.has(trackId) || !score.tracks.some((track) => track.id === trackId) ||
      !instruction || instruction.length > 5_000) {
      throw new Error("A consolidated track instruction did not target one exact retained track.");
    }
    ids.add(trackId);
  }
  if (ids.size !== score.tracks.length) throw new Error("The consolidated plan omitted a retained track writer.");
  return normalizeAdviserSuggestions(payload.privateMidiSuggestions, score, { omitInvalidOptionalMidiClip: true });
}

function validateOperationsPayload(payload: AnyRecord, base: ScoreValue, trackId: string): AnyRecord[] {
  if (typeof payload.summary !== "string" || !payload.summary.trim() || payload.summary.length > 1_200) {
    throw new Error("The instrument writer returned an invalid summary.");
  }
  if (!Array.isArray(payload.operations) || payload.operations.length === 0) {
    throw new Error("The instrument writer returned no operations.");
  }
  const validated = validateScoreOperations(base, payload.operations);
  const diagnostics = (validated as unknown as { diagnostics?: AnyRecord[] }).diagnostics ?? [];
  if (diagnostics.length || validated.length !== payload.operations.length) {
    throw new Error(`The instrument writer operations failed atomic score validation. Production diagnostic: ${JSON.stringify(diagnostics)}`);
  }
  const operations = validated as AnyRecord[];
  if (operations.some((operation) => operation.trackId !== trackId || operation.type !== "add-region")) {
    throw new Error(`The instrument writer attempted a non-owned operation or removed pre-existing material. Production diagnostic: ${JSON.stringify(operations.map((operation, index) => ({ index, fields: ["trackId", "type"], reason: "writer operation must target only its assigned track with add-region" })))}`);
  }
  return operations;
}

function validateVerificationPayload(payload: AnyRecord): void {
  if (typeof payload.pass !== "boolean" || typeof payload.reason !== "string" ||
    !payload.reason.trim() || payload.reason.length > 1_200) {
    throw new Error("The consolidated Orchestrator verification response was malformed: pass and a bounded non-empty reason are required.");
  }
  const checks = payload.checks;
  const requiredChecks = ["duration", "sectionSpan", "newMaterialPerTrack", "membership", "ownership", "segments", "originalRegions"];
  if (!checks || typeof checks !== "object" || Array.isArray(checks) ||
    requiredChecks.some((key) => typeof (checks as AnyRecord)[key] !== "boolean")) {
    throw new Error(`The consolidated Orchestrator verification response must include boolean checks: ${requiredChecks.join(", ")}.`);
  }
  if (payload.pass !== requiredChecks.every((key) => (checks as AnyRecord)[key] === true)) {
    throw new Error("The consolidated Orchestrator verification pass must agree with every required boolean check.");
  }
}

async function persistPrivateMidi(
  arm: ArmName,
  stage: string,
  suggestion: AdviserSuggestion,
  score: ScoreValue,
  records: PrivateMidiRecord[],
): Promise<PrivateMidiRecord | undefined> {
  if (!suggestion.midiClip) return undefined;
  const target = score.tracks.find((track) => suggestion.targetTrackIds.includes(track.id)) ??
    score.tracks.find((track) => findPlayableInstrument(track.instrument ?? "")?.id === suggestion.instrumentId);
  if (!target) return undefined;
  const safeName = suggestion.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const path = join(privateMidiPath, `${arm}-${stage}-${safeName}-${randomUUID()}.mid`);
  const bytesValue = encodeTrackMidi(
    { tempo: suggestion.midiClip.tempo },
    {
      id: `private-${suggestion.id}`,
      name: suggestion.label,
      instrument: target.instrument,
      midiProgram: target.midiProgram,
      regions: [{ startBeat: 0, notes: suggestion.midiClip.notes }],
    },
  );
  await writeFile(path, bytesValue);
  const record: PrivateMidiRecord = {
    arm,
    stage,
    suggestionId: suggestion.id,
    label: suggestion.label,
    path: path.slice(here.length + 1),
    bytes: bytesValue.byteLength,
    sha256: sha256(bytesValue),
    durationBeats: suggestion.midiClip.durationBeats,
    noteCount: suggestion.midiClip.notes.length,
    targets: suggestion.targetTrackIds,
  };
  records.push(record);
  return record;
}

function privateMidiRef(
  arm: ArmName,
  stage: string,
  suggestion: AdviserSuggestion,
  score: ScoreValue,
  records: PrivateMidiRecord[],
): AnyRecord {
  const id = randomUUID();
  const objectPath = `/objects/projects/intro-workflow-comparison/${id}/${randomUUID()}`;
  const target = score.tracks.find((track) => suggestion.targetTrackIds.includes(track.id));
  const playable = findPlayableInstrument(suggestion.instrumentId ?? target?.instrument ?? "");
  const clip = suggestion.midiClip as AdvisoryMidiClip | undefined;
  const path = join(privateMidiPath, `${arm}-${stage}-${id}.mid`);
  if (!clip || !target) throw new Error("Private MIDI reference was requested without a bound suggestion target.");
  const midi = encodeTrackMidi(
    { tempo: clip.tempo },
    { id: `private-${id}`, name: suggestion.label, instrument: target.instrument, midiProgram: target.midiProgram, regions: [{ startBeat: 0, notes: clip.notes }] },
  );
  return {
    id,
    objectPath,
    sha256: sha256(midi),
    label: suggestion.label,
    alignment: { startBeat: 0, durationBeats: clip.durationBeats },
    targets: {
      trackIds: suggestion.targetTrackIds,
      instrumentIds: playable ? [playable.id] : [],
      instruments: playable ? [playable.name] : [],
    },
    path,
    midi,
    arm,
    stage,
    records,
  };
}

async function saveCurrentPrivateMidi(
  suggestion: AdviserSuggestion,
  score: ScoreValue,
  records: PrivateMidiRecord[],
  store: Map<string, AdvisoryMidiClip>,
): Promise<AdvisoryMidiRef> {
  const ref = privateMidiRef("current-adviser-first", "adviser", suggestion, score, records);
  await writeFile(ref.path as string, ref.midi as Buffer);
  store.set(ref.objectPath as string, clone(suggestion.midiClip as AdvisoryMidiClip));
  records.push({
    arm: "current-adviser-first",
    stage: "adviser",
    suggestionId: suggestion.id,
    label: suggestion.label,
    path: (ref.path as string).slice(here.length + 1),
    bytes: (ref.midi as Buffer).byteLength,
    sha256: String(ref.sha256),
    durationBeats: Number((ref.alignment as AnyRecord).durationBeats),
    noteCount: suggestion.midiClip?.notes.length ?? 0,
    targets: suggestion.targetTrackIds,
  });
  const { path: _path, midi: _midi, arm: _arm, stage: _stage, records: _records, ...publicRef } = ref;
  return publicRef as AdvisoryMidiRef;
}

async function materializePrivateSuggestion(
  suggestion: AdviserSuggestion,
  score: ScoreValue,
  arm: ArmName,
  stage: string,
  records: PrivateMidiRecord[],
  store: Map<string, AdvisoryMidiClip>,
): Promise<AdviserSuggestion> {
  if (!suggestion.midiClip) return suggestion;
  const ref = privateMidiRef(arm, stage, suggestion, score, records);
  await writeFile(ref.path as string, ref.midi as Buffer);
  store.set(ref.objectPath as string, clone(suggestion.midiClip));
  records.push({
    arm,
    stage,
    suggestionId: suggestion.id,
    label: suggestion.label,
    path: (ref.path as string).slice(here.length + 1),
    bytes: (ref.midi as Buffer).byteLength,
    sha256: String(ref.sha256),
    durationBeats: Number((ref.alignment as AnyRecord).durationBeats),
    noteCount: suggestion.midiClip.notes.length,
    targets: suggestion.targetTrackIds,
  });
  const { path: _path, midi: _midi, arm: _arm, stage: _stage, records: _records, midiClip: _midiClip, ...publicRef } = ref;
  const { midiClip: _discardedClip, ...withoutClip } = suggestion;
  return { ...withoutClip, advisoryMidiRef: publicRef as AdvisoryMidiRef };
}

async function materializePrivateSuggestions(
  suggestions: AdviserSuggestion[],
  score: ScoreValue,
  arm: ArmName,
  stage: string,
  records: PrivateMidiRecord[],
  store: Map<string, AdvisoryMidiClip>,
): Promise<AdviserSuggestion[]> {
  return Promise.all(suggestions.map((suggestion) =>
    materializePrivateSuggestion(suggestion, score, arm, stage, records, store)));
}

function dereferenceTargetedSuggestions(
  suggestions: unknown,
  trackId: string,
  store: Map<string, AdvisoryMidiClip>,
  onLoad: () => void,
): AnyRecord[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const suggestion = candidate as AnyRecord;
    const ref = suggestion.advisoryMidiRef;
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return [];
    const refValue = ref as AnyRecord;
    const targets = refValue.targets && typeof refValue.targets === "object" && !Array.isArray(refValue.targets)
      ? refValue.targets as AnyRecord
      : undefined;
    const targetTrackIds = Array.isArray(targets?.trackIds) ? targets.trackIds : [];
    if (!targetTrackIds.includes(trackId)) return [];
    const objectPath = typeof refValue.objectPath === "string" ? refValue.objectPath : "";
    const clip = store.get(objectPath);
    if (!clip) throw new Error(`The experiment-private advisory MIDI reference ${objectPath || "without a path"} was not found.`);
    onLoad();
    return [{ ...suggestion, advisoryMidi: { ...clone(clip), sourceRefId: refValue.id } }];
  });
}

async function writeCandidateMidi(arm: ArmName, score: ScoreValue): Promise<string[]> {
  const paths: string[] = [];
  for (const track of score.tracks) {
    const path = join(midiPath, `${arm}-${track.id}.mid`);
    await writeFile(path, encodeTrackMidi(score, track));
    paths.push(path.slice(here.length + 1));
  }
  return paths;
}

function updateLimits(limits: ModelLimits, calls: CallMetric[]): void {
  for (const call of calls) {
    limits.observedMaxInputChars = Math.max(limits.observedMaxInputChars, call.inputChars);
    limits.observedMaxInputBytes = Math.max(limits.observedMaxInputBytes, call.inputBytes);
    limits.observedMaxMessageChars = Math.max(limits.observedMaxMessageChars, call.messageChars);
    limits.observedMaxMessageBytes = Math.max(limits.observedMaxMessageBytes, call.messageBytes);
  }
}

function currentExperimentCompletionBudget(messages: ModelMessage[], requested: number): number {
  const text = messages.map((message) => message.content).join("\n");
  return /adviser|specialist|instrument writer|planner|review|orchestrator/i.test(text)
    ? LARGE_CONTEXT_COMPLETION_TOKENS
    : requested;
}

async function runCurrentArm(
  connectors: ReplitConnectors,
  model: ProviderModel,
  baseline: ScoreValue,
  sourceMidi: AnyRecord[],
  calls: CallMetric[],
  offlineResponder?: OfflineResponder,
): Promise<ArmResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const events: unknown[] = [];
  const errors: Array<{ code?: string; message: string }> = [];
  const privateMidi: PrivateMidiRecord[] = [];
  const privateMidiStore = new Map<string, AdvisoryMidiClip>();
  let advisoryMidiLoads = 0;
  const baselineCopy = clone(baseline);
  let candidate: ScoreValue | undefined;
  let operations: AnyRecord[] = [];
  let workflow: AnyRecord | undefined;
  let repairs = 0;
  try {
    const workflowModel: WorkflowModel = {
      complete: async (messages, maxTokens) => (await providerCompletion(
        connectors,
        model.id,
        "current-adviser-first",
        messages,
        currentExperimentCompletionBudget(messages, maxTokens),
        calls,
        baseline,
        sourceMidi,
        undefined,
        offlineResponder,
      )).content,
      completeDetailed: async (messages, maxTokens) => providerCompletion(
        connectors,
        model.id,
        "current-adviser-first",
        messages,
        currentExperimentCompletionBudget(messages, maxTokens),
        calls,
        baseline,
        sourceMidi,
        undefined,
        offlineResponder,
      ),
    };
    const result = await runCompositionWorkflow({
      model: workflowModel,
      message: request.message,
      safeDirection: request.safeDirection,
      originalMessage: request.message,
      selectedStyle: request.selectedStyle,
      intent: "edit",
      history: [],
      score: baselineCopy,
      sourceMidi,
      onEvent: (event) => events.push(event),
       persistAdvisoryMidiClip: async (suggestion, score) => saveCurrentPrivateMidi(suggestion, score, privateMidi, privateMidiStore),
       loadAdvisoryMidiRef: async (ref): Promise<MaterializedAdvisoryMidi> => {
         const clip = privateMidiStore.get(ref.objectPath);
         if (!clip) throw new Error("The experiment-private advisory MIDI reference was not found.");
         advisoryMidiLoads += 1;
         return { ...clone(clip), sourceRefId: ref.id };
       },
    });
    workflow = {
      status: result.status,
      summary: result.summary,
      tasks: result.tasks,
      consultations: result.consultations,
      changedFiles: result.changedFiles,
      trackProposals: result.trackProposals,
      workflowEventCount: result.events.length,
    };
    operations = result.operations as AnyRecord[];
    const validated = validateScoreOperations(baselineCopy, operations);
    const diagnostics = (validated as unknown as { diagnostics?: unknown[] }).diagnostics ?? [];
    if (diagnostics.length || validated.length !== operations.length || !operations.length) {
      throw new Error("The existing workflow returned operations that failed the experiment's atomic validation.");
    }
    candidate = applyOperations(baselineCopy, validated as AnyRecord[]);
    if (stable(baseline) !== stable(baselineCopy)) throw new Error("Current arm baseline copy changed before apply.");
  } catch (error) {
    errors.push(errorInfo(error));
  }
  const baselineUnchanged = stable(baseline) === stable(baselineCopy);
  const objectiveRubric = evaluateObjective(baseline, candidate, operations, baselineUnchanged);
  if (candidate) {
    await writeJson(currentCandidatePath, candidate);
  }
  const end = Date.now();
  const writerCalls = calls.filter((call) =>
    call.arm === "current-adviser-first" && (call.stage === "instrument-writer" || call.stage === "current-workflow") &&
    call.writerPromptHasSegmentBounds !== undefined,
  );
  const callsWithBounds = writerCalls.filter((call) => call.writerPromptHasSegmentBounds).length;
  const writerRepairAttempts = events.filter((event) =>
    event && typeof event === "object" && (event as AnyRecord).stage === "operation-format-repair",
  ).length;
  return {
    arm: "current-adviser-first",
    status: candidate && !errors.length && objectiveRubric.pass ? "verified" : "failed",
    approved: false,
    startedAt,
    completedAt: new Date().toISOString(),
    wallMs: end - started,
    model: model.id,
    workflow,
    candidate,
    ...(candidate ? { candidateScorePath: currentCandidatePath.slice(here.length + 1) } : {}),
    operations,
    events,
    errors,
    repairs,
    privateMidi,
    advisoryMidiLoads,
    writerAttempts: writerCalls.length,
    writerRepairAttempts,
    writerRepairLimit: 2,
    objectiveRubric,
    selfVerification: workflow ? { existingWorkflowReturnedVerified: workflow.status === "verified" } : undefined,
    baselineUnchanged,
    writerPromptChecks: {
      writerCalls: writerCalls.length,
      callsWithSegmentBounds: callsWithBounds,
      allWriterCallsHadSegmentBounds: writerCalls.length > 0 && callsWithBounds === writerCalls.length,
      note: `The production writer schema itself includes 128-beat, 512-note, 512-startBeat, and 60-operation limits; this arm also received the same explicit segment rules and sparse-writing direction in safeDirection. The experiment adapter lifted adviser-stage completion budgets to ${LARGE_CONTEXT_COMPLETION_TOKENS} tokens; normal production behavior is unchanged.`,
    },
  };
}

async function runConsolidatedArm(
  connectors: ReplitConnectors,
  model: ProviderModel,
  baseline: ScoreValue,
  sourceMidi: AnyRecord[],
  calls: CallMetric[],
  skills: SkillDocuments,
  offlineResponder?: OfflineResponder,
): Promise<ArmResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const events: unknown[] = [];
  const errors: Array<{ code?: string; message: string }> = [];
  const privateMidi: PrivateMidiRecord[] = [];
  const privateMidiStore = new Map<string, AdvisoryMidiClip>();
  let advisoryMidiLoads = 0;
  const writerRepairBudget = { used: 0, max: 2 };
  const baselineCopy = clone(baseline);
  let candidate: ScoreValue | undefined;
  let operations: AnyRecord[] = [];
  let repairs = 0;
  let selfVerification: AnyRecord | undefined;
  let plan: AnyRecord | undefined;
  const styleContext = {
    ...sourceContext(baselineCopy, sourceMidi),
    loadedSkillDocuments: { style: skills.style },
    orchestrationProtocol: "One Orchestrator progressively invokes style, concept, plan, retained writers, then verification; no separate adviser personas.",
  };
  try {
    events.push({ stage: "orchestrator-started", message: "Consolidated Orchestrator started a sequential on-demand skill flow." });
    const style = await requestJson({
      connectors,
      model: model.id,
      arm: "consolidated-orchestrator",
      stage: "skill-style",
       agent: "Orchestrator",
       system: `You are the single consolidated Orchestrator invoking the loaded style skill, read-only and advisory. This is not a separate adviser persona. Inspect the complete score, complete source MIDI, and loaded reusable style skill document. Return JSON only: {"insight":"actionable original-neutral style guidance","suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact retained track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":72,"durationBeats":16,"notes":[{"pitch":60,"velocity":70,"startBeat":0,"durationBeats":1}]}}]}. The optional midiClip is private advisory MIDI only; it is never a score operation or a track. Use only the playable catalog. Do not return operations, membership changes, or copied named references. ${SEGMENT_RULES} ${SPARSE_WRITING_RULES} ${playableInstrumentCatalogPrompt()}`,
       user: { ...styleContext, activeSkill: "style" },
       maxTokens: LARGE_CONTEXT_COMPLETION_TOKENS,
      calls,
      score: baselineCopy,
      sourceMidi,
      validate: (payload) => {
        validateSkillPayload(payload, baselineCopy);
      },
       offlineResponder,
    });
    repairs += style.repairs;
     const styleSuggestions = await materializePrivateSuggestions(
       validateSkillPayload(style.payload, baselineCopy),
       baselineCopy,
       "consolidated-orchestrator",
       "style",
       privateMidi,
       privateMidiStore,
     );
     style.payload = { ...style.payload, suggestions: styleSuggestions };
     const conceptContext = {
       ...styleContext,
       loadedSkillDocuments: { style: skills.style, concept: skills.concept },
     };
    const concept = await requestJson({
      connectors,
      model: model.id,
      arm: "consolidated-orchestrator",
      stage: "skill-concept",
       agent: "Orchestrator",
       system: `You are the single consolidated Orchestrator invoking the loaded concept skill after style. This is not a separate adviser persona. The call is sequential and receives the complete original context, loaded reusable concept skill document, and accumulated style reply. Return JSON only: {"insight":"actionable original-neutral harmonic, melodic, register, and pacing guidance","suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact retained track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":72,"durationBeats":16,"notes":[{"pitch":60,"velocity":70,"startBeat":0,"durationBeats":1}]}}]}. The optional midiClip is private advisory MIDI only; it is never a score operation or track. Do not return operations or membership changes. ${SEGMENT_RULES} ${SPARSE_WRITING_RULES} ${playableInstrumentCatalogPrompt()}`,
        user: { ...conceptContext, activeSkill: "concept", styleSkill: style.payload },
       maxTokens: LARGE_CONTEXT_COMPLETION_TOKENS,
      calls,
      score: baselineCopy,
      sourceMidi,
      validate: (payload) => {
        validateSkillPayload(payload, baselineCopy);
      },
       offlineResponder,
    });
    repairs += concept.repairs;
     const conceptSuggestions = await materializePrivateSuggestions(
       validateSkillPayload(concept.payload, baselineCopy),
       baselineCopy,
       "consolidated-orchestrator",
       "concept",
       privateMidi,
       privateMidiStore,
     );
     concept.payload = { ...concept.payload, suggestions: conceptSuggestions };
    events.push({ stage: "on-demand-skills-completed", message: "Style then concept skills completed sequentially; advisory MIDI remained private." });

    const planResult = await requestJson({
      connectors,
      model: model.id,
      arm: "consolidated-orchestrator",
      stage: "orchestrator-plan",
       agent: "Orchestrator",
       system: `You are the single consolidated Orchestrator. Combine the loaded style and concept skill documents plus their accumulated replies into a retained-track plan. Return JSON only: {"trackInstructions":[{"trackId":"exact retained track id","instruction":"specific writer direction <=5000 chars"}],"privateMidiSuggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact retained track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":72,"durationBeats":16,"notes":[{"pitch":60,"velocity":70,"startBeat":0,"durationBeats":1}]}}],"verificationChecks":["check"]}. Assign exactly one retained instrument-track writer instruction to every current track. Keep membership unchanged: no operations, additions, deletions, or remapping. privateMidiSuggestions are optional private suggestions, never score writes. ${SEGMENT_RULES} ${SPARSE_WRITING_RULES} ${playableInstrumentCatalogPrompt()}`,
      user: {
         ...conceptContext,
         activeSkill: "plan",
        styleSkill: style.payload,
        conceptSkill: concept.payload,
      },
       maxTokens: LARGE_CONTEXT_COMPLETION_TOKENS,
      calls,
      score: baselineCopy,
      sourceMidi,
      validate: (payload) => {
        validatePlanPayload(payload, baselineCopy);
      },
       offlineResponder,
    });
    repairs += planResult.repairs;
    plan = planResult.payload;
    const planSuggestions = await materializePrivateSuggestions(
      validatePlanPayload(plan, baselineCopy),
      baselineCopy,
      "consolidated-orchestrator",
      "plan",
      privateMidi,
      privateMidiStore,
    );
    plan = { ...plan, privateMidiSuggestions: planSuggestions };
    events.push({ stage: "retained-track-plan-completed", message: "Orchestrator assigned all retained tracks without changing membership." });

    let staged = clone(baselineCopy);
    const instructions = plan.trackInstructions as AnyRecord[];
    for (const instruction of instructions) {
      const trackId = String(instruction.trackId);
      const track = staged.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error(`Consolidated writer track ${trackId} disappeared.`);
      const writer = await requestJson({
        connectors,
        model: model.id,
        arm: "consolidated-orchestrator",
        stage: "instrument-writer",
         agent: `${track.instrument} Instrument Writer`,
         system: `You are the ${track.instrument} Instrument Writer, the production roster agent assigned only to trackId "${track.id}". The Orchestrator coordinates this request but does not replace your instrument-agent identity. Read the complete accumulated score, source MIDI, loaded skill documents, style/concept replies, and Orchestrator instruction, but write only add-region operations on this assigned track. Never remove pre-existing regions, change membership, or address another track. Return JSON only: {"summary":"non-empty <=1200 chars","operations":[...]} and obey this exact production writer contract: ${PRODUCTION_WRITER_CONTRACT} ${SEGMENT_RULES} ${SPARSE_WRITING_RULES} Every added region must be <=${MAX_REGION_BEATS} beats and fit inside score duration ${INTRO_BEATS}; split longer phrases rather than truncating. ${playableInstrumentCatalogPrompt()}`,
        user: {
           ...conceptContext,
           ...sourceContext(staged, sourceMidi),
           activeSkill: "instrument-writer",
          originalScore: baselineCopy,
          assignedTrackId: track.id,
          instruction: instruction.instruction,
          styleSkill: style.payload,
          conceptSkill: concept.payload,
          orchestratorPlan: plan,
           targetedAdvisoryMidi: [
             ...dereferenceTargetedSuggestions(style.payload.suggestions, track.id, privateMidiStore, () => { advisoryMidiLoads += 1; }),
             ...dereferenceTargetedSuggestions(concept.payload.suggestions, track.id, privateMidiStore, () => { advisoryMidiLoads += 1; }),
             ...dereferenceTargetedSuggestions(plan.privateMidiSuggestions, track.id, privateMidiStore, () => { advisoryMidiLoads += 1; }),
           ],
        },
         maxTokens: LARGE_CONTEXT_COMPLETION_TOKENS,
        calls,
        score: staged,
        sourceMidi,
        validate: (payload) => {
          validateOperationsPayload(payload, staged, track.id);
        },
          maxRepairs: 2,
          repairBudget: writerRepairBudget,
          repairLabel: "shared consolidated writer-repair pool",
         offlineResponder,
      });
      repairs += writer.repairs;
      const writerOperations = validateOperationsPayload(writer.payload, staged, track.id);
      if (operations.length + writerOperations.length > MAX_OPERATIONS) {
        throw new Error(`The consolidated operation count exceeded ${MAX_OPERATIONS}.`);
      }
      operations.push(...writerOperations);
      staged = applyOperations(staged, writerOperations);
      events.push({ stage: "track-writer-completed", agent: track.instrument, trackId: track.id, operationCount: writerOperations.length });
    }
    candidate = staged;
    const verification = await requestJson({
      connectors,
      model: model.id,
      arm: "consolidated-orchestrator",
      stage: "orchestrator-verification",
       agent: "Orchestrator",
       system: `You are the single consolidated Orchestrator invoking the loaded verification skill. Independently inspect the complete original score, complete candidate score, complete source MIDI, all operations, and the original neutral request. Sparse rests are allowed; verify the full 0-${INTRO_BEATS} section span and new material on every retained track rather than requiring continuous sound union. Return JSON only: {"pass":boolean,"reason":"bounded explanation","checks":{"duration":boolean,"sectionSpan":boolean,"newMaterialPerTrack":boolean,"membership":boolean,"ownership":boolean,"segments":boolean,"originalRegions":boolean}}. Reject if any pre-existing track/region was lost, any operation is outside its assigned track, any region exceeds ${MAX_REGION_BEATS} beats, any note is invalid, or the candidate does not span all ${INTRO_BEATS} beats. This is verification, not permission to repair or invent music.`,
      user: {
         ...conceptContext,
         loadedSkillDocuments: { style: skills.style, concept: skills.concept, verification: skills.verification },
         activeSkill: "verification",
         request,
        originalScore: baselineCopy,
        candidateScore: candidate,
        operations,
        sourceMidi,
        plan,
      },
       maxTokens: LARGE_CONTEXT_COMPLETION_TOKENS,
      calls,
      score: candidate,
      sourceMidi,
      validate: validateVerificationPayload,
       offlineResponder,
    });
    repairs += verification.repairs;
    selfVerification = verification.payload;
    if (verification.payload.pass !== true) {
      throw new Error(`Consolidated Orchestrator verification rejected the candidate: ${screenMusicText(String(verification.payload.reason), "The candidate failed Orchestrator verification.")}`);
    }
    events.push({ stage: "orchestrator-verified", message: "The consolidated Orchestrator verification pass accepted the staged candidate." });
  } catch (error) {
    errors.push(errorInfo(error));
  }
  const baselineUnchanged = stable(baseline) === stable(baselineCopy);
  const objectiveRubric = evaluateObjective(baseline, candidate, operations, baselineUnchanged);
  if (candidate) await writeJson(orchestratorCandidatePath, candidate);
  const writerCalls = calls.filter((call) =>
    call.arm === "consolidated-orchestrator" && call.stage === "instrument-writer",
  );
  const callsWithBounds = writerCalls.filter((call) => call.writerPromptHasSegmentBounds).length;
  return {
    arm: "consolidated-orchestrator",
    status: candidate && !errors.length && objectiveRubric.pass ? "verified" : "failed",
    approved: false,
    startedAt,
    completedAt: new Date().toISOString(),
    wallMs: Date.now() - started,
    model: model.id,
    candidate,
    ...(candidate ? { candidateScorePath: orchestratorCandidatePath.slice(here.length + 1) } : {}),
    operations,
    events,
    errors,
    repairs,
    privateMidi,
    advisoryMidiLoads,
    writerAttempts: writerCalls.length,
    writerRepairAttempts: writerRepairBudget.used,
    writerRepairLimit: writerRepairBudget.max,
    objectiveRubric,
    selfVerification,
    baselineUnchanged,
    writerPromptChecks: {
      writerCalls: writerCalls.length,
      callsWithSegmentBounds: callsWithBounds,
      allWriterCallsHadSegmentBounds: writerCalls.length > 0 && callsWithBounds === writerCalls.length,
      note: "The consolidated writer prompt repeats the exact segment rules received by the current arm; no arm gets a larger region or operation allowance.",
    },
  };
}

function objectiveScoreForEvaluator(
  candidate: ScoreValue | undefined,
): AnyRecord | null {
  return candidate ? { score: candidate, available: true } : { score: null, available: false };
}

async function runSharedEvaluator(
  connectors: ReplitConnectors,
  model: ProviderModel,
  baseline: ScoreValue,
  current: ArmResult,
  consolidated: ArmResult,
  calls: CallMetric[],
  offlineResponder?: OfflineResponder,
): Promise<AnyRecord> {
  const user = {
    request,
    originalScore: baseline,
    candidates: [
      { id: "candidate-1", ...objectiveScoreForEvaluator(current.candidate) },
      { id: "candidate-2", ...objectiveScoreForEvaluator(consolidated.candidate) },
    ],
  };
  try {
    const result = await requestJson({
      connectors,
      model: model.id,
      arm: "shared",
      stage: "shared-evaluator",
      agent: "Independent evaluator",
       system: `You are an independent blind post-hoc musical evaluator. Do not use either arm's self-verdict, events, or model claims as evidence. Compare the original score and each candidate directly. Apply the same rubric to both candidates: original neutral request followed, candidate spans the full 0-${INTRO_BEATS} section with real notes while allowing sparse rests, new material exists on every retained track, pre-existing regions and retained membership preserved, only playable catalog instruments, valid operation-shaped score data, and an original coherent intro. Return JSON only: {"candidates":[{"id":"candidate-1","available":boolean,"pass":boolean,"reason":"bounded reason","violations":["..."]},{"id":"candidate-2","available":boolean,"pass":boolean,"reason":"bounded reason","violations":["..."]}],"rubric":"same rubric applied blindly to both"}. If a candidate is unavailable, pass must be false. Do not choose a winner and do not treat a provider's own verification as evidence.`,
      user,
       maxTokens: LARGE_CONTEXT_COMPLETION_TOKENS,
      calls,
      score: baseline,
      validate: (payload) => {
        validateEvaluatorPayload(payload, [Boolean(current.candidate), Boolean(consolidated.candidate)]);
      },
      offlineResponder,
    });
    return { status: "verified", ...result.payload };
  } catch (error) {
    return { status: "failed", error: errorInfo(error) };
  }
}

function validateEvaluatorPayload(payload: AnyRecord, expectedAvailability: [boolean, boolean]): void {
  if (!Array.isArray(payload.candidates) || payload.candidates.length !== 2) {
    throw new Error("Shared evaluator did not return exactly two candidate verdicts.");
  }
  const expected = new Map([
    ["candidate-1", expectedAvailability[0]],
    ["candidate-2", expectedAvailability[1]],
  ]);
  const ids = new Set<string>();
  for (const item of payload.candidates as AnyRecord[]) {
    if (!item || typeof item.id !== "string" || !expected.has(item.id) || ids.has(item.id)) {
      throw new Error("Shared evaluator candidate IDs were malformed or duplicated.");
    }
    ids.add(item.id);
    if (typeof item.pass !== "boolean" || typeof item.available !== "boolean" ||
      item.available !== expected.get(item.id) || (!item.available && item.pass !== false) ||
      typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 1_200 ||
      !Array.isArray(item.violations) ||
      item.violations.some((violation) => typeof violation !== "string" || !violation.trim() || violation.length > 1_200)) {
      throw new Error("Shared evaluator returned an incomplete, unsafe, or availability-inconsistent candidate verdict.");
    }
  }
  if (ids.size !== 2 || typeof payload.rubric !== "string" || !payload.rubric.trim() || payload.rubric.length > 1_200) {
    throw new Error("Shared evaluator rubric or candidate coverage was malformed.");
  }
}

function blindVerdict(shared: AnyRecord, id: string): boolean | undefined {
  if (!Array.isArray(shared.candidates)) return undefined;
  const verdict = (shared.candidates as AnyRecord[]).find((candidate) => candidate.id === id);
  return verdict && verdict.available === true && verdict.pass === true ? true :
    verdict && verdict.available === false && verdict.pass === false ? false :
      undefined;
}

function blindAvailability(shared: AnyRecord, id: string): boolean | undefined {
  if (!Array.isArray(shared.candidates)) return undefined;
  const verdict = (shared.candidates as AnyRecord[]).find((candidate) => candidate.id === id);
  return verdict && typeof verdict.available === "boolean" ? verdict.available : undefined;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function report(
  outcome: AnyRecord,
  model: ProviderModel | undefined,
  calls: CallMetric[],
): string {
  const arms = outcome.arms as ArmResult[];
  const line = (arm: ArmResult) => {
    const rubric = arm.objectiveRubric;
    return [
      `- **${arm.arm}**: status=${arm.status}; approved=${arm.approved}; wall=${arm.wallMs} ms; calls=${calls.filter((call) => call.arm === arm.arm).length}; repairs=${arm.repairs};`,
      `  candidate=${arm.candidate ? "captured separately" : "unavailable"}; objective=${rubric?.pass ? "pass" : "fail"};`,
      `  section-span=${rubric ? `${rubric.sectionStartBeat.toFixed(2)}-${rubric.sectionEndBeat.toFixed(2)} (${rubric.sectionSpanBeats.toFixed(2)} beats)` : "n/a"}; duration=${rubric?.durationBeats ?? "n/a"} beats;`,
      `  coverage-density=${rubric ? `${rubric.coverageDensityBeats.toFixed(2)} beats (${(rubric.coverageDensityFraction * 100).toFixed(1)}%, ${rubric.barsWithAnyNote}/${INTRO_BARS} bars)` : "n/a"}; new-material-tracks=${rubric?.tracksWithNewMaterial.join(", ") || "none"};`,
      `  private MIDI=${arm.privateMidi.length}; segment-bounds=${arm.writerPromptChecks.callsWithSegmentBounds}/${arm.writerPromptChecks.writerCalls}.`,
    ].join("\n");
  };
  const callSizes = calls.map((call) => call.inputBytes);
  const maxInput = callSizes.length ? Math.max(...callSizes) : 0;
  const shared = outcome.sharedEvaluator as AnyRecord;
  const recommendation = arms.every((arm) => arm.approved)
    ? "Both candidates cleared local atomic checks, consolidated/current verification, and the shared blind evaluator. This remains one paired sample, not a general performance claim."
    : "Do not promote either arm from this sample. Keep any captured candidate as unapproved evidence and address the listed objective/provider failures before another explicitly authorized experiment.";
  return `# 64-bar intro workflow comparison

## Run status

One corrected paired live xAI run completed. The experiment was isolated under \`docs/verification/intro-workflow-comparison-corrected\`; no saved project, project ID, normal route, or UI was touched. This is a small-sample limitation: one prompt and one paired run cannot establish general quality, latency, or cost superiority, and no repeated expensive retry was made outside each arm's bounded repair policy.

The source freeze/hash, exact launch command, PID, and artifact locations are recorded in \`source-freeze.json\`, \`job-info.json\`, and \`run-lock.json\`; stdout/stderr is \`run.log\`. The paired run did not use the locked \`evaluation-feedback/run-real-xai-verification.ts\` harness. The prior pilot's executed bytes were not frozen and cannot be reconstructed; its evidence remains separate and unchanged.

## Shared request and safeguards

- Request: original, neutral, non-referential cinematic intro; exactly ${INTRO_BARS} bars in 4/4 (${INTRO_BEATS} beats), retained Piano, String Ensemble, and French Horn tracks. Sparse rests are allowed; the objective checks section span and new material per retained track, not continuous sound union.
- Both arms received the identical explicit segment rules: regions <=${MAX_REGION_BEATS} beats, <=${MAX_NOTES_PER_REGION} notes/region, startBeat <=512, <=${MAX_OPERATIONS} operations, region-relative note offsets, and full 256-beat section span; sparse rests do not fail the span check.
- Both arms used the experiment-only ${LARGE_CONTEXT_COMPLETION_TOKENS}-token completion budget for equivalent advisory/skill work. The current arm reused the production adviser-first workflow through an adapter override; normal production remains unchanged.
- The consolidated arm is one consistent Orchestrator progressively loading the reusable style, concept, and verification skill documents, then accumulating replies into plan, retained-track writers, and verification. This prototype uses a fixed bounded style -> concept -> plan -> writers -> verification sequence, not an adaptive skill selector, and does not create separate adviser personas. Optional skill MIDI remained private.
- Current writer audit: ${arms[0]?.writerPromptChecks.note ?? "not available"} Consolidated writer audit: ${arms[1]?.writerPromptChecks.note ?? "not available"}.
- Both arms were checked locally for atomic validation, ownership, catalog membership, retained regions, segment bounds, semantic change, and complete coverage before approval. A failed arm is never labeled successful; a safely reconstructed candidate is stored separately as unapproved evidence.

## Observed arm results

${arms.map(line).join("\n")}

## Context, provider metadata, and feasibility

- Selected model: \`${model?.id ?? "unavailable"}\`.
- Model limit metadata (when returned, non-secret fields only): \`${JSON.stringify(model?.limits.selectedMetadata ?? {})}\`.
- Observed maximum request input: ${maxInput} bytes / ${calls.length ? Math.max(...calls.map((call) => call.inputChars)) : 0} UTF-16 chars; observed max message content: ${model?.limits.observedMaxMessageBytes ?? 0} bytes / ${model?.limits.observedMaxMessageChars ?? 0} chars. Completion budget was ${LARGE_CONTEXT_COMPLETION_TOKENS} tokens in both arms; actual provider usage remains in call metrics.
- Per-call exact input/output character and byte counts, provider usage tokens, finish reason, request ID, transport attempts, and wall time are in \`call-metrics.json\`. No score or skill context was arbitrarily truncated; the report records feasibility from actual provider requests and returned usage.
- Provider input/output token counts were returned for ${calls.filter((call) => call.providerInputTokens !== undefined || call.providerOutputTokens !== undefined).length}/${calls.length} calls. Missing usage is reported as missing, not estimated.

## Independent post-hoc rubric

The shared evaluator used one blind rubric for opaque candidate-1 and candidate-2 only when at least one candidate existed. It did not receive either arm's self-verdict. Its result is in \`outcome.json\`, while the objective checks are in each arm's \`objectiveRubric\`. Shared evaluator status=${shared.status}; candidate-1 pass=${blindVerdict(shared, "candidate-1") ?? "unavailable"}; candidate-2 pass=${blindVerdict(shared, "candidate-2") ?? "unavailable"}.

## Recommendation

${recommendation}

Measured root causes and limitations are in each arm's errors/events and \`call-metrics.json\`; do not infer a strategy quality trade-off from an arm that failed before producing a candidate. This corrected run specifically tests whether matched ample completion budgets and the progressively accumulated Orchestrator context get past the prior setup failure.
`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--offline-fixture")) {
    const result = await runOfflineEndToEndFixture();
    await writeJson(offlineFixturePath, result);
    console.log(JSON.stringify(result));
    return;
  }
  if (process.argv.includes("--fixtures")) {
    console.log(JSON.stringify(runFixtures()));
    return;
  }
  if (process.argv.includes("--verify-freeze")) {
    console.log(JSON.stringify(await verifyFrozenSource()));
    return;
  }
  if (!process.argv.includes("--run")) {
    throw new Error("This one-shot experiment requires --run.");
  }
  const sourceFreeze = await verifyFrozenSource();
  const fixtureResult = runFixtures();
  try {
    await access(lockPath);
    throw new Error("The paired intro experiment is already locked; no repeated live run is permitted.");
  } catch (error) {
    if (error instanceof Error && !/ENOENT/.test(error.message)) throw error;
  }
  try {
    await access(outcomePath);
    throw new Error("The paired intro experiment already has an outcome; no repeated live run is permitted.");
  } catch (error) {
    if (error instanceof Error && !/ENOENT/.test(error.message)) throw error;
  }
  await mkdir(privateMidiPath, { recursive: true });
  await mkdir(midiPath, { recursive: true });
  const baseline = makeBaseline();
  await writeJson(baselinePath, baseline);
  const startedAt = new Date().toISOString();
  const calls: CallMetric[] = [];
  await writeJson(lockPath, {
    schemaVersion: 1,
    runId: randomUUID(),
    pid: process.pid,
    startedAt,
    provider: "xai",
    experiment: "64-bar-intro-workflow-comparison",
    arms: ["current-adviser-first", "consolidated-orchestrator"],
    baselinePath: "baseline.json",
    baselineSha256: sha256(stable(baseline)),
    sourceFreezeSha256: sourceFreeze.sha256,
    request,
    note: `One isolated paired live run. Baseline is synthetic and no saved project is used. Both arms use the experiment-only ${LARGE_CONTEXT_COMPLETION_TOKENS}-token completion budget for equivalent advisory/skill work; the normal production budget is not changed.`,
  });
  const connectors = new ReplitConnectors();
  let model: ProviderModel | undefined;
  let discoveryError: { code?: string; message: string } | undefined;
  try {
    model = await discoverModel(connectors, calls);
  } catch (error) {
    discoveryError = errorInfo(error);
  }
  const sourceMidi = makeSourceMidi(baseline);
  let current: ArmResult;
  let consolidated: ArmResult;
  if (!model) {
    const failed = (arm: ArmName): ArmResult => ({
      arm,
      status: "failed",
      approved: false,
      startedAt,
      completedAt: new Date().toISOString(),
      wallMs: 0,
      operations: [],
      events: [],
      errors: [discoveryError ?? { message: "xAI model discovery failed." }],
      repairs: 0,
      privateMidi: [],
      baselineUnchanged: true,
      objectiveRubric: evaluateObjective(baseline, undefined, [], true),
      writerPromptChecks: {
        writerCalls: 0,
        callsWithSegmentBounds: 0,
        allWriterCallsHadSegmentBounds: false,
        note: "No writer calls launched because provider model discovery failed.",
      },
    });
    current = failed("current-adviser-first");
    consolidated = failed("consolidated-orchestrator");
  } else {
    current = await runCurrentArm(connectors, model, baseline, sourceMidi, calls);
    const skills = await loadSkillDocuments();
    consolidated = await runConsolidatedArm(connectors, model, baseline, sourceMidi, calls, skills);
  }
  await writeJson(currentEventsPath, current.events);
  await writeJson(orchestratorEventsPath, consolidated.events);
  const sharedEvaluatorResult = !current.candidate && !consolidated.candidate
    ? { status: "not-run-no-candidates", reason: "Both arms produced no candidate score; blind evaluation was skipped." }
    : model
      ? await runSharedEvaluator(connectors, model, baseline, current, consolidated, calls)
      : { status: "not-run", error: discoveryError };
  const currentBlind = blindVerdict(sharedEvaluatorResult, "candidate-1");
  const consolidatedBlind = blindVerdict(sharedEvaluatorResult, "candidate-2");
  const evaluatorVerified = sharedEvaluatorResult.status === "verified";
  current.approved = Boolean(evaluatorVerified && current.status === "verified" && current.objectiveRubric?.pass &&
    current.selfVerification?.existingWorkflowReturnedVerified === true &&
    blindAvailability(sharedEvaluatorResult, "candidate-1") === true && currentBlind === true);
  consolidated.approved = Boolean(evaluatorVerified && consolidated.status === "verified" && consolidated.objectiveRubric?.pass &&
    consolidated.selfVerification?.pass === true &&
    blindAvailability(sharedEvaluatorResult, "candidate-2") === true && consolidatedBlind === true);
  if (current.approved && current.candidate) {
    await writeJson(currentApprovedPath, current.candidate);
    await writeCandidateMidi("current-adviser-first", current.candidate);
    current.approvedScorePath = currentApprovedPath.slice(here.length + 1);
  }
  if (consolidated.approved && consolidated.candidate) {
    await writeJson(orchestratorApprovedPath, consolidated.candidate);
    await writeCandidateMidi("consolidated-orchestrator", consolidated.candidate);
    consolidated.approvedScorePath = orchestratorApprovedPath.slice(here.length + 1);
  }
  updateLimits(model?.limits ?? {
    selectedModel: "unavailable",
    selectedMetadata: {},
    observedMaxInputChars: 0,
    observedMaxInputBytes: 0,
    observedMaxMessageChars: 0,
    observedMaxMessageBytes: 0,
  }, calls);
  await writeJson(callsPath, calls);
  const outcome: AnyRecord = {
    schemaVersion: 1,
    status: current.approved || consolidated.approved ? "paired-result-with-valid-candidate" : "paired-run-failed-or-unapproved",
    startedAt,
    completedAt: new Date().toISOString(),
    provider: "xai",
    model: model?.id,
    modelLimits: model?.limits,
    sourceFreeze,
    fixtureResult,
    completionBudget: {
      currentAdviserStages: LARGE_CONTEXT_COMPLETION_TOKENS,
      consolidatedSkillPlanWriterVerification: LARGE_CONTEXT_COMPLETION_TOKENS,
      sharedEvaluator: LARGE_CONTEXT_COMPLETION_TOKENS,
      normalProductionWorkflowChanged: false,
    },
    request,
    segmentRules: {
      introBars: INTRO_BARS,
      timeSignature: "4/4",
      durationBeats: INTRO_BEATS,
      maxRegionBeats: MAX_REGION_BEATS,
      maxNotesPerRegion: MAX_NOTES_PER_REGION,
      maxOperations: MAX_OPERATIONS,
      sameRulesInBothArms: true,
    },
    baseline: {
      path: "baseline.json",
      sha256: sha256(stable(baseline)),
      durationBeats: baseline.durationBeats,
      coverage: coverage(baseline),
      trackIds: baseline.tracks.map((track) => track.id),
      catalog: baseline.tracks.map((track) => ({ id: track.id, instrument: track.instrument, midiProgram: track.midiProgram })),
    },
    arms: [current, consolidated],
    sharedEvaluator: sharedEvaluatorResult,
    callTotals: {
      totalProviderCalls: calls.length,
      byArm: Object.fromEntries(
        [...new Set(calls.map((call) => call.arm))].map((arm) => [
          arm,
          calls.filter((call) => call.arm === arm).length,
        ]),
      ),
      totalRepairs: current.repairs + consolidated.repairs,
      wallMsByArm: {
        "current-adviser-first": current.wallMs,
        "consolidated-orchestrator": consolidated.wallMs,
      },
    },
    segmentBoundPromptAudit: {
      currentWriterPrompt: current.writerPromptChecks,
      consolidatedWriterPrompt: consolidated.writerPromptChecks,
      sameExplicitRulesRequested: true,
      omissionStatus: current.writerPromptChecks.writerCalls === 0 || consolidated.writerPromptChecks.writerCalls === 0
        ? "not-observable-for-at-least-one-arm-because-writer-did-not-launch"
        : "observed",
    },
    callsPath: "call-metrics.json",
    smallSampleLimitation: "One paired run for one long prompt is directional evidence only; no repeated expensive retries were made beyond bounded workflow/adapter repairs.",
    savedProjectTouched: false,
    normalProductionWorkflowChanged: false,
  };
  await writeJson(outcomePath, outcome);
  await writeFile(reportPath, report(outcome, model, calls), "utf8");
}

await main();