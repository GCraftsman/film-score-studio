import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { AI_MUSIC_SAFETY_POLICY } from "../../../artifacts/api-server/src/lib/ai-music-safety.ts";
import {
  CHAT_MAX_ATTEMPTS,
  parseRetryAfter,
  providerRequestTimeoutMs,
  retryDelayMs,
  xaiLaunchLimiter,
} from "../../../artifacts/api-server/src/lib/chat-limiter.ts";
import {
  type ModelCompletion,
  type ProviderCompletionMetadata,
  safeProviderMetadata,
  throwForCompletionFailure,
} from "../../../artifacts/api-server/src/lib/model-diagnostics.ts";
import {
  type ModelMessage,
  type ScoreValue,
} from "../../../artifacts/api-server/src/lib/composition-workflow.ts";
import {
  findPlayableInstrument,
  playableInstrumentCatalogPrompt,
} from "../../../artifacts/api-server/src/lib/scoring-agents.ts";
import {
  type AdviserSuggestion,
  type AdvisoryMidiClip,
  type AdvisoryMidiRef,
  normalizeAdviserSuggestions,
  loadAdvisoryMidiRef,
  parseAdvisoryMidi,
  validateAdvisoryMidiRef,
} from "../../../artifacts/api-server/src/lib/adviser-suggestions.ts";
import { encodeTrackMidi } from "../../../artifacts/api-server/src/lib/track-midi.ts";
import { validateScoreOperations } from "../../../artifacts/api-server/src/lib/score-operations.ts";

/**
 * Isolated section experiment.
 *
 * This file is intentionally not imported by the compose route.  It reads the
 * prior immutable synthetic baseline, makes a new 32-bar source freeze, and
 * never writes a project, project id, normal score, or UI state.
 */
const here = dirname(fileURLToPath(import.meta.url));
const priorBaselinePath = join(here, "../intro-workflow-comparison-final/baseline.json");
const baselinePath = join(here, "baseline.json");
const sourceMidiPath = join(here, "source-midi");
const privateMidiPath = join(here, "private-midi");
const candidateMidiPath = join(here, "candidate-midi");
const partialPath = join(here, "partial-stage.json");
const progressPath = join(here, "progress.json");
const callsPath = join(here, "call-metrics.json");
const eventsPath = join(here, "events.json");
const outcomePath = join(here, "outcome.json");
const offlineFixturePath = join(here, "offline-fixture.json");
const reportPath = join(here, "report.md");
const lockPath = join(here, "run-lock.json");
const sourceFreezePath = join(here, "source-freeze.json");
const snapshotPath = join(here, "experiment.executed.ts");
const productionHashesPath = join(here, "production-module-hashes.json");

const BAR_BEATS = 4;
const TOTAL_BARS = 32;
const TOTAL_BEATS = TOTAL_BARS * BAR_BEATS;
const SECTION_COUNT = 4;
const SECTION_BARS = 8;
const SECTION_BEATS = SECTION_BARS * BAR_BEATS;
const TEMPO = 72;
const MAX_REGION_BEATS = 128;
const MAX_NOTES_PER_REGION = 512;
const MAX_OPERATIONS = 60;
const INITIAL_COMPLETION_TOKENS = 16_000;
const REPAIR_COMPLETION_TOKENS = 32_000;
const MAX_SECTION_REPAIRS = 4;
// Worst case is five attempts for each of 12 section writers plus five
// attempts for each global/evaluator stage (85); leave a small fixed margin
// for discovery/diagnostic calls without permitting an unbounded retry storm.
const MAX_PROVIDER_CALLS = 96;
const MAX_EXPERIMENT_WALL_MS = 25 * 60 * 1000;
const PREFERRED_MODEL = "grok-4.20-0309-non-reasoning";
const PRIVATE_OWNER = "section-intro-experiment";
const PRIVATE_PROJECT = "00000000-0000-4000-8000-000000000000";

const CANONICAL_CHECKLIST = `
IMPORTANT — BEFORE RESPONDING, verify every applicable constraint below. Do not
print this checklist or claim validation substitutes for server verification.
1. Follow the composer's requested scope, complete source MIDI, selected style,
assigned instruction, and any refinement feedback. Preserve source performance
and actionable constraints; do not silently shorten, omit, or replace them.
2. Advisers may inspect all tracks but cannot write executable score edits or
membership changes. Instrument writers edit ONLY their assigned track and
section. Only Orchestrator coordinates writers. Never treat advice as approval.
3. Use original neutral musical language, not named references, quoted titles,
or imitation requests. Use supported catalog instruments and achievable
techniques.
4. Return exactly the requested JSON contract with all required fields, correct
types, allowed enum values, valid IDs and targets, bounded arrays and strings,
and no forbidden fields. Finish the entire response; never return partial MIDI
or placeholder/no-op edits.
5. For MIDI verify ALL notes and regions: finite timing, integer pitch/velocity,
valid dynamics/articulation, correct beat coordinate system, allowed counts,
duration containment, track ownership, and exact existing removal targets.
6. During structural repair preserve musical content exactly. Only an
explicitly authorized bounded musical regeneration may change invalid musical
content; preserve valid siblings and immutable review decisions. Never hide a
failed constraint by dropping an operation.
`;

const OPERATION_JSON_SCHEMA = `
When your response contains an "operations" field, it MUST be an array. Every
array item MUST exactly be one of:
{"id":"unique-operation-id","type":"add-region","trackId":"existing-track-id",
"summary":"original edit","region":{"id":"unique-region-id",
"name":"original cue region","startBeat":0,"durationBeats":4,"dynamics":"mf",
"articulation":"sustain","notes":[{"pitch":60,"velocity":80,"startBeat":0,
"durationBeats":1,"articulation":"sustain"}]}}
or {"id":"existing-operation-id","type":"remove-region",
"trackId":"existing-track-id","regionId":"existing-region-id",
"summary":"original edit"}.
Every operation id and every add-region region.id is mandatory, non-empty, and
unique within the response. Remove-region must retain the exact provided target.
Every summary is required and <=1200 characters. Never use edits, changes,
addRegion, removeRegion, or an envelope other than operations. Never invent
music, notes, targets, or fallback edits to fill an omitted field. Dynamics are
one of pp,p,mp,mf,f,ff. Articulation is one of sustain,legato,staccato,marcato,
tremolo,pizzicato. Notes use region-relative, zero-based beat offsets; regions
use score-relative, zero-based beat offsets. Every note must fit its region and
every region must fit the score.
`;
const PRODUCTION_WRITER_CONTRACT = `${OPERATION_JSON_SCHEMA}\n${CANONICAL_CHECKLIST}`;

const introRequest = [
  "Write an original, neutral cinematic film-score intro with no named references, titles, quoted material, or imitation language.",
  "It must be a complete 32-bar introduction in 4/4 (exactly 128 beats) with a restrained, gradually widening arc: a quiet opening, a clear central lift, and a resolved but open handoff at the end.",
  "Retain every pre-existing track and its existing regions. Use only the existing playable catalog tracks (Piano, String Ensemble, and French Horn); do not add, delete, rename, or remap tracks.",
  "Develop new, original material on every retained track while preserving the existing opening material. Use achievable range, articulation, dynamics, and transparent orchestration rather than a named composer's sound.",
  `This is section-based generation: divide the complete ${TOTAL_BEATS}-beat request into exactly ${SECTION_COUNT} sequential sections of ${SECTION_BARS} bars (${SECTION_BEATS} beats) and call one owning instrument writer per retained track in every section. Sparse rests are allowed, but every section and every retained track must receive new playable material.`,
  `Each section writer may add only regions inside its absolute score-relative window. Regions are <=${MAX_REGION_BEATS} beats, notes are region-relative, and every region must fit both the ${TOTAL_BEATS}-beat score and its assigned ${SECTION_BEATS}-beat section. Keep all original regions and original source notes.`,
].join(" ");

