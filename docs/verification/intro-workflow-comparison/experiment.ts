import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
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

const BAR_BEATS = 4;
const INTRO_BARS = 64;
const INTRO_BEATS = BAR_BEATS * INTRO_BARS;
const TEMPO = 72;
const MAX_REGION_BEATS = 128;
const MAX_NOTES_PER_REGION = 512;
const MAX_OPERATIONS = 60;

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
  "Notes use region-relative startBeat values; each region and note must remain inside its declared duration. Do not shorten the 256-beat request to fit one region.",
].join(" ");

const request = {
  message: [
    "Write an original, neutral cinematic film-score intro with no named references, titles, quoted material, or imitation language.",
    "It must be a complete 64-bar introduction in 4/4 (exactly 256 beats) with a restrained, gradually widening arc: a quiet opening, a clear central lift, and a resolved but open handoff at the end.",
    "Retain every pre-existing track and its existing regions. Use only the existing playable catalog tracks (Piano, String Ensemble, and French Horn); do not add, delete, rename, or remap tracks.",
    "Develop new, original material on every retained track while preserving the existing opening material. Use achievable range, articulation, dynamics, and transparent orchestration rather than a named composer's sound.",
    SEGMENT_RULES,
    "The final candidate must cover the full 256-beat intro with real playable notes. Keep the writing sparse enough to remain legible, vary register and density across the arc, and leave the last phrase suitable for a later cue transition.",
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
};

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
  actualMaxNoteEndBeat: number;
  coverageBeats: number;
  coverageFraction: number;
  barsWithAnyNote: number;
  noteCount: number;
  tracksWithNotes: string[];
  semanticChanged: boolean;
  fullIntroCoverage: boolean;
};

type ProviderModel = {
  id: string;
  limits: ModelLimits;
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
  maxEnd: number;
  coveredBeats: number;
  fraction: number;
  barsWithAnyNote: number;
} {
  const intervals = notes(score)
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
    maxEnd: end,
    coveredBeats: covered,
    fraction: score.durationBeats > 0 ? covered / score.durationBeats : 0,
    barsWithAnyNote: bars.size,
  };
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
      actualMaxNoteEndBeat: 0,
      coverageBeats: 0,
      coverageFraction: 0,
      barsWithAnyNote: 0,
      noteCount: 0,
      tracksWithNotes: [],
      semanticChanged: false,
      fullIntroCoverage: false,
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
  const fullCoverage = timing.maxEnd >= INTRO_BEATS && timing.coveredBeats >= INTRO_BEATS;
  const failures = [
    baselineUnchangedBeforeApply ? "" : "The baseline copy changed before apply.",
    membership ? "" : "Track membership or track identity changed.",
    catalog ? "" : "A track does not resolve to the playable catalog with its declared program.",
    regions ? "" : "A pre-existing region was changed or removed.",
    ownership ? "" : "An operation targeted a track outside the retained baseline tracks.",
    operationValid ? "" : "Returned operations did not pass atomic score-operation validation.",
    bounded ? "" : "Region, note, operation-count, or duration bounds failed.",
    changed ? "" : "The candidate has no rendered MIDI semantic change.",
    fullCoverage ? "" : `The candidate covers only ${timing.maxEnd.toFixed(2)} of ${INTRO_BEATS} beats.`,
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
    actualMaxNoteEndBeat: timing.maxEnd,
    coverageBeats: timing.coveredBeats,
    coverageFraction: timing.fraction,
    barsWithAnyNote: timing.barsWithAnyNote,
    noteCount: notes(candidate).length,
    tracksWithNotes: candidate.tracks.filter((track) => track.regions.some((region) => region.notes.length > 0)).map((track) => track.id),
    semanticChanged: changed,
    fullIntroCoverage: fullCoverage,
  };
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
    attempt: 1,
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
          body.includes(`${MAX_OPERATIONS}-operation`),
      }
      : {}),
    ...(score && sourceMidi ? {
      promptHasCompleteScore: hasCompleteContext(messages, score, sourceMidi).score,
      promptHasCompleteSourceMidi: hasCompleteContext(messages, score, sourceMidi).sourceMidi,
    } : {}),
  };
  const started = Date.now();
  let transportAttempts = 0;
  try {
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
      finishReason: choice?.finish_reason,
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
    if (!content.trim()) throw new ProviderCallError("empty-completion", "xAI returned an empty completion.");
    if (choice?.message?.refusal) {
      metric.status = "error";
      metric.errorCode = "provider-refusal";
      metric.error = "xAI refused this isolated completion.";
    } else if (!metric.errorCode) {
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
  },
): Promise<{ payload: AnyRecord; repairs: number }> {
  let priorResponse = "";
  let failure = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const system = attempt === 0
      ? args.system
      : `${args.system}\nThis is the one bounded structural repair for the same response. Preserve the musical intention and every valid decision; repair only the JSON contract. Do not shorten the score or omit any source MIDI. Validator failure: ${failure}`;
    const user = attempt === 0
      ? args.user
      : { ...args.user, priorResponse, repairAttempt: "1/1", validatorFailure: failure };
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
      );
      priorResponse = completion.content;
      if (completion.metadata?.finishReason && completion.metadata.finishReason !== "stop") {
        failure = `The provider finished with ${completion.metadata.finishReason}; return a complete replacement rather than a partial response.`;
        if (attempt === 1) throw new ProviderCallError(
          completion.metadata.finishReason === "length" ? "provider-token-limit" : "provider-finish-reason",
          failure,
        );
        continue;
      }
      const payload = parseObject(completion.content);
      args.validate(payload);
      return { payload, repairs: attempt };
    } catch (error) {
      if (error instanceof ProviderCallError) throw error;
      failure = error instanceof Error ? error.message : "The response failed the experiment validator.";
      if (attempt === 1) throw error;
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
  const diagnostics = (validated as unknown as { diagnostics?: unknown[] }).diagnostics ?? [];
  if (diagnostics.length || validated.length !== payload.operations.length) {
    throw new Error("The instrument writer operations failed atomic score validation.");
  }
  const operations = validated as AnyRecord[];
  if (operations.some((operation) => operation.trackId !== trackId || operation.type !== "add-region")) {
    throw new Error("The instrument writer attempted a non-owned operation or removed pre-existing material.");
  }
  return operations;
}

