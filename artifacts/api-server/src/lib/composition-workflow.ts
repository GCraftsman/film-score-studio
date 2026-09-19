import { createHash, randomUUID } from "node:crypto";
import { sanitizeOperationText, screenMusicText } from "./ai-music-safety.ts";
import {
  MAX_WORKFLOW_OPERATIONS,
  validateScoreOperations,
  type ScoreOperationDiagnostic,
  type ScoreOperationObservedType,
} from "./score-operations.ts";
import {
  defaultReadOnlyAdvisers,
  findPlayableInstrument,
  PLAYABLE_INSTRUMENTS,
  playableInstrumentCatalogPrompt,
  type AdviserSelection,
} from "./scoring-agents.ts";
import {
  diagnosticSummary,
  envelopeShape,
  attachRawResponse,
  type ModelCallContext,
  type ModelCallStage,
  type ModelCompletion,
  ModelResponseError,
  normalizeModelCompletion,
  parseModelJson,
  safeProviderMetadata,
  throwForCompletionFailure,
  type ModelResponseDiagnostic,
  type ProviderCompletionMetadata,
} from "./model-diagnostics.ts";
import {
  normalizeAdviserSuggestions,
  validateAdvisoryMidiRef,
  type MaterializedAdvisoryMidi,
  type AdviserSuggestion,
  type AdvisoryMidiRef,
  AdviserSuggestionValidationError,
} from "./adviser-suggestions.ts";

export type WorkflowIntent = "edit" | "discussion";
export type WorkflowEvent = {
  stage: string;
  message: string;
  /** Content-free diagnostic reason safe for stream and workflow audit. */
  reason?: string;
  agent?: string;
  taskId?: string;
  files?: string[];
  /** Structured fields used by the UI for operation-format diagnostics. */
  attempt?: string;
  index?: number;
  code?: string;
  fields?: string[];
  targetId?: string;
  duplicateId?: string;
  observedType?: ScoreOperationObservedType;
  observedLength?: number;
  maxLength?: number;
  outcome?: "recovered" | "retrying" | "exhausted";
  /** Structured evaluator feedback. These values are safe, bounded, and
   * derived from the compared score copies rather than provider prose. */
  evaluationKind?: EvaluationKind;
  scope?: EvaluationScope;
  trackId?: string;
  candidateRevision?: string;
  expectedConstraints?: string[];
  observedConstraints?: string[];
  evidence?: string[];
  /** Terminal audit fields consumed by the compose route. */
  evaluatorCategory?: "malformed" | "musical-rejection" | "no-op" | "unknown";
  affectedScope?: string[];
  expected?: string;
  observed?: string;
  correctionOutcome?: string;
  commitStatus?: "not-committed";
  workflowId?: string;
  requestId?: string;
};
export type WorkflowTask = {
  id: string; title: string; priority: string; scope: number; agents: string[];
  status: string; summary: string; editedFiles: string[]; compact?: boolean;
};
export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
export type WorkflowModel = {
  /**
   * The legacy string method remains the compatibility path for existing
   * tests/models. New providers should implement completeDetailed so finish
   * metadata is retained for diagnostics.
   */
  complete: (messages: ModelMessage[], maxTokens: number, json?: boolean) => Promise<string>;
  completeDetailed?: (
    messages: ModelMessage[],
    maxTokens: number,
    json?: boolean,
  ) => Promise<ModelCompletion | string>;
};
export type ScoreValue = {
  tempo: number; durationBeats: number;
  tracks: Array<{
    id: string; name?: string; role?: string; instrument?: string; midiProgram?: number;
    regions: Array<Record<string, unknown> & {
      id: string; startBeat: number; durationBeats?: number;
      notes: Array<{ pitch: number; velocity: number; startBeat: number; durationBeats: number }>;
    }>;
  }>;
};
export type WorkflowResult = {
  intent: WorkflowIntent; status: "verified" | "discussion"; summary: string;
  tasks: Array<Pick<WorkflowTask, "id" | "title" | "priority" | "status" | "summary" | "editedFiles">>;
  events: WorkflowEvent[]; changedFiles: string[]; operations: Record<string, unknown>[];
  /** Membership proposals are returned both for approval checkpoints and for
   * verified additions that were approved before generation. */
  trackProposals: TrackProposal[];
  consultations: Array<{ agent: string; group: "instrument" | "style" | "concept"; question: string; insight: string; suggestions?: AdviserSuggestion[] }>;
  /** Present only while a membership proposal is awaiting explicit approval. */
  approvalContext?: CompositionApprovalContext;
};

type PlannerRosterEntry = { id: string; name: string };
export type EvaluationKind = "malformed" | "no-musical-change" | "musical-rejection";

export type EvaluationScope = "track" | "task" | "overall";
export type TrackProposal = {
  id: string;
  action: "add" | "delete";
  trackId?: string;
  instrument: string;
  role: string;
  midiProgram: number;
  summary: string;
  reason: string;
};

export type CompositionApprovalBudget = {
  adviserConsultationsUsed: number;
  trackWriterRoundsUsed: number;
  refinementRoundsUsed: number;
  /** Shared two-attempt pool for writer operation repairs and plan structural repair. */
  operationRepairAttemptsUsed: number;
};

export type CompositionApprovalContext = {
  originalMessage: string;
  originalHistory: unknown[];
  originalMidi: unknown[];
  selectedStyle?: string;
  projectId?: string;
  /**
   * Bound by the initial Orchestrator membership plan.  Missing is retained
   * only for legacy checkpoints; new checkpoints always carry this decision.
   */
  requiresPlayableMaterial?: boolean;
  adviserRoster: AdviserSelection[];
  adviserConsultations: WorkflowResult["consultations"];
  consumedBudget: CompositionApprovalBudget;
};
export type EvaluationFeedback = {
  kind: EvaluationKind;
  scope: EvaluationScope;
  /** The exact writer track implicated by the feedback, when there is one. */
  trackId?: string;
  /** Stable digest of the candidate score that was inspected. */
  candidateRevision: string;
  /** Expected constraints are model-authored claims, separately screened. */
  expectedConstraints: string[];
  /** Observed constraints are service-derived; never copy evaluator prose. */
  observedConstraints: string[];
  reason: string;
  evidence: string[];
  correctionAgents: string[];
  instrumentAdditions?: TrackProposal[];
};
const MAX_TASKS = 5;
const MAX_DIALOG_EXCHANGES = 12;
const MAX_INSTRUMENT_ADDITIONS = 4;
const MAX_CORRECTION_ROUNDS = MAX_TASKS + 1;
type WorkflowRunState = {
  executedTasks: number;
  planRepairUsed: boolean;
  correctionRoundsUsed: number;
  operationCount: number;
  dialogExchangesUsed: number;
  expansionUsed: boolean;
};

function newWorkflowRunState(): WorkflowRunState {
  return {
    executedTasks: 0,
    planRepairUsed: false,
    correctionRoundsUsed: 0,
    operationCount: 0,
    dialogExchangesUsed: 0,
    expansionUsed: false,
  };
}

type OperationPromptMode = "compact" | "canonical";

/**
 * xAI's currently selected Grok models support a substantially larger
 * completion window than the old 3,600-token specialist budget. Keep these
 * values explicit and bounded: a large score-operation batch needs room for
 * every note, while a repair must be able to return a complete replacement
 * rather than appending an impossible suffix to truncated JSON.
 */
export const SPECIALIST_INITIAL_COMPLETION_TOKENS = 16_000;
export const SPECIALIST_REPAIR_COMPLETION_TOKENS = 32_000;
export const SPECIALIST_FIRST_REPAIR_COMPLETION_TOKENS = 24_000;

const IMPORTANT_AGENT_CHECKLIST = `
IMPORTANT — BEFORE RESPONDING, verify every applicable constraint below. Do not print this checklist or claim validation substitutes for server verification.
1. Follow the composer's requested scope, complete source MIDI, selected style, assigned instruction, and any refinement feedback. Preserve source performance and actionable constraints; do not silently shorten, omit, or replace them.
2. Respect your role: advisers may inspect all tracks but cannot write executable score edits or membership changes. Instrument writers edit ONLY their assigned track. Only Orchestrator coordinates writers and requests explicit approval for adding/removing tracks. Never treat advice as approval.
3. Use original neutral musical language, not named references, quoted titles, or imitation requests. Use supported catalog instruments and achievable techniques; explicitly map creative timbres to supported instruments.
4. Return exactly the requested JSON contract with all required fields, correct types, allowed enum values, valid IDs and targets, bounded arrays and strings, and no forbidden fields. Finish the entire response; never return partial MIDI or placeholder/no-op edits.
5. If returning MIDI, verify ALL notes and regions: finite timing, valid integer pitch/velocity, valid dynamics/articulation, correct beat coordinate system, allowed counts, duration containment, track ownership, and exact existing removal targets. Check every event, not just the first. Ensure requested playable additions contain real playable material.
6. During structural repair preserve musical content exactly. Only an explicitly authorized bounded musical regeneration may change invalid musical content; preserve valid siblings and immutable review decisions. Never hide a failed constraint by dropping an operation.
`;

function specialistRepairCompletionTokens(attempt: number): number {
  return attempt <= 1
    ? SPECIALIST_FIRST_REPAIR_COMPLETION_TOKENS
    : SPECIALIST_REPAIR_COMPLETION_TOKENS;
}

const OPERATION_JSON_SCHEMA = `When your response contains an "operations" field, it MUST be an array. Every array item MUST exactly be one of:
{"id":"unique-operation-id","type":"add-region","trackId":"existing-track-id","summary":"original edit","region":{"id":"unique-region-id","name":"original cue region","startBeat":0,"durationBeats":4,"dynamics":"mf","articulation":"sustain","notes":[{"pitch":60,"velocity":80,"startBeat":0,"durationBeats":1,"articulation":"sustain"}]}}
or {"id":"existing-operation-id","type":"remove-region","trackId":"existing-track-id","regionId":"existing-region-id","summary":"original edit"}.
Every operation "id" is mandatory, and every add-region "region.id" is mandatory. Use non-empty unique IDs within this response; never omit, reuse, or write placeholder values such as "optional-operation-id" or "optional-new-region-id". IDs are metadata, not musical identity, so repairing a duplicate or placeholder ID means replacing only that ID with a fresh unique ID while preserving the operation's type, target, region, and notes. Remove-region always requires the exact provided existing trackId and regionId; never invent, rename, or substitute a target.
Every operation summary is required, must be a non-empty string, and must be no longer than 1200 characters. This is a structural contract, not prose: do not use edits, changes, addRegion, removeRegion, or any envelope other than operations. Never invent music, notes, targets, or fallback edits to fill an omitted field. Never drop an operation because a sibling is malformed; repair the cited field in the complete response or fail closed.
The JSON example contains valid sample values, not pipe-separated alternatives. Region dynamics must be exactly one of: pp, p, mp, mf, f, ff. Region and note articulation must be exactly one of: sustain, legato, staccato, marcato, tremolo, pizzicato. Never put a list such as "pp|p|mp|mf|f|ff" into a JSON field.
Notes use region-relative, zero-based beat offsets; regions use score-relative, zero-based beat offsets. Four bars in 4/4 means 16 beats, not four beats. Every note startBeat + durationBeats must be <= its region.durationBeats; every region startBeat + durationBeats must be <= score.durationBeats. Use existing track IDs exactly. All displayed fields are required, including note articulation. Notes and regions must fit their durations.`;

const MAX_OPERATION_FORMAT_REPAIRS = 2;
export class WorkflowFailure extends Error {
  readonly evaluationFeedback?: EvaluationFeedback;
  constructor(message: string, evaluationFeedback?: EvaluationFeedback) {
    super(message);
    this.name = "WorkflowFailure";
    this.evaluationFeedback = evaluationFeedback;
  }
}

export type WorkflowOperationDiagnostic = {
  index: number;
  reason: string;
  fields: string[];
  code?: ScoreOperationDiagnostic["code"] | string;
  targetId?: string;
  duplicateId?: string;
  observedType?: ScoreOperationObservedType;
  observedLength?: number;
  maxLength?: number;
};

export class OperationValidationError extends WorkflowFailure {
  readonly diagnostic: WorkflowOperationDiagnostic;
  constructor(diagnostic: WorkflowOperationDiagnostic) {
    super(`Invalid score operation at index ${diagnostic.index}: ${diagnostic.reason}.`);
    this.name = "OperationValidationError";
    this.diagnostic = diagnostic;
  }
}

function diagnosticRequiresMusicalRegeneration(diagnostic: WorkflowOperationDiagnostic): boolean {
  return diagnostic.fields.some(field =>
    field === "trackId" ||
    field === "regionId" ||
    field === "region" ||
    field === "region.startBeat" ||
    field === "region.durationBeats" ||
    field === "region.dynamics" ||
    field === "region.articulation" ||
    field === "region.notes" ||
    field.startsWith("region.notes[")
  );
}

export type PlanDiagnostic = {
  index: number;
  code: string;
  reason: string;
  fields: string[];
};

export type WorkflowDiagnostic = Omit<ModelResponseDiagnostic, "code"> & ModelCallContext & {
  code: string;
  /** Optional score-operation diagnostic fields; all values are bounded metadata. */
  index?: number;
  fields?: string[];
  targetId?: string;
  duplicateId?: string;
  observedType?: ScoreOperationObservedType;
  observedLength?: number;
  maxLength?: number;
};

type DiagnosticEmitter = (diagnostic: WorkflowDiagnostic) => void;

async function completeModel(
  model: WorkflowModel,
  messages: ModelMessage[],
  maxTokens: number,
  jsonMode: boolean | undefined,
): Promise<ModelCompletion> {
  messages = messages.map(message => message.role === "system"
    ? { ...message, content: `${message.content}\n${IMPORTANT_AGENT_CHECKLIST}` }
    : message);
  const raw = model.completeDetailed
    ? await model.completeDetailed(messages, maxTokens, jsonMode)
    : model.complete
      ? await model.complete(messages, maxTokens, jsonMode)
      : undefined;
  const completion = normalizeModelCompletion(raw);
  // Metadata supplied by test doubles is normalized here too, so no caller
  // can accidentally log unbounded provider fields.
  completion.metadata = safeProviderMetadata(completion.metadata);
  try {
    throwForCompletionFailure(completion);
  } catch (error) {
    if (error instanceof ModelResponseError) {
      // Keep the budget in the bounded diagnostic so a caller can distinguish
      // a provider cutoff from a schema failure and decide whether one of its
      // finite retries should escalate it.
      error.diagnostic.requestedTokens = Math.max(0, Math.min(
        Math.floor(maxTokens),
        SPECIALIST_REPAIR_COMPLETION_TOKENS,
      ));
    }
    if (error instanceof ModelResponseError && completion.content) attachRawResponse(error, completion.content);
    throw error;
  }
  return completion;
}

async function completeJson(
  model: WorkflowModel,
  messages: ModelMessage[],
  maxTokens: number,
  context: ModelCallContext,
  emitDiagnostic?: DiagnosticEmitter,
  requireOperations = false,
  allowProviderLengthPayload = false,
): Promise<{
  raw: string;
  payload: Record<string, unknown>;
  metadata?: ProviderCompletionMetadata;
  /**
   * A provider can return a parseable prefix and still report finish_reason
   * length. Callers producing score operations must not accept that prefix as
   * complete, but may use its complete siblings losslessly in recovery.
   */
  providerFailure?: ModelResponseError;
}> {
  try {
    const completion = await completeModel(model, messages, maxTokens, true);
    try {
      const payload = parseModelJson(completion.content, {
        requireOperations,
        provider: completion.metadata,
      });
      return { raw: completion.content, payload, metadata: completion.metadata };
    } catch (error) {
      if (error instanceof ModelResponseError) attachRawResponse(error, completion.content);
      throw error;
    }
  } catch (error) {
    if (error instanceof ModelResponseError) {
      // finish_reason=length is different from a structural schema defect.
      // When the provider happened to finish a complete JSON prefix, retain
      // that envelope for lossless sibling preservation while still returning
      // the provider failure to the bounded operation-recovery loop. Parse
      // without requireOperations here so a truncated envelope missing its
      // operations key gets a complete-replacement recovery request rather
      // than an impossible structural repair of a missing suffix.
      if (
        allowProviderLengthPayload &&
        error.diagnostic.code === "provider-token-limit" &&
        error.rawResponse
      ) {
        try {
          const payload = parseModelJson(error.rawResponse, {
            provider: error.diagnostic.provider,
          });
          emitDiagnostic?.({ ...error.diagnostic, ...context, maxTokens });
          return {
            raw: error.rawResponse,
            payload,
            metadata: error.diagnostic.provider,
            providerFailure: error,
          };
        } catch {
          // The raw completion is not a complete JSON object. The caller
          // still receives the provider-token-limit diagnostic and asks for a
          // complete replacement, while any safely extractable operations
          // are recovered separately by validateWithTwoFormatRepairs.
        }
      }
      emitDiagnostic?.({ ...error.diagnostic, ...context, maxTokens });
    } else {
      emitDiagnostic?.({
        code: "model-request-failure",
        reason: "The model request failed before a safe response could be classified.",
        responseChars: 0,
        envelope: envelopeShape(undefined),
        ...context,
        maxTokens,
      });
    }
    throw error;
  }
}

async function completeText(
  model: WorkflowModel,
  messages: ModelMessage[],
  maxTokens: number,
  context: ModelCallContext,
  emitDiagnostic?: DiagnosticEmitter,
): Promise<{ raw: string; metadata?: ProviderCompletionMetadata }> {
  try {
    const completion = await completeModel(model, messages, maxTokens, false);
    return { raw: completion.content, metadata: completion.metadata };
  } catch (error) {
    if (!(error instanceof ModelResponseError)) throw error;
    emitDiagnostic?.({ ...error.diagnostic, ...context, maxTokens });
    throw error;
  }
}

type WorkflowDiagnosticFields = Pick<
  WorkflowEvent,
  "reason" | "index" | "code" | "fields" | "targetId" | "duplicateId" |
  "observedType" | "observedLength" | "maxLength"
>;

/**
 * Convert an operation/model failure to the small allowlist that may cross
 * diagnostic, stream, and audit boundaries. In particular, never spread a
 * failed operation or provider response into a workflow event.
 */
function workflowDiagnosticFields(
  diagnostic: WorkflowOperationDiagnostic | ModelResponseDiagnostic,
): WorkflowDiagnosticFields {
  if ("index" in diagnostic) {
    return {
      reason: diagnostic.reason,
      index: diagnostic.index,
      code: String(diagnostic.code ?? "unknown"),
      fields: diagnostic.fields,
      ...(diagnostic.targetId !== undefined ? { targetId: diagnostic.targetId } : {}),
      ...(diagnostic.duplicateId !== undefined ? { duplicateId: diagnostic.duplicateId } : {}),
      ...(diagnostic.observedType !== undefined ? { observedType: diagnostic.observedType } : {}),
      ...(diagnostic.observedLength !== undefined ? { observedLength: diagnostic.observedLength } : {}),
      ...(diagnostic.maxLength !== undefined ? { maxLength: diagnostic.maxLength } : {}),
    };
  }
  return {
    reason: diagnostic.reason,
    code: diagnostic.code,
    fields: ["response"],
  };
}

function modelFailureEvent(
  diagnostic: WorkflowDiagnostic,
): WorkflowEvent {
  return {
    stage: "agent-response-error",
    message: diagnosticSummary(diagnostic, diagnostic),
    reason: diagnostic.reason,
    ...(diagnostic.agent ? { agent: diagnostic.agent } : {}),
    ...(diagnostic.taskId ? { taskId: diagnostic.taskId } : {}),
    ...(diagnostic.attempt ? { attempt: diagnostic.attempt } : {}),
    code: diagnostic.code,
    ...(diagnostic.index !== undefined ? { index: diagnostic.index } : {}),
    fields: diagnostic.fields ?? ["response"],
    ...(diagnostic.targetId !== undefined ? { targetId: diagnostic.targetId } : {}),
    ...(diagnostic.duplicateId !== undefined ? { duplicateId: diagnostic.duplicateId } : {}),
    ...(diagnostic.observedType !== undefined ? { observedType: diagnostic.observedType } : {}),
    ...(diagnostic.observedLength !== undefined ? { observedLength: diagnostic.observedLength } : {}),
    ...(diagnostic.maxLength !== undefined ? { maxLength: diagnostic.maxLength } : {}),
    evaluatorCategory: "unknown",
    affectedScope: ["unknown"],
    evidence: [],
    correctionOutcome: diagnostic.attempt ? "retrying" : "not-attempted",
    commitStatus: "not-committed",
  };
}

function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value.trim() : fallback; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function publicFile(trackId: string): string { return `${trackId}.mid`; }

function proposalSummary(value: unknown, instrument: string): string {
  const summary = screenMusicText(text(value), `Add ${instrument} for the requested musical material.`);
  return summary.slice(0, 1_200) || `Add ${instrument} for the requested musical material.`;
}

function proposalReason(value: unknown, instrument: string): string {
  const reason = screenMusicText(text(value), `The requested material needs ${instrument}.`);
  return reason.slice(0, 2_500) || `The requested material needs ${instrument}.`;
}