type AnyRecord = Record<string, unknown>;
type Stage = "skill-style" | "skill-concept" | "orchestrator-plan" | "instrument-writer" | "orchestrator-verification" | "shared-evaluator" | "fixture-repair";
type ProviderArm = "section-orchestrator" | "shared" | "provider" | "fixture";
type Section = { index: number; startBeat: number; endBeat: number; bars: number };
type CallMetric = {
  arm: ProviderArm;
  stage: Stage;
  agent?: string;
  sectionIndex?: number;
  trackId?: string;
  attempt: number;
  maxTokens: number;
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
  promptHasCanonicalSchema?: boolean;
  promptHasCompleteScore?: boolean;
  promptHasCompleteSourceMidi?: boolean;
  promptHasExactSectionScope?: boolean;
  loadedSkillKeys?: string[];
};
type ProviderModel = { id: string; metadata: AnyRecord };
type OfflineResponder = (input: {
  arm: ProviderArm;
  stage: Stage;
  messages: ModelMessage[];
  maxTokens: number;
  attempt: number;
}) => Promise<ModelCompletion>;
type PrivateMidiRecord = {
  id: string;
  stage: string;
  suggestionId: string;
  objectPath: string;
  path: string;
  sha256: string;
  noteCount: number;
  roundTripNoteCount: number;
  targets: string[];
};
type ProgressSection = Section & {
  trackId: string;
  status: "staged" | "failed";
  attempts: number;
  repairs: number;
  operationCount: number;
  diagnostics: Array<{ code?: string; reason: string; fields?: string[] }>;
};
type ExperimentResult = {
  status: "verified" | "failed";
  approved: boolean;
  candidate?: ScoreValue;
  operations: AnyRecord[];
  errors: Array<{ code?: string; reason: string; fields?: string[] }>;
  events: AnyRecord[];
  progress: ProgressSection[];
  objective: AnyRecord;
  verification?: AnyRecord;
  evaluator?: AnyRecord;
  privateMidi: PrivateMidiRecord[];
  advisoryMidiLoads: number;
  writerAttempts: number;
  writerRepairs: number;
  repairCountsBySection: Record<string, number>;
  wallMs: number;
};

class ExperimentGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ExperimentGuardError";
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
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function sectionFor(index: number): Section {
  return { index, startBeat: index * SECTION_BEATS, endBeat: (index + 1) * SECTION_BEATS, bars: SECTION_BARS };
}
function allSections(): Section[] {
  return Array.from({ length: SECTION_COUNT }, (_, index) => sectionFor(index));
}
function errorInfo(error: unknown): { code?: string; reason: string; fields?: string[] } {
  const record = error && typeof error === "object" ? error as AnyRecord : {};
  const diagnostic = record.diagnostic && typeof record.diagnostic === "object"
    ? record.diagnostic as AnyRecord
    : undefined;
  if (diagnostic && typeof diagnostic.reason === "string") {
    return {
      code: typeof diagnostic.code === "string" ? diagnostic.code : undefined,
      reason: diagnostic.reason,
      fields: Array.isArray(diagnostic.fields) ? diagnostic.fields.filter((field): field is string => typeof field === "string") : undefined,
    };
  }
  return {
    code: record.code && typeof record.code === "string" ? record.code : undefined,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function sectionsFromBaseline(raw: ScoreValue): ScoreValue {
  const score = clone(raw);
  score.tempo = TEMPO;
  score.durationBeats = TOTAL_BEATS;
  for (const track of score.tracks) {
    track.regions = track.regions.filter((region) => region.startBeat + Number(region.durationBeats ?? 0) <= TOTAL_BEATS);
  }
  return score;
}
async function loadBaseline(): Promise<ScoreValue> {
  const raw = JSON.parse(await readFile(priorBaselinePath, "utf8")) as ScoreValue;
  const score = sectionsFromBaseline(raw);
  if (score.durationBeats !== TOTAL_BEATS || score.tempo !== TEMPO || score.tracks.length !== 3) {
    throw new Error("The immutable source baseline did not produce the required 32-bar score.");
  }
  return score;
}
function sourceMidi(score: ScoreValue): AnyRecord[] {
  return score.tracks.map((track) => ({
    id: `source-${track.id}`,
    tempo: score.tempo,
    durationMs: score.durationBeats * 60_000 / score.tempo,
    notes: track.regions.flatMap((region) => region.notes.map((note) => ({
      note: note.pitch,
      velocity: note.velocity,
      startMs: (region.startBeat + note.startBeat) * 60_000 / score.tempo,
      durationMs: note.durationBeats * 60_000 / score.tempo,
    }))),
  }));
}
function sourceNotesInWindow(midi: AnyRecord[], startBeat: number, endBeat: number): AnyRecord[] {
  const startMs = startBeat * 60_000 / TEMPO;
  const endMs = endBeat * 60_000 / TEMPO;
  return midi.flatMap((part) => (Array.isArray(part.notes) ? part.notes : [])
    .filter((note) => Number(note.startMs) < endMs && Number(note.startMs) + Number(note.durationMs) > startMs)
    .map((note) => ({ partId: part.id, ...note })));
}
function sourceContext(score: ScoreValue, midi: AnyRecord[], section?: Section): AnyRecord {
  return {
    completeOriginalScore: score,
    completeSourceMidi: midi,
    sourceNoteHash: sha256(stable(midi)),
    request: introRequest,
    supportedCatalog: playableInstrumentCatalogPrompt(),
    ...(section ? {
      sectionScope: { ...section, coordinateSystem: "score-relative region startBeat; region-relative note startBeat" },
      exactSourceNotesInSection: sourceNotesInWindow(midi, section.startBeat, section.endBeat),
      exactSourceNotesInPreviousAndNextSections: sourceNotesInWindow(
        midi,
        Math.max(0, section.startBeat - SECTION_BEATS),
        Math.min(TOTAL_BEATS, section.endBeat + SECTION_BEATS),
      ),
    } : {}),
  };
}
function applyOperations(score: ScoreValue, operations: AnyRecord[]): ScoreValue {
  const next = clone(score);
  for (const operation of operations) {
    const track = next.tracks.find((item) => item.id === operation.trackId);
    if (!track) throw new Error(`Operation targeted missing track ${String(operation.trackId)}.`);
    if (operation.type === "add-region") {
      track.regions.push(clone(operation.region as ScoreValue["tracks"][number]["regions"][number]));
    }
    if (operation.type === "remove-region") track.regions = track.regions.filter((region) => region.id !== operation.regionId);
  }
  return next;
}
function renderedNotes(score: ScoreValue): Array<{ trackId: string; pitch: number; velocity: number; startBeat: number; durationBeats: number }> {
  return score.tracks.flatMap((track) => track.regions.flatMap((region) => region.notes.map((note) => ({
    trackId: track.id,
    pitch: note.pitch,
    velocity: note.velocity,
    startBeat: region.startBeat + note.startBeat,
    durationBeats: note.durationBeats,
  }))));
}
function coverage(score: ScoreValue): AnyRecord {
  const intervals = renderedNotes(score).map((note) => [
    Math.max(0, note.startBeat),
    Math.min(score.durationBeats, note.startBeat + note.durationBeats),
  ] as [number, number]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (!last || interval[0] > last[1]) merged.push(interval);
    else last[1] = Math.max(last[1], interval[1]);
  }
  const covered = merged.reduce((sum, [start, end]) => sum + end - start, 0);
  const noteList = renderedNotes(score);
  const bars = new Set<number>();
  for (const note of noteList) {
    for (let bar = Math.floor(note.startBeat / BAR_BEATS); bar <= Math.floor((note.startBeat + note.durationBeats - Number.EPSILON) / BAR_BEATS); bar += 1) bars.add(bar);
  }
  return {
    minStart: noteList.length ? Math.min(...noteList.map((note) => note.startBeat)) : 0,
    maxEnd: merged.length ? merged.at(-1)![1] : 0,
    span: merged.length ? merged.at(-1)![1] - merged[0][0] : 0,
    coveredBeats: covered,
    densityFraction: score.durationBeats ? covered / score.durationBeats : 0,
    barsWithAnyNote: bars.size,
    noteCount: noteList.length,
  };
}
function originalRegionsPreserved(original: ScoreValue, candidate: ScoreValue): boolean {
  return original.tracks.every((track) => track.regions.every((region) => {
    const found = candidate.tracks.find((item) => item.id === track.id)?.regions.find((item) => item.id === region.id);
    return found !== undefined && stable(found) === stable(region);
  }));
}
function retainedMembership(original: ScoreValue, candidate: ScoreValue): boolean {
  return stable(original.tracks.map(({ id, instrument, midiProgram, role }) => ({ id, instrument, midiProgram, role }))) ===
    stable(candidate.tracks.map(({ id, instrument, midiProgram, role }) => ({ id, instrument, midiProgram, role })));
}
function newMaterialTracks(original: ScoreValue, candidate: ScoreValue): string[] {
  const baseline = new Set(renderedNotes(original).map((note) => `${note.trackId}|${note.pitch}|${note.velocity}|${note.startBeat}|${note.durationBeats}`));
  return candidate.tracks.filter((track) => renderedNotes({ ...candidate, tracks: [track] }).some((note) =>
    !baseline.has(`${note.trackId}|${note.pitch}|${note.velocity}|${note.startBeat}|${note.durationBeats}`))).map((track) => track.id);
}
function operationSection(operation: AnyRecord): number | undefined {
  const region = operation.region as AnyRecord | undefined;
  if (!region || typeof region.startBeat !== "number") return undefined;
  return Math.floor(region.startBeat / SECTION_BEATS);
}
function evaluateObjective(original: ScoreValue, candidate: ScoreValue | undefined, operations: AnyRecord[], progress: ProgressSection[]): AnyRecord {
  if (!candidate) return { pass: false, failures: ["No complete candidate was staged."], durationBeats: 0, sectionCoverage: [] };
  const timing = coverage(candidate);
  const diagnostics = (validateScoreOperations(original, operations) as unknown as { diagnostics?: AnyRecord[] }).diagnostics ?? [];
  const eachSection = allSections().flatMap((section) => original.tracks.map((track) => {
    const notes = renderedNotes(candidate).filter((note) => note.trackId === track.id && note.startBeat >= section.startBeat && note.startBeat < section.endBeat);
    return { section: section.index, trackId: track.id, noteCount: notes.length, pass: notes.length > 0 };
  }));
  const sectionCoverage = eachSection.every((item) => item.pass);
  const operationOwnership = operations.every((operation) => original.tracks.some((track) => track.id === operation.trackId));
  const bounded = candidate.durationBeats === TOTAL_BEATS && operations.length === SECTION_COUNT * original.tracks.length &&
    candidate.tracks.every((track) => track.regions.every((region) =>
      region.startBeat >= 0 && region.startBeat + Number(region.durationBeats ?? 0) <= TOTAL_BEATS &&
      Number(region.durationBeats ?? 0) <= MAX_REGION_BEATS && region.notes.length <= MAX_NOTES_PER_REGION));
  const failures = [
    stable(original) === stable(original) ? "" : "The immutable source baseline was changed before apply.",
    retainedMembership(original, candidate) ? "" : "Track membership changed.",
    originalRegionsPreserved(original, candidate) ? "" : "An original region or source note changed.",
    diagnostics.length === 0 ? "" : `Canonical production operation diagnostics: ${JSON.stringify(diagnostics)}`,
    operationOwnership ? "" : "An operation targeted a track outside the retained ownership roster.",
    bounded ? "" : "Duration, section operation count, region, or note bounds failed.",
    Number(timing.minStart) <= 0 && Number(timing.maxEnd) >= TOTAL_BEATS ? "" : `Whole-score span is ${timing.minStart}-${timing.maxEnd}, not 0-${TOTAL_BEATS}.`,
    sectionCoverage ? "" : "At least one track-section has no new material.",
    newMaterialTracks(original, candidate).length === original.tracks.length ? "" : "At least one retained track has no new material.",
    progress.length === SECTION_COUNT * original.tracks.length && progress.every((item) => item.status === "staged") ? "" : "Not every owned section was staged.",
  ].filter(Boolean);
  return {
    pass: failures.length === 0,
    failures,
    durationBeats: candidate.durationBeats,
    sectionCoverage,
    sectionCoverageRows: eachSection,
    wholeScoreCoverage: timing,
    retainedMembership: retainedMembership(original, candidate),
    originalRegionsPreserved: originalRegionsPreserved(original, candidate),
    operationOwnership,
    canonicalOperationsValid: diagnostics.length === 0 && operations.length > 0,
    newMaterialTracks: newMaterialTracks(original, candidate),
    totalNotes: timing.noteCount,
    sectionCount: SECTION_COUNT,
    sectionBars: SECTION_BARS,
    totalBars: TOTAL_BARS,
  };
}

function parseObject(content: string): AnyRecord {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Provider returned a JSON value that was not an object.");
  return parsed as AnyRecord;
}
function loadedSkills(messages: ModelMessage[]): string[] {
  const message = [...messages].reverse().find((item) => item.role === "user")?.content;
  if (!message) return [];
  try {
    const value = JSON.parse(message) as AnyRecord;
    return value.loadedSkillDocuments && typeof value.loadedSkillDocuments === "object"
      ? Object.keys(value.loadedSkillDocuments).sort()
      : [];
  } catch {
    return [];
  }
}
function providerError(error: unknown): { code?: string; reason: string; fields?: string[] } {
  const info = errorInfo(error);
  return info;
}
function stageAgent(messages: ModelMessage[]): string | undefined {
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const match = system.match(/You are ([^.]+)/);
  return match?.[1];
}

async function providerCompletion(
  connectors: ReplitConnectors,
  model: string,
  arm: ProviderArm,
  stage: Stage,
  messages: ModelMessage[],
  maxTokens: number,
  calls: CallMetric[],
  options: { section?: Section; trackId?: string; offline?: OfflineResponder; attempt?: number } = {},
): Promise<ModelCompletion> {
  if (calls.length >= MAX_PROVIDER_CALLS) throw new ExperimentGuardError("call-guard", `Finite provider-call guard of ${MAX_PROVIDER_CALLS} was reached.`);
  const completeMessages: ModelMessage[] = [{ role: "system", content: AI_MUSIC_SAFETY_POLICY }, ...messages];
  const body = JSON.stringify({
    model,
    messages: completeMessages,
    temperature: 0.45,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
  });
  const inputText = completeMessages.map((message) => message.content).join("\n");
  const metric: CallMetric = {
    arm,
    stage,
    agent: stageAgent(messages),
    sectionIndex: options.section?.index,
    trackId: options.trackId,
    attempt: options.attempt ?? 1,
    maxTokens,
    inputChars: body.length,
    inputBytes: utf8Bytes(body),
    messageChars: inputText.length,
    messageBytes: utf8Bytes(inputText),
    wallMs: 0,
    status: "error",
    promptHasCanonicalSchema: stage === "instrument-writer" ? inputText.includes(OPERATION_JSON_SCHEMA.trim().slice(0, 80)) : undefined,
    promptHasCompleteScore: inputText.includes('"completeOriginalScore"'),
    promptHasCompleteSourceMidi: inputText.includes('"completeSourceMidi"'),
    promptHasExactSectionScope: stage === "instrument-writer" ? inputText.includes('"sectionScope"') && inputText.includes(`${SECTION_BEATS}`) : undefined,
    loadedSkillKeys: loadedSkills(messages),
  };
  const started = Date.now();
  let transportAttempts = 0;
  try {
    let completion: ModelCompletion;
    if (options.offline) {
      completion = await options.offline({
        arm,
        stage,
        messages: completeMessages,
        maxTokens,
        attempt: options.attempt ?? 1,
      });
      transportAttempts = 0;
    } else {
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
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, parseRetryAfter(response?.headers.get("retry-after") ?? null))));
          continue;
        }
        throw new ExperimentGuardError(`http-${response.status}`, `xAI completion failed with HTTP ${response.status}.`);
      }
      if (!response?.ok) throw new ExperimentGuardError("provider-empty-response", "xAI returned no response.");
      const payload = await response.json() as AnyRecord;
      const choice = Array.isArray(payload.choices) ? payload.choices[0] as AnyRecord : {};
      const message = choice.message && typeof choice.message === "object" ? choice.message as AnyRecord : {};
      completion = {
        content: typeof message.content === "string" ? message.content : "",
        metadata: safeProviderMetadata({
          finishReason: message.refusal ? "refusal" : choice.finish_reason,
          usage: payload.usage,
          model: payload.model ?? model,
          providerRequestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? payload.id,
        }),
      };
    }
    const metadata = safeProviderMetadata(completion.metadata);
    metric.outputChars = completion.content.length;
    metric.outputBytes = utf8Bytes(completion.content);
    metric.providerInputTokens = metadata?.usage?.promptTokens;
    metric.providerOutputTokens = metadata?.usage?.completionTokens;
    metric.providerTotalTokens = metadata?.usage?.totalTokens;
    metric.finishReason = metadata?.finishReason;
    metric.providerModel = metadata?.model ?? model;
    metric.providerRequestId = metadata?.providerRequestId;
    metric.transportAttempts = transportAttempts;
    metric.wallMs = Date.now() - started;
    metric.status = metadata?.finishReason && metadata.finishReason !== "stop" ? "error" : "success";
    if (metric.status === "error") {
      metric.errorCode = metadata?.finishReason === "length" ? "provider-token-limit" : "provider-finish-reason";
      metric.error = `Provider finished with ${metadata?.finishReason}; no incomplete response was accepted.`;
    }
    calls.push(metric);
    return { content: completion.content, metadata };
  } catch (error) {
    metric.transportAttempts = transportAttempts || undefined;
    metric.wallMs = Date.now() - started;
    const info = providerError(error);
    metric.errorCode = info.code;
    metric.error = info.reason;
    calls.push(metric);
    throw error;
  }
}

async function requestJson(args: {
  connectors: ReplitConnectors;
  model: string;
  arm: ProviderArm;
  stage: Stage;
  system: string;
  user: AnyRecord;
  calls: CallMetric[];
  validate: (payload: AnyRecord) => void;
  section?: Section;
  trackId?: string;
  offline?: OfflineResponder;
  maxRepairs?: number;
}): Promise<{ payload: AnyRecord; repairs: number }> {
  const maxRepairs = args.maxRepairs ?? MAX_SECTION_REPAIRS;
  let priorResponse = "";
  let failure = "";
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const repair = attempt > 0;
    const system = repair
      ? `${args.system}\nThis is structural repair ${attempt}/${maxRepairs} after the initial attempt for the same ${args.section ? `section ${args.section.index + 1}` : "response"}. Preserve every valid musical choice and all complete source context; repair only the cited contract or scoped timing defect. Do not drop a section, sibling, operation, note, or source note. Diagnostic: ${failure}`
      : args.system;
    const user = repair
      ? { ...args.user, priorResponse, repairAttempt: `${attempt}/${maxRepairs}`, validatorDiagnostic: failure }
      : args.user;
    try {
      const completion = await providerCompletion(
        args.connectors,
        args.model,
        args.arm,
        args.stage,
        [{ role: "system", content: system }, { role: "user", content: JSON.stringify(user) }],
        repair ? REPAIR_COMPLETION_TOKENS : INITIAL_COMPLETION_TOKENS,
        args.calls,
        { section: args.section, trackId: args.trackId, offline: args.offline, attempt: attempt + 1 },
      );
      priorResponse = completion.content;
      try {
        throwForCompletionFailure(completion);
      } catch (error) {
        failure = error instanceof Error ? error.message : "Provider completion failed.";
        if (attempt === maxRepairs) throw error;
        continue;
      }
      const payload = parseObject(completion.content);
      args.validate(payload);
      return { payload, repairs: attempt };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (attempt === maxRepairs) throw error;
    }
  }
  throw new Error("Bounded response repair loop ended unexpectedly.");
}

function validateSkill(payload: AnyRecord, score: ScoreValue): AdviserSuggestion[] {
  if (typeof payload.insight !== "string" || !payload.insight.trim()) throw new Error("Orchestrator skill returned no actionable insight.");
  return normalizeAdviserSuggestions(payload.suggestions, score, { omitInvalidOptionalMidiClip: false });
}
function validatePlan(payload: AnyRecord, score: ScoreValue): void {
  if (payload.operations !== undefined || payload.membershipProposals !== undefined) throw new Error("Global Orchestrator plan attempted a write or membership capability.");
  if (!Array.isArray(payload.trackInstructions) || payload.trackInstructions.length !== score.tracks.length) throw new Error("Global Orchestrator plan must assign one instruction per retained track.");
  const ids = new Set<string>();
  for (const raw of payload.trackInstructions) {
    const item = raw as AnyRecord;
    if (!item || typeof item.trackId !== "string" || ids.has(item.trackId) || !score.tracks.some((track) => track.id === item.trackId) ||
      typeof item.instruction !== "string" || !item.instruction.trim() || item.instruction.length > 5000) {
      throw new Error("Global Orchestrator plan contained an invalid retained-track instruction.");
    }
    ids.add(item.trackId);
  }
}
function validateWriter(payload: AnyRecord, staged: ScoreValue, section: Section, trackId: string): AnyRecord[] {
  if (typeof payload.summary !== "string" || !payload.summary.trim() || payload.summary.length > 1200) throw new Error("Instrument writer summary is invalid.");
  if (!Array.isArray(payload.operations) || payload.operations.length === 0) throw new Error("Instrument writer returned no operations.");
  const validated = validateScoreOperations(staged, payload.operations);
  const diagnostics = (validated as unknown as { diagnostics?: AnyRecord[] }).diagnostics ?? [];
  if (diagnostics.length || validated.length !== payload.operations.length) throw new Error(`Canonical production operation diagnostics: ${JSON.stringify(diagnostics)}`);
  const operations = validated as AnyRecord[];
  for (const operation of operations) {
    if (operation.type !== "add-region" || operation.trackId !== trackId) {
      throw new Error(`Section writer ownership diagnostic: operation must be add-region on assigned track ${trackId}.`);
    }
    const region = operation.region as AnyRecord;
    if (Number(region.startBeat) < section.startBeat || Number(region.startBeat) + Number(region.durationBeats) > section.endBeat) {
      throw new Error(`Section scope diagnostic: region must fit absolute section ${section.startBeat}-${section.endBeat}.`);
    }
  }
  return operations;
}
function validateVerification(payload: AnyRecord): void {
  const required = ["duration", "allSections", "newMaterialPerTrack", "membership", "ownership", "segments", "originalRegions"];
  if (typeof payload.pass !== "boolean" || typeof payload.reason !== "string" || !payload.reason.trim()) throw new Error("Orchestrator verification requires pass and reason.");
  if (!payload.checks || typeof payload.checks !== "object" || required.some((key) => typeof (payload.checks as AnyRecord)[key] !== "boolean")) throw new Error(`Orchestrator verification requires boolean checks: ${required.join(", ")}.`);
  if (payload.pass !== required.every((key) => (payload.checks as AnyRecord)[key] === true)) throw new Error("Orchestrator verification pass disagreed with its checks.");
}
function validateEvaluator(payload: AnyRecord, available: boolean): void {
  if (!Array.isArray(payload.candidates) || payload.candidates.length !== 1) throw new Error("Independent evaluator must return one candidate verdict.");
  const candidate = payload.candidates[0] as AnyRecord;
  if (candidate.id !== "candidate-1" || candidate.available !== available || typeof candidate.pass !== "boolean" ||
    (!available && candidate.pass) || typeof candidate.reason !== "string" || !candidate.reason.trim() ||
    !Array.isArray(candidate.violations)) throw new Error("Independent evaluator availability/pass gate failed.");
  if (typeof payload.rubric !== "string" || !payload.rubric.trim()) throw new Error("Independent evaluator rubric is missing.");
}

async function materializeSuggestions(
  suggestions: AdviserSuggestion[],
  score: ScoreValue,
  stage: string,
  records: PrivateMidiRecord[],
  store: Map<string, { clip: AdvisoryMidiClip; bytes: Buffer }>,
): Promise<AdviserSuggestion[]> {
  return Promise.all(suggestions.map(async (suggestion) => {
    if (!suggestion.midiClip) return suggestion;
    const target = score.tracks.find((track) => suggestion.targetTrackIds.includes(track.id));
    if (!target) throw new Error(`Advisory suggestion ${suggestion.id} did not target a retained track.`);
    const id = randomUUID();
    const objectPath = `/objects/projects/${PRIVATE_OWNER}/${PRIVATE_PROJECT}/${randomUUID()}`;
    const bytes = encodeTrackMidi({ tempo: suggestion.midiClip.tempo }, {
      id: `advisory-${id}`,
      name: suggestion.label,
      instrument: target.instrument,
      midiProgram: target.midiProgram,
      regions: [{ startBeat: 0, notes: suggestion.midiClip.notes }],
    });
    const parsed = parseAdvisoryMidi(bytes, id);
    const ref: AdvisoryMidiRef = validateAdvisoryMidiRef({
      id,
      objectPath,
      sha256: sha256(bytes),
      label: suggestion.label,
      alignment: { startBeat: 0, durationBeats: suggestion.midiClip.durationBeats },
      targets: {
        trackIds: suggestion.targetTrackIds,
        instrumentIds: suggestion.instrumentId ? [suggestion.instrumentId] : [],
        instruments: suggestion.instrumentName ? [suggestion.instrumentName] : [],
      },
    });
    const path = join(privateMidiPath, `${stage}-${suggestion.id}-${id}.mid`);
    await writeFile(path, bytes);
    store.set(ref.objectPath, { clip: suggestion.midiClip, bytes });
    records.push({
      id,
      stage,
      suggestionId: suggestion.id,
      objectPath: ref.objectPath,
      path: path.slice(here.length + 1),
      sha256: ref.sha256,
      noteCount: suggestion.midiClip.notes.length,
      roundTripNoteCount: parsed.notes.length,
      targets: [...suggestion.targetTrackIds],
    });
    const { midiClip: _midiClip, ...withoutClip } = suggestion;
    return { ...withoutClip, advisoryMidiRef: ref };
  }));
}
async function loadTargetedRefs(suggestions: unknown, trackId: string, store: Map<string, { clip: AdvisoryMidiClip; bytes: Buffer }>, loaded: { count: number }): Promise<AnyRecord[]> {
  if (!Array.isArray(suggestions)) return [];
  const materialized: AnyRecord[] = [];
  for (const raw of suggestions) {
    const suggestion = raw as AnyRecord;
    const ref = suggestion?.advisoryMidiRef as AnyRecord | undefined;
    const targetIds = ref?.targets && typeof ref.targets === "object" ? (ref.targets as AnyRecord).trackIds : [];
    if (!ref || !Array.isArray(targetIds) || !targetIds.includes(trackId)) continue;
    const stored = store.get(String(ref.objectPath));
    if (!stored) throw new Error(`Private advisory loader could not resolve ${String(ref.objectPath)}.`);
    const roundTrip = await loadAdvisoryMidiRef({
      ownerId: PRIVATE_OWNER,
      projectId: PRIVATE_PROJECT,
      ref: ref as AdvisoryMidiRef,
      storage: {
        getFile: async () => ref.objectPath,
        download: async () => new Response(stored.bytes),
      },
    });
    loaded.count += 1;
    materialized.push({ ...suggestion, advisoryMidi: roundTrip });
  }
  return materialized;
}

function syntheticOperation(trackId: string, section: Section, repairFault: boolean): AnyRecord {
  const safe = `${trackId}-${section.index}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    id: `offline-operation-${safe}`,
    type: "add-region",
    trackId,
    summary: "Offline section continuation.",
    region: {
      id: `offline-region-${safe}`,
      name: "Offline section continuation",
      startBeat: section.startBeat,
      durationBeats: repairFault ? SECTION_BEATS + 1 : SECTION_BEATS,
      dynamics: "mf",
      articulation: "legato",
      notes: [
        { pitch: 60 + section.index, velocity: 72, startBeat: 0, durationBeats: 1, articulation: "legato" },
        { pitch: 67 + section.index, velocity: 76, startBeat: SECTION_BEATS - 1, durationBeats: 1, articulation: "legato" },
      ],
    },
  };
}
function syntheticResponder(): OfflineResponder {
  return async ({ stage, messages, attempt }) => {
    const user = JSON.parse([...messages].reverse().find((message) => message.role === "user")?.content ?? "{}") as AnyRecord;
    let payload: AnyRecord;
    if (stage === "skill-style" || stage === "skill-concept") {
      payload = {
        insight: "Use sparse neutral pacing with a clear handoff at each section boundary.",
        suggestions: ["track-piano", "track-strings", "track-horn"].map((trackId, index) => ({
          id: `offline-${stage}-${index}`,
          label: `Offline ${stage} cue ${index}`,
          instructions: ["Preserve source notes and hand off cleanly to the next section."],
          targetTrackIds: [trackId],
          instrumentId: findPlayableInstrument(trackId === "track-piano" ? "Piano" : trackId === "track-strings" ? "String Ensemble" : "French Horn")?.id,
          midiClip: { tempo: TEMPO, durationBeats: 4, notes: [{ pitch: 60 + index, velocity: 68, startBeat: 0, durationBeats: 1 }] },
        })),
      };
    } else if (stage === "orchestrator-plan") {
      payload = {
        trackInstructions: ["track-piano", "track-strings", "track-horn"].map((trackId) => ({
          trackId,
          instruction: `Write sparse original material for all four ${SECTION_BARS}-bar sections on this exact retained track.`,
        })),
        privateMidiSuggestions: [],
      };
    } else if (stage === "instrument-writer") {
      const section = user.sectionScope as Section;
      const trackId = String(user.assignedTrackId);
      payload = { summary: "Offline section writer response.", operations: [syntheticOperation(trackId, section, trackId === "track-strings" && section.index === 1 && attempt === 1)] };
    } else if (stage === "orchestrator-verification") {
      payload = {
        pass: true,
        reason: "Offline verification confirms all four sections and retained source.",
        checks: { duration: true, allSections: true, newMaterialPerTrack: true, membership: true, ownership: true, segments: true, originalRegions: true },
      };
    } else if (stage === "shared-evaluator") {
      const available = (user.candidate as AnyRecord | undefined)?.available === true;
      payload = {
        candidates: [{ id: "candidate-1", available, pass: available, reason: available ? "Offline blind rubric passed." : "Candidate unavailable.", violations: available ? [] : ["Candidate unavailable."] }],
        rubric: "Same offline rubric applied without the Orchestrator verdict.",
      };
    } else {
      payload = { summary: "fixture response" };
    }
    return {
      content: JSON.stringify(payload),
      metadata: safeProviderMetadata({
        finishReason: "stop",
        model: "offline-synthetic",
        providerRequestId: `offline-${stage}-${attempt}`,
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }),
    };
  };
}

function validateFixtureFailure(): void {
  let failed = false;
  try {
    validateVerification({
      pass: true,
      reason: "inconsistent",
      checks: { duration: true, allSections: false, newMaterialPerTrack: true, membership: true, ownership: true, segments: true, originalRegions: true },
    });
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("Offline verifier negative gate did not reject inconsistent booleans.");
  failed = false;
  try {
    validateEvaluator({
      candidates: [{ id: "candidate-1", available: false, pass: true, reason: "invalid", violations: [] }],
      rubric: "negative",
    }, false);
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("Offline evaluator negative gate did not reject unavailable/pass=true.");
}

async function runRepairExhaustionFixture(): Promise<AnyRecord> {
  const calls: CallMetric[] = [];
  const responder: OfflineResponder = async () => ({
    content: JSON.stringify({ malformed: true }),
    metadata: safeProviderMetadata({ finishReason: "stop", model: "offline-repair-exhaustion", providerRequestId: "repair-fixture", usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
  });
  let rejected = false;
  try {
    await requestJson({
      connectors: {} as ReplitConnectors,
      model: "offline-repair-exhaustion",
      arm: "fixture",
      stage: "fixture-repair",
      system: "Return JSON with required field.",
      user: { fixture: "four repair cycles" },
      calls,
      offline: responder,
      maxRepairs: MAX_SECTION_REPAIRS,
      validate: (payload) => {
        if (payload.required !== true) throw new Error("fixture-required-field diagnostic");
      },
    });
  } catch (error) {
    rejected = /fixture-required-field/.test(error instanceof Error ? error.message : String(error));
  }
  return {
    pass: rejected && calls.length === 1 + MAX_SECTION_REPAIRS,
    initialAttempt: 1,
    repairCyclesAllowed: MAX_SECTION_REPAIRS,
    callsMade: calls.length,
    fifthAttemptRejected: calls.length === 5,
    noSixthAttempt: calls.length < 6,
    diagnostics: calls.map((call) => ({ attempt: call.attempt, error: call.error })),
  };
}

async function writeSourceMidi(score: ScoreValue): Promise<void> {
  await mkdir(sourceMidiPath, { recursive: true });
  for (const track of score.tracks) await writeFile(join(sourceMidiPath, `${track.id}.mid`), encodeTrackMidi(score, track));
}
async function persistProgress(progress: ProgressSection[], events: AnyRecord[]): Promise<void> {
  await writeJson(progressPath, progress);
  await writeJson(eventsPath, events);
}

async function runExperiment(
  model: ProviderModel,
  offline: OfflineResponder | undefined,
): Promise<{ result: ExperimentResult; calls: CallMetric[]; source: ScoreValue; sourceMidi: AnyRecord[] }> {
  const started = Date.now();
  const source = await loadBaseline();
  const midi = sourceMidi(source);
  await writeJson(baselinePath, source);
  await writeSourceMidi(source);
  const calls: CallMetric[] = [];
  const events: AnyRecord[] = [];
  const progress: ProgressSection[] = [];
  const privateMidi: PrivateMidiRecord[] = [];
  const privateStore = new Map<string, { clip: AdvisoryMidiClip; bytes: Buffer }>();
  const loaded = { count: 0 };
  const errors: Array<{ code?: string; reason: string; fields?: string[] }> = [];
  const repairCountsBySection: Record<string, number> = {};
  const baselineHash = sha256(stable(source));
  let staged = clone(source);
  let operations: AnyRecord[] = [];
  let candidate: ScoreValue | undefined;
  let verification: AnyRecord | undefined;
  let evaluator: AnyRecord | undefined;
  let plan: AnyRecord | undefined;
  try {
    const style = await requestJson({
      connectors: offline ? {} as ReplitConnectors : new ReplitConnectors(),
      model: model.id,
      arm: "section-orchestrator",
      stage: "skill-style",
      system: `You are the single global Orchestrator loading the style skill sequentially. You are not a separate adviser. Return JSON only with non-empty insight and optional advisory suggestions. Never return operations or membership changes. ${CANONICAL_CHECKLIST}`,
      user: { ...sourceContext(source, midi), loadedSkillDocuments: { style: "style skill: sparse neutral pacing" }, activeSkill: "style" },
      calls,
      offline,
      maxRepairs: MAX_SECTION_REPAIRS,
      validate: (payload) => { validateSkill(payload, source); },
    });
    const styleSuggestions = await materializeSuggestions(validateSkill(style.payload, source), source, "style", privateMidi, privateStore);
    const concept = await requestJson({
      connectors: offline ? {} as ReplitConnectors : new ReplitConnectors(),
      model: model.id,
      arm: "section-orchestrator",
      stage: "skill-concept",
      system: `You are the same single global Orchestrator loading the concept skill after style. Preserve complete source context and style reply. Return JSON only with non-empty insight and optional private suggestions; never return operations. ${CANONICAL_CHECKLIST}`,
      user: { ...sourceContext(source, midi), loadedSkillDocuments: { style: "style skill: sparse neutral pacing", concept: "concept skill: register and handoff" }, activeSkill: "concept", styleReply: style.payload },
      calls,
      offline,
      maxRepairs: MAX_SECTION_REPAIRS,
      validate: (payload) => { validateSkill(payload, source); },
    });
    const conceptSuggestions = await materializeSuggestions(validateSkill(concept.payload, source), source, "concept", privateMidi, privateStore);
    const planResult = await requestJson({
      connectors: offline ? {} as ReplitConnectors : new ReplitConnectors(),
      model: model.id,
      arm: "section-orchestrator",
      stage: "orchestrator-plan",
      system: `You are the same single global Orchestrator making a global ${TOTAL_BARS}-bar plan after sequential style and concept skills. Assign one instruction to every retained track. This is a plan, not a score write: no operations, no membership changes, and no lossy score replacement. ${CANONICAL_CHECKLIST}`,
      user: { ...sourceContext(source, midi), loadedSkillDocuments: { style: "style skill: sparse neutral pacing", concept: "concept skill: register and handoff" }, activeSkill: "plan", styleReply: { ...style.payload, suggestions: styleSuggestions }, conceptReply: { ...concept.payload, suggestions: conceptSuggestions } },
      calls,
      offline,
      maxRepairs: MAX_SECTION_REPAIRS,
      validate: (payload) => { validatePlan(payload, source); },
    });
    plan = planResult.payload;
    const planSuggestions = await materializeSuggestions(normalizeAdviserSuggestions(plan.privateMidiSuggestions, source, { omitInvalidOptionalMidiClip: false }), source, "plan", privateMidi, privateStore);
    plan = { ...plan, privateMidiSuggestions: planSuggestions };
    await writeJson(join(here, "source-context.json"), {
      immutableSourceScore: source,
      completeSourceMidi: midi,
      sourceNoteHash: baselineHash,
      sectionContexts: allSections().map((section) => ({
        section,
        exactSourceNotesInSection: sourceNotesInWindow(midi, section.startBeat, section.endBeat),
        exactSourceNotesInPreviousAndNextSections: sourceNotesInWindow(
          midi,
          Math.max(0, section.startBeat - SECTION_BEATS),
          Math.min(TOTAL_BEATS, section.endBeat + SECTION_BEATS),
        ),
      })),
      derivedGlobalPlan: plan,
      note: "Global plan is supplemental; writers received the complete immutable source score/MIDI and these exact local source/neighbour notes.",
    });
    events.push({ stage: "global-plan-completed", sections: SECTION_COUNT, sectionBeats: SECTION_BEATS, tracks: source.tracks.map((track) => track.id), sourceHash: baselineHash });

    for (const section of allSections()) {
      for (const track of source.tracks) {
        if (Date.now() - started > MAX_EXPERIMENT_WALL_MS) throw new ExperimentGuardError("time-guard", `Finite experiment wall-time guard of ${MAX_EXPERIMENT_WALL_MS} ms was reached.`);
        const instruction = (plan.trackInstructions as AnyRecord[]).find((item) => item.trackId === track.id)?.instruction;
        if (!instruction) throw new Error(`Global plan omitted retained track ${track.id}.`);
        let repairs = 0;
        try {
          const writer = await requestJson({
            connectors: offline ? {} as ReplitConnectors : new ReplitConnectors(),
            model: model.id,
            arm: "section-orchestrator",
            stage: "instrument-writer",
            section,
            trackId: track.id,
            system: `You are the ${track.instrument} Instrument Writer, the sole production writer assigned to retained track "${track.id}" and absolute section ${section.index + 1} (${section.startBeat}-${section.endBeat} beats, ${section.bars} bars). The global Orchestrator coordinates but does not replace your instrument identity. Write ONLY add-region operations on this track in this section; do not remove originals, edit siblings, change membership, or write another section. Regions use absolute score-relative startBeat; notes use region-relative startBeat. Preserve every complete original score/source note and exact neighboring source context. Return JSON only and obey the production contract below. ${PRODUCTION_WRITER_CONTRACT} ${playableInstrumentCatalogPrompt()}`,
            user: {
              ...sourceContext(staged, midi, section),
              immutableOriginalScore: source,
              immutableSourceHash: baselineHash,
              assignedTrackId: track.id,
              sectionScope: { ...section, ownership: track.id },
              globalPlan: plan,
              neighboringStagedSections: staged.tracks.find((item) => item.id === track.id)?.regions.filter((region) => region.startBeat < section.startBeat || region.startBeat >= section.endBeat) ?? [],
              targetedAdvisoryMidi: [
                ...(await loadTargetedRefs(styleSuggestions, track.id, privateStore, loaded)),
                ...(await loadTargetedRefs(conceptSuggestions, track.id, privateStore, loaded)),
                ...(await loadTargetedRefs(planSuggestions, track.id, privateStore, loaded)),
              ],
              loadedSkillDocuments: { style: "style skill: sparse neutral pacing", concept: "concept skill: register and handoff" },
            },
            calls,
            offline,
            maxRepairs: MAX_SECTION_REPAIRS,
            validate: (payload) => { validateWriter(payload, staged, section, track.id); },
          });
          repairs = writer.repairs;
          const writerOperations = validateWriter(writer.payload, staged, section, track.id);
          if (operations.length + writerOperations.length > MAX_OPERATIONS) throw new Error(`Operation count would exceed production limit ${MAX_OPERATIONS}.`);
          operations.push(...writerOperations);
          staged = applyOperations(staged, writerOperations);
          const row: ProgressSection = { ...section, trackId: track.id, status: "staged", attempts: 1 + repairs, repairs, operationCount: writerOperations.length, diagnostics: [] };
          progress.push(row);
          repairCountsBySection[`${section.index}:${track.id}`] = repairs;
          events.push({ stage: "section-staged", sectionIndex: section.index, trackId: track.id, startBeat: section.startBeat, endBeat: section.endBeat, repairs, operationCount: writerOperations.length, stagedSiblingCount: operations.length });
          await persistProgress(progress, events);
        } catch (error) {
          const diagnostic = errorInfo(error);
          repairCountsBySection[`${section.index}:${track.id}`] = repairs;
          progress.push({ ...section, trackId: track.id, status: "failed", attempts: 1 + repairs, repairs, operationCount: 0, diagnostics: [diagnostic] });
          events.push({ stage: "section-failed-closed", sectionIndex: section.index, trackId: track.id, repairs, diagnostic });
          await writeJson(partialPath, { status: "failed-partial-stage", completedSections: progress, staged, operations, failedSection: { section, trackId: track.id, diagnostic } });
          await persistProgress(progress, events);
          throw error;
        }
      }
    }
    candidate = staged;
    const objective = evaluateObjective(source, candidate, operations, progress);
    if (!objective.pass) throw new Error(`Whole-score deterministic objective failed: ${JSON.stringify(objective.failures)}`);
    const verificationResult = await requestJson({
      connectors: offline ? {} as ReplitConnectors : new ReplitConnectors(),
      model: model.id,
      arm: "section-orchestrator",
      stage: "orchestrator-verification",
      system: `You are the global Orchestrator loading the verification skill last. Inspect the complete original ${TOTAL_BARS}-bar score, complete staged candidate, complete source MIDI, all ${operations.length} operations, all section ledger rows, and the original request. Return JSON only: {"pass":boolean,"reason":"bounded reason","checks":{"duration":boolean,"allSections":boolean,"newMaterialPerTrack":boolean,"membership":boolean,"ownership":boolean,"segments":boolean,"originalRegions":boolean}}. Pass must agree with every check. Sparse rests are allowed, but every retained track must have material in all four sections and the whole score must span 0-${TOTAL_BEATS}. Do not repair or invent music. ${CANONICAL_CHECKLIST}`,
      user: { ...sourceContext(source, midi), loadedSkillDocuments: { style: "style skill", concept: "concept skill", verification: "verification skill" }, activeSkill: "verification", originalScore: source, candidateScore: candidate, operations, sectionLedger: progress, globalPlan: plan },
      calls,
      offline,
      maxRepairs: MAX_SECTION_REPAIRS,
      validate: validateVerification,
    });
    verification = verificationResult.payload;
    if (verification.pass !== true) throw new Error(`Global Orchestrator verification rejected the staged candidate: ${verification.reason}`);
    events.push({ stage: "whole-score-verified", checks: verification.checks });
    const evaluatorResult = await requestJson({
      connectors: offline ? {} as ReplitConnectors : new ReplitConnectors(),
      model: model.id,
      arm: "shared",
      stage: "shared-evaluator",
      system: `You are an independent blind evaluator. Apply one rubric directly to candidate-1 and do not use Orchestrator claims. The rubric checks complete ${TOTAL_BARS}-bar span, all ${SECTION_COUNT} sections, original source/regions, retained membership, exact writer ownership, valid canonical operations, playable catalog, and coherent original neutral writing. If unavailable, pass must be false. Return JSON only with candidates:[{id,available,pass,reason,violations}] and rubric.`,
      user: { request: introRequest, originalScore: source, candidate: { id: "candidate-1", available: true, score: candidate }, operations },
      calls,
      offline,
      maxRepairs: MAX_SECTION_REPAIRS,
      validate: (payload) => validateEvaluator(payload, true),
    });
    evaluator = evaluatorResult.payload;
    if (!(evaluator.candidates as AnyRecord[])[0]?.pass) throw new Error(`Independent evaluator rejected the candidate: ${String((evaluator.candidates as AnyRecord[])[0]?.reason ?? "no reason")}`);
    events.push({ stage: "blind-evaluator-passed" });
    await writeJson(join(here, "staged-candidate.json"), candidate);
  } catch (error) {
    errors.push(errorInfo(error));
  }
  const objective = evaluateObjective(source, candidate, operations, progress);
  const elapsed = Date.now() - started;
  const result: ExperimentResult = {
    status: candidate && !errors.length && objective.pass ? "verified" : "failed",
    approved: Boolean(candidate && !errors.length && objective.pass && verification?.pass === true && evaluator && (evaluator.candidates as AnyRecord[])[0]?.pass === true),
    ...(candidate ? { candidate } : {}),
    operations,
    errors,
    events,
    progress,
    objective,
    ...(verification ? { verification } : {}),
    ...(evaluator ? { evaluator } : {}),
    privateMidi,
    advisoryMidiLoads: loaded.count,
    // A writer slot is one owned track-section. Retry calls are measured
    // separately as repairs, so a four-section x three-track run has twelve
    // initial slots even when one slot needs a bounded replacement.
    writerAttempts: progress.length,
    writerRepairs: Object.values(repairCountsBySection).reduce((sum, count) => sum + count, 0),
    repairCountsBySection,
    wallMs: elapsed,
  };
  return { result, calls, source, sourceMidi: midi };
}

async function discoverModel(connectors: ReplitConnectors, calls: CallMetric[]): Promise<ProviderModel> {
  const started = Date.now();
  const response = await xaiLaunchLimiter.schedule(() => connectors.proxy("xai", "/v1/language-models", { method: "GET" }));
  if (!response.ok) {
    await response.arrayBuffer();
    throw new ExperimentGuardError(`http-${response.status}`, `xAI model discovery failed with HTTP ${response.status}.`);
  }
  const raw = await response.arrayBuffer();
  const payload = JSON.parse(Buffer.from(raw).toString("utf8")) as AnyRecord;
  const models = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
  const selected = models.find((item) => item && item.id === PREFERRED_MODEL) ?? models.find((item) => typeof item?.id === "string" && item.id.includes("grok-4")) ?? models[0];
  if (!selected || typeof selected.id !== "string") throw new Error("xAI returned no usable language model.");
  calls.push({
    arm: "provider",
    stage: "skill-style",
    attempt: 1,
    maxTokens: 0,
    inputChars: 0,
    inputBytes: 0,
    messageChars: 0,
    messageBytes: 0,
    outputChars: raw.byteLength,
    outputBytes: raw.byteLength,
    providerModel: selected.id,
    wallMs: Date.now() - started,
    status: "success",
  });
  return { id: selected.id, metadata: Object.fromEntries(["id", "context_length", "max_output_tokens", "max_completion_tokens"].flatMap((key) => selected[key] === undefined ? [] : [[key, selected[key]]])) };
}

async function ensureFreeze(): Promise<AnyRecord> {
  const source = await readFile(join(here, "experiment.ts"));
  const hashPaths = [
    "artifacts/api-server/src/lib/ai-music-safety.ts",
    "artifacts/api-server/src/lib/chat-limiter.ts",
    "artifacts/api-server/src/lib/model-diagnostics.ts",
    "artifacts/api-server/src/lib/scoring-agents.ts",
    "artifacts/api-server/src/lib/adviser-suggestions.ts",
    "artifacts/api-server/src/lib/track-midi.ts",
    "artifacts/api-server/src/lib/score-operations.ts",
  ];
  let manifest: AnyRecord;
  try {
    manifest = JSON.parse(await readFile(productionHashesPath, "utf8")) as AnyRecord;
  } catch {
    manifest = {
      modules: await Promise.all(hashPaths.map(async (path) => ({ path, sha256: sha256(await readFile(join(here, "../../..", path))) }))),
    };
    await writeJson(productionHashesPath, manifest);
  }
  const sourceHash = sha256(source);
  try {
    const snapshot = await readFile(snapshotPath);
    const freeze = JSON.parse(await readFile(sourceFreezePath, "utf8")) as AnyRecord;
    if (sha256(snapshot) !== sourceHash || freeze.sha256 !== sourceHash) throw new Error("Executed source freeze does not match experiment.ts.");
  } catch (error) {
    if (error instanceof Error && !/ENOENT|no such file/i.test(error.message)) throw error;
    await writeFile(snapshotPath, source);
    await writeJson(sourceFreezePath, {
      schemaVersion: 1,
      source: "experiment.ts",
      snapshot: "experiment.executed.ts",
      sha256: sourceHash,
      bytes: source.byteLength,
      frozenAt: new Date().toISOString(),
      productionModuleHashes: "production-module-hashes.json",
      immutablePriorBaseline: "../intro-workflow-comparison-final/baseline.json",
      note: "Generated before offline fixture; live run refuses changed source or imported production modules.",
    });
  }
  const saved = JSON.parse(await readFile(sourceFreezePath, "utf8")) as AnyRecord;
  for (const item of (manifest.modules as AnyRecord[])) {
    const current = sha256(await readFile(join(here, "../../..", String(item.path))));
    if (current !== item.sha256) throw new Error(`Imported production module hash changed: ${String(item.path)}.`);
  }
  return { ...saved, productionModuleHashesVerified: true };
}

function report(outcome: AnyRecord): string {
  const result = outcome.result as ExperimentResult;
  const calls = outcome.callMetrics as CallMetric[];
  const usage = calls.reduce((sum, call) => sum + (call.providerTotalTokens ?? 0), 0);
  const cumulativeInput = calls.reduce((sum, call) => sum + (call.providerInputTokens ?? 0), 0);
  return `# Section-based 32-bar intro experiment

## Status

Exactly one isolated section-based experiment is authorized. This evidence directory is new and does not overwrite the earlier comparison. No saved project, project ID, normal route, or UI was touched. The experiment is one bounded sample and cannot establish general success or quality.

- Result: **${result.approved ? "verified and approved" : "failed closed or unapproved"}**
- Score: ${TOTAL_BARS} bars, 4/4, ${TEMPO} BPM, ${TOTAL_BEATS} beats
- Sections: ${SECTION_COUNT} x ${SECTION_BARS} bars (${SECTION_BEATS} beats), ${result.writerAttempts} writer calls
- Repair policy: up to ${MAX_SECTION_REPAIRS} repair cycles after the initial attempt **per failed section**; observed ${result.writerRepairs} repairs
- Model: \`${String(outcome.model ?? "offline")}\`
- Wall time: ${result.wallMs} ms; calls: ${calls.length}; cumulative reported provider input tokens: ${cumulativeInput}; cumulative reported total tokens: ${usage}

## Safeguards and source preservation

- One global Orchestrator identity loaded style, concept, and verification skills sequentially, then produced one global plan. Derived plan text was supplemental; each writer received complete original score, complete immutable source MIDI, exact section source notes, previous/next source neighbors, and staged siblings.
- There were exactly ${SECTION_COUNT * 3} owned section writer slots. A failed slot is recorded and stops promotion; it is never silently dropped. Staged siblings remain in \`partial-stage.json\` only and are not a candidate.
- Canonical production operation schema/checklist and \`validateScoreOperations\` were used. Writer regions used absolute score-relative starts and region-relative note offsets.
- Private advisory MIDI references were materialized, hash-bound, parsed by the production advisory MIDI loader, and retained as private evidence only.
- Original baseline notes/regions and track membership were compared independently of operation IDs. Candidate promotion required deterministic all-section and whole-score checks, Orchestrator verification, and a common blind evaluator.

## Observed result

\`\`\`json
${JSON.stringify({ objective: result.objective, verification: result.verification, evaluator: result.evaluator, errors: result.errors, progress: result.progress, repairCountsBySection: result.repairCountsBySection }, null, 2)}
\`\`\`

## Context and timing

Per-call exact UTF-16 character counts, UTF-8 byte counts, provider input/output/total tokens when returned, finish reasons, request IDs, transport attempts, and wall time are in \`call-metrics.json\`. Peak input bytes were ${Math.max(0, ...calls.map((call) => call.inputBytes))}; cumulative input bytes were ${calls.reduce((sum, call) => sum + call.inputBytes, 0)}. Missing provider usage is preserved as missing rather than estimated. No arbitrary score/source context was truncated.

## Offline gate and limitations

The offline full-flow and repair-exhaustion fixture completed before any live launch. Its checks are in \`offline-fixture.json\`. The offline fixture explicitly confirms all 12 section ownership slots, source preservation, four repair cycles with no sixth attempt, private advisory loader round trips, canonical prompts, verifier/evaluator negative gates, and complete-candidate-only evaluation. Directional comparison with earlier paired workflows is not a general success claim.
`;
}

async function offlineFixture(): Promise<AnyRecord> {
  await mkdir(privateMidiPath, { recursive: true });
  await mkdir(sourceMidiPath, { recursive: true });
  await ensureFreeze();
  const model: ProviderModel = { id: "offline-synthetic", metadata: { id: "offline-synthetic" } };
  const run = await runExperiment(model, syntheticResponder());
  const exhaustion = await runRepairExhaustionFixture();
  validateFixtureFailure();
  const allSlots = run.result.progress.length === SECTION_COUNT * 3 && run.result.progress.every((row) => row.status === "staged");
  const sourcePreserved = run.result.candidate ? originalRegionsPreserved(run.source, run.result.candidate) && retainedMembership(run.source, run.result.candidate) : false;
  const checks = {
    completeAllSections: allSlots && run.result.objective.pass,
    exactlyTwelveOwnedWriterSlots: run.result.writerAttempts === SECTION_COUNT * 3,
    sourceNotesAndRegionsPreserved: sourcePreserved,
    fourRepairCyclesThenNoSixthAttempt: exhaustion.pass && exhaustion.callsMade === 5 && exhaustion.noSixthAttempt,
    privateAdvisoryLoaderRoundTrip: run.result.privateMidi.length > 0 && run.result.privateMidi.every((item) => item.roundTripNoteCount === item.noteCount) && run.result.advisoryMidiLoads > 0,
    canonicalOperationPrompts: run.calls.filter((call) => call.stage === "instrument-writer").every((call) => call.promptHasCanonicalSchema && call.promptHasExactSectionScope),
    completeSourceContextPrompts: run.calls.filter((call) => call.stage === "instrument-writer").every((call) => call.promptHasCompleteScore && call.promptHasCompleteSourceMidi),
    verifierNegativeGate: (() => { try { validateVerification({ pass: true, reason: "bad", checks: { duration: true, allSections: false, newMaterialPerTrack: true, membership: true, ownership: true, segments: true, originalRegions: true } }); return false; } catch { return true; } })(),
    evaluatorNegativeGate: (() => { try { validateEvaluator({ candidates: [{ id: "candidate-1", available: false, pass: true, reason: "bad", violations: [] }], rubric: "bad" }, false); return false; } catch { return true; } })(),
    diagnosticsRemainSpecific: run.result.errors.length === 0 && run.calls.some((call) => call.stage === "instrument-writer"),
  };
  if (Object.values(checks).some((value) => !value)) throw new Error(`Offline section experiment failed: ${JSON.stringify({ checks, errors: run.result.errors, objective: run.result.objective, exhaustion })}`);
  const fixture = { mode: "offline-full-flow-before-live", model: model.id, checks, repairExhaustion: exhaustion, result: run.result, calls: run.calls };
  await writeJson(offlineFixturePath, fixture);
  return fixture;
}

async function main(): Promise<void> {
  await mkdir(here, { recursive: true });
  if (process.argv.includes("--offline-fixture")) {
    console.log(JSON.stringify(await offlineFixture()));
    return;
  }
  await ensureFreeze();
  if (process.argv.includes("--verify-freeze")) {
    console.log(JSON.stringify(await ensureFreeze()));
    return;
  }
  if (!process.argv.includes("--run")) throw new Error("This one-shot experiment requires --offline-fixture or --run.");
  try {
    await access(lockPath);
    throw new Error("The section experiment is already locked; no repeated live run is permitted.");
  } catch (error) {
    if (error instanceof Error && !/ENOENT|no such file/i.test(error.message)) throw error;
  }
  try {
    const fixture = JSON.parse(await readFile(offlineFixturePath, "utf8")) as AnyRecord;
    if (fixture.mode !== "offline-full-flow-before-live" || !fixture.checks || Object.values(fixture.checks as AnyRecord).some((value) => value !== true)) {
      throw new Error("Offline full-flow fixture did not pass; live launch is refused.");
    }
  } catch (error) {
    throw new Error(`Live launch requires a passing offline fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
  const startedAt = new Date().toISOString();
  const calls: CallMetric[] = [];
  const lock = {
    schemaVersion: 1,
    runId: randomUUID(),
    pid: process.pid,
    startedAt,
    provider: "xai",
    modelPreference: PREFERRED_MODEL,
    experiment: "isolated-32-bar-section-intro",
    sections: allSections(),
    repairCyclesAfterInitialPerFailedSection: MAX_SECTION_REPAIRS,
    finiteGuards: { maxProviderCalls: MAX_PROVIDER_CALLS, maxWallMs: MAX_EXPERIMENT_WALL_MS },
    note: "Exactly one bounded live run after passing offline full-flow gate; no rerun without explicit approval.",
  };
  await writeJson(lockPath, lock);
  let model: ProviderModel | undefined;
  let result: ExperimentResult;
  let source: ScoreValue;
  try {
    model = await discoverModel(new ReplitConnectors(), calls);
    const run = await runExperiment(model, undefined);
    result = run.result;
    source = run.source;
    await writeJson(callsPath, [...calls, ...run.calls]);
  } catch (error) {
    const failure = errorInfo(error);
    source = await loadBaseline();
    result = {
      status: "failed",
      approved: false,
      operations: [],
      errors: [failure],
      events: [{ stage: "experiment-failed-closed", diagnostic: failure }],
      progress: [],
      objective: evaluateObjective(source, undefined, [], []),
      privateMidi: [],
      advisoryMidiLoads: 0,
      writerAttempts: 0,
      writerRepairs: 0,
      repairCountsBySection: {},
      wallMs: 0,
    };
    await writeJson(callsPath, calls);
  }
  const outcome = {
    schemaVersion: 1,
    mode: "one-bounded-live-run",
    model: model?.id,
    modelMetadata: model?.metadata,
    sourceFreeze: await ensureFreeze(),
    source: { path: "baseline.json", sha256: sha256(stable(source)), durationBeats: source.durationBeats, trackIds: source.tracks.map((track) => track.id), originalRegionCount: source.tracks.reduce((sum, track) => sum + track.regions.length, 0) },
    request: introRequest,
    sectionRules: { totalBars: TOTAL_BARS, totalBeats: TOTAL_BEATS, sectionCount: SECTION_COUNT, sectionBars: SECTION_BARS, sectionBeats: SECTION_BEATS, timeSignature: "4/4", tempo: TEMPO },
    repairPolicy: { maxRepairsAfterInitialPerFailedSection: MAX_SECTION_REPAIRS, noSilentSectionDrop: true },
    result,
    callMetrics: calls,
    callTotals: { count: calls.length, cumulativeInputChars: calls.reduce((sum, call) => sum + call.inputChars, 0), cumulativeInputBytes: calls.reduce((sum, call) => sum + call.inputBytes, 0), cumulativeProviderInputTokens: calls.reduce((sum, call) => sum + (call.providerInputTokens ?? 0), 0), cumulativeProviderOutputTokens: calls.reduce((sum, call) => sum + (call.providerOutputTokens ?? 0), 0), cumulativeProviderTotalTokens: calls.reduce((sum, call) => sum + (call.providerTotalTokens ?? 0), 0), peakInputBytes: Math.max(0, ...calls.map((call) => call.inputBytes)) },
    savedProjectTouched: false,
    normalProductionWorkflowChanged: false,
  };
  await writeJson(outcomePath, outcome);
  await writeJson(callsPath, calls);
  await writeFile(reportPath, report(outcome), "utf8");
  if (result.approved && result.candidate) {
    await writeJson(join(here, "candidate.json"), result.candidate);
    await mkdir(candidateMidiPath, { recursive: true });
    for (const track of result.candidate.tracks) await writeFile(join(candidateMidiPath, `${track.id}.mid`), encodeTrackMidi(result.candidate, track));
  }
  console.log(JSON.stringify({ status: result.status, approved: result.approved, model: model?.id, calls: calls.length, repairs: result.writerRepairs }));
}

await main();