function validateVerificationPayload(payload: AnyRecord): void {
  if (typeof payload.pass !== "boolean" || typeof payload.reason !== "string" || !payload.reason.trim()) {
    throw new Error("The consolidated Orchestrator verification response was malformed.");
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
  const path = join(privateMidiPath, `current-${stage}-${id}.mid`);
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
): Promise<AdvisoryMidiRef> {
  const ref = privateMidiRef("current-adviser-first", "adviser", suggestion, score, records);
  await writeFile(ref.path as string, ref.midi as Buffer);
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

async function runCurrentArm(
  connectors: ReplitConnectors,
  model: ProviderModel,
  baseline: ScoreValue,
  sourceMidi: AnyRecord[],
  calls: CallMetric[],
): Promise<ArmResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const events: unknown[] = [];
  const errors: Array<{ code?: string; message: string }> = [];
  const privateMidi: PrivateMidiRecord[] = [];
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
        maxTokens,
        calls,
        baseline,
        sourceMidi,
      )).content,
      completeDetailed: async (messages, maxTokens) => providerCompletion(
        connectors,
        model.id,
        "current-adviser-first",
        messages,
        maxTokens,
        calls,
        baseline,
        sourceMidi,
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
      persistAdvisoryMidiClip: async (suggestion, score) => saveCurrentPrivateMidi(suggestion, score, privateMidi),
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
    objectiveRubric,
    selfVerification: workflow ? { existingWorkflowReturnedVerified: workflow.status === "verified" } : undefined,
    baselineUnchanged,
    writerPromptChecks: {
      writerCalls: writerCalls.length,
      callsWithSegmentBounds: callsWithBounds,
      allWriterCallsHadSegmentBounds: writerCalls.length > 0 && callsWithBounds === writerCalls.length,
      note: "The production writer schema itself includes 128-beat, 512-note, 512-startBeat, and 60-operation limits; this arm also received the same explicit segment rules in safeDirection.",
    },
  };
}

async function runConsolidatedArm(
  connectors: ReplitConnectors,
  model: ProviderModel,
  baseline: ScoreValue,
  sourceMidi: AnyRecord[],
  calls: CallMetric[],
): Promise<ArmResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const events: unknown[] = [];
  const errors: Array<{ code?: string; message: string }> = [];
  const privateMidi: PrivateMidiRecord[] = [];
  const baselineCopy = clone(baseline);
  let candidate: ScoreValue | undefined;
  let operations: AnyRecord[] = [];
  let repairs = 0;
  let selfVerification: AnyRecord | undefined;
  let plan: AnyRecord | undefined;
  const styleContext = sourceContext(baselineCopy, sourceMidi);
  try {
    events.push({ stage: "orchestrator-started", message: "Consolidated Orchestrator started a sequential on-demand skill flow." });
    const style = await requestJson({
      connectors,
      model: model.id,
      arm: "consolidated-orchestrator",
      stage: "skill-style",
      agent: "Contemporary Cinematic",
      system: `You are the Orchestrator's on-demand style skill, read-only and advisory. Inspect the complete score and complete source MIDI. Return JSON only: {"insight":"actionable original-neutral style guidance","suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact retained track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":72,"durationBeats":16,"notes":[{"pitch":60,"velocity":70,"startBeat":0,"durationBeats":1}]}}]}. The optional midiClip is private advisory MIDI only; it is never a score operation or a track. Use only the playable catalog. Do not return operations, membership changes, or copied named references. ${SEGMENT_RULES} ${playableInstrumentCatalogPrompt()}`,
      user: styleContext,
      maxTokens: 1_800,
      calls,
      score: baselineCopy,
      sourceMidi,
      validate: (payload) => {
        validateSkillPayload(payload, baselineCopy);
      },
    });
    repairs += style.repairs;
    const styleSuggestions = validateSkillPayload(style.payload, baselineCopy);
    for (const suggestion of styleSuggestions) {
      if (suggestion.midiClip) {
        await persistPrivateMidi("consolidated-orchestrator", "style", suggestion, baselineCopy, privateMidi);
      }
    }
    const concept = await requestJson({
      connectors,
      model: model.id,
      arm: "consolidated-orchestrator",
      stage: "skill-concept",
      agent: "Harmony & Voice Leading",
      system: `You are the Orchestrator's on-demand concept skill, read-only and advisory. This call is sequential and receives the complete original context plus the style skill reply. Return JSON only: {"insight":"actionable original-neutral harmonic, melodic, register, and pacing guidance","suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact retained track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":72,"durationBeats":16,"notes":[{"pitch":60,"velocity":70,"startBeat":0,"durationBeats":1}]}}]}. The optional midiClip is private advisory MIDI only; it is never a score operation or track. Do not return operations or membership changes. ${SEGMENT_RULES} ${playableInstrumentCatalogPrompt()}`,
      user: { ...styleContext, styleSkill: style.payload },
      maxTokens: 1_800,
      calls,
      score: baselineCopy,
      sourceMidi,
      validate: (payload) => {
        validateSkillPayload(payload, baselineCopy);
      },
    });
    repairs += concept.repairs;
    const conceptSuggestions = validateSkillPayload(concept.payload, baselineCopy);
    for (const suggestion of conceptSuggestions) {
      if (suggestion.midiClip) {
        await persistPrivateMidi("consolidated-orchestrator", "concept", suggestion, baselineCopy, privateMidi);
      }
    }
    events.push({ stage: "on-demand-skills-completed", message: "Style then concept skills completed sequentially; advisory MIDI remained private." });

    const planResult = await requestJson({
      connectors,
      model: model.id,
      arm: "consolidated-orchestrator",
      stage: "orchestrator-plan",
      agent: "Orchestrator",
      system: `You are one consolidated Orchestrator. Combine the sequential style and concept skill replies into a retained-track plan. Return JSON only: {"trackInstructions":[{"trackId":"exact retained track id","instruction":"specific writer direction <=5000 chars"}],"privateMidiSuggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact retained track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":72,"durationBeats":16,"notes":[{"pitch":60,"velocity":70,"startBeat":0,"durationBeats":1}]}}],"verificationChecks":["check"]}. Assign exactly one retained instrument-track writer instruction to every current track. Keep membership unchanged: no operations, additions, deletions, or remapping. privateMidiSuggestions are optional private suggestions, never score writes. ${SEGMENT_RULES} ${playableInstrumentCatalogPrompt()}`,
      user: {
        ...styleContext,
        styleSkill: style.payload,
        conceptSkill: concept.payload,
      },
      maxTokens: 4_500,
      calls,
      score: baselineCopy,
      sourceMidi,
      validate: (payload) => {
        validatePlanPayload(payload, baselineCopy);
      },
    });
    repairs += planResult.repairs;
    plan = planResult.payload;
    const planSuggestions = validatePlanPayload(plan, baselineCopy);
    for (const suggestion of planSuggestions) {
      if (suggestion.midiClip) {
        await persistPrivateMidi("consolidated-orchestrator", "plan", suggestion, baselineCopy, privateMidi);
      }
    }
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
        agent: `${track.instrument} (instrument, track ${track.id})`,
        system: `You are the retained ${track.instrument} track writer assigned only to trackId "${track.id}". Read the complete score, source MIDI, style skill, concept skill, and Orchestrator instruction, but write only add-region operations on this assigned track. Never remove pre-existing regions, change membership, or address another track. Return JSON only: {"summary":"non-empty <=1200 chars","operations":[...]} with canonical operation objects and all notes. ${SEGMENT_RULES} Every added region must be <=${MAX_REGION_BEATS} beats and fit inside score duration ${INTRO_BEATS}; split longer phrases rather than truncating. ${playableInstrumentCatalogPrompt()}`,
        user: {
          ...sourceContext(staged, sourceMidi),
          originalScore: baselineCopy,
          assignedTrackId: track.id,
          instruction: instruction.instruction,
          styleSkill: style.payload,
          conceptSkill: concept.payload,
          orchestratorPlan: plan,
        },
        maxTokens: 16_000,
        calls,
        score: staged,
        sourceMidi,
        validate: (payload) => {
          validateOperationsPayload(payload, staged, track.id);
        },
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
      system: `You are the consolidated Orchestrator's final verification pass. Independently inspect the complete original score, complete candidate score, complete source MIDI, all operations, and the original neutral request. Return JSON only: {"pass":boolean,"reason":"bounded explanation","checks":{"duration":boolean,"coverage":boolean,"membership":boolean,"ownership":boolean,"segments":boolean,"originalRegions":boolean}}. Reject if any pre-existing track/region was lost, any operation is outside its assigned track, any region exceeds ${MAX_REGION_BEATS} beats, any note is invalid, or the candidate does not cover all ${INTRO_BEATS} beats. This is verification, not permission to repair or invent music.`,
      user: {
        request,
        originalScore: baselineCopy,
        candidateScore: candidate,
        operations,
        sourceMidi,
        plan,
      },
      maxTokens: 2_000,
      calls,
      score: candidate,
      sourceMidi,
      validate: validateVerificationPayload,
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
      system: `You are an independent blind post-hoc musical evaluator. Do not use either arm's self-verdict, events, or model claims as evidence. Compare the original score and each candidate directly. Apply the same rubric to both candidates: original neutral request followed, all ${INTRO_BEATS} beats covered with real notes, pre-existing regions and retained membership preserved, only playable catalog instruments, valid operation-shaped score data, and an original coherent intro. Return JSON only: {"candidates":[{"id":"candidate-1","available":boolean,"pass":boolean,"reason":"bounded reason","violations":["..."]},{"id":"candidate-2","available":boolean,"pass":boolean,"reason":"bounded reason","violations":["..."]}],"rubric":"same rubric applied blindly to both"}. If a candidate is unavailable, pass must be false. Do not choose a winner and do not treat a provider's own verification as evidence.`,
      user,
      maxTokens: 2_400,
      calls,
      score: baseline,
      validate: (payload) => {
        if (!Array.isArray(payload.candidates) || payload.candidates.length !== 2) {
          throw new Error("Shared evaluator did not return exactly two candidate verdicts.");
        }
        const ids = new Set((payload.candidates as AnyRecord[]).map((item) => item && item.id));
        if (!ids.has("candidate-1") || !ids.has("candidate-2")) throw new Error("Shared evaluator candidate IDs were malformed.");
        for (const item of payload.candidates as AnyRecord[]) {
          if (typeof item.pass !== "boolean" || typeof item.available !== "boolean" || typeof item.reason !== "string") {
            throw new Error("Shared evaluator returned an incomplete candidate verdict.");
          }
        }
      },
    });
    return { status: "verified", ...result.payload };
  } catch (error) {
    return { status: "failed", error: errorInfo(error) };
  }
}

function blindVerdict(shared: AnyRecord, id: string): boolean | undefined {
  if (!Array.isArray(shared.candidates)) return undefined;
  const verdict = (shared.candidates as AnyRecord[]).find((candidate) => candidate.id === id);
  return verdict && typeof verdict.pass === "boolean" ? verdict.pass : undefined;
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
      `  duration=${rubric?.durationBeats ?? "n/a"} beats; max note end=${rubric?.actualMaxNoteEndBeat?.toFixed(2) ?? "n/a"};`,
      `  coverage=${rubric ? `${rubric.coverageBeats.toFixed(2)} beats (${(rubric.coverageFraction * 100).toFixed(1)}%, ${rubric.barsWithAnyNote}/${INTRO_BARS} bars)` : "n/a"};`,
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

One paired live xAI run completed. The experiment was isolated under \`docs/verification/intro-workflow-comparison\`; no saved project, project ID, normal route, or UI was touched. This is a small-sample limitation: one prompt and one paired run cannot establish general quality, latency, or cost superiority, and no repeated expensive retry was made outside each arm's bounded repair policy.

The harness was launched as a background job with the exact locations recorded in \`run-lock.json\` and \`job-info.json\`; its stdout/stderr location is \`run.log\`. The paired run did not use the locked \`evaluation-feedback/run-real-xai-verification.ts\` harness.

## Shared request and safeguards

- Request: original, neutral, non-referential cinematic intro; exactly ${INTRO_BARS} bars in 4/4 (${INTRO_BEATS} beats), retained Piano, String Ensemble, and French Horn tracks.
- Both arms received the identical explicit segment rules: regions <=${MAX_REGION_BEATS} beats, <=${MAX_NOTES_PER_REGION} notes/region, startBeat <=512, <=${MAX_OPERATIONS} operations, region-relative note offsets, and full 256-beat coverage.
- The current arm reused the production adviser-first workflow and its atomic operation/evaluator safeguards through an experiment-only adapter. Its actual writer prompt was inspected: ${arms[0]?.writerPromptChecks.note ?? "not available"}.
- The consolidated arm sequentially called on-demand style then concept skills, retained one server-scoped writer per existing track, kept optional skill MIDI private, and asked the Orchestrator for a final verification verdict. Its verdict was not used as the independent evaluator.
- Both arms were checked locally for atomic validation, ownership, catalog membership, retained regions, segment bounds, semantic change, and complete coverage before approval. A failed arm is never labeled successful; a safely reconstructed candidate is stored separately as unapproved evidence.

## Observed arm results

${arms.map(line).join("\n")}

## Context, provider metadata, and feasibility

- Selected model: \`${model?.id ?? "unavailable"}\`.
- Model limit metadata (when returned, non-secret fields only): \`${JSON.stringify(model?.limits.selectedMetadata ?? {})}\`.
- Observed maximum request input: ${maxInput} bytes / ${calls.length ? Math.max(...calls.map((call) => call.inputChars)) : 0} UTF-16 chars; observed max message content: ${model?.limits.observedMaxMessageBytes ?? 0} bytes / ${model?.limits.observedMaxMessageChars ?? 0} chars.
- Per-call exact input/output character and byte counts, provider usage tokens, finish reason, request ID, transport attempts, and wall time are in \`call-metrics.json\`. No score or skill context was arbitrarily truncated; the report records feasibility from actual provider requests and returned usage.
- Provider input/output token counts were returned for ${calls.filter((call) => call.providerInputTokens !== undefined || call.providerOutputTokens !== undefined).length}/${calls.length} calls. Missing usage is reported as missing, not estimated.

## Independent post-hoc rubric

The shared evaluator used one blind rubric for opaque candidate-1 and candidate-2. It did not receive either arm's self-verdict. Its result is in \`outcome.json\`, while the objective checks are in each arm's \`objectiveRubric\`. Shared evaluator status=${shared.status}; candidate-1 pass=${blindVerdict(shared, "candidate-1") ?? "unavailable"}; candidate-2 pass=${blindVerdict(shared, "candidate-2") ?? "unavailable"}.

## Recommendation

${recommendation}

Observed strategy trade-off: the current adviser-first path has more lifecycle calls (initial advisers, planner, retained writers, review, and bounded refinements) but reuses the production transaction. The consolidated path makes style/concept context sequential and explicit before retained writers, reducing role fragmentation in its experiment adapter at the cost of a large repeated Orchestrator context. For long scores, keep full score/source MIDI context, preserve bounded segment output, instrument actual usage, and make any future comparison use matched policies and another explicitly authorized paired sample.
`;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--run")) {
    throw new Error("This one-shot experiment requires --run.");
  }
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
    request,
    note: "One isolated paired live run. Baseline is synthetic and no saved project is used.",
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
    consolidated = await runConsolidatedArm(connectors, model, baseline, sourceMidi, calls);
  }
  await writeJson(currentEventsPath, current.events);
  await writeJson(orchestratorEventsPath, consolidated.events);
  const sharedEvaluatorResult = model
    ? await runSharedEvaluator(connectors, model, baseline, current, consolidated, calls)
    : { status: "not-run", error: discoveryError };
  const currentBlind = blindVerdict(sharedEvaluatorResult, "candidate-1");
  const consolidatedBlind = blindVerdict(sharedEvaluatorResult, "candidate-2");
  current.approved = Boolean(current.status === "verified" && current.objectiveRubric?.pass &&
    current.selfVerification?.existingWorkflowReturnedVerified === true && currentBlind === true);
  consolidated.approved = Boolean(consolidated.status === "verified" && consolidated.objectiveRubric?.pass &&
    consolidated.selfVerification?.pass === true && consolidatedBlind === true);
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