/**
 * Instrument membership is deliberately normalized at the workflow boundary.
 * Model-authored programs, roles, and aliases never get to create an
 * unplayable track, and duplicate needs fail closed rather than becoming
 * multiple tracks or silently changing an existing score.
 */
function parseInstrumentNeeds(value: unknown, score: ScoreValue): TrackProposal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INSTRUMENT_ADDITIONS) {
    throw new WorkflowFailure(`Instrument additions must contain no more than ${MAX_INSTRUMENT_ADDITIONS} supported instruments.`);
  }
  const existing = new Set(score.tracks.map((track) => {
    const playable = findPlayableInstrument(track.instrument ?? "");
    return playable?.id ?? String(track.instrument ?? "").trim().toLowerCase();
  }));
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WorkflowFailure(`Instrument addition ${index + 1} was malformed.`);
    }
    const record = item as Record<string, unknown>;
    const playable = findPlayableInstrument(typeof record.instrument === "string" ? record.instrument : "");
    if (!playable) throw new WorkflowFailure("Instrument addition requested an unsupported instrument.");
    if (existing.has(playable.id) || seen.has(playable.id)) {
      throw new WorkflowFailure(`Instrument addition "${playable.name}" is duplicate or already present.`);
    }
    const suppliedId = text(record.id);
    const id = suppliedId || `instrument-add-${playable.id}`;
    if (id.length > 370) throw new WorkflowFailure("Instrument addition proposal IDs must leave room for their deterministic track IDs.");
    if (seen.has(id)) throw new WorkflowFailure("Instrument additions must have unique proposal IDs.");
    seen.add(playable.id);
    seen.add(id);
    return {
      id,
      action: "add" as const,
      trackId: `track-${id}`,
      instrument: playable.name,
      role: playable.role,
      midiProgram: playable.midiProgram,
      summary: proposalSummary(record.summary, playable.name),
      reason: proposalReason(record.reason, playable.name),
    };
  });
}

function applyInstrumentAdditions(score: ScoreValue, additions: TrackProposal[]): ScoreValue {
  if (!additions.length) return clone(score);
  const next = clone(score);
  const trackIds = new Set(next.tracks.map((track) => track.id));
  const instrumentIds = new Set(next.tracks.map((track) => findPlayableInstrument(track.instrument ?? "")?.id));
  for (const addition of additions) {
    const playable = findPlayableInstrument(addition.instrument);
    const trackId = addition.trackId || `track-${addition.id}`;
    if (addition.action !== "add" || !playable || trackIds.has(trackId) || instrumentIds.has(playable.id)) {
      throw new WorkflowFailure("Approved instrument additions were unsupported, duplicated, or already present; no score change was made.");
    }
    if (next.tracks.length >= 32) throw new WorkflowFailure("The score already contains the maximum supported track count.");
    next.tracks.push({
      id: trackId,
      name: playable.name,
      role: playable.role,
      instrument: playable.name,
      midiProgram: playable.midiProgram,
      regions: [],
    });
    trackIds.add(trackId);
    instrumentIds.add(playable.id);
  }
  return next;
}

function applyOperations(score: ScoreValue, operations: Record<string, unknown>[]): ScoreValue {
  const next = clone(score);
  for (const operation of operations) {
    const track = next.tracks.find((candidate) => candidate.id === operation.trackId);
    if (!track) throw new WorkflowFailure("A validated operation referenced a missing track.");
    if (operation.type === "remove-region") {
      track.regions = track.regions.filter((region) => region.id !== operation.regionId);
    } else if (operation.type === "add-region") {
      track.regions.push(clone(operation.region as ScoreValue["tracks"][number]["regions"][number]));
    }
  }
  return next;
}

function reserveOperationIds(existing: Record<string, unknown>[], incoming: Record<string, unknown>[]): Record<string, unknown>[] {
  const ids = new Set(existing.map((operation) => String(operation.id ?? "")));
  return incoming.map((operation) => {
    const current = String(operation.id ?? "");
    const id = current && !ids.has(current) ? current : `operation-${randomUUID()}`;
    ids.add(id);
    return { ...operation, id };
  });
}
function validOperations(score: ScoreValue, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new OperationValidationError({ index: -1, code: "invalid-operations", reason: "operations is not an array", fields: ["operations"] });
  const operations = value.map((operation) => sanitizeOperationText(operation));
  if (operations.some((operation) => !operation || typeof operation !== "object")) {
    throw new OperationValidationError({ index: operations.findIndex((operation) => !operation || typeof operation !== "object"), code: "malformed-operation", reason: "operation is not an object", fields: [] });
  }
  const validated = validateScoreOperations(score, operations);
  if (validated.diagnostics.length) {
    throw new OperationValidationError(validated.diagnostics[0]);
  }
  if (validated.length !== operations.length) {
    const invalid = operations.findIndex((operation, index) => validated[index] !== operation);
    const operation = operations[Math.max(0, invalid)] as Record<string, unknown>;
    const fields = operation && typeof operation === "object"
      ? ["id", "type", "trackId", ...(operation.type === "add-region" ? ["region"] : ["regionId"])].filter((field) => operation[field] === undefined)
      : [];
    throw new OperationValidationError({
      index: invalid,
      code: "invalid-field",
      reason: fields.length ? "required field missing" : "fails score bounds, identifiers, target, or note structure",
      fields,
    });
  }
  return validated;
}

/**
 * A format repair replaces the response envelope, not the musical proposal.
 * Compare operation content without metadata IDs, labels, or summaries so a
 * provider can safely replace a duplicate/placeholder ID while still being
 * required to return exactly every otherwise-valid edit.  This is a
 * fingerprint *multiset*, rather than a set: two identical musical edits are
 * still two edits and cannot be silently collapsed by a repair.
 */
function operationContentFingerprint(operation: Record<string, unknown>): string {
  if (operation.type === "remove-region") {
    return JSON.stringify({
      type: operation.type,
      trackId: operation.trackId,
      regionId: operation.regionId,
    });
  }
  const region = operation.region && typeof operation.region === "object"
    ? operation.region as Record<string, unknown>
    : undefined;
  const notes = Array.isArray(region?.notes)
    ? region.notes.map((note) => {
      const value = note as Record<string, unknown>;
      return {
        pitch: value.pitch,
        velocity: value.velocity,
        startBeat: value.startBeat,
        durationBeats: value.durationBeats,
        articulation: value.articulation,
      };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : region?.notes;
  return JSON.stringify({
    type: operation.type,
    trackId: operation.trackId,
    region: region && {
      startBeat: region.startBeat,
      durationBeats: region.durationBeats,
      dynamics: region.dynamics,
      articulation: region.articulation,
      notes,
    },
  });
}

function fingerprintableRepairOperation(
  score: ScoreValue,
  candidate: unknown,
): Record<string, unknown>[] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
  const operation = clone(candidate as Record<string, unknown>);
  // IDs and summaries are envelope metadata for this comparison.  Supplying
  // private IDs lets us fingerprint an otherwise complete operation even when
  // the response's ID is missing, duplicated, or a placeholder and is the
  // field that the bounded repair is expected to fix.
  operation.id = "__repair-operation-id__";
  operation.summary = "__repair-summary__";
  if (operation.type === "add-region" && operation.region && typeof operation.region === "object" && !Array.isArray(operation.region)) {
    operation.region = { ...(operation.region as Record<string, unknown>), id: "__repair-region-id__" };
  }
  try {
    const validated = validOperations(score, [operation])[0];
    return validated ? [validated] : [];
  } catch {
    return [];
  }
}

function validRepairSiblingOperations(score: ScoreValue, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => fingerprintableRepairOperation(score, candidate));
}

function validRepairSiblings(score: ScoreValue, value: unknown): string[] {
  return validRepairSiblingOperations(score, value).map(operationContentFingerprint);
}

function mergeSiblingFingerprints(existing: string[], incoming: string[]): string[] {
  const counts = (values: string[]) => {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const merged = counts(existing);
  for (const [fingerprint, count] of counts(incoming)) {
    merged.set(fingerprint, Math.max(merged.get(fingerprint) ?? 0, count));
  }
  return [...merged.entries()].flatMap(([fingerprint, count]) => Array.from({ length: count }, () => fingerprint));
}

/**
 * A length-limited response can be invalid JSON even when its operations
 * array contains one or more complete object values before the missing
 * suffix. This is deliberately a lexical scanner rather than a regular
 * expression: `"operations"` in a string, a nested example object, or a
 * nested property must never be mistaken for the root response's array.
 * Extract only independently balanced object values; never guess at a
 * partial object or synthesize fields. Complete non-object values are
 * skipped so a later complete operation remains recoverable.
 */
type JsonLexicalValue = { end: number; kind: "object" | "other" };

function skipJsonWhitespace(raw: string, start: number): number {
  let cursor = start;
  while (cursor < raw.length && /\s/.test(raw[cursor] ?? "")) cursor += 1;
  return cursor;
}

function scanJsonString(raw: string, start: number): number | undefined {
  if (raw[start] !== "\"") return undefined;
  let escaped = false;
  for (let cursor = start + 1; cursor < raw.length; cursor += 1) {
    const character = raw[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") return cursor + 1;
  }
  return undefined;
}

/**
 * Find the end of one JSON value without interpreting object keys. Composite
 * values are balanced lexically, including braces and brackets inside nested
 * values; strings honor escaped quotes and backslashes. JSON.parse is still
 * used by the caller to decide whether a complete object is an operation.
 */
function scanJsonValue(raw: string, start: number): JsonLexicalValue | undefined {
  const first = raw[start];
  if (first === "\"") {
    const end = scanJsonString(raw, start);
    return end === undefined ? undefined : { end, kind: "other" };
  }
  if (first === "{" || first === "[") {
    const stack: string[] = [first === "{" ? "}" : "]"];
    let cursor = start + 1;
    while (cursor < raw.length) {
      const character = raw[cursor];
      if (character === "\"") {
        const end = scanJsonString(raw, cursor);
        if (end === undefined) return undefined;
        cursor = end;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character === "{" ? "}" : "]");
      } else if (character === "}" || character === "]") {
        if (stack.at(-1) !== character) return undefined;
        stack.pop();
        if (!stack.length) {
          return { end: cursor + 1, kind: first === "{" ? "object" : "other" };
        }
      }
      cursor += 1;
    }
    return undefined;
  }
  const literal = raw.slice(start).match(/^(?:true|false|null)(?=\s|[,}\]]|$)/);
  if (literal) return { end: start + literal[0].length, kind: "other" };
  const number = raw.slice(start).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s|[,}\]]|$)/);
  return number ? { end: start + number[0].length, kind: "other" } : undefined;
}

export type TruncatedOperationsScan = {
  operations: Record<string, unknown>[];
  hasIncompleteValue: boolean;
};

function scanOperationsArray(raw: string, start: number): TruncatedOperationsScan {
  if (raw[start] !== "[") return { operations: [], hasIncompleteValue: false };
  const result: Record<string, unknown>[] = [];
  let cursor = start + 1;
  while (cursor < raw.length) {
    cursor = skipJsonWhitespace(raw, cursor);
    if (raw[cursor] === "]") return { operations: result, hasIncompleteValue: false };
    if (raw[cursor] === ",") {
      // A malformed separator is not a value. Skip it and continue looking
      // for independently complete values without treating nested content as
      // an operation.
      cursor += 1;
      continue;
    }
    const value = scanJsonValue(raw, cursor);
    // A value that starts but never reaches a balanced boundary is evidence
    // that the provider cut off an intended sibling. Returning the complete
    // prefix alone would make a later replacement indistinguishable from a
    // response that intentionally contained only that prefix.
    if (!value) return { operations: result, hasIncompleteValue: true };
    if (value.kind === "object") {
      try {
        const candidate = JSON.parse(raw.slice(cursor, value.end)) as unknown;
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          result.push(candidate as Record<string, unknown>);
        }
      } catch {
        // A complete but malformed object is not safe to recover. Its lexical
        // boundary is still known, so continue to a later complete sibling.
      }
    }
    cursor = skipJsonWhitespace(raw, value.end);
    if (raw[cursor] === ",") cursor += 1;
    else if (raw[cursor] === "]") return { operations: result, hasIncompleteValue: false };
    else return { operations: result, hasIncompleteValue: true };
  }
  // The array itself never closed. This includes a trailing comma after a
  // complete sibling and an unfinished value after that comma.
  return { operations: result, hasIncompleteValue: true };
}

/**
 * Locate only the root object's operations property. Root properties are
 * scanned as complete values, so nested/example operations keys and strings
 * containing JSON are never searched.
 */
export function scanTruncatedOperations(raw: string): TruncatedOperationsScan {
  let cursor = skipJsonWhitespace(raw, 0);
  if (raw[cursor] !== "{") return { operations: [], hasIncompleteValue: false };
  cursor += 1;
  while (cursor < raw.length) {
    cursor = skipJsonWhitespace(raw, cursor);
    if (raw[cursor] === "}") return { operations: [], hasIncompleteValue: false };
    if (raw[cursor] !== "\"") return { operations: [], hasIncompleteValue: false };
    const keyEnd = scanJsonString(raw, cursor);
    if (keyEnd === undefined) return { operations: [], hasIncompleteValue: false };
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(cursor, keyEnd)) as unknown;
    } catch {
      return { operations: [], hasIncompleteValue: false };
    }
    cursor = skipJsonWhitespace(raw, keyEnd);
    if (raw[cursor] !== ":") return { operations: [], hasIncompleteValue: false };
    cursor = skipJsonWhitespace(raw, cursor + 1);
    if (key === "operations" && raw[cursor] === "[") {
      return scanOperationsArray(raw, cursor);
    }
    const value = scanJsonValue(raw, cursor);
    if (!value) return { operations: [], hasIncompleteValue: false };
    cursor = skipJsonWhitespace(raw, value.end);
    if (raw[cursor] === ",") cursor += 1;
    else if (raw[cursor] === "}") return { operations: [], hasIncompleteValue: false };
    else return { operations: [], hasIncompleteValue: false };
  }
  return { operations: [], hasIncompleteValue: false };
}

export function completeOperationsFromTruncatedJson(raw: string): Record<string, unknown>[] {
  return scanTruncatedOperations(raw).operations;
}

function assertExactRepairOperationMultiset(
  baseline: string[],
  operations: Record<string, unknown>[],
): void {
  if (!baseline.length) return;
  const available = operations.map(operationContentFingerprint);
  for (const fingerprint of baseline) {
    const index = available.indexOf(fingerprint);
    if (index < 0) {
      throw new OperationValidationError({
        index: -1,
        code: "invalid-operations",
        reason: "format repair dropped a valid operation or changed its musical content",
        fields: ["operations"],
      });
    }
    available.splice(index, 1);
  }
  if (available.length) {
    throw new OperationValidationError({
      index: -1,
      code: "invalid-operations",
      reason: "format repair appended an unverified musical operation",
      fields: ["operations"],
    });
  }
}

/** MIDI-semantic comparison intentionally ignores internal IDs, cue labels and
 * region/note ordering. It checks actual rendered note timing/pitch/velocity. */
export function semanticMidiFingerprint(score: ScoreValue): string {
  const tracks = score.tracks.map((track) => ({
    program: track.midiProgram ?? 0,
    instrument: track.instrument ?? "",
    notes: track.regions.flatMap((region) => region.notes.map((note) => ({
      pitch: note.pitch, velocity: note.velocity,
      startBeat: region.startBeat + note.startBeat,
      durationBeats: note.durationBeats,
    }))).sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch || a.velocity - b.velocity || a.durationBeats - b.durationBeats),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ tempo: score.tempo, durationBeats: score.durationBeats, tracks });
}

type RenderedMidiNote = {
  trackId: string;
  pitch: number;
  velocity: number;
  startBeat: number;
  durationBeats: number;
};
function trackAgent(track: ScoreValue["tracks"][number]): string {
  // Track ID preserves unique specialist identity for duplicate instruments.
  return `${track.instrument || track.name || "Instrument"} (instrument, track ${track.id})`;
}
function groupForAgent(agent: string): "instrument" | "style" | "concept" {
  if (agent.includes("(instrument, track ")) return "instrument";
  if (/style|jazz|classical|cinematic|ambient|electronic|folk|modern/i.test(agent)) return "style";
  return "concept";
}

export async function classifyIntent(
  model: WorkflowModel,
  message: string,
  history: unknown[],
  sourceMidi?: unknown,
  onDiagnostic?: DiagnosticEmitter,
): Promise<WorkflowIntent> {
  let completion: { raw: string; payload: Record<string, unknown>; metadata?: ProviderCompletionMetadata };
  try {
    completion = await completeJson(model, [
      { role: "system", content: "Classify the composer's semantic intent. Return JSON only: {\"intent\":\"edit\"|\"discussion\"}. Discussion includes questions, explanation, feedback, and approval decisions with no request to alter playable score data. Edit requires a concrete request to create, revise, add, remove, arrange, or otherwise alter score material. Classify semantically, never with keyword matching." },
      { role: "user", content: JSON.stringify({ message, history, completeSourceMidi: sourceMidi }) },
    ], 180, { stage: "initial", agent: "Orchestrator" }, onDiagnostic);
  } catch (error) {
    if (error instanceof ModelResponseError) {
      error.message = diagnosticSummary(error.diagnostic, { stage: "initial", agent: "Orchestrator" });
    }
    throw error;
  }
  const result = completion.payload;
  if (result.intent !== "edit" && result.intent !== "discussion") {
    onDiagnostic?.({
      code: "invalid-intent",
      reason: "The Orchestrator returned an unsupported semantic intent.",
      responseChars: completion.raw.length,
      envelope: envelopeShape(result),
      ...(completion.metadata ? { provider: completion.metadata } : {}),
      stage: "initial",
      agent: "Orchestrator",
    });
    throw new WorkflowFailure("The scoring room could not classify the request safely: Specialist Orchestrator returned invalid-intent. Please try again.");
  }
  return result.intent;
}

function planError(code: string, reason: string, index = -1, fields: string[] = ["tasks"]): never {
  throw new PlanValidationError({ index, code, reason, fields });
}

function parseTasks(value: unknown, roster: PlannerRoster, compact = false, maxTasks = MAX_TASKS): WorkflowTask[] {
  if (!Array.isArray(value)) {
    planError("tasks-array-missing", "tasks must be an array", -1, ["tasks"]);
  }
  if (value.length === 0) {
    planError("tasks-empty", "tasks must contain at least one task", -1, ["tasks"]);
  }
  if (value.length > maxTasks) {
    planError("too-many-tasks", `tasks must contain no more than ${maxTasks} tasks for the remaining workflow budget`, -1, ["tasks"]);
  }
  const ids = new Set<string>();
  const tasks: WorkflowTask[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    if (!record || typeof record !== "object") {
      planError("malformed-task", "task must be an object", index, [`tasks[${index}]`]);
    }
    const task = record as Record<string, unknown>;
    const id = text(task.id); const title = screenMusicText(text(task.title), "Original score task"); const scope = Number(task.scope);
    if (!Array.isArray(task.agents)) {
      planError("agents-array-missing", "agents must be an array of exact roster strings", index, [`tasks[${index}].agents`]);
    }
    if (task.agents.length === 0) {
      planError("agents-empty", "agents must contain between one and four specialists", index, [`tasks[${index}].agents`]);
    }
    if (task.agents.length > 4) {
      planError("too-many-agents", "agents must contain no more than four specialists", index, [`tasks[${index}].agents`]);
    }
    const agents: string[] = [];
    for (let agentIndex = 0; agentIndex < task.agents.length; agentIndex += 1) {
      const rawAgent = task.agents[agentIndex];
      if (typeof rawAgent !== "string" || !text(rawAgent)) {
        planError("agent-not-string", "each agent must be a non-empty exact roster string", index, [`tasks[${index}].agents[${agentIndex}]`]);
      }
      const token = text(rawAgent);
      const agent = roster.byId.get(token) ?? (roster.names.has(token) ? token : undefined);
      if (!agent) {
        planError("unknown-agent", "each agent must match an exact roster ID or full roster name", index, [`tasks[${index}].agents[${agentIndex}]`]);
      }
      if (agents.includes(agent)) {
        planError("duplicate-agent", "agents must contain unique specialist strings", index, [`tasks[${index}].agents`]);
      }
      agents.push(agent);
    }
    if (!id || ids.has(id) || !title || !Number.isFinite(scope) || scope < 0) {
      planError("malformed-task-fields", "task id, title, and non-negative finite scope are required", index, [`tasks[${index}]`]);
    }
    ids.add(id);
    tasks.push({
      id, title, priority: screenMusicText(text(task.priority, "planned"), "planned"), scope, agents,
      status: "planned", summary: "", editedFiles: [], compact: compact || undefined,
    });
  }
  const ordered = tasks.sort((a, b) => b.scope - a.scope || a.title.localeCompare(b.title));
  if (!compact || ordered.length <= 1) return ordered;

  // The planner owns the semantic compactness decision. A short, bounded
  // request (for example, one four-bar piano idea) is one musical edit even
  // when the planner lists separate melodic, harmonic, or rhythmic facets.
  // Keep those facets in one task so they share one original-copy round,
  // one evaluation, and one bounded correction budget. The explicit agent
  // union also preserves specialist consultation without turning facets into
  // sequential edits against partially changed score state.
  const agents = [...new Set(ordered.flatMap((task) => task.agents))];
  if (agents.length > 4) {
    planError("too-many-agents", "agents must contain no more than four specialists", -1, ["tasks"]);
  }
  const title = screenMusicText(
    ordered.map((task) => task.title).join(" + "),
    "Compact score edit",
  );
  return [{
    ...ordered[0],
    title,
    scope: Math.max(...ordered.map((task) => task.scope)),
    agents,
    compact: true,
  }];
}

function compactPlan(value: Record<string, unknown>): boolean {
  return value.compact === true || value.granularity === "compact" || value.taskMode === "compact";
}

type PlannerResult = {
  tasks: WorkflowTask[];
  instrumentAdditions: TrackProposal[];
};

function parsePlannerResult(value: Record<string, unknown>, roster: PlannerRoster, score: ScoreValue, maxTasks = MAX_TASKS): PlannerResult {
  const instrumentAdditions = parseInstrumentNeeds(value.instrumentNeeds, score);
  // A first-pass plan may name a specialist that does not exist until the
  // requested roster expansion is applied. Ignore that provisional task list
  // and validate the bounded replacement plan after expansion.
  if (instrumentAdditions.length) return { tasks: [], instrumentAdditions };
  return {
    tasks: parseTasks(value.tasks, roster, compactPlan(value), maxTasks),
    instrumentAdditions,
  };
}

async function validateWithTwoFormatRepairs(args: {
  model: WorkflowModel;
  payload?: Record<string, unknown>;
  response?: string;
  responseMetadata?: ProviderCompletionMetadata;
  responseStage?: ModelCallStage;
  responseMaxTokens?: number;
  initialFailure?: ModelResponseError;
  agent: string;
  task: WorkflowTask;
  base: ScoreValue;
  context: string;
  direction: string;
  evaluatorFeedback?: EvaluationFeedback;
  /**
   * The complete user context that produced a response. Relay responses need
   * more than the generic score context during repair: recipient, question,
   * reply, requester operations, task, style, and evaluator direction must
   * remain identical on both bounded replacement attempts.
   */
  responseContext?: Record<string, unknown>;
  requireRevision?: boolean;
  emit: (event: WorkflowEvent) => void;
  onDiagnostic?: DiagnosticEmitter;
  /** Shared across track writers and refinement: one musical regeneration per run. */
  musicalRegeneration?: { trackId: string; budget: { used: boolean } };
}): Promise<{ payload: Record<string, unknown>; operations: Record<string, unknown>[] }> {
  let payload = args.payload;
  let response = args.response ?? JSON.stringify(args.payload);
  let responseMetadata = args.responseMetadata;
  const responseStage = args.responseStage ?? "initial";
  let responseMaxTokens = args.responseMaxTokens ?? SPECIALIST_INITIAL_COMPLETION_TOKENS;
  let pending: OperationValidationError | ModelResponseError | undefined = args.initialFailure;
  // The first response establishes the only musical baseline a structural
  // replacement may contain. Keep multiplicity: two identical edits remain
  // two edits and cannot be collapsed by a repair.
  let baselineFingerprints = validRepairSiblings(args.base, args.payload?.operations);
  let baselineEstablished = baselineFingerprints.length > 0;
  let hasIncompleteTruncatedOperations = false;
  const rememberTruncatedOperations = (raw: string): TruncatedOperationsScan => {
    const scan = scanTruncatedOperations(raw);
    hasIncompleteTruncatedOperations ||= scan.hasIncompleteValue;
    return scan;
  };
  const initialProviderLength = args.initialFailure?.diagnostic.code === "provider-token-limit";
  const failClosedTokenLimit = (failure: ModelResponseError, attempt: string): never => {
    if (args.initialFailure?.diagnostic.code === "provider-request-timeout") {
      args.emit({
        stage: "operation-timeout-exhausted",
        message: "Provider request-timeout recovery was superseded by an unverifiable token-limit response; no partial or regenerated musical content was accepted.",
        taskId: args.task.id,
        agent: args.agent,
        attempt,
        code: "provider-request-timeout",
        fields: ["response"],
        reason: args.initialFailure?.diagnostic.reason,
        outcome: "exhausted",
      });
    }
    args.emit({
      stage: "operation-truncation-exhausted",
      message: "Provider token-limit response contained no certifiable complete operation; no partial or regenerated musical content was accepted.",
      taskId: args.task.id,
      agent: args.agent,
      attempt,
      code: "provider-token-limit",
      fields: ["operations"],
      reason: failure.diagnostic.reason,
      outcome: "exhausted",
    });
    failure.message = diagnosticSummary(failure.diagnostic, {
      stage: attempt === "initial" ? responseStage : "repair",
      agent: args.agent,
      taskId: args.task.id,
      ...(attempt === "initial" ? {} : { attempt }),
    });
    throw failure;
  };
  if (initialProviderLength) {
    // The provider may have stopped before JSON.parse could recover an
    // envelope. Keep only complete, root-level operation siblings as
    // requirements for the replacement validator; never append them locally.
    const scan = rememberTruncatedOperations(response);
    baselineFingerprints = mergeSiblingFingerprints(
      baselineFingerprints,
      validRepairSiblings(args.base, scan.operations),
    );
    baselineEstablished = baselineFingerprints.length > 0;
  }
  // Unlike a deadline, a token-limited completion can contain an uncertain
  // musical suffix. If no independently closed operation can be certified,
  // never ask the model to regenerate the missing music from that response.
  // This is terminal and intentionally does not spend a recovery attempt.
  if (initialProviderLength && !baselineEstablished) {
    failClosedTokenLimit(args.initialFailure!, "initial");
  }
  const validateResponse = (candidate: Record<string, unknown>) => {
    const operations = validOperations(args.base, candidate.operations);
    // A complete, structurally valid operations array is a musical baseline
    // even when the envelope still lacks a relay-only field such as revision.
    // Capture it before checking envelope requirements so a later repair
    // cannot replace operation A with unrelated operation B.
    if (!baselineEstablished && operations.length) {
      baselineFingerprints = operations.map(operationContentFingerprint);
      baselineEstablished = true;
    }
    if (baselineEstablished) {
      // Every replacement, including revision-only relay repairs and
      // provider-limit replacements, must be the exact musical multiset.
      assertExactRepairOperationMultiset(baselineFingerprints, operations);
    }
    if (hasIncompleteTruncatedOperations) {
      throw new OperationValidationError({
        index: -1,
        code: "invalid-operations",
        reason: "provider token-limit response contained an incomplete operations tail that no replacement can certify",
        fields: ["operations"],
      });
    }
    if (args.requireRevision && !text(candidate.revision)) {
      throw new OperationValidationError({
        index: -1,
        code: "missing-field",
        reason: "required response field missing",
        fields: ["revision"],
      });
    }
    const candidateSummary = text(candidate.summary);
    if (!candidateSummary || candidateSummary.length > 1_200) {
      throw new OperationValidationError({
        index: -1,
        code: candidateSummary ? "invalid-field" : "missing-field",
        reason: candidateSummary ? "summary must be no longer than 1200 characters" : "required response field missing",
        fields: ["summary"],
      });
    }
    return operations;
  };

  for (let repairs = 0; repairs <= MAX_OPERATION_FORMAT_REPAIRS; repairs += 1) {
    let failure = pending;
    pending = undefined;
    if (!failure) {
      try {
        if (!payload) {
          throw new WorkflowFailure("The specialist response was unavailable for structural validation.");
        }
        return { payload, operations: validateResponse(payload) };
      } catch (error) {
        if (!(error instanceof OperationValidationError)) throw error;
        failure = error;
      }
    }

    const diagnostic = failure.diagnostic;
    const providerLengthFailure = failure instanceof ModelResponseError &&
      failure.diagnostic.code === "provider-token-limit";
    const providerTimeoutFailure = failure instanceof ModelResponseError &&
      failure.diagnostic.code === "provider-request-timeout";
    if (providerLengthFailure) {
      const scan = rememberTruncatedOperations(response);
      baselineFingerprints = mergeSiblingFingerprints(
        baselineFingerprints,
        validRepairSiblings(args.base, payload?.operations),
      );
      baselineFingerprints = mergeSiblingFingerprints(
        baselineFingerprints,
        validRepairSiblings(args.base, scan.operations),
      );
      baselineEstablished = baselineFingerprints.length > 0;
      // A token-limited recovery that has no independently closed operation
      // cannot be followed by another replacement that invents the musical
      // baseline. This also covers structural -> token-limit and
      // timeout -> token-limit transitions.
      if (!baselineEstablished) {
        failClosedTokenLimit(failure as ModelResponseError, repairs === 0 ? "initial" : `${repairs}/${MAX_OPERATION_FORMAT_REPAIRS}`);
      }
    }
    if (failure instanceof OperationValidationError) {
      args.onDiagnostic?.({
        ...workflowDiagnosticFields(diagnostic),
        code: String(diagnostic.code ?? "unknown"),
        reason: diagnostic.reason,
        responseChars: response.length,
        envelope: envelopeShape(payload),
        ...(responseMetadata ? { provider: responseMetadata } : {}),
        stage: repairs === 0 ? responseStage : "repair",
        agent: args.agent,
        taskId: args.task.id,
        maxTokens: responseMaxTokens,
        ...(repairs === 0 ? {} : { attempt: `${repairs}/${MAX_OPERATION_FORMAT_REPAIRS}` }),
      });
    }
    const failureLabel = repairs === 0 ? "Initial validation failed" : `Repair ${repairs}/${MAX_OPERATION_FORMAT_REPAIRS} failed`;
    args.emit({
      stage: "operation-format-error",
      message: `${failureLabel}${providerLengthFailure ? " (provider token-limit recovery required)" : providerTimeoutFailure ? " (provider request-timeout recovery required)" : ""}: ${diagnostic.reason} (${operationDiagnosticDetail(diagnostic)}).`,
      taskId: args.task.id,
      agent: args.agent,
      index: "index" in diagnostic ? diagnostic.index : -1,
      code: String(diagnostic.code ?? "unknown"),
      fields: "fields" in diagnostic ? diagnostic.fields : ["response"],
      targetId: "targetId" in diagnostic ? diagnostic.targetId : undefined,
      duplicateId: "duplicateId" in diagnostic ? diagnostic.duplicateId : undefined,
      reason: diagnostic.reason,
      observedType: "observedType" in diagnostic ? diagnostic.observedType : undefined,
      observedLength: "observedLength" in diagnostic ? diagnostic.observedLength : undefined,
      maxLength: "maxLength" in diagnostic ? diagnostic.maxLength : undefined,
      attempt: repairs === 0 ? "initial" : `${repairs}/${MAX_OPERATION_FORMAT_REPAIRS}`,
    });
    if (
      failure instanceof OperationValidationError &&
      diagnosticRequiresMusicalRegeneration(failure.diagnostic)
    ) {
      const regeneration = args.musicalRegeneration;
      const originals = payload?.operations;
      const regenerableDiagnostic = (diagnostic: WorkflowOperationDiagnostic) =>
        ["invalid-timing", "invalid-field"].includes(diagnostic.code ?? "") &&
        diagnostic.fields.length > 0 &&
        diagnostic.fields.every(field => /^region\.(?:startBeat|durationBeats|dynamics|articulation|notes(?:\[\d+\](?:\.(?:pitch|velocity|startBeat|durationBeats|articulation))?)?)$/.test(field));
      // Never repair capability violations, missing targets/whole regions, or
      // uncertain/truncated content by inventing a replacement.
      const eligible = regeneration && !regeneration.budget.used &&
        !hasIncompleteTruncatedOperations && !args.initialFailure &&
        payload && Object.keys(payload).every(key => key === "summary" || key === "operations") &&
        regenerableDiagnostic(failure.diagnostic) &&
        Array.isArray(originals) && originals.length > 0 &&
        originals.every(operation => {
          // Check every sibling, not only the first failing operation. An
          // unrelated structural defect must not authorize musical changes.
          if (fingerprintableRepairOperation(args.base, operation).length) return true;
          try {
            validOperations(args.base, [operation]);
            return true;
          } catch (error) {
            return error instanceof OperationValidationError && regenerableDiagnostic(error.diagnostic);
          }
        }) &&
        originals.every(operation => operation && typeof operation === "object" &&
          operation.trackId === regeneration.trackId &&
          (operation.type === "remove-region"
            ? args.base.tracks.find(track => track.id === regeneration.trackId)?.regions.some(region => region.id === operation.regionId)
            : operation.type === "add-region" && operation.region &&
              Array.isArray(operation.region.notes) && operation.region.notes.length > 0));
      if (eligible) {
        regeneration.budget.used = true;
        // Also consumes the existing shared recovery budget; it is not an
        // extra unbounded retry pool or an adviser refinement round.
        args.emit({
          stage: "operation-format-repair", agent: args.agent, taskId: args.task.id,
          attempt: "1/1", code: "musical-regeneration", outcome: "retrying",
          message: "IMPORTANT: bounded musical regeneration 1/1 started for invalid musical fields. Valid operations and track ownership must remain unchanged.",
        });
        try {
          const replacement = await completeJson(args.model, [
            {
              role: "system",
              content: `You are ${args.agent}. This is the single authorized bounded musical regeneration (1/1), NOT structural repair or a new composition/refinement round. IMPORTANT: regenerate only invalid musical operations to satisfy the original request and ALL constraints. Return complete JSON {"summary":"non-empty <=1200 chars","operations":[...]}. Keep the exact operation count and order, operation types, assigned trackId "${regeneration.trackId}", and existing removal targets. Preserve every already-valid operation's musical content exactly, including all notes and multiplicity. Do not omit, truncate, silently clip, or replace valid siblings. No membership changes or other-track edits. Verify every note and region against the checklist before responding. ${operationSchemaFor(args.base)}`,
            },
            { role: "user", content: JSON.stringify({
              originalContext: args.responseContext, direction: args.direction,
              completeScore: args.base, completeContext: args.context,
              rejectedResponse: payload, diagnostic: failure.diagnostic,
            }) },
          ], SPECIALIST_FIRST_REPAIR_COMPLETION_TOKENS, { stage: "repair", agent: args.agent, taskId: args.task.id, attempt: "1/1" }, args.onDiagnostic, true);
          if (Object.keys(replacement.payload).some(key => key !== "summary" && key !== "operations")) {
            throw new WorkflowFailure("Musical regeneration returned forbidden fields; no changes were applied.");
          }
          const operations = ownedOperations(args.base, regeneration.trackId, replacement.payload.operations);
          if (operations.length !== originals.length || operations.some((operation, index) => {
            const original = originals[index];
            const validSibling = fingerprintableRepairOperation(args.base, original)[0];
            return operation.type !== original.type || operation.trackId !== original.trackId ||
              (original.type === "remove-region" && operation.regionId !== original.regionId) ||
              (validSibling && operationContentFingerprint(operation) !== operationContentFingerprint(validSibling));
          })) throw new WorkflowFailure("Musical regeneration changed a valid sibling, operation count, or target; no changes were applied.");
          const remainingFingerprints = operations.map(operationContentFingerprint);
          for (const fingerprint of baselineFingerprints) {
            const index = remainingFingerprints.indexOf(fingerprint);
            if (index < 0) throw new WorkflowFailure("Musical regeneration changed a previously valid sibling; no changes were applied.");
            remainingFingerprints.splice(index, 1);
          }
          const summary = text(replacement.payload.summary);
          if (!summary || summary.length > 1_200) throw new WorkflowFailure("Musical regeneration returned an invalid summary; no changes were applied.");
          args.emit({ stage: "operation-format-recovered", agent: args.agent, taskId: args.task.id, attempt: "1/1", code: "musical-regeneration", outcome: "recovered", message: "Bounded musical regeneration passed operation validation; final MIDI/timing reconstruction remains required." });
          return { payload: replacement.payload, operations };
        } catch (error) {
          args.emit({ stage: "operation-format-exhausted", agent: args.agent, taskId: args.task.id, attempt: "1/1", code: "musical-regeneration", outcome: "exhausted", message: "The single musical regeneration failed; the score remains unchanged." });
          throw error;
        }
      }
      failure.message = `Invalid score operation at index ${failure.diagnostic.index}: ${failure.diagnostic.reason}. The cited musical field cannot be structurally repaired without regenerating musical content, so the response was not applied.`;
      throw failure;
    }
    if (providerLengthFailure) {
      args.emit({
        stage: "operation-truncation-error",
        message: `Provider token-limit recovery required: the response was not treated as complete; bounded complete-replacement recovery is ${repairs < MAX_OPERATION_FORMAT_REPAIRS ? "starting" : "exhausted"}.`,
        taskId: args.task.id,
        agent: args.agent,
        attempt: repairs === 0 ? "initial" : `${repairs}/${MAX_OPERATION_FORMAT_REPAIRS}`,
        code: "provider-token-limit",
        fields: ["response"],
        reason: diagnostic.reason,
        outcome: repairs < MAX_OPERATION_FORMAT_REPAIRS ? "retrying" : "exhausted",
      });
    }
    if (providerTimeoutFailure) {
      args.emit({
        stage: "operation-timeout-error",
        message: `Provider request-timeout recovery required: no partial musical response was available; bounded full-context replacement recovery is ${repairs < MAX_OPERATION_FORMAT_REPAIRS ? "starting" : "exhausted"}.`,
        taskId: args.task.id,
        agent: args.agent,
        attempt: repairs === 0 ? "initial" : `${repairs}/${MAX_OPERATION_FORMAT_REPAIRS}`,
        code: "provider-request-timeout",
        fields: ["response"],
        reason: diagnostic.reason,
        outcome: repairs < MAX_OPERATION_FORMAT_REPAIRS ? "retrying" : "exhausted",
      });
    }
    if (repairs === MAX_OPERATION_FORMAT_REPAIRS) {
      args.emit({
        stage: "operation-format-exhausted",
        message: `${providerLengthFailure ? "Provider token-limit complete-replacement recovery" : providerTimeoutFailure ? "Provider request-timeout complete-replacement recovery" : "Operation format repair"} exhausted after ${MAX_OPERATION_FORMAT_REPAIRS}/${MAX_OPERATION_FORMAT_REPAIRS}: ${diagnostic.reason} (${operationDiagnosticDetail(diagnostic)}); the response was not applied.`,
        taskId: args.task.id,
        agent: args.agent,
        attempt: `${MAX_OPERATION_FORMAT_REPAIRS}/${MAX_OPERATION_FORMAT_REPAIRS}`,
        index: "index" in diagnostic ? diagnostic.index : -1,
        code: String(diagnostic.code ?? "unknown"),
        fields: "fields" in diagnostic ? diagnostic.fields : ["response"],
        targetId: "targetId" in diagnostic ? diagnostic.targetId : undefined,
        duplicateId: "duplicateId" in diagnostic ? diagnostic.duplicateId : undefined,
        reason: diagnostic.reason,
        observedType: "observedType" in diagnostic ? diagnostic.observedType : undefined,
        observedLength: "observedLength" in diagnostic ? diagnostic.observedLength : undefined,
        maxLength: "maxLength" in diagnostic ? diagnostic.maxLength : undefined,
        outcome: "exhausted",
      });
      if (providerLengthFailure) {
        args.emit({
          stage: "operation-truncation-exhausted",
          message: "Provider token-limit complete-replacement recovery exhausted; no partial or regenerated musical content was accepted.",
          taskId: args.task.id,
          agent: args.agent,
          attempt: `${MAX_OPERATION_FORMAT_REPAIRS}/${MAX_OPERATION_FORMAT_REPAIRS}`,
          code: "provider-token-limit",
          fields: ["response"],
          reason: diagnostic.reason,
          outcome: "exhausted",
        });
      }
      if (providerTimeoutFailure) {
        args.emit({
          stage: "operation-timeout-exhausted",
          message: "Provider request-timeout complete-replacement recovery exhausted; no partial or regenerated musical content was accepted.",
          taskId: args.task.id,
          agent: args.agent,
          attempt: `${MAX_OPERATION_FORMAT_REPAIRS}/${MAX_OPERATION_FORMAT_REPAIRS}`,
          code: "provider-request-timeout",
          fields: ["response"],
          reason: diagnostic.reason,
          outcome: "exhausted",
        });
      }
      // A failed response is terminal. In particular, do not retain valid
      // siblings from an unverifiable structural batch or synthesize fallback
      // music. Provider-limited responses are terminal only after the same
      // complete-replacement budget is exhausted.
      if (failure instanceof ModelResponseError) {
        failure.message = diagnosticSummary(
          failure.diagnostic,
          {
            stage: repairs > 0 ? "repair" : responseStage,
            agent: args.agent,
            taskId: args.task.id,
            attempt: repairs > 0 ? `${repairs}/${MAX_OPERATION_FORMAT_REPAIRS}` : undefined,
          },
        );
      }
      throw failure;
    }

    const attempt = repairs + 1;
    const responseShape = args.requireRevision
      ? '{"revision":"revised plan","summary":"...","operations":[...],"questions":[...]}'
      : '{"summary":"...","operations":[...],"questions":[...]}';
    args.emit({
      stage: "operation-format-repair",
      message: `Operation format repair attempt ${attempt}/${MAX_OPERATION_FORMAT_REPAIRS}${providerLengthFailure ? " (provider token-limit complete-replacement recovery)" : ""} started after ${diagnostic.reason} (${operationDiagnosticDetail(diagnostic)}).`,
      taskId: args.task.id,
      agent: args.agent,
      attempt: `${attempt}/${MAX_OPERATION_FORMAT_REPAIRS}`,
      index: "index" in diagnostic ? diagnostic.index : -1,
      code: diagnostic.code,
      fields: "fields" in diagnostic ? diagnostic.fields : ["response"],
      targetId: "targetId" in diagnostic ? diagnostic.targetId : undefined,
      duplicateId: "duplicateId" in diagnostic ? diagnostic.duplicateId : undefined,
      reason: diagnostic.reason,
      observedType: "observedType" in diagnostic ? diagnostic.observedType : undefined,
      observedLength: "observedLength" in diagnostic ? diagnostic.observedLength : undefined,
      maxLength: "maxLength" in diagnostic ? diagnostic.maxLength : undefined,
    });
    let repairedResponse = "";
    let repaired: Record<string, unknown> | undefined;
    try {
      const incompleteTailWarning = hasIncompleteTruncatedOperations
        ? "The latest provider response visibly started an additional operations value or left the operations array unclosed. Its complete prefix is not a complete proposal: do not return a prefix-only replacement or guess the missing tail; this response must fail closed."
        : "";
      const recoveryPrompt = providerLengthFailure
        ? `This is bounded provider-token-limit recovery attempt ${attempt}/${MAX_OPERATION_FORMAT_REPAIRS}; the provider stopped before a complete response. This is not structural repair of a missing JSON suffix. Return a complete replacement response from the full task and MIDI context. ${baselineEstablished
          ? "An exact known baseline already exists as a musical operation multiset. Preserve that exact known baseline, including multiplicity; the baseline's operation notes, pitch, timing, duration, velocity, target, and musical region fields must be unchanged. Do not add, drop, or regenerate any baseline operation."
          : "No certifiable complete musical operation exists from any prior response. Do not establish or regenerate a musical baseline on this attempt; fail closed rather than inventing uncertain musical content."} Do not add an unverified operation, note, target, or fallback edit.`
        : providerTimeoutFailure
        ? `This is bounded provider-request-timeout recovery attempt ${attempt}/${MAX_OPERATION_FORMAT_REPAIRS}; no partial musical response was available because the provider request exceeded its deadline. Return a complete replacement response from the full task and MIDI context. The first complete replacement may establish the musical baseline. Once established, every subsequent replacement must preserve its exact musical operation multiset (including multiplicity): operation notes, pitch, timing, duration, velocity, target, and musical region fields must be unchanged. Do not add an unverified operation, note, target, or fallback edit, and do not invent content from a partial response.`
        : `This is bounded structural format repair attempt ${attempt}/${MAX_OPERATION_FORMAT_REPAIRS} for your existing response, not a new musical iteration. Return a complete replacement response, not a patch. Preserve the exact musical operation multiset (including multiplicity) of the existing response; repair only the cited structural or envelope field. Metadata operation IDs and add-region region IDs may be replaced, and envelope fields such as summary (required, non-empty, <=1200 characters), questions, or revision may change, but do not change notes, pitch, timing, duration, velocity, target, dynamics, articulation, or other musical region fields. Do not add an operation or note, and do not drop a valid sibling.`;
      const completion = await completeJson(args.model, [
        {
          role: "system",
          content: `You are ${args.agent}. ${recoveryPrompt} ${incompleteTailWarning} Every operation id and every add-region region.id is mandatory: for a duplicate or placeholder ID, replace only that metadata value with a fresh unique non-empty ID. Never omit a mandatory ID. A remove-region operation must retain the exact target regionId but may use a new unique operation ID when its metadata ID is duplicated; never change or substitute a remove target. If the existing response cannot be repaired without changing musical content, fail closed rather than inventing content. Return JSON only: ${responseShape}. Validator diagnostic (precise, no note data): ${JSON.stringify(diagnostic)}. ${operationSchemaFor(args.base, args.task.compact ? "compact" : "canonical")} ${args.evaluatorFeedback ? `The Orchestrator's evaluator feedback is authoritative: ${JSON.stringify(args.evaluatorFeedback)}. Preserve the direction, selected style, complete MIDI context, and every musical choice while repairing only structure.` : ""}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            // For relays this is the exact response-producing request
            // context. Only prior/latest response fields are changed by the
            // bounded loop; all musical and consultation context is stable.
            ...(args.responseContext ?? {
              task: args.task,
              direction: args.direction,
              evaluatorFeedback: args.evaluatorFeedback,
              completeScoreAndMidiContext: args.context,
            }),
            originalContext: args.context,
            priorResponse: payload,
            latestFailedResponse: response,
            truncatedOperationsTailIncomplete: hasIncompleteTruncatedOperations,
          }),
        },
      ], specialistRepairCompletionTokens(attempt), { stage: "repair", agent: args.agent, taskId: args.task.id, attempt: `${attempt}/${MAX_OPERATION_FORMAT_REPAIRS}` }, args.onDiagnostic, true, true);
      repairedResponse = completion.raw;
      repaired = completion.payload;
      responseMetadata = completion.metadata;
      responseMaxTokens = specialistRepairCompletionTokens(attempt);
      if (completion.providerFailure) {
        if (!baselineEstablished) {
          const repairedFingerprints = validRepairSiblings(args.base, repaired.operations);
          if (repairedFingerprints.length) {
            baselineFingerprints = repairedFingerprints;
            baselineEstablished = true;
          }
        }
        payload = repaired;
        response = repairedResponse;
        pending = completion.providerFailure;
        continue;
      }
    } catch (error) {
      if (!(error instanceof ModelResponseError)) throw error;
      // completeJson has already reported this failure to onDiagnostic; keep
      // the bounded repair loop alive without substituting an empty object.
      payload = undefined;
      response = error.rawResponse ?? "";
      responseMetadata = error.diagnostic.provider;
      pending = error;
      continue;
    }
    if (!repaired) throw new WorkflowFailure("The specialist repair response was unavailable.");
    try {
      const operations = validateResponse(repaired);
      args.emit({
        stage: "operation-format-recovered",
        message: `Operation format recovered on repair attempt ${attempt}/${MAX_OPERATION_FORMAT_REPAIRS}${providerLengthFailure ? " after provider token-limit complete-replacement recovery" : ""} (${operationDiagnosticDetail(diagnostic)}).`,
        taskId: args.task.id,
        agent: args.agent,
        attempt: `${attempt}/${MAX_OPERATION_FORMAT_REPAIRS}`,
        index: "index" in diagnostic ? diagnostic.index : -1,
        code: diagnostic.code,
        fields: "fields" in diagnostic ? diagnostic.fields : ["response"],
        targetId: "targetId" in diagnostic ? diagnostic.targetId : undefined,
        duplicateId: "duplicateId" in diagnostic ? diagnostic.duplicateId : undefined,
        reason: diagnostic.reason,
        observedType: "observedType" in diagnostic ? diagnostic.observedType : undefined,
        observedLength: "observedLength" in diagnostic ? diagnostic.observedLength : undefined,
        maxLength: "maxLength" in diagnostic ? diagnostic.maxLength : undefined,
        outcome: "recovered",
      });
      return { payload: repaired, operations };
    } catch (error) {
      if (!(error instanceof OperationValidationError)) throw error;
      const operationFormatFailure = !(args.requireRevision &&
        error.diagnostic.code === "missing-field" &&
        error.diagnostic.fields.length === 1 &&
        error.diagnostic.fields[0] === "revision");
      if (operationFormatFailure) {
        // If no independently verifiable operation existed in the original
        // response, the first complete repair establishes the baseline for
        // the next bounded attempt. Once established, it is immutable.
        if (!baselineEstablished) {
          const repairedFingerprints = validRepairSiblings(args.base, repaired.operations);
          if (repairedFingerprints.length) {
            baselineFingerprints = repairedFingerprints;
            baselineEstablished = true;
          }
        }
      }
      // The next loop emits the failed response's diagnostic exactly once,
      // before deciding whether a further bounded attempt is available.
      payload = repaired;
      response = repairedResponse;
      pending = error;
    }
  }
  throw new WorkflowFailure("Operation format repair loop ended unexpectedly.");
}
export async function relayAgentDialog(
  model: WorkflowModel, requester: string, recipient: string, question: string, baseContext: string,
  options?: {
    task?: WorkflowTask;
    requesterOperations?: unknown;
    roster?: Set<string>;
    base?: ScoreValue;
    direction?: string;
    selectedStyle?: string;
    evaluatorFeedback?: EvaluationFeedback;
     emit?: (event: WorkflowEvent) => void;
     onDiagnostic?: DiagnosticEmitter;
  },
): Promise<{
  reply: string;
  revision: string;
  payload?: Record<string, unknown>;
  recipientPayload: Record<string, unknown>;
  requesterResponse?: string;
  requesterFailure?: ModelResponseError;
  requesterMetadata?: ProviderCompletionMetadata;
  requesterContext: Record<string, unknown>;
}> {
  if (options?.roster && !options.roster.has(recipient)) throw new WorkflowFailure(`Unknown relay recipient "${recipient}".`);
  const recipientResult = await completeJson(model, [
    { role: "system", content: `You are ${recipient}. Return JSON only: {"reply":"concise answer","questions":[{"recipient":"real roster agent","question":"..."}]}. You may ask a follow-up only through Orchestrator. ${operationSchemaFor(options?.base, options?.task?.compact ? "compact" : "canonical")} ${options?.evaluatorFeedback ? `The Orchestrator's evaluator feedback is authoritative; advise a correction that addresses it without changing the direction, selected style, or complete MIDI context: ${JSON.stringify(options.evaluatorFeedback)}.` : ""}` },
    { role: "user", content: JSON.stringify({ task: options?.task, requester, requesterOperations: options?.requesterOperations, question, direction: options?.direction, selectedStyle: options?.selectedStyle, evaluatorFeedback: options?.evaluatorFeedback, completeScoreAndMidiContext: baseContext }) },
        ], 700, { stage: "relay", agent: recipient, taskId: options?.task?.id }, options?.onDiagnostic);
  const recipientPayload = recipientResult.payload;
  const reply = text(recipientPayload.reply);
  if (!reply) throw new WorkflowFailure(`The routed reply from ${recipient} was empty.`);
  let requesterResponse: string | undefined;
  let payload: Record<string, unknown> | undefined;
  let requesterMetadata: ProviderCompletionMetadata | undefined;
  let requesterFailure: ModelResponseError | undefined;
  const requesterContext = {
    task: options?.task,
    direction: options?.direction,
    selectedStyle: options?.selectedStyle,
    evaluatorFeedback: options?.evaluatorFeedback,
    completeScoreAndMidiContext: baseContext,
    // Keep the historical field name for existing requester prompts while
    // also exposing the canonical relay field used by bounded repairs.
    ownOriginalOperations: options?.requesterOperations,
    requesterOperations: options?.requesterOperations,
    recipient,
    reply,
    question,
  };
  try {
    const requesterResult = await completeJson(model, [
      { role: "system", content: `You are ${requester}, the original requester. Incorporate the recipient reply. Return JSON only: {"revision":"revised plan","summary":"...","operations":[...],"questions":[{"recipient":"real roster agent","question":"..."}]}. Return a replacement operations array when you previously proposed one. ${operationSchemaFor(options?.base, options?.task?.compact ? "compact" : "canonical")} ${options?.evaluatorFeedback ? `The Orchestrator's evaluator feedback is authoritative; address it while preserving the direction, selected style, complete MIDI context, and valid musical content: ${JSON.stringify(options.evaluatorFeedback)}.` : ""}` },
      { role: "user", content: JSON.stringify(requesterContext) },
    ], SPECIALIST_INITIAL_COMPLETION_TOKENS, { stage: "relay", agent: requester, taskId: options?.task?.id }, options?.onDiagnostic, false, true);
    requesterResponse = requesterResult.raw;
    payload = requesterResult.payload;
    requesterMetadata = requesterResult.metadata;
    requesterFailure = requesterResult.providerFailure;
  } catch (error) {
    if (!(error instanceof ModelResponseError)) throw error;
    requesterFailure = error;
    requesterResponse = error.rawResponse;
    requesterMetadata = error.diagnostic.provider;
  }
  const revision = text(payload?.revision);
  // With a score base, the requester is an operation-producing response and
  // its structural fields are validated by the caller's bounded repair loop.
  // Keep the old eager revision check for standalone dialog consumers.
  if (!revision && !options?.base && !requesterFailure) throw new WorkflowFailure(`The original requester ${requester} did not return a revision.`);
  return { reply, revision, payload, recipientPayload, requesterResponse, requesterFailure, requesterMetadata, requesterContext };
}

const MAX_ADVISER_CONSULTATIONS = 16;
/** At most five distinct track owners may be selected initially. */
const MAX_INITIAL_TRACK_WRITERS = 5;
/** Kept in the approval-context contract for compatibility with signed
 * checkpoints created before post-write musical review was removed. */
const MAX_TRACK_WRITER_ROUNDS = 2;
const MAX_INSTRUMENT_REFINEMENT_ROUNDS = 1;

type TrackInstruction = { trackId: string; instruction: string };
type AdviserReview = {
  feedback: string;
  needsRefinement: boolean;
  affectedTrackIds: string[];
  /** Expected constraints are claims from the review, not measured evidence. */
  expectedConstraints: string[];
  suggestions: AdviserSuggestion[];
};

export type AdviserPhase = "initial" | "review";

/**
 * Adviser responses are a different contract from writer responses.  In
 * particular, an empty `operations` array is not a harmless no-op here: an
 * adviser has no operation capability at all.  Keep these diagnostics
 * content-free so a malformed adviser response cannot put user prose, note
 * data, or a private track identifier in an event or repair request.
 */
export type AdviserValidationDiagnostic = {
  code: "forbidden-field" | "missing-field" | "invalid-field" | "invalid-affected-track" | "advice-changed" | "decision-changed";
  reason: string;
  fields: string[];
  observedType?: ScoreOperationObservedType;
  observedLength?: number;
  maxLength?: number;
};

export class AdviserValidationError extends WorkflowFailure {
  readonly diagnostic: AdviserValidationDiagnostic;
  constructor(diagnostic: AdviserValidationDiagnostic) {
    super(`Read-only adviser response invalid: ${diagnostic.reason}.`);
    this.name = "AdviserValidationError";
    this.diagnostic = diagnostic;
  }
}

const MAX_ADVISER_FORMAT_REPAIRS = 2;
/** Hard service validator ceiling; providers are given a lower safety margin. */
export const ADVISER_FEEDBACK_MAX_LENGTH = 4_000;
export const ADVISER_FEEDBACK_TARGET_LENGTH = 2_250;
export const ADVISER_COMPLETION_TOKENS = 3_500;
export const ADVISER_REPAIR_COMPLETION_TOKENS = 4_500;
export const REJECTED_ADVISER_TEXT_LOG_MAX_LENGTH = 5_000;
const ADVISER_SAFETY_SCREEN_EMPTY_REASON = "adviser feedback was empty after safety screening";

export type RejectedAdviserTextDiagnostic = {
  /** Raw adviser insight/feedback, bounded before it leaves the workflow. */
  text: string;
  originalLength: number;
  truncated: boolean;
  agent: string;
  phase: AdviserPhase;
  field: "insight" | "feedback";
  /** "initial" for the first response, or the bounded repair attempt. */
  attempt: string;
  workflowId?: string;
  requestId?: string;
};

function adviserObservedType(value: unknown): ScoreOperationObservedType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function adviserValidation(
  code: AdviserValidationDiagnostic["code"],
  reason: string,
  fields: string[],
  value?: unknown,
  maxLength?: number,
): AdviserValidationError {
  return new AdviserValidationError({
    code,
    reason,
    fields,
    ...(value !== undefined ? { observedType: adviserObservedType(value) } : {}),
    ...(typeof value === "string" ? { observedLength: Math.min(value.length, (maxLength ?? ADVISER_FEEDBACK_MAX_LENGTH) + 1) } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
  });
}

function adviserText(value: unknown, field: "insight" | "feedback"): string {
  if (typeof value !== "string") {
    throw adviserValidation("invalid-field", "adviser feedback must be a string", [field], value);
  }
  const raw = text(value);
  if (!raw) throw adviserValidation("missing-field", "required adviser feedback field missing", [field]);
  const screened = screenMusicText(raw, "");
  if (!screened) throw adviserValidation("invalid-field", ADVISER_SAFETY_SCREEN_EMPTY_REASON, [field]);
  if (screened.length > ADVISER_FEEDBACK_MAX_LENGTH) {
    throw adviserValidation(
      "invalid-field",
      `adviser feedback must be no longer than ${ADVISER_FEEDBACK_MAX_LENGTH} characters`,
      [field],
      screened,
      ADVISER_FEEDBACK_MAX_LENGTH,
    );
  }
  return screened;
}

const ADVISER_CAPABILITY_FIELDS = [
  "operations",
  "membershipProposals",
  "instrumentNeeds",
  "instrumentProposals",
  "trackMembership",
  "trackAdditions",
  "trackDeletions",
  "trackProposals",
  "trackChanges",
  "edits",
  "changes",
  "privateTrackFiles",
];

function hasNonEmptyAdviserPayload(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function nonEmptyAdviserForbiddenField(value: Record<string, unknown>, phase: AdviserPhase): string | undefined {
  const allowedFields = phase === "initial"
    ? new Set(["insight", "suggestions"])
    : new Set(["feedback", "needsRefinement", "affectedTrackIds", "expectedConstraints", "suggestions"]);
  return Object.keys(value).find((field) => !allowedFields.has(field) && hasNonEmptyAdviserPayload(value[field]));
}

type AdviserReviewDecision = Pick<AdviserReview, "needsRefinement" | "affectedTrackIds" | "expectedConstraints">;

function validAdviserReviewDecision(
  value: Record<string, unknown>,
  score: ScoreValue,
): AdviserReviewDecision | undefined {
  if (typeof value.needsRefinement !== "boolean" || !Array.isArray(value.affectedTrackIds)) return undefined;
  if (value.affectedTrackIds.length > MAX_INITIAL_TRACK_WRITERS) return undefined;
  const affectedTrackIds = value.affectedTrackIds.map((candidate) => text(candidate));
  if (
    affectedTrackIds.some((trackId) => !trackId) ||
    new Set(affectedTrackIds).size !== affectedTrackIds.length ||
    affectedTrackIds.some((trackId) => !score.tracks.some((track) => track.id === trackId)) ||
    (value.needsRefinement && affectedTrackIds.length === 0) ||
    (!value.needsRefinement && affectedTrackIds.length > 0)
  ) {
    return undefined;
  }
  const feedback = typeof value.feedback === "string"
    ? screenMusicText(text(value.feedback), "")
    : "";
  return {
    needsRefinement: value.needsRefinement,
    affectedTrackIds,
    expectedConstraints: normalizeConstraintList(value.expectedConstraints, feedback || "A requested musical constraint."),
  };
}

function validateAdviserPayload(
  value: Record<string, unknown>,
  phase: AdviserPhase,
  score: ScoreValue,
): AdviserReview {
  const allowedFields = phase === "initial"
    ? new Set(["insight", "suggestions"])
    : new Set(["feedback", "needsRefinement", "affectedTrackIds", "expectedConstraints", "suggestions"]);
  const forbiddenFields = Object.keys(value).filter((field) => !allowedFields.has(field));
  if (forbiddenFields.length) {
    // Never echo arbitrary model-controlled keys. Known capability-bearing
    // fields get a precise safe path; all other unknown fields collapse to the
    // response envelope.
    const fields = forbiddenFields.map((field) => (
      ADVISER_CAPABILITY_FIELDS.includes(field)
        ? field
        : "response"
    ));
    throw adviserValidation(
      "forbidden-field",
      "read-only advisers may return feedback only; operations and membership changes must be routed through Orchestrator",
      [...new Set(fields)],
    );
  }

  const feedback = adviserText(
    value[phase === "initial" ? "insight" : "feedback"],
    phase === "initial" ? "insight" : "feedback",
  );
  let suggestions: AdviserSuggestion[];
  try {
    suggestions = normalizeAdviserSuggestions(value.suggestions, score, {
      omitInvalidOptionalMidiClip: true,
    });
  } catch (error) {
    if (!(error instanceof AdviserSuggestionValidationError)) throw error;
    // Structured suggestions are optional, read-only guidance. Preserve any
    // independently valid siblings, but never remap an invalid target or let
    // malformed optional guidance block valid adviser prose.
    const validRawSuggestions = Array.isArray(value.suggestions)
      ? value.suggestions.filter((candidate) => {
        try {
          normalizeAdviserSuggestions([candidate], score, {
            omitInvalidOptionalMidiClip: true,
          });
          return true;
        } catch (candidateError) {
          if (candidateError instanceof AdviserSuggestionValidationError) return false;
          throw candidateError;
        }
      })
      : [];
    try {
      suggestions = normalizeAdviserSuggestions(validRawSuggestions, score, {
        omitInvalidOptionalMidiClip: true,
      });
    } catch (combinedError) {
      if (!(combinedError instanceof AdviserSuggestionValidationError)) throw combinedError;
      suggestions = [];
    }
  }
  if (phase === "initial") {
    return {
      feedback, needsRefinement: false, affectedTrackIds: [], expectedConstraints: [],
      suggestions,
    };
  }

  if (typeof value.needsRefinement !== "boolean") {
    throw adviserValidation("invalid-field", "A candidate review must explicitly state whether refinement is needed", ["needsRefinement"], value.needsRefinement);
  }
  if (!Array.isArray(value.affectedTrackIds)) {
    throw adviserValidation("invalid-field", "candidate review affectedTrackIds must be an array", ["affectedTrackIds"], value.affectedTrackIds);
  }
  if (value.affectedTrackIds.length > MAX_INITIAL_TRACK_WRITERS) {
    throw adviserValidation(
      "invalid-field",
      `candidate review affectedTrackIds must contain no more than ${MAX_INITIAL_TRACK_WRITERS} tracks`,
      ["affectedTrackIds"],
      value.affectedTrackIds,
      MAX_INITIAL_TRACK_WRITERS,
    );
  }
  const affectedTrackIds: string[] = [];
  for (const candidate of value.affectedTrackIds) {
    if (typeof candidate !== "string" || !text(candidate)) {
      throw adviserValidation("invalid-affected-track", "an adviser identified an invalid affected track", ["affectedTrackIds"], candidate);
    }
    const trackId = text(candidate);
    if (affectedTrackIds.includes(trackId) || !score.tracks.some((track) => track.id === trackId)) {
      throw adviserValidation("invalid-affected-track", "an adviser identified an invalid affected track", ["affectedTrackIds"]);
    }
    affectedTrackIds.push(trackId);
  }
  if (value.needsRefinement && !affectedTrackIds.length) {
    throw adviserValidation("invalid-affected-track", "an adviser requested refinement without identifying an original writer track", ["affectedTrackIds"]);
  }
  return {
    feedback,
    needsRefinement: value.needsRefinement,
    // The explicit boolean controls whether another writer round is allowed.
    // Extra valid track IDs on a no-refinement response carry no capability
    // and are deterministically ignored rather than changing that decision.
    affectedTrackIds: value.needsRefinement ? affectedTrackIds : [],
    expectedConstraints: normalizeConstraintList(value.expectedConstraints, feedback),
    suggestions,
  };
}

function adviserDiagnosticDetail(diagnostic: AdviserValidationDiagnostic | ModelResponseDiagnostic): string {
  if ("fields" in diagnostic && diagnostic.fields) {
    return `code ${diagnostic.code}, fields ${diagnostic.fields.join(", ") || "response"}${
      diagnostic.observedType ? `, observed type ${diagnostic.observedType}` : ""
    }${diagnostic.observedLength !== undefined ? `, observed length ${diagnostic.observedLength}` : ""}${
      diagnostic.maxLength !== undefined ? `, maximum length ${diagnostic.maxLength}` : ""
    }`;
  }
  return `response code ${diagnostic.code}, fields response`;
}

/**
 * Adviser format recovery never repairs or accepts musical operations.  It
 * only asks for a complete replacement of the adviser envelope, preserves an
 * already-readable advice string byte-for-byte after safety screening, and
 * stops after two structural attempts.
 */
async function validateAdviserWithTwoStructuralRepairs(args: {
  model: WorkflowModel;
  adviser: AdviserSelection;
  phase: AdviserPhase;
  score: ScoreValue;
  direction: string;
  selectedStyle?: string;
  originalMessage: string;
  originalHistory: unknown[];
  originalMidi: unknown[];
  question: string;
  payload?: Record<string, unknown>;
  response?: string;
  responseMetadata?: ProviderCompletionMetadata;
  initialFailure?: ModelResponseError;
  emit: (event: WorkflowEvent) => void;
  onDiagnostic?: DiagnosticEmitter;
  onRejectedAdviserText?: (diagnostic: RejectedAdviserTextDiagnostic) => void;
  workflowId?: string;
  requestId?: string;
}): Promise<AdviserReview> {
  let payload = args.payload;
  let response = args.response ?? (payload ? JSON.stringify(payload) : "");
  let responseMetadata = args.responseMetadata;
  let pending: AdviserValidationError | ModelResponseError | undefined = args.initialFailure;
  const adviceField = args.phase === "initial" ? "insight" : "feedback";
  let preservedAdvice: string | undefined;
  // Readable advice is byte-preserved for ordinary structural defects. An
  // overlength string is the one deliberate exception: asking the model to
  // preserve it exactly would make the hard ceiling impossible to satisfy.
  const initialAdviceText = payload && typeof payload[adviceField] === "string"
    ? screenMusicText(text(payload[adviceField]), "")
    : "";
  const adviceNeedsCompression = initialAdviceText.length > ADVISER_FEEDBACK_MAX_LENGTH;
  const preservedDecision = args.phase === "review" && payload
    ? validAdviserReviewDecision(payload, args.score)
    : undefined;
  if (initialAdviceText && !adviceNeedsCompression) {
    preservedAdvice = initialAdviceText;
  }

  const validate = (candidate: Record<string, unknown>): AdviserReview => {
    const result = validateAdviserPayload(candidate, args.phase, args.score);
    if (!adviceNeedsCompression && preservedAdvice !== undefined && result.feedback !== preservedAdvice) {
      throw adviserValidation("advice-changed", "structural repair changed the original adviser feedback", [adviceField]);
    }
    if (
      preservedDecision &&
      (
        result.needsRefinement !== preservedDecision.needsRefinement ||
        result.affectedTrackIds.length !== preservedDecision.affectedTrackIds.length ||
        result.affectedTrackIds.some((trackId, index) => trackId !== preservedDecision.affectedTrackIds[index]) ||
        result.expectedConstraints.length !== preservedDecision.expectedConstraints.length ||
        result.expectedConstraints.some((constraint, index) => constraint !== preservedDecision.expectedConstraints[index])
      )
    ) {
      throw adviserValidation(
        "decision-changed",
        "structural repair changed the original adviser refinement decision or affected tracks",
        ["needsRefinement", "affectedTrackIds", "expectedConstraints"],
      );
    }
    if (preservedAdvice === undefined) preservedAdvice = result.feedback;
    return result;
  };

  const reportValidation = (failure: AdviserValidationError, attempt: string): void => {
    // Keep the ordinary content-free invalid-field diagnostic unchanged; this
    // exact reason identifies the temporary safety false-positive probe.
    if (failure.diagnostic.code === "invalid-field" && failure.diagnostic.reason === ADVISER_SAFETY_SCREEN_EMPTY_REASON) {
      const rejectedText = payload?.[adviceField];
      if (typeof rejectedText === "string") {
        const originalLength = rejectedText.length;
        args.onRejectedAdviserText?.({
          text: rejectedText.slice(0, REJECTED_ADVISER_TEXT_LOG_MAX_LENGTH),
          originalLength,
          truncated: originalLength > REJECTED_ADVISER_TEXT_LOG_MAX_LENGTH,
          agent: args.adviser.agent,
          phase: args.phase,
          field: adviceField,
          attempt,
          ...(args.workflowId ? { workflowId: args.workflowId } : {}),
          ...(args.requestId ? { requestId: args.requestId } : {}),
        });
      }
    }
    args.onDiagnostic?.({
      code: failure.diagnostic.code,
      reason: failure.diagnostic.reason,
      responseChars: Math.max(0, Math.min(response.length, 10_000_000)),
      envelope: envelopeShape(payload),
      stage: attempt === "initial" ? "initial" : "repair",
      agent: args.adviser.agent,
      attempt: attempt === "initial" ? undefined : attempt,
      fields: failure.diagnostic.fields,
      ...(failure.diagnostic.observedType ? { observedType: failure.diagnostic.observedType } : {}),
      ...(failure.diagnostic.observedLength !== undefined ? { observedLength: failure.diagnostic.observedLength } : {}),
      ...(failure.diagnostic.maxLength !== undefined ? { maxLength: failure.diagnostic.maxLength } : {}),
      ...(responseMetadata ? { provider: responseMetadata } : {}),
    });
  };

  const rejectNonEmptyForbidden = (candidate: Record<string, unknown>, attempt: string): void => {
    const field = nonEmptyAdviserForbiddenField(candidate, args.phase);
    if (!field) return;
    const terminalFailure = adviserValidation(
      "forbidden-field",
      "read-only adviser returned a non-empty forbidden field; no further repair is permitted",
      [ADVISER_CAPABILITY_FIELDS.includes(field) ? field : "response"],
    );
    reportValidation(terminalFailure, attempt);
    args.emit({
      stage: "adviser-format-exhausted",
      message: attempt === "initial"
        ? "Read-only adviser returned a non-empty forbidden field; no repair was attempted and no feedback was accepted."
        : "Read-only adviser repair returned a non-empty forbidden field; no further repair was attempted and no feedback was accepted.",
      agent: args.adviser.agent,
      attempt,
      code: terminalFailure.diagnostic.code,
      fields: terminalFailure.diagnostic.fields,
      reason: terminalFailure.diagnostic.reason,
      outcome: "exhausted",
    });
    throw terminalFailure;
  };

  for (let repairs = 0; repairs <= MAX_ADVISER_FORMAT_REPAIRS; repairs += 1) {
    let failure = pending;
    pending = undefined;
    if (repairs === 0 && payload) rejectNonEmptyForbidden(payload, "initial");
    if (!failure) {
      try {
        if (!payload) throw new WorkflowFailure("The read-only adviser response was unavailable for structural validation.");
        return validate(payload);
      } catch (error) {
        if (!(error instanceof AdviserValidationError)) throw error;
        failure = error;
      }
    }
    // Structured adviser material is an optional extension, but once supplied
    // it is never silently dropped by a prose-only repair. A malformed clip,
    // target, or catalog id therefore fails closed explicitly.
    if (failure instanceof AdviserValidationError && failure.diagnostic.fields.includes("suggestions")) {
      args.emit({
        stage: "adviser-format-exhausted",
        message: "Read-only adviser structured suggestions were malformed; no suggestion or score change was accepted.",
        agent: args.adviser.agent,
        attempt: repairs === 0 ? "initial" : `${repairs}/${MAX_ADVISER_FORMAT_REPAIRS}`,
        code: failure.diagnostic.code,
        fields: failure.diagnostic.fields,
        reason: failure.diagnostic.reason,
        outcome: "exhausted",
      });
      throw failure;
    }

    const attempt = repairs === 0 ? "initial" : `${repairs}/${MAX_ADVISER_FORMAT_REPAIRS}`;
    if (failure instanceof AdviserValidationError) reportValidation(failure, attempt);
    const detail = failure instanceof AdviserValidationError
      ? adviserDiagnosticDetail(failure.diagnostic)
      : adviserDiagnosticDetail(failure.diagnostic);
    args.emit({
      stage: "adviser-format-error",
      message: `${repairs === 0 ? "Initial adviser validation failed" : `Adviser repair ${repairs}/${MAX_ADVISER_FORMAT_REPAIRS} failed`}: ${failure.diagnostic.reason} (${detail}).`,
      agent: args.adviser.agent,
      attempt,
      code: failure.diagnostic.code,
      fields: failure instanceof AdviserValidationError ? failure.diagnostic.fields : ["response"],
      reason: failure.diagnostic.reason,
    });
    if (repairs === MAX_ADVISER_FORMAT_REPAIRS) {
      args.emit({
        stage: "adviser-format-exhausted",
        message: `Read-only adviser structural repair exhausted after ${MAX_ADVISER_FORMAT_REPAIRS}/${MAX_ADVISER_FORMAT_REPAIRS}; no adviser feedback was accepted.`,
        agent: args.adviser.agent,
        attempt,
        code: failure.diagnostic.code,
        fields: failure instanceof AdviserValidationError ? failure.diagnostic.fields : ["response"],
        reason: failure.diagnostic.reason,
        outcome: "exhausted",
      });
      if (failure instanceof ModelResponseError) {
        failure.message = diagnosticSummary(failure.diagnostic, {
          stage: repairs > 0 ? "repair" : "initial",
          agent: args.adviser.agent,
          attempt: repairs > 0 ? attempt : undefined,
        });
      }
      throw failure;
    }

    const nextAttempt = repairs + 1;
    const safetyRewrite = failure.diagnostic.reason === ADVISER_SAFETY_SCREEN_EMPTY_REASON;
    const proseRepairInstruction = safetyRewrite
      ? `The existing ${adviceField} failed safety screening. Rewrite the rejected text as unquoted neutral musical instructions; do not repeat it verbatim. Remove named references, title-like quotations, and imitation language while preserving actionable musical constraints and supported-instrument mappings. This safety rewrite is permitted in addition to envelope repair; do not change valid review decisions or track targets.`
      : "Preserve the exact existing actionable advice whenever it is readable. Repair only the response envelope.";
    const responseShape = args.phase === "initial"
      ? `{"insight":"non-empty actionable advice <=${ADVISER_FEEDBACK_TARGET_LENGTH} chars","suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instrument instruction"],"targetTrackIds":["exact existing track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":120,"durationBeats":4,"notes":[{"pitch":60,"velocity":80,"startBeat":0,"durationBeats":1}]}}]}`
      : `{"feedback":"non-empty actionable feedback <=${ADVISER_FEEDBACK_TARGET_LENGTH} chars","needsRefinement":boolean,"affectedTrackIds":["existing track id"],"expectedConstraints":["specific requested constraint <=1200 chars"],"suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instrument instruction"],"targetTrackIds":["exact existing track id"],"instrumentId":"supported catalog id"}]}`;
    args.emit({
      stage: "adviser-format-repair",
      message: `Read-only adviser structural repair attempt ${nextAttempt}/${MAX_ADVISER_FORMAT_REPAIRS} started after ${failure.diagnostic.reason} (${detail}).`,
      agent: args.adviser.agent,
      attempt: `${nextAttempt}/${MAX_ADVISER_FORMAT_REPAIRS}`,
      code: failure.diagnostic.code,
      fields: failure instanceof AdviserValidationError ? failure.diagnostic.fields : ["response"],
      reason: failure.diagnostic.reason,
      outcome: "retrying",
    });
    try {
      const completion = await completeJson(args.model, [
        {
          role: "system",
          content: `You are ${args.adviser.agent}, ${args.phase === "initial" ? "a read-all/edit-none" : "the same bounded read-only"} ${args.adviser.group} adviser. This is bounded structural repair attempt ${nextAttempt}/${MAX_ADVISER_FORMAT_REPAIRS}, not a new musical iteration. Return JSON only: ${responseShape} ${adviceNeedsCompression ? `The existing ${adviceField} exceeds the hard ceiling of ${ADVISER_FEEDBACK_MAX_LENGTH} characters. Compress it to the safety target of ${ADVISER_FEEDBACK_TARGET_LENGTH} characters or fewer while retaining every independently identifiable actionable constraint and every supported-instrument mapping, including any creative timbre mapping and its achievable technique, articulation, register, dynamics, and texture. Never mechanically slice, truncate, or omit a constraint; rewrite for concision and keep the result actionable.` : proseRepairInstruction} Remove every unsupported field, including operations even when it is an empty array, membershipProposals, trackProposals, edits, and track changes. Advisers have no write or membership capability; legitimate recommendations are prose for Orchestrator. Do not return empty feedback, invent a no-op, or claim a score edit. ${playableInstrumentCatalogPrompt()} ${args.phase === "review" ? "The original valid needsRefinement decision, affectedTrackIds, and expectedConstraints are immutable: return the exact same boolean, track-ID list, and constraint list; the server rejects any attempt to suppress or add refinement." : ""}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            adviser: args.adviser,
            phase: args.phase,
            question: args.question,
            direction: args.direction,
            selectedStyle: args.selectedStyle,
            originalUserMessage: args.originalMessage,
            safetyNormalizedHistory: args.originalHistory,
            completeSourceMidi: args.originalMidi,
            completeScore: args.score,
            priorResponse: payload,
            latestFailedResponse: response,
          }),
        },
      ], ADVISER_REPAIR_COMPLETION_TOKENS, { stage: "repair", agent: args.adviser.agent, attempt: `${nextAttempt}/${MAX_ADVISER_FORMAT_REPAIRS}` }, args.onDiagnostic);
      payload = completion.payload;
      response = completion.raw;
      responseMetadata = completion.metadata;
      rejectNonEmptyForbidden(payload, `${nextAttempt}/${MAX_ADVISER_FORMAT_REPAIRS}`);
      const result = validate(payload);
      args.emit({
        stage: "adviser-format-recovered",
        message: `Read-only adviser response recovered on structural repair attempt ${nextAttempt}/${MAX_ADVISER_FORMAT_REPAIRS}.`,
        agent: args.adviser.agent,
        attempt: `${nextAttempt}/${MAX_ADVISER_FORMAT_REPAIRS}`,
        code: "recovered",
        fields: [adviceField],
        reason: "adviser response envelope is valid",
        outcome: "recovered",
      });
      return result;
    } catch (error) {
      if (error instanceof AdviserValidationError) {
        pending = error;
        continue;
      }
      if (error instanceof ModelResponseError) {
        payload = undefined;
        response = error.rawResponse ?? "";
        responseMetadata = error.diagnostic.provider;
        pending = error;
        continue;
      }
      throw error;
    }
  }
  throw new WorkflowFailure("Read-only adviser structural repair loop ended unexpectedly.");
}

function approvalBudget(value: unknown): CompositionApprovalBudget {
  const budget = value as Partial<CompositionApprovalBudget> | undefined;
  const fields: Array<[keyof CompositionApprovalBudget, number]> = [
    ["adviserConsultationsUsed", MAX_ADVISER_CONSULTATIONS],
    // The generated approval contract permits five for compatibility, while
    // this transaction consumes one initial writer round. Legacy checkpoints
    // may still carry the former two-round budget.
    ["trackWriterRoundsUsed", MAX_TRACK_WRITER_ROUNDS],
    ["refinementRoundsUsed", MAX_INSTRUMENT_REFINEMENT_ROUNDS],
    ["operationRepairAttemptsUsed", MAX_OPERATION_FORMAT_REPAIRS],
  ];
  const output = {} as CompositionApprovalBudget;
  for (const [field, maximum] of fields) {
    const number = budget?.[field];
    if (!Number.isInteger(number) || number! < 0 || number! > maximum) {
      throw new WorkflowFailure(`Approval context has an invalid ${field} budget.`);
    }
    output[field] = number!;
  }
  return output;
}

function resumedApprovalContext(value: unknown): CompositionApprovalContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowFailure("Approval context was malformed.");
  }
  const context = value as Record<string, unknown>;
  if (!text(context.originalMessage) || !Array.isArray(context.originalHistory) ||
    !Array.isArray(context.originalMidi) || !Array.isArray(context.adviserRoster) ||
    !Array.isArray(context.adviserConsultations) || context.adviserRoster.length > MAX_ADVISER_CONSULTATIONS ||
    context.adviserConsultations.length > MAX_ADVISER_CONSULTATIONS) {
    throw new WorkflowFailure("Approval context was malformed.");
  }
  const adviserRoster: AdviserSelection[] = context.adviserRoster.map((value) => {
    if (!value || typeof value !== "object") throw new WorkflowFailure("Approval context adviser roster was malformed.");
    const adviser = value as Record<string, unknown>;
    const group = adviser.group;
    if ((group !== "style" && group !== "concept") || !text(adviser.agent) || !text(adviser.question)) {
      throw new WorkflowFailure("Approval context adviser roster was malformed.");
    }
    return { agent: text(adviser.agent), group: group as "style" | "concept", question: text(adviser.question) };
  });
  const adviserConsultations: WorkflowResult["consultations"] = context.adviserConsultations.map((value) => {
    if (!value || typeof value !== "object") throw new WorkflowFailure("Approval context consultations were malformed.");
    const consultation = value as Record<string, unknown>;
    const group = consultation.group;
    if ((group !== "style" && group !== "concept") || !text(consultation.agent) ||
      !text(consultation.question) || !text(consultation.insight)) {
      throw new WorkflowFailure("Approval context consultations were malformed.");
    }
    const suggestions = consultation.suggestions === undefined ? [] :
      (consultation.suggestions as unknown[]).map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new WorkflowFailure("Approval context adviser suggestions were malformed.");
        }
        const suggestion = raw as Record<string, unknown>;
        if (suggestion.midiClip !== undefined || !Array.isArray(suggestion.targetTrackIds) ||
          !Array.isArray(suggestion.instructions) || typeof suggestion.id !== "string" ||
          typeof suggestion.label !== "string" ||
          suggestion.instructions.length === 0 ||
          suggestion.instructions.length > 4 ||
          suggestion.targetTrackIds.length > 8 ||
          suggestion.id.length > 400 || suggestion.label.length > 600 ||
          suggestion.instructions.some((value) => typeof value !== "string") ||
          suggestion.instructions.some((value) => typeof value === "string" && (!value.trim() || value.length > 2_000)) ||
          suggestion.targetTrackIds.some((value) => typeof value !== "string" || !value)) {
          throw new WorkflowFailure("Approval context adviser suggestions were malformed.");
        }
        return {
          id: suggestion.id,
          label: suggestion.label,
          instructions: suggestion.instructions as string[],
          targetTrackIds: suggestion.targetTrackIds as string[],
          ...(typeof suggestion.instrumentId === "string" ? { instrumentId: suggestion.instrumentId } : {}),
          ...(typeof suggestion.instrumentName === "string" ? { instrumentName: suggestion.instrumentName } : {}),
          ...(suggestion.advisoryMidiRef !== undefined
            ? { advisoryMidiRef: validateAdvisoryMidiRef(suggestion.advisoryMidiRef) }
            : {}),
        };
      });
    return {
      agent: text(consultation.agent),
      group: group as "style" | "concept",
      question: text(consultation.question),
      insight: screenMusicText(text(consultation.insight)),
      ...(suggestions.length ? { suggestions } : {}),
    };
  });
  const budget = approvalBudget(context.consumedBudget);
  if (budget.adviserConsultationsUsed < adviserConsultations.length) {
    throw new WorkflowFailure("Approval context adviser budget cannot be less than its recorded consultations.");
  }
  return {
    originalMessage: text(context.originalMessage),
    originalHistory: clone(context.originalHistory as unknown[]),
    originalMidi: clone(context.originalMidi as unknown[]),
    ...(text(context.selectedStyle) ? { selectedStyle: text(context.selectedStyle) } : {}),
    ...(context.projectId === undefined
      ? {}
      : typeof context.projectId === "string" && /^[0-9a-f-]{36}$/i.test(context.projectId)
        ? { projectId: context.projectId }
        : (() => { throw new WorkflowFailure("Approval context projectId was malformed."); })()),
    ...(context.requiresPlayableMaterial === undefined
      ? {}
      : typeof context.requiresPlayableMaterial === "boolean"
        ? { requiresPlayableMaterial: context.requiresPlayableMaterial }
        : (() => { throw new WorkflowFailure("Approval context requiresPlayableMaterial was malformed."); })()),
    adviserRoster,
    adviserConsultations,
    consumedBudget: budget,
  };
}

function explicitExistingTrack(direction: string, score: ScoreValue): string | undefined {
  const hasExactToken = (value: string | undefined) => Boolean(value) &&
    new RegExp(`(^|[^a-z0-9])${value!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(direction);
  const explicitlyQualified = /\b(existing|current|this)\b.*\btrack\b|\btrack\b.*\b(existing|current|this)\b/i.test(direction);
  const matches = score.tracks.filter((track) => {
    // A literal track ID is unambiguous; names/instruments require an explicit
    // existing-track qualifier and must not select duplicate instruments.
    if (hasExactToken(track.id)) return true;
    return explicitlyQualified && (hasExactToken(track.name) || hasExactToken(track.instrument));
  });
  return matches.length === 1 ? matches[0].id : undefined;
}

/**
 * A requested section length is a structural constraint, not a musical
 * opinion.  Keep this parser intentionally narrow: only explicit numeric
 * `bar(s)` or `beat(s)` phrases establish a duration.  In particular, the
 * number after `bar` in "bar 4 louder" is a location, not a four-bar request.
 *
 * Bars are converted using the explicit meter when one is present.  The score
 * model uses quarter-note beats, so 6/8 is three score beats per bar while
 * the common 4/4 model remains four beats per bar.
 */
export type RequestedSectionLength = {
  durationBeats: number;
  source: string;
  meter?: string;
  beatsPerBar: number;
  diagnostic?: string;
};

type ParsedSectionLength = RequestedSectionLength & {
  values: number[];
};

const NUMERIC_DURATION = "(\\d+(?:\\.\\d+)?)";
const BAR_DURATION_PATTERN = new RegExp(`\\b${NUMERIC_DURATION}\\s*(?:[-\\u2013\\u2014])?\\s*bars?\\b`, "gi");
const BEAT_DURATION_PATTERN = new RegExp(`\\b${NUMERIC_DURATION}\\s*(?:[-\\u2013\\u2014])?\\s*beats?\\b`, "gi");
const METER_PATTERN = /\b([1-9]|1[0-2])\s*\/\s*(2|4|8|16)\b/g;

function parseRequestedSectionLengthDetails(value: string): ParsedSectionLength | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const meterMatches = [...input.matchAll(METER_PATTERN)];
  const meter = meterMatches[0] ? `${meterMatches[0][1]}/${meterMatches[0][2]}` : undefined;
  const beatsPerBar = meter
    ? Number(meterMatches[0]![1]) * (4 / Number(meterMatches[0]![2]))
    : 4;
  const durations: Array<{ value: number; source: string }> = [];
  for (const match of input.matchAll(BAR_DURATION_PATTERN)) {
    const bars = Number(match[1]);
    if (Number.isFinite(bars) && bars > 0) durations.push({ value: bars * beatsPerBar, source: match[0].trim() });
  }
  for (const match of input.matchAll(BEAT_DURATION_PATTERN)) {
    const beats = Number(match[1]);
    if (Number.isFinite(beats) && beats > 0) durations.push({ value: beats, source: match[0].trim() });
  }
  if (!durations.length) return undefined;
  const values = [...new Set(durations.map(({ value }) => value))];
  const durationBeats = values[0]!;
  const diagnostic = values.length > 1
    ? `The request contains conflicting explicit section lengths (${values.join(" and ")} beats); specify one numeric bar or beat duration.`
    : undefined;
  return {
    durationBeats,
    source: durations.map(({ source }) => source).join(", "),
    ...(meter ? { meter } : {}),
    beatsPerBar,
    values,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/**
 * Public, deterministic length parser for route/unit-test consumers.  A
 * conflicting request is returned with a diagnostic so callers can surface a
 * clear failure rather than selecting one of two user constraints.
 */
export function parseRequestedSectionLength(value: string): RequestedSectionLength | undefined {
  const parsed = parseRequestedSectionLengthDetails(value);
  if (!parsed) return undefined;
  const { values: _values, ...publicResult } = parsed;
  return publicResult;
}

/** Backwards-friendly descriptive alias for callers that prefer noun-first
 * naming. */
export function requestedSectionLength(value: string): RequestedSectionLength | undefined {
  return parseRequestedSectionLength(value);
}

function requestedSectionLengthPrompt(length: RequestedSectionLength | undefined): string {
  if (!length) return "";
  const meter = length.meter ? ` in ${length.meter}` : "";
  return `The composer explicitly requested a ${length.durationBeats}-beat section${meter} (${length.source}). Every new or replaced section produced for this request must span exactly ${length.durationBeats} score beats from its earliest add-region start to its latest add-region end. Rests are allowed; do not add notes merely to fill the span.`;
}

/**
 * Validate only generated/replacement material. Existing regions are
 * deliberately excluded: score padding and unrelated existing music must not
 * make a short new section appear to satisfy a longer request. Remove-region
 * operations are likewise excluded because they identify replaced material;
 * add-region operations define the new section's span.
 */
export function validateRequestedSectionLength(
  score: ScoreValue,
  operations: Record<string, unknown>[],
  length: RequestedSectionLength | undefined,
): void {
  if (!length) return;
  if (length.diagnostic) throw new WorkflowFailure(length.diagnostic);
  if (length.durationBeats > score.durationBeats) {
    throw new WorkflowFailure(
      `Requested section length is ${length.durationBeats} beats, but the existing score is only ${score.durationBeats} beats long; no score-length change was authorized, so the edit was not applied.`,
    );
  }
  const additions = operations
    .filter((operation) => operation.type === "add-region")
    .map((operation) => operation.region)
    .filter((region): region is Record<string, unknown> =>
      Boolean(region && typeof region === "object" && !Array.isArray(region)),
    );
  if (!additions.length) {
    throw new WorkflowFailure(
      `Requested section length is ${length.durationBeats} beats, but the generated edit contains no new or replacement region to measure; the score was left unchanged.`,
    );
  }
  const starts = additions.map((region) => Number(region.startBeat));
  const ends = additions.map((region) => Number(region.startBeat) + Number(region.durationBeats));
  const startBeat = Math.min(...starts);
  const endBeat = Math.max(...ends);
  const span = endBeat - startBeat;
  if (!Number.isFinite(span) || Math.abs(span - length.durationBeats) > 1e-9) {
    throw new WorkflowFailure(
      `Requested section length mismatch: requested ${length.durationBeats} beats, but generated new/replacement regions span ${Number.isFinite(span) ? span : "an invalid"} beats; no score change was applied.`,
    );
  }
}

function parseMembershipProposals(value: unknown, score: ScoreValue): TrackProposal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INSTRUMENT_ADDITIONS) {
    throw new WorkflowFailure(`Membership proposals must contain no more than ${MAX_INSTRUMENT_ADDITIONS} changes.`);
  }
  if (value.some((item) => !item || typeof item !== "object" || Array.isArray(item) ||
    (((item as Record<string, unknown>).action !== "add") && ((item as Record<string, unknown>).action !== "delete")))) {
    throw new WorkflowFailure("Every membership proposal must explicitly be an addition or deletion.");
  }
  const additions = parseInstrumentNeeds(value.filter((item) => (
    (item as Record<string, unknown>).action === "add"
  )), score);
  const ids = new Set(additions.map((proposal) => proposal.id));
  const deleted = new Set<string>();
  const deletions = value.filter((item) => (
    item && typeof item === "object" && (item as Record<string, unknown>).action === "delete"
  )).map((item) => {
    const proposal = item as Record<string, unknown>;
    const id = text(proposal.id);
    const trackId = text(proposal.trackId);
    const track = score.tracks.find((candidate) => candidate.id === trackId);
    const playable = findPlayableInstrument(typeof proposal.instrument === "string" ? proposal.instrument : "");
    if (!id || ids.has(id) || !track || !playable ||
      findPlayableInstrument(track.instrument ?? "")?.id !== playable.id || deleted.has(trackId)) {
      throw new WorkflowFailure("A membership removal was malformed, duplicated, or did not match an existing playable track.");
    }
    ids.add(id); deleted.add(trackId);
    return {
      id, action: "delete" as const, trackId, instrument: playable.name,
      role: playable.role, midiProgram: playable.midiProgram,
      summary: proposalSummary(proposal.summary, playable.name),
      reason: proposalReason(proposal.reason, playable.name),
    };
  });
  return [...additions, ...deletions];
}

function parseTrackInstructions(value: unknown, score: ScoreValue): TrackInstruction[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_INITIAL_TRACK_WRITERS) {
    throw new WorkflowFailure(`The Orchestrator must return one to ${MAX_INITIAL_TRACK_WRITERS} specific track instructions.`);
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new WorkflowFailure("A per-track instruction was malformed.");
    const record = item as Record<string, unknown>;
    const trackId = text(record.trackId);
    const rawInstruction = text(record.instruction);
    const instruction = screenMusicText(rawInstruction, "");
    if (rawInstruction && !instruction) {
      throw new WorkflowFailure("A per-track instruction was withheld by music-safety screening; no actionable direction was accepted.");
    }
    if (!trackId || !instruction || instruction.length > 5_000 || seen.has(trackId) ||
      !score.tracks.some((track) => track.id === trackId)) {
      throw new WorkflowFailure("A per-track instruction must uniquely target one current track and contain actionable direction.");
    }
    seen.add(trackId);
    return { trackId, instruction };
  });
}

function trackInstructionContract(score: ScoreValue): string {
  const mapping = score.tracks.map((track) => ({
    trackId: track.id,
    name: track.name,
    instrument: track.instrument,
    role: track.role,
  }));
  const examples = score.tracks.slice(0, 2).map((track) => ({
    trackId: track.id,
    instruction: `Write only the requested material for the assigned ${track.instrument} track; follow the original direction.`,
  }));
  return [
    `AUTHORITATIVE CURRENT TRACK MAPPING (copy trackId exactly; never use a name or placeholder): ${JSON.stringify(mapping)}.`,
    `Valid per-track output examples using live IDs (the instruction remains the original requested direction, not invented musical content): ${JSON.stringify(examples)}.`,
    "Each trackInstructions entry must contain exactly one trackId from that mapping, and every trackId may appear at most once. Do not remap names to IDs, merge entries, drop entries, or invent a track.",
  ].join(" ");
}

function contentFreePlanRepairDiagnostic(error: WorkflowFailure): string {
  const screened = error.message.includes("withheld by music-safety screening");
  return JSON.stringify({
    code: screened ? "track-instruction-safety-screen" : "track-instruction-structure",
    fields: ["trackInstructions"],
    reason: screened
      ? "A non-empty per-track instruction was removed by the music-safety screen; return safe actionable direction."
      : "Each per-track instruction must use one unique exact current track ID and contain actionable direction.",
  });
}

function assertRequiredTrackInstructions(
  instructions: TrackInstruction[],
  requiredTrackIds: Set<string>,
): void {
  const missing = [...requiredTrackIds].filter((trackId) =>
    !instructions.some((instruction) => instruction.trackId === trackId),
  );
  if (missing.length) {
    planError(
      "required-approved-track-instruction-missing",
      "every approved playable-material addition must have one writer instruction",
      -1,
      ["trackInstructions"],
    );
  }
}

function trackHasPlayableMaterial(score: ScoreValue, trackId: string): boolean {
  const track = score.tracks.find((candidate) => candidate.id === trackId);
  return Boolean(track?.regions.some((region) =>
    Array.isArray(region.notes) && region.notes.some((note) =>
      Number.isInteger(note.pitch) &&
      Number.isInteger(note.velocity) &&
      Number.isFinite(note.startBeat) &&
      Number.isFinite(note.durationBeats) &&
      note.durationBeats > 0,
    ),
  ));
}

function ownedOperations(score: ScoreValue, trackId: string, operations: unknown): Record<string, unknown>[] {
  const validated = validOperations(score, operations);
  if (validated.some((operation) => operation.trackId !== trackId)) {
    throw new WorkflowFailure("A track writer attempted an operation outside its server-assigned track.");
  }
  return validated;
}

function approvalPauseContext(
  originalMessage: string,
  originalHistory: unknown[],
  originalMidi: unknown[],
  selectedStyle: string | undefined,
  projectId: string | undefined,
  requiresPlayableMaterial: boolean,
  adviserRoster: AdviserSelection[],
  consultations: WorkflowResult["consultations"],
  consumedBudget: CompositionApprovalBudget,
): CompositionApprovalContext {
  return {
    originalMessage,
    originalHistory: clone(originalHistory),
    originalMidi: clone(originalMidi),
    ...(selectedStyle ? { selectedStyle } : {}),
    ...(projectId ? { projectId } : {}),
    requiresPlayableMaterial,
    adviserRoster: clone(adviserRoster),
    adviserConsultations: clone(consultations.filter((consultation) => consultation.group !== "instrument")),
    consumedBudget: clone(consumedBudget),
  };
}

/**
 * Adviser-first composition transaction.  No model is ever given a mutable
 * score copy: advisers can read the complete score, and the service validates
 * each writer response against its single assigned track before constructing
 * the one staged candidate.
 */
export async function runCompositionWorkflow(input: {
  model: WorkflowModel; message: string; safeDirection: string; intent?: WorkflowIntent; sanitizeDirection?: () => Promise<string>;
  originalMessage?: string; selectedStyle?: string; history: unknown[]; score: ScoreValue; sourceMidi?: unknown;
  projectId?: string;
  approvedTrackProposals?: unknown[];
  approvalContext?: unknown;
  /** Correlation is owned by the compose route and copied onto terminal
   * evaluator events when supplied. */
  workflowId?: string;
  requestId?: string;
  onEvent?: (event: WorkflowEvent) => void; onDiagnostic?: DiagnosticEmitter;
  onRejectedAdviserText?: (diagnostic: RejectedAdviserTextDiagnostic) => void;
  /** Server-owned persistence hook. Raw adviser MIDI never leaves this hook. */
  persistAdvisoryMidiClip?: (suggestion: AdviserSuggestion, score: ScoreValue) => Promise<AdvisoryMidiRef>;
  loadAdvisoryMidiRef?: (ref: AdvisoryMidiRef, suggestion: AdviserSuggestion) => Promise<MaterializedAdvisoryMidi>;
}): Promise<WorkflowResult> {
  const events: WorkflowEvent[] = [];
  const resumed = resumedApprovalContext(input.approvalContext);
  if (resumed?.projectId !== undefined && resumed.projectId !== input.projectId) {
    throw new WorkflowFailure("The signed approval project cannot be changed during continuation.");
  }
  const consultations: WorkflowResult["consultations"] = clone(resumed?.adviserConsultations ?? []);
  const musicalRegenerationBudget = { used: false };
  const budget = approvalBudget(resumed?.consumedBudget ?? {
    adviserConsultationsUsed: 0, trackWriterRoundsUsed: 0, refinementRoundsUsed: 0, operationRepairAttemptsUsed: 0,
  });
  const emit = (event: WorkflowEvent) => {
    if (event.stage === "operation-format-repair") {
      if (budget.operationRepairAttemptsUsed >= MAX_OPERATION_FORMAT_REPAIRS) {
        throw new WorkflowFailure(`The shared operation-repair budget of ${MAX_OPERATION_FORMAT_REPAIRS} was exhausted; the score was left unchanged.`);
      }
      budget.operationRepairAttemptsUsed += 1;
    }
    const safe = {
      ...event,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      // Evaluator fields are screened independently before construction. A
      // second pass over the combined message can erase a safe musical reason
      // when it contains a capitalized track or agent label.
      message: event.stage.startsWith("operation-format-") ||
        event.stage === "agent-response-error" ||
        event.stage.startsWith("evaluation-")
        ? event.message
        : screenMusicText(event.message, "Score workflow update."),
    };
    events.push(safe);
    input.onEvent?.(safe);
  };
  const reportDiagnostic: DiagnosticEmitter = (diagnostic) => {
    emit(modelFailureEvent(diagnostic));
    input.onDiagnostic?.(diagnostic);
  };
  const intent = input.intent ?? await classifyIntent(input.model, input.message, input.history, input.sourceMidi, reportDiagnostic);
  if (input.intent === undefined) {
    emit({ stage: "intent-classified", message: `Semantic intent classified as ${intent}.`, agent: "Orchestrator" });
  }
  const direction = input.sanitizeDirection ? await input.sanitizeDirection() : input.safeDirection;
  if (intent === "discussion") {
    const summary = text((await completeText(input.model, [
      { role: "system", content: "You are Orchestrator. Answer discussion only; do not propose or claim score mutations." },
      { role: "user", content: JSON.stringify({ direction, score: input.score, sourceMidi: input.sourceMidi, history: input.history }) },
    ], 900, { stage: "initial", agent: "Orchestrator" }, reportDiagnostic)).raw);
    if (!summary) throw new WorkflowFailure("The Orchestrator returned an empty discussion response.");
    return { intent, status: "discussion", summary, tasks: [], events, changedFiles: [], operations: [], trackProposals: [], consultations };
  }

  const originalMessage = resumed?.originalMessage ?? input.originalMessage ?? direction;
  const originalHistory = resumed?.originalHistory ?? input.history;
  const originalMidi = resumed?.originalMidi ?? (Array.isArray(input.sourceMidi) ? input.sourceMidi : []);
  const selectedStyle = resumed?.selectedStyle ?? input.selectedStyle;
  // The original composer wording is authoritative.  A safety-normalized
  // direction may paraphrase prose, but it must not be allowed to alter an
  // explicit requested span.
  const requestedLength = parseRequestedSectionLength(originalMessage || direction);
  if (requestedLength?.diagnostic) throw new WorkflowFailure(requestedLength.diagnostic);
  if (requestedLength && requestedLength.durationBeats > input.score.durationBeats) {
    throw new WorkflowFailure(
      `Requested section length is ${requestedLength.durationBeats} beats, but the existing score is only ${input.score.durationBeats} beats long; no score-length change was authorized, so the edit was not applied.`,
    );
  }
  const approved = parseMembershipProposals(input.approvedTrackProposals, input.score);
  const approvedAdditions = approved.filter((proposal) => proposal.action === "add");
  if (approvedAdditions.length > MAX_INITIAL_TRACK_WRITERS) {
    throw new WorkflowFailure(`The approved membership contains more playable-material additions than the ${MAX_INITIAL_TRACK_WRITERS}-writer safety ceiling; the score was left unchanged.`);
  }
  let workingScore = applyInstrumentAdditions(input.score, approvedAdditions);
  // A continuation normally arrives with approved deletions already removed
  // from the client score.  Remove them here too when it has not, so the
  // staged candidate always has the authorized membership and never writes a
  // subsequently deleted track.
  const deleted = new Set(approved.filter((proposal) => proposal.action === "delete").map((proposal) => proposal.trackId));
  if (deleted.size) workingScore = { ...workingScore, tracks: workingScore.tracks.filter((track) => !deleted.has(track.id)) };

  const shortcutTrackId = resumed ? undefined : explicitExistingTrack(direction, workingScore);
  const requiredApprovedTrackIds = new Set(
    resumed?.requiresPlayableMaterial === true
      ? approvedAdditions.map((proposal) => proposal.trackId!).filter(Boolean)
      : [],
  );
  const adviserRoster = resumed?.adviserRoster ?? (shortcutTrackId ? [] : defaultReadOnlyAdvisers());
  // Initial adviser planning remains available, but post-write musical review
  // is deliberately not part of the commit path. Structural MIDI/timing
  // validation is the only acceptance gate after track writers return.
  const reservedAdviserCalls = resumed ? 0 : adviserRoster.length;
  if (budget.adviserConsultationsUsed + reservedAdviserCalls > MAX_ADVISER_CONSULTATIONS) {
    throw new WorkflowFailure(`The shared adviser budget cannot reserve initial planning calls within ${MAX_ADVISER_CONSULTATIONS}; the score was left unchanged.`);
  }
  const consultAdviser = async (adviser: AdviserSelection, phase: "initial" | "review", candidate?: ScoreValue): Promise<AdviserReview> => {
    if (budget.adviserConsultationsUsed >= MAX_ADVISER_CONSULTATIONS) {
      throw new WorkflowFailure(`The shared adviser consultation budget of ${MAX_ADVISER_CONSULTATIONS} was exhausted; the score was left unchanged.`);
    }
    budget.adviserConsultationsUsed += 1;
    const adviserMessages: ModelMessage[] = [
      {
        role: "system",
        content: phase === "initial"
           ? `You are ${adviser.agent}, a bounded read-all/edit-none ${adviser.group} adviser. You have no write or membership capability. Return mostly prose as JSON: {"insight":"non-empty actionable advice <=${ADVISER_FEEDBACK_TARGET_LENGTH} chars","suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact existing track id"],"instrumentId":"supported catalog id","midiClip":{"tempo":120,"durationBeats":4,"notes":[{"pitch":60,"velocity":80,"startBeat":0,"durationBeats":1}]}}]}. suggestions is optional; each suggestion must have a stable unique id, exact existing track IDs and/or a canonical supported instrument id/name, and no more than four bounded instructions. The optional MIDI clip is advisory only and must use bounded timing, pitch, velocity, and tempo. The server validates it and stores it as an opaque temporary object; it is never a score track. The hard service ceiling is ${ADVISER_FEEDBACK_MAX_LENGTH}; target the lower limit for safety margin. Do not include operations even when the array would be empty, membershipProposals, trackProposals, edits, track changes, or private copies. Advise only on the composer's requested musical constraints; legitimate recommendations are prose for Orchestrator, not a demand to rewrite the whole arrangement. ${playableInstrumentCatalogPrompt()}`
           : `You are ${adviser.agent}, the same bounded read-only ${adviser.group} adviser. Inspect the complete staged candidate against the composer's requested constraints only. You have no write or membership capability. Return mostly prose as JSON: {"feedback":"non-empty actionable feedback <=${ADVISER_FEEDBACK_TARGET_LENGTH} chars","needsRefinement":boolean,"affectedTrackIds":["existing track id"],"expectedConstraints":["specific requested constraint <=1200 chars"],"suggestions":[{"id":"stable-id","label":"short label","instructions":["bounded instruction"],"targetTrackIds":["exact existing track id"],"instrumentId":"supported catalog id"}]}. suggestions is optional structured advice only. The hard service ceiling for feedback is ${ADVISER_FEEDBACK_MAX_LENGTH}; target the lower limit for safety margin. expectedConstraints describes what the candidate is expected to satisfy; do not claim measured note counts, pitches, timings, or other observations there. The service derives observed constraints from the compared score copies. Do not include operations even when the array would be empty, membershipProposals, trackProposals, edits, track changes, or private copies. Identify only original writer tracks that need the one permitted refinement. ${playableInstrumentCatalogPrompt()}`,
      },
      {
        role: "user",
        content: JSON.stringify({
          question: adviser.question, direction, selectedStyle, originalUserMessage: originalMessage,
          safetyNormalizedHistory: originalHistory, completeSourceMidi: originalMidi,
          completeScore: phase === "review" ? candidate : workingScore,
          ...(phase === "review" && candidate ? { candidateRevision: candidateRevision(candidate) } : {}),
        }),
      },
    ];
    let payload: Record<string, unknown> | undefined;
    let raw = "";
    let metadata: ProviderCompletionMetadata | undefined;
    let failure: ModelResponseError | undefined;
    try {
      const completion = await completeJson(
        input.model,
        adviserMessages,
        ADVISER_COMPLETION_TOKENS,
        { stage: phase === "initial" ? "initial" : "read", agent: adviser.agent },
        reportDiagnostic,
      );
      payload = completion.payload;
      raw = completion.raw;
      metadata = completion.metadata;
      failure = completion.providerFailure;
    } catch (error) {
      if (!(error instanceof ModelResponseError)) throw error;
      failure = error;
      raw = error.rawResponse ?? "";
      metadata = error.diagnostic.provider;
    }
    const advice = await validateAdviserWithTwoStructuralRepairs({
      model: input.model,
      adviser,
      phase,
      score: candidate ?? workingScore,
      direction,
      selectedStyle,
      originalMessage,
      originalHistory,
      originalMidi,
      question: adviser.question,
      payload,
      response: raw,
      responseMetadata: metadata,
      initialFailure: failure,
      emit,
      onDiagnostic: reportDiagnostic,
      onRejectedAdviserText: input.onRejectedAdviserText,
      workflowId: input.workflowId,
      requestId: input.requestId,
    });
    for (const suggestion of advice.suggestions) {
      if (!suggestion.midiClip) continue;
      if (!input.persistAdvisoryMidiClip) {
        throw new WorkflowFailure("An advisory MIDI clip was supplied but no server-owned project storage was available; no score change was made.");
      }
      const ref = await input.persistAdvisoryMidiClip(suggestion, candidate ?? workingScore);
      delete suggestion.midiClip;
      suggestion.advisoryMidiRef = ref;
    }
    return advice;
  };

  const noMusicalChangeFeedback = (
    before: ScoreValue,
    after: ScoreValue,
    trackId?: string,
    scope: EvaluationScope = trackId ? "track" : "task",
  ): EvaluationFeedback => createEvaluationFeedback({
    kind: "no-musical-change",
    scope,
    original: before,
    candidate: after,
    trackId,
    reason: "The candidate produced no playable musical change in rendered MIDI.",
    expectedConstraints: ["A playable musical change in notes, timing, duration, pitch, or velocity."],
  });

  if (!resumed && !shortcutTrackId) {
    for (const adviser of adviserRoster) {
      const advice = await consultAdviser(adviser, "initial");
      consultations.push({
        agent: adviser.agent, group: adviser.group, question: adviser.question, insight: advice.feedback,
        ...(advice.suggestions.length ? { suggestions: advice.suggestions } : {}),
      });
    }
    emit({ stage: "advisers-consulted", message: `${adviserRoster.length} read-only style and concept advisers completed their bounded consultation.`, agent: "Orchestrator" });
  }

  let plan: Record<string, unknown>;
  if (shortcutTrackId) {
    plan = { trackInstructions: [{ trackId: shortcutTrackId, instruction: direction }], membershipProposals: [] };
    emit({ stage: "existing-instrument-shortcut", message: "An explicitly identified existing track uses the direct track-owner path; technical validation remains required.", agent: "Orchestrator" });
  } else {
    plan = (await completeJson(input.model, [
      {
        role: "system",
          content: `You are Orchestrator. Convert the read-only adviser advice into specific per-track instructions. Return JSON only: {"trackInstructions":[{"trackId":"exact ID from the current track mapping","instruction":"specific actionable direction <=5000 chars"}],"membershipProposals":[{"id":"proposal-id","action":"add|delete","trackId":"required-existing-track-id-for-delete","instrument":"exact supported catalog name","role":"catalog role","midiProgram":0,"summary":"non-empty <=1200 chars","reason":"non-empty"}],"requiresPlayableMaterial":boolean}. A proposal for either an addition OR deletion requires explicit composer approval before any track writer runs. Whenever membershipProposals is non-empty, requiresPlayableMaterial is mandatory and MUST be true when the original composer request asks to create or alter notes, regions, or other playable music after approval; it is false only for membership bookkeeping such as adding or removing an empty track. Bind this decision to the original composer request, not the approval wording. ${requiredApprovedTrackIds.size ? `This is an approval continuation. The signed approved additions require one writer instruction for each of these exact new track IDs: ${JSON.stringify([...requiredApprovedTrackIds])}.` : ""} Never automatically add/remove membership, never return operations, and assign at most ${MAX_INITIAL_TRACK_WRITERS} current tracks. Each instruction must be scoped to the requested constraint, not a whole-arrangement demand. ${trackInstructionContract(workingScore)} ${playableInstrumentCatalogPrompt()}`
      },
      {
        role: "user",
        content: JSON.stringify({
          direction, selectedStyle, originalUserMessage: originalMessage, safetyNormalizedHistory: originalHistory,
          completeSourceMidi: originalMidi, score: workingScore,
          requiredApprovedTrackIds: [...requiredApprovedTrackIds],
          adviserAdvice: consultations.filter((consultation) => consultation.group !== "instrument"),
        }),
      },
    ], 1200, { stage: "initial", agent: "Orchestrator" }, reportDiagnostic)).payload;
  }
  let membership: TrackProposal[];
  let instructions: TrackInstruction[] | undefined;
  let requiresPlayableMaterial: boolean | undefined;
  const priorMembership = plan.membershipProposals ?? plan.instrumentNeeds;
  const priorMembershipPresent = Array.isArray(priorMembership) && priorMembership.length > 0;
  const priorRequiresPlayableMaterial = plan.requiresPlayableMaterial;
  const parsePlanDecision = (candidate: Record<string, unknown>) => {
    const proposedMembership = parseMembershipProposals(candidate.membershipProposals ?? candidate.instrumentNeeds, workingScore);
    if (proposedMembership.length && typeof candidate.requiresPlayableMaterial !== "boolean") {
      planError(
        "membership-intent-missing",
        "requiresPlayableMaterial must be a boolean whenever membershipProposals is non-empty",
        -1,
        ["requiresPlayableMaterial"],
      );
    }
    if (
      priorMembershipPresent !== (proposedMembership.length > 0) ||
      (priorMembershipPresent &&
        typeof priorRequiresPlayableMaterial === "boolean" &&
        candidate.requiresPlayableMaterial !== priorRequiresPlayableMaterial)
    ) {
      planError(
        "membership-intent-changed",
        "the bounded plan repair changed the original membership decision",
        -1,
        ["membershipProposals", "requiresPlayableMaterial"],
      );
    }
    const parsedInstructions = proposedMembership.length
      ? undefined
      : parseTrackInstructions(candidate.trackInstructions, workingScore);
    if (parsedInstructions) assertRequiredTrackInstructions(parsedInstructions, requiredApprovedTrackIds);
    return {
      membership: proposedMembership,
      instructions: parsedInstructions,
      requiresPlayableMaterial: proposedMembership.length
        ? candidate.requiresPlayableMaterial as boolean
        : resumed?.requiresPlayableMaterial,
    };
  };
  try {
    ({ membership, instructions, requiresPlayableMaterial } = parsePlanDecision(plan));
  } catch (error) {
    if (!(error instanceof WorkflowFailure)) throw error;
    if (budget.operationRepairAttemptsUsed >= MAX_OPERATION_FORMAT_REPAIRS) {
      throw new WorkflowFailure(`The shared two-repair pool was exhausted before the Orchestrator plan could be repaired; the score was left unchanged.`);
    }
    budget.operationRepairAttemptsUsed += 1;
    emit({ stage: "plan-format-repair", message: "The Orchestrator plan needs its one bounded structural repair; membership decisions remain unchanged.", agent: "Orchestrator" });
    plan = (await completeJson(input.model, [
      {
        role: "system",
          content: `You are Orchestrator. This is the single bounded structural repair of your existing adviser-informed plan, not a new musical iteration. Return the exact JSON shape {"trackInstructions":[{"trackId":"exact ID from the current track mapping","instruction":"specific actionable direction <=5000 chars"}],"membershipProposals":[{"id":"proposal-id","action":"add|delete","trackId":"required for delete","instrument":"exact supported catalog name","role":"catalog role","midiProgram":0,"summary":"non-empty <=1200 chars","reason":"non-empty"}],"requiresPlayableMaterial":boolean}. Preserve every existing membership decision, the exact requiresPlayableMaterial decision, and every musical instruction; repair only missing/wrong structural fields. Do not silently normalize, drop, add, or reverse a proposal. ${requiredApprovedTrackIds.size ? `The signed approval requires one writer instruction for each approved added track: ${JSON.stringify([...requiredApprovedTrackIds])}.` : ""} ${trackInstructionContract(workingScore)} Content-free validator diagnostic: ${contentFreePlanRepairDiagnostic(error)} ${playableInstrumentCatalogPrompt()}`,
      },
      {
        role: "user",
        content: JSON.stringify({ direction, selectedStyle, score: workingScore, requiredApprovedTrackIds: [...requiredApprovedTrackIds], adviserAdvice: consultations.filter((consultation) => consultation.group !== "instrument"), priorPlan: plan }),
      },
    ], 1200, { stage: "repair", agent: "Orchestrator", attempt: "1/1" }, reportDiagnostic)).payload;
    ({ membership, instructions, requiresPlayableMaterial } = parsePlanDecision(plan));
  }
  if (membership.length) {
    emit({ stage: "membership-approval-needed", message: "Track additions or removals require explicit composer approval; no staged candidate was applied.", agent: "Orchestrator" });
    return {
      intent, status: "discussion", summary: "Track membership proposals are waiting for explicit approval.",
      tasks: [], events, changedFiles: [], operations: [], trackProposals: membership, consultations,
      approvalContext: approvalPauseContext(originalMessage, originalHistory, originalMidi, selectedStyle, input.projectId, requiresPlayableMaterial === true, adviserRoster, consultations, budget),
    };
  }
  if (!instructions) throw new WorkflowFailure("The Orchestrator did not produce track instructions after membership review.");
  const consumeWriterRound = () => {
    if (budget.trackWriterRoundsUsed >= MAX_TRACK_WRITER_ROUNDS) {
      throw new WorkflowFailure(`The shared track-writer round budget of ${MAX_TRACK_WRITER_ROUNDS} was exhausted; the score was left unchanged.`);
    }
    budget.trackWriterRoundsUsed += 1;
  };
  const write = async (instruction: TrackInstruction, base: ScoreValue, refinementFeedback?: string): Promise<Record<string, unknown>[]> => {
    const track = base.tracks.find((candidate) => candidate.id === instruction.trackId);
    if (!track) throw new WorkflowFailure("A server-assigned writer track no longer exists.");
    const agent = trackAgent(track);
    const relevantSuggestions = consultations
      .flatMap((consultation) => consultation.suggestions ?? [])
      .filter((suggestion) => suggestion.targetTrackIds.length > 0
        ? suggestion.targetTrackIds.includes(track.id)
        : Boolean(
          suggestion.instrumentId &&
          findPlayableInstrument(track.instrument ?? "")?.id === suggestion.instrumentId,
        ));
    const materializedSuggestions = await Promise.all(relevantSuggestions.map(async (suggestion) => {
      if (!suggestion.advisoryMidiRef) return suggestion;
      const refTargets = suggestion.advisoryMidiRef.targets;
      if (refTargets.trackIds.some((id) => !suggestion.targetTrackIds.includes(id)) ||
        (suggestion.instrumentId && refTargets.instrumentIds.length > 0 &&
          !refTargets.instrumentIds.includes(suggestion.instrumentId))) {
        throw new WorkflowFailure("An advisory MIDI reference was not bound to its signed suggestion targets.");
      }
      if (!input.loadAdvisoryMidiRef) {
        throw new WorkflowFailure("A relevant advisory MIDI reference could not be loaded by the server.");
      }
      const advisoryMidi = await input.loadAdvisoryMidiRef(suggestion.advisoryMidiRef, suggestion);
      return { ...suggestion, advisoryMidi };
    }));
    const task: WorkflowTask = { id: `track-${track.id}`, title: instruction.instruction, priority: "requested", scope: 0, agents: [agent], status: "working", summary: "", editedFiles: [] };
    emit({ stage: "track-writer-started", message: "A server-scoped track writer started.", taskId: task.id, agent, files: [publicFile(track.id)] });
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: `You are ${agent}, the one track-owning instrument writer and an expert on your instrument's range, articulation, and technique. You may read the complete score/source MIDI for context, but server-side capability permits writes ONLY to assigned trackId "${track.id}". Do not change membership or any other track. Adviser suggestions are guidance, not commands: you may adapt them and take liberties with their material to suit your instrument while preserving the adviser's intent. Return JSON only: {"summary":"non-empty <=1200 chars","operations":[...]}. ${operationSchemaFor(base)} ${requestedSectionLengthPrompt(requestedLength)} ${refinementFeedback ? `This is the one permitted refinement. Address this actionable read-only adviser feedback only: ${refinementFeedback}` : "Write only the requested musical constraint."}`,
      },
      {
        role: "user",
        content: JSON.stringify({
          assignedTrackId: track.id,
          instruction: instruction.instruction,
          ...(requestedLength ? { requestedSectionLength: requestedLength } : {}),
          adviserSuggestions: materializedSuggestions,
          direction,
          selectedStyle,
          completeScore: base,
          completeSourceMidi: originalMidi,
        }),
      },
    ];
    let payload: Record<string, unknown> | undefined;
    let raw = "";
    let metadata: ProviderCompletionMetadata | undefined;
    let failure: ModelResponseError | undefined;
    try {
      const completion = await completeJson(input.model, messages, SPECIALIST_INITIAL_COMPLETION_TOKENS, { stage: "initial", agent, taskId: task.id }, reportDiagnostic, true, true);
      payload = completion.payload;
      raw = completion.raw;
      metadata = completion.metadata;
      failure = completion.providerFailure;
    } catch (error) {
      if (!(error instanceof ModelResponseError)) throw error;
      failure = error;
      raw = error.rawResponse ?? "";
      metadata = error.diagnostic.provider;
    }
    const validated = await validateWithTwoFormatRepairs({
      model: input.model, payload, response: raw, responseMetadata: metadata, initialFailure: failure,
      musicalRegeneration: { trackId: track.id, budget: musicalRegenerationBudget },
      agent, task, base, context: JSON.stringify({ completeScore: base, completeSourceMidi: originalMidi }),
      direction, emit, onDiagnostic: reportDiagnostic,
      responseContext: {
        assignedTrackId: track.id,
        instruction: instruction.instruction,
        direction,
        selectedStyle,
        completeScore: base,
        completeSourceMidi: originalMidi,
        originalWriterMessages: messages,
        ...(refinementFeedback ? { refinementFeedback } : {}),
      },
    });
    const summary = text(validated.payload.summary);
    if (!summary || summary.length > 1_200) throw new WorkflowFailure("A track writer returned an invalid summary.");
    const operations = ownedOperations(base, track.id, validated.operations);
    if (!operations.length) {
      const feedback = noMusicalChangeFeedback(base, base, track.id);
      emitEvaluationFeedback(emit, feedback, task.id);
      emitEvaluationRejection(emit, feedback, task.id);
      throw new WorkflowFailure("A track writer returned no playable operation.", feedback);
    }
    emit({ stage: "track-writer-completed", message: screenMusicText(summary), taskId: task.id, agent, files: [publicFile(track.id)] });
    consultations.push({ agent, group: "instrument", question: instruction.instruction, insight: screenMusicText(summary) });
    return operations;
  };

  const writtenOperations: Record<string, unknown>[] = [];
  consumeWriterRound();
  for (const instruction of instructions) writtenOperations.push(...await write(instruction, workingScore));
  const operations = reserveOperationIds([], writtenOperations);
  if (operations.length > MAX_WORKFLOW_OPERATIONS) throw new WorkflowFailure(`The workflow exceeds the ${MAX_WORKFLOW_OPERATIONS}-operation safety ceiling; the score was left unchanged.`);
  let candidate = applyOperations(workingScore, operations);
  if (resumed?.requiresPlayableMaterial === true && approvedAdditions.length) {
    for (const addition of approvedAdditions) {
      const trackId = addition.trackId!;
      const targeted = operations.some((operation) => operation.trackId === trackId);
      if (!targeted || !trackHasPlayableMaterial(candidate, trackId)) {
        const feedback = noMusicalChangeFeedback(workingScore, candidate, trackId, "track");
        emitEvaluationFeedback(emit, feedback);
        emitEvaluationRejection(emit, feedback);
        throw new WorkflowFailure(
          `Approved playable-material addition ${trackId} did not receive valid playable MIDI; no membership or score change was committed.`,
          feedback,
        );
      }
    }
  }
  // No post-write adviser review or refinement loop is allowed to veto a
  // structurally valid candidate. Requested length is checked against only
  // the new/replacement regions; existing score padding and rests do not
  // count as generated coverage.
  validateRequestedSectionLength(workingScore, operations, requestedLength);
  if (operations.length > MAX_WORKFLOW_OPERATIONS) {
    throw new WorkflowFailure(`The workflow exceeds the ${MAX_WORKFLOW_OPERATIONS}-operation safety ceiling; the score was left unchanged.`);
  }
  if (semanticMidiFingerprint(workingScore) === semanticMidiFingerprint(candidate)) {
    const feedback = noMusicalChangeFeedback(workingScore, candidate);
    emitEvaluationFeedback(emit, feedback);
    emitEvaluationRejection(emit, feedback);
    throw new WorkflowFailure("The staged candidate did not produce a valid requested musical change; the score was left unchanged.", feedback);
  }
  // Re-check the signed approved-addition postcondition immediately before
  // technical reconstruction.
  if (resumed?.requiresPlayableMaterial === true && approvedAdditions.length) {
    for (const addition of approvedAdditions) {
      const trackId = addition.trackId!;
      if (!trackHasPlayableMaterial(candidate, trackId)) {
        const feedback = noMusicalChangeFeedback(workingScore, candidate, trackId, "track");
        emitEvaluationFeedback(emit, feedback);
        emitEvaluationRejection(emit, feedback);
        throw new WorkflowFailure(
          `Approved playable-material addition ${trackId} no longer contains valid playable MIDI before commit; no membership or score change was committed.`,
          feedback,
        );
      }
    }
  }
  // Final validation is deliberately local and atomic: no evaluator asks any
  // individual writer to satisfy unrelated whole-arrangement constraints.
  let reconstructedCandidate = clone(workingScore);
  for (const operation of operations) {
    validOperations(reconstructedCandidate, [operation]);
    reconstructedCandidate = applyOperations(reconstructedCandidate, [operation]);
  }
  if (semanticMidiFingerprint(reconstructedCandidate) !== semanticMidiFingerprint(candidate)) {
    throw new WorkflowFailure("Final technical validation could not reconstruct the exact staged candidate from returned operations.");
  }
  const changedFiles = [...new Set(operations.map((operation) => publicFile(String(operation.trackId))))];
  emit({ stage: "technical-validation", message: "The single staged candidate passed final server-side technical validation.", agent: "Orchestrator", files: changedFiles });
  emit({ stage: "verified", message: "The validated staged candidate is ready for one atomic saved-score commit and Undo.", agent: "Orchestrator", files: changedFiles });
  return {
    intent, status: "verified", summary: "Server-scoped track owners produced a technically validated MIDI/timing candidate; no subjective musical review was required.",
    tasks: instructions.map((instruction) => ({ id: `track-${instruction.trackId}`, title: instruction.instruction, priority: "requested", status: "verified", summary: "Server-scoped track write verified.", editedFiles: [publicFile(instruction.trackId)] })),
    events, changedFiles, operations, trackProposals: approved, consultations,
  };
}

export class PlanValidationError extends WorkflowFailure {
  readonly diagnostic: PlanDiagnostic;
  constructor(diagnostic: PlanDiagnostic) {
    super(`Invalid edit plan${diagnostic.index >= 0 ? ` at task ${diagnostic.index + 1}` : ""}: ${diagnostic.reason}.`);
    this.name = "PlanValidationError";
    this.diagnostic = diagnostic;
  }
}

async function validatePlanWithOneStructuralRepair(args: {
  model: WorkflowModel;
  initial?: Record<string, unknown>;
  initialFailure?: ModelResponseError;
  roster: PlannerRoster;
  direction: string;
  selectedStyle?: string;
  score: ScoreValue;
  sourceMidi?: unknown;
  history: unknown[];
  emit: (event: WorkflowEvent) => void;
  onDiagnostic?: DiagnosticEmitter;
  runState?: WorkflowRunState;
}): Promise<PlannerResult> {
  const maxTasks = Math.max(0, MAX_TASKS - (args.runState?.executedTasks ?? 0));
  try {
    if (args.initialFailure) throw args.initialFailure;
    if (!args.initial) throw new WorkflowFailure("The edit plan response was unavailable.");
    return parsePlannerResult(args.initial, args.roster, args.score, maxTasks);
  } catch (error) {
    if (!(error instanceof PlanValidationError) && !(error instanceof ModelResponseError)) throw error;
    const planDiagnostic = error instanceof PlanValidationError
      ? error.diagnostic
      : { index: -1, code: error.diagnostic.code, reason: error.diagnostic.reason, fields: ["response"] };
    if (error instanceof ModelResponseError && error.diagnostic.code === "provider-token-limit") {
      args.emit({
        stage: "plan-output-limit",
        message: `Provider output-limit rejection: the edit plan was cut off before it could be proven complete (${error.diagnostic.requestedTokens ?? "bounded"} completion tokens). No plan repair or musical generation was attempted; retry with a shorter scope or a more concise request.`,
        agent: "Orchestrator",
      });
      error.message = diagnosticSummary(error.diagnostic, { stage: "initial", agent: "Orchestrator" });
      throw error;
    }
    if (error instanceof ModelResponseError && error.diagnostic.code === "provider-request-timeout") {
      args.emit({
        stage: "plan-request-timeout",
        message: "The Orchestrator plan request exceeded its bounded deadline; no partial plan was repaired or executed.",
        agent: "Orchestrator",
        code: "provider-request-timeout",
        fields: ["response"],
        outcome: "exhausted",
      });
      error.message = diagnosticSummary(error.diagnostic, { stage: "initial", agent: "Orchestrator" });
      throw error;
    }
    if (args.runState?.planRepairUsed) {
      throw new WorkflowFailure(`The edit plan remained invalid after the shared one-plan-repair budget was already used; only ${maxTasks} task(s) remain and the score was left unchanged.`);
    }
    if (maxTasks === 0) {
      throw new WorkflowFailure("No task budget remains for a repaired plan; the score was left unchanged.");
    }
    if (args.runState) args.runState.planRepairUsed = true;
    args.emit({
      stage: "plan-format-repair",
      message: "The edit plan needs one bounded structural repair before specialists can run.",
      agent: "Orchestrator",
    });
    let repaired: Record<string, unknown>;
    try {
      repaired = (await completeJson(args.model, [
      {
        role: "system",
        content: [
          "You are Orchestrator. This is the single permitted structural repair of your existing edit plan, not a new musical iteration.",
          "Preserve the existing musical task intention, task titles, ids, priorities, scopes, compactness, and separations whenever present.",
           `Repair only the plan structure: return JSON only as {"compact":boolean,"tasks":[{"id":"...","title":"...","priority":"...","scope":number,"agents":["agent-id"]}]} with one to ${maxTasks} task(s).`,
          "Every task MUST have an agents array containing 1-4 UNIQUE roster IDs copied EXACTLY from the JSON roster. For a simple direction limited to one instrument or track and one short phrase, repair to exactly one task with exactly one matching instrument specialist; do not add style or concept specialists unless the direction separately requires them. Assign only the minimal specialists directly relevant to each task. Never invent category labels, track names, or agent names. Exact full roster names remain accepted only for compatibility.",
          `JSON roster: ${JSON.stringify(args.roster.entries)}.`,
          `Content-free validator diagnostic: ${JSON.stringify(planDiagnostic)}.`,
          "Do not silently drop tasks or musical intentions. If the prior plan is incomplete, reconstruct its intended task structure from the direction and prior response within these limits.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          direction: args.direction,
          selectedStyle: args.selectedStyle,
          score: args.score,
          completeSourceMidi: args.sourceMidi,
          history: args.history,
          priorPlan: args.initial,
        }),
      },
      ], 1100, { stage: "repair", agent: "Orchestrator", attempt: "1/1" }, args.onDiagnostic)).payload;
    } catch (repairError) {
      if (repairError instanceof ModelResponseError) {
        repairError.message = diagnosticSummary(repairError.diagnostic, {
          stage: "repair",
          agent: "Orchestrator",
          attempt: "1/1",
        });
      }
      throw repairError;
    }
    // The repair is structural only and is validated exactly like the
    // original response. A second failure is terminal; no task is dropped
    // or synthesized locally.
     return parsePlannerResult(repaired, args.roster, args.score, maxTasks);
  }
}

type PlannerRoster = {
  entries: PlannerRosterEntry[];
  byId: Map<string, string>;
  names: Set<string>;
};

function operationDiagnosticDetail(
  diagnostic: OperationValidationError["diagnostic"] | ModelResponseDiagnostic,
): string {
  if ("index" in diagnostic) {
    return `index ${diagnostic.index}, code ${diagnostic.code}, fields ${diagnostic.fields.join(", ") || "none"}${diagnostic.targetId ? `, target ID ${diagnostic.targetId}` : ""}${diagnostic.duplicateId ? `, duplicate ID ${diagnostic.duplicateId}` : ""}${diagnostic.observedType ? `, observed type ${diagnostic.observedType}` : ""}${diagnostic.observedLength !== undefined ? `, observed length ${diagnostic.observedLength}` : ""}${diagnostic.maxLength !== undefined ? `, maximum length ${diagnostic.maxLength}` : ""}`;
  }
  return `response code ${diagnostic.code}, fields response, ${diagnostic.responseChars} response characters${diagnostic.requestedTokens !== undefined ? `, requested budget ${diagnostic.requestedTokens} completion tokens` : ""}`;
}

function operationSchemaFor(score?: ScoreValue, mode: OperationPromptMode = "canonical"): string {
  const modeGuidance = mode === "compact"
    ? "This is a compact musical task, but compact means fewer musical tasks, not a shortened operation object: return the same canonical validated operation shape and all mandatory IDs."
    : "This is a canonical score-operation response: return every required field and every mandatory ID exactly as shown.";
  const inventory = score
    ? `\nThis batch's complete valid target inventory is authoritative; do not address any other track or region. Empty tracks may receive add-region only because they have no removable regions. ${operationTargetInventory(score)}`
    : "";
  return `${modeGuidance}\n${OPERATION_JSON_SCHEMA}${inventory}
IMPORTANT — MIDI pre-response checks: IDs <=400 characters; region names <=600; summaries <=1200. Each region has 1–512 notes. Pitch must be an integer 0–127 and suit the assigned instrument; velocity an integer 1–127. All beat values must be finite. Region and note starts are zero-based, nonnegative, and <=512. Region durations must be >0 and <=128 beats; note durations must be >0 and <=64 beats. ${score ? `This score ends at beat ${score.durationBeats}; each region must satisfy startBeat + durationBeats <= ${score.durationBeats}.` : ""} Notes use REGION-RELATIVE beats: note.startBeat + note.durationBeats <= region.durationBeats. Do not use score-absolute offsets inside notes. Split longer passages into valid regions, retaining all requested musical material. Verify all required fields, exact dynamics/articulation enums, unique IDs, existing removal targets, assigned-track ownership, supported instrument technique, requested scope/style/source performance, and playable changes before returning complete JSON.`;
}

function operationTargetInventory(score: ScoreValue): string {
  return JSON.stringify({
    tracks: score.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      instrument: track.instrument,
      allowedOperationTypes: track.regions.length ? ["add-region", "remove-region"] : ["add-region"],
      regions: track.regions.map((region) => ({
        id: region.id,
        name: region.name,
        startBeat: region.startBeat,
        durationBeats: region.durationBeats,
      })),
    })),
  });
}

function evaluationFeedbackMessage(feedback: EvaluationFeedback): string {
  const track = feedback.trackId ? ` Track: ${groundedEvidenceToken(feedback.trackId)}.` : "";
  return `Evaluation feedback (${feedback.kind}, scope ${feedback.scope}).${track} ` +
    `Candidate revision ${feedback.candidateRevision}. Expected constraints: ${feedback.expectedConstraints.join(" | ")}. ` +
    `Observed constraints: ${feedback.observedConstraints.join(" | ")}. Evidence: ${feedback.evidence.join(" | ")}.`;
}

function groundedEvidenceToken(value: unknown): string {
  const token = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return token.slice(0, 48) || "unknown";
}

function noteDifference(
  original: ScoreValue,
  candidate: ScoreValue,
): { added: RenderedMidiNote[]; removed: RenderedMidiNote[] } {
  const removeMatching = (left: RenderedMidiNote[], right: RenderedMidiNote[]) => {
    const remaining = new Map<string, number>();
    for (const note of right) {
      const key = renderedMidiNoteKey(note);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    return left.filter((note) => {
      const key = renderedMidiNoteKey(note);
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
        return false;
      }
      return true;
    });
  };
  const originalNotes = renderedMidiNotes(original);
  const candidateNotes = renderedMidiNotes(candidate);
  return {
    added: removeMatching(candidateNotes, originalNotes),
    removed: removeMatching(originalNotes, candidateNotes),
  };
}

/**
 * Return only facts measured from the two score copies. In particular, do not
 * fall back to an arbitrary existing region when the copies are equal: that
 * would present unrelated material as evidence for a rejection.
 */
export function groundedEvaluationEvidence(original: ScoreValue, candidate: ScoreValue): string {
  const difference = noteDifference(original, candidate);
  const tracks = [...new Set([
    ...difference.added.map((note) => note.trackId),
    ...difference.removed.map((note) => note.trackId),
  ])];
  if (!difference.added.length && !difference.removed.length) {
    return "No rendered MIDI difference was observed in the compared score copies.";
  }
  const measured = [
    difference.added.length ? `${difference.added.length} rendered note event(s) added` : "",
    difference.removed.length ? `${difference.removed.length} rendered note event(s) removed` : "",
  ].filter(Boolean).join(" and ");
  const excerpts = [...difference.added, ...difference.removed]
    .slice(0, 4)
    .map(evidenceNote)
    .join("; ");
  return `${measured} on track(s) ${tracks.map(groundedEvidenceToken).join(", ")}. ` +
    `Measured changed events: ${excerpts}.`;
}

/**
 * Construct rejection feedback without trusting model-authored observations.
 * `expectedConstraints` may come from the evaluator/reviewer, while observed
 * constraints and evidence always come from the compared score values.
 */
export function createEvaluationFeedback(args: {
  kind: EvaluationKind;
  scope: EvaluationScope;
  original: ScoreValue;
  candidate: ScoreValue;
  reason: string;
  expectedConstraints?: unknown;
  correctionAgents?: string[];
  trackId?: string;
  instrumentAdditions?: TrackProposal[];
}): EvaluationFeedback {
  const reason = screenMusicText(text(args.reason), "The candidate did not meet a requested musical constraint.");
  const scopedScore = (score: ScoreValue): ScoreValue => args.scope === "track"
    ? { ...score, tracks: score.tracks.filter(track => track.id === args.trackId) }
    : score;
  const original = scopedScore(args.original);
  const candidate = scopedScore(args.candidate);
  const observedConstraints = noteDifference(original, candidate);
  const observed = observedConstraints.added.length || observedConstraints.removed.length
    ? [groundedAggregateEvaluationEvidence(original, candidate)]
    : ["No rendered note difference was observed in the compared score copies."];
  return {
    kind: args.kind,
    scope: args.scope,
    ...(text(args.trackId) ? { trackId: text(args.trackId) } : {}),
    candidateRevision: candidateRevision(args.candidate),
    expectedConstraints: normalizeConstraintList(args.expectedConstraints, reason),
    observedConstraints: observed,
    reason,
    evidence: [groundedAggregateEvaluationEvidence(original, candidate)],
    correctionAgents: [...new Set((args.correctionAgents ?? []).filter((agent) => typeof agent === "string").map((agent) => text(agent)).filter(Boolean))].slice(0, 4),
    ...(args.instrumentAdditions?.length ? { instrumentAdditions: args.instrumentAdditions } : {}),
  };
}

function emitEvaluationFeedback(
  emit: (event: WorkflowEvent) => void,
  feedback: EvaluationFeedback,
  taskId?: string,
): void {
  emit({
    stage: "evaluation-feedback",
    message: evaluationFeedbackMessage(feedback),
    taskId,
    agent: "Evaluator",
    code: feedback.kind,
    evaluationKind: feedback.kind,
    evaluatorCategory: feedback.kind === "no-musical-change" ? "no-op" : feedback.kind,
    scope: feedback.scope,
    affectedScope: [
      feedback.scope,
      ...(feedback.trackId ? [`track:${groundedEvidenceToken(feedback.trackId)}`] : []),
    ],
    ...(feedback.trackId ? { trackId: feedback.trackId } : {}),
    candidateRevision: feedback.candidateRevision,
    expectedConstraints: feedback.expectedConstraints,
    observedConstraints: feedback.observedConstraints,
    expected: feedback.expectedConstraints.join(" | "),
    observed: feedback.observedConstraints.join(" | "),
    evidence: feedback.evidence,
    reason: feedback.reason,
    correctionOutcome: feedback.kind === "musical-rejection" ? "correction-requested" : "not-attempted",
    commitStatus: "not-committed",
  });
}

/**
 * Terminal audit evidence deliberately contains only service-measured
 * aggregates. Do not persist MIDI note details (pitch, beat, duration, or
 * velocity) as evaluator evidence; those details are useful only to the
 * internal legacy diagnostic above.
 */
export function groundedAggregateEvaluationEvidence(original: ScoreValue, candidate: ScoreValue): string {
  const difference = noteDifference(original, candidate);
  const tracks = [...new Set([
    ...difference.added.map((note) => note.trackId),
    ...difference.removed.map((note) => note.trackId),
  ])];
  if (!difference.added.length && !difference.removed.length) {
    return "No rendered note difference was observed in the compared score copies.";
  }
  const measured = [
    difference.added.length ? `${difference.added.length} rendered note event(s) added` : "",
    difference.removed.length ? `${difference.removed.length} rendered note event(s) removed` : "",
  ].filter(Boolean).join(" and ");
  return `${measured} on track(s) ${tracks.map(groundedEvidenceToken).join(", ")}.`;
}

function renderedMidiNoteKey(note: RenderedMidiNote): string {
  return JSON.stringify([
    note.trackId,
    note.pitch,
    note.velocity,
    note.startBeat,
    note.durationBeats,
  ]);
}

function renderedMidiNotes(score: ScoreValue): RenderedMidiNote[] {
  return score.tracks.flatMap((track) => track.regions.flatMap((region) => region.notes.map((note) => ({
    trackId: track.id,
    pitch: note.pitch,
    velocity: note.velocity,
    startBeat: region.startBeat + note.startBeat,
    durationBeats: note.durationBeats,
  })))).sort((left, right) =>
    left.trackId.localeCompare(right.trackId) ||
    left.startBeat - right.startBeat ||
    left.pitch - right.pitch ||
    left.velocity - right.velocity ||
    left.durationBeats - right.durationBeats
  );
}

function emitEvaluationRejection(
  emit: (event: WorkflowEvent) => void,
  feedback: EvaluationFeedback,
  taskId?: string,
  correctionOutcome = "not-attempted",
): void {
  emit({
    stage: "evaluation-rejected",
    message: `Evaluation rejection (${feedback.kind}, scope ${feedback.scope}). ` +
      `Candidate revision ${feedback.candidateRevision}. Expected constraints: ${feedback.expectedConstraints.join(" | ")}. ` +
      `Observed constraints: ${feedback.observedConstraints.join(" | ")}. Evidence: ${feedback.evidence.join(" | ")}. The score was left unchanged.`,
    taskId,
    agent: "Evaluator",
    code: feedback.kind,
    evaluationKind: feedback.kind,
    evaluatorCategory: feedback.kind === "no-musical-change" ? "no-op" : feedback.kind,
    scope: feedback.scope,
    affectedScope: [
      feedback.scope,
      ...(feedback.trackId ? [`track:${groundedEvidenceToken(feedback.trackId)}`] : []),
    ],
    ...(feedback.trackId ? { trackId: feedback.trackId } : {}),
    candidateRevision: feedback.candidateRevision,
    expectedConstraints: feedback.expectedConstraints,
    observedConstraints: feedback.observedConstraints,
    expected: feedback.expectedConstraints.join(" | "),
    observed: feedback.observedConstraints.join(" | "),
    evidence: feedback.evidence,
    reason: feedback.reason,
    correctionOutcome,
    commitStatus: "not-committed",
  });
}

function evidenceNote(note: RenderedMidiNote): string {
  return `track ${groundedEvidenceToken(note.trackId)} pitch ${note.pitch} ` +
    `beat ${note.startBeat.toFixed(2)} duration ${note.durationBeats.toFixed(2)} velocity ${note.velocity}`;
}

/** A stable, content-only revision label for the inspected candidate. */
export function candidateRevision(score: ScoreValue): string {
  return `candidate-${createHash("sha256").update(semanticMidiFingerprint(score)).digest("hex").slice(0, 16)}`;
}

function normalizeConstraintList(value: unknown, fallback: string): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => screenMusicText(item.trim(), "").slice(0, 1_200))
    .filter(Boolean)
    .slice(0, 8);
  return normalized.length ? normalized : [screenMusicText(fallback.slice(0, 1_200), "A requested musical constraint.")];
}
