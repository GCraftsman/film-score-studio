import type {
  CompositionApprovalContext,
  CompositionRequest,
  ConversationMessage,
  EditWorkflow,
  EditWorkflowEvent,
  Score,
  ScoreOperation,
  StyleSuggestion,
  TrackProposal,
  MidiSnippet,
} from '@workspace/api-client-react';
import type { LocalMessage } from '@/hooks/use-workspace';
import { findInstrument } from './instrument-catalog.ts';

export type WorkspaceOnboardingPhase =
  | 'style-needed'
  | 'style-review'
  | 'instrument-review'
  | 'ready';

export type PendingProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export const SELECTED_STYLE_MAX_LENGTH = 1000;
const STYLE_SUGGESTION_ID_MAX_LENGTH = 80;
const STYLE_SUGGESTION_NAME_MAX_LENGTH = 120;
const STYLE_SUGGESTION_DESCRIPTION_MAX_LENGTH = 500;
const STYLE_SUGGESTION_AGENT_MAX_LENGTH = 120;

export type PendingWorkflowProposal = {
  id: string;
  kind: 'style' | 'instruments' | 'tracks';
  status: PendingProposalStatus;
  sourceMessageId: string;
  sourceText: string;
  originatingMidi: MidiSnippet[];
  /** The pre-approval conversation, not the synthetic continuation bubble. */
  originatingHistory: ConversationMessage[];
  selectedStyle?: string;
  styleSuggestions?: StyleSuggestion[];
  trackProposals?: TrackProposal[];
  /**
   * Opaque-to-the-editor workflow continuation state returned by the
   * Orchestrator. It records the original source/advisers and already-used
   * shared capacity, so a reload cannot restart the adviser round or budget.
   */
  approvalContext?: CompositionApprovalContext;
};

export type WorkspaceOnboarding = {
  phase: WorkspaceOnboardingPhase;
  selectedStyle?: string;
  originatingMidi: MidiSnippet[];
};

/**
 * Safe terminal evaluator evidence is intentionally stored separately from
 * score mutations. A rejected staged candidate must not be able to change the
 * committed score, but its bounded reviewer feedback should remain available
 * after saving and reopening the project.
 */
export type TerminalAuditEvaluatorCategory =
  | 'malformed'
  | 'musical-rejection'
  | 'no-op'
  | 'unknown';

export type TerminalAuditCommitStatus =
  | 'not-committed'
  | 'unchanged'
  | 'committed';

export type TerminalAudit = {
  workflowId: string;
  requestId?: string;
  reason: string;
  evidence: string[];
  evaluatorCategory: TerminalAuditEvaluatorCategory;
  affectedScope: string[];
  expected?: string;
  observed?: string;
  candidateRevision?: number | string;
  correctionOutcome: string;
  commitStatus: TerminalAuditCommitStatus;
};

const MAX_TERMINAL_AUDITS = 20;
const TERMINAL_AUDIT_ID_MAX_LENGTH = 160;
const TERMINAL_AUDIT_REASON_MAX_LENGTH = 2000;
const TERMINAL_AUDIT_EVIDENCE_MAX_ITEMS = 8;
const TERMINAL_AUDIT_EVIDENCE_MAX_LENGTH = 1000;
const TERMINAL_AUDIT_SCOPE_MAX_ITEMS = 16;
const TERMINAL_AUDIT_SCOPE_MAX_LENGTH = 160;
const TERMINAL_AUDIT_CONSTRAINT_MAX_LENGTH = 2000;
const TERMINAL_AUDIT_CORRECTION_MAX_LENGTH = 160;

export type StoredProject = {
  score: Score;
  scoreRevision: number;
  messages: LocalMessage[];
  undoStack: Score[];
  onboarding: WorkspaceOnboarding;
  pendingProposals: PendingWorkflowProposal[];
  terminalAudits?: TerminalAudit[];
};

/**
 * The membership approval callback is a continuation of the original
 * composition request, not a second user conversation. Additions are carried
 * as authorization metadata and committed only with the verified result;
 * deletions remain an explicit local membership transaction. The API still
 * classifies every request from its `message`, so make the continuation
 * unambiguously actionable while retaining the complete original direction
 * for the planner and evaluator.
 */
export function buildApprovedCompositionContinuation(sourceText: string): string {
  const original = sourceText.trim() || '(MIDI-only composer request)';
  return [
    'Continue the original composer request after approved instrument membership.',
    'Treat the approval itself as complete membership bookkeeping, not as a request to alter notes or regions. Re-evaluate the original direction semantically: if it requested playable score material, continue to specialist generation; if it requested membership only, record the approved membership without inventing notes.',
    'Original composer direction:',
    original,
  ].join('\n\n');
}

/** A failed approval submission may already have consumed its one-time token. */
export function freshPlanRetryFromApprovalContext(
  approvalContext: CompositionApprovalContext,
): NonNullable<LocalMessage['retry']> {
  return {
    message: approvalContext.originalMessage,
    snippets: approvalContext.originalMidi,
    selectedStyle: approvalContext.selectedStyle,
    phase: 'composition',
    suppressUserMessage: true,
    history: approvalContext.originalHistory,
    // Deliberately omit all approval IDs and the approval context itself.
    freshPlan: true,
  };
}

export function buildCompositionRequest(input: {
  message: string;
  phase: CompositionRequest['phase'];
  /** Active cloud project used for server-side terminal audit persistence. */
  projectId?: string;
  selectedStyle?: string;
  approvedTrackProposalIds?: string[];
  approvedTrackProposals?: TrackProposal[];
  approvalContext?: CompositionApprovalContext;
  midiSnippets: CompositionRequest['midiSnippets'];
  history: CompositionRequest['history'];
  score: CompositionRequest['score'];
}): CompositionRequest {
  return {
    message: input.message,
    phase: input.phase,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.selectedStyle ? { selectedStyle: input.selectedStyle } : {}),
    ...(input.approvedTrackProposalIds ? { approvedTrackProposalIds: input.approvedTrackProposalIds } : {}),
    ...(input.approvedTrackProposals ? { approvedTrackProposals: input.approvedTrackProposals } : {}),
    ...(input.approvalContext ? { approvalContext: input.approvalContext } : {}),
    midiSnippets: input.midiSnippets,
    history: input.history,
    score: input.score,
  } as CompositionRequest & { projectId?: string };
}

/**
 * Stream progress and the terminal workflow payload intentionally share the
 * same events. Collapse only exact content/event identities: diagnostic
 * attempts remain distinct so repair evidence is never lost.
 */
export function workflowEventIdentity(event: EditWorkflowEvent): string {
  return JSON.stringify([
    event.stage,
    event.message,
    event.reason ?? '',
    event.agent ?? '',
    event.taskId ?? '',
    event.files ?? [],
    event.attempt ?? null,
    event.index ?? null,
    event.code ?? null,
    event.fields ?? null,
    event.targetId ?? null,
    event.duplicateId ?? null,
    event.observedType ?? null,
    event.observedLength ?? null,
    event.maxLength ?? null,
    event.outcome ?? null,
  ]);
}

export function dedupeWorkflowEvents(events: EditWorkflowEvent[]): EditWorkflowEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const identity = workflowEventIdentity(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Intent classification is an internal routing detail. Hiding it from the
 * conversation keeps approval continuations from filling the audit with
 * repeated classifier rows while preserving every structural repair
 * diagnostic and specialist event.
 */
export function hideWorkflowRoutingEvents(events: EditWorkflowEvent[]): EditWorkflowEvent[] {
  return events.filter((event) => event.stage !== 'intent-classified');
}

export type WorkspaceSnapshot = StoredProject & {
  version: 3;
};

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function boundedStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map(item => item.trim().slice(0, maxLength));
  return values.length === value.length ? values : undefined;
}

function terminalAuditCategory(value: unknown): TerminalAuditEvaluatorCategory | undefined {
  if (value === 'malformed' || value === 'musical-rejection' || value === 'no-op' || value === 'unknown') {
    return value;
  }
  // The workflow's internal evaluator name predates the client audit
  // contract. Keep old server records readable without presenting a new
  // category or inventing evidence.
  if (value === 'no-musical-change') return 'no-op';
  return undefined;
}

function terminalAuditCommitStatus(value: unknown): TerminalAuditCommitStatus | undefined {
  return value === 'not-committed' || value === 'unchanged' || value === 'committed'
    ? value
    : undefined;
}

function normalizeTerminalAudit(value: unknown): TerminalAudit | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const workflowId = boundedString(candidate.workflowId, TERMINAL_AUDIT_ID_MAX_LENGTH);
  const requestId = candidate.requestId === undefined
    ? undefined
    : boundedString(candidate.requestId, TERMINAL_AUDIT_ID_MAX_LENGTH);
  const reason = boundedString(candidate.reason, TERMINAL_AUDIT_REASON_MAX_LENGTH);
  const rawEvidence = typeof candidate.evidence === 'string' ? [candidate.evidence] : candidate.evidence;
  const evidence = boundedStringArray(
    rawEvidence,
    TERMINAL_AUDIT_EVIDENCE_MAX_ITEMS,
    TERMINAL_AUDIT_EVIDENCE_MAX_LENGTH,
  );
  const evaluatorCategory = terminalAuditCategory(candidate.evaluatorCategory ?? candidate.evaluationKind);
  const rawAffectedScope = candidate.affectedScope ?? (
    candidate.scope === undefined
      ? undefined
      : [
        candidate.scope,
        ...(candidate.trackId === undefined ? [] : [`track:${String(candidate.trackId)}`]),
      ]
  );
  const affectedScope = boundedStringArray(
    rawAffectedScope,
    TERMINAL_AUDIT_SCOPE_MAX_ITEMS,
    TERMINAL_AUDIT_SCOPE_MAX_LENGTH,
  );
  const correctionOutcome = boundedString(candidate.correctionOutcome, TERMINAL_AUDIT_CORRECTION_MAX_LENGTH);
  const commitStatus = terminalAuditCommitStatus(candidate.commitStatus);
  const expected = candidate.expected === undefined
    ? boundedStringArray(candidate.expectedConstraints, TERMINAL_AUDIT_EVIDENCE_MAX_ITEMS, TERMINAL_AUDIT_CONSTRAINT_MAX_LENGTH)
      ?.join(' | ').slice(0, TERMINAL_AUDIT_CONSTRAINT_MAX_LENGTH)
    : boundedString(candidate.expected, TERMINAL_AUDIT_CONSTRAINT_MAX_LENGTH);
  const observed = candidate.observed === undefined
    ? boundedStringArray(candidate.observedConstraints, TERMINAL_AUDIT_EVIDENCE_MAX_ITEMS, TERMINAL_AUDIT_CONSTRAINT_MAX_LENGTH)
      ?.join(' | ').slice(0, TERMINAL_AUDIT_CONSTRAINT_MAX_LENGTH)
    : boundedString(candidate.observed, TERMINAL_AUDIT_CONSTRAINT_MAX_LENGTH);
  const candidateRevision = candidate.candidateRevision === undefined
    ? undefined
    : typeof candidate.candidateRevision === 'number' && Number.isInteger(candidate.candidateRevision) &&
      candidate.candidateRevision >= 0
      ? candidate.candidateRevision
      : typeof candidate.candidateRevision === 'string' &&
        candidate.candidateRevision.trim()
        ? boundedString(candidate.candidateRevision, TERMINAL_AUDIT_ID_MAX_LENGTH)
        : null;
  if (!workflowId || !reason || !evidence || !evaluatorCategory ||
    !affectedScope || !correctionOutcome || !commitStatus || candidateRevision === null ||
    (candidate.requestId !== undefined && requestId === undefined) ||
    (candidate.expected !== undefined && expected === undefined) ||
    (candidate.expectedConstraints !== undefined && expected === undefined) ||
    (candidate.observed !== undefined && observed === undefined)) {
    return null;
  }
  return {
    workflowId,
    ...(requestId !== undefined ? { requestId } : {}),
    reason,
    evidence,
    evaluatorCategory,
    affectedScope,
    ...(expected !== undefined ? { expected } : {}),
    ...(observed !== undefined ? { observed } : {}),
    ...(candidateRevision !== undefined ? { candidateRevision } : {}),
    correctionOutcome,
    commitStatus,
  };
}

export function terminalAuditIdentity(audit: TerminalAudit): string {
  return `${audit.workflowId}\u0000${audit.requestId ?? ''}`;
}

export function normalizeTerminalAudits(value: unknown): TerminalAudit[] {
  if (!Array.isArray(value)) return [];
  const auditsByIdentity = new Map<string, TerminalAudit>();
  value.forEach((item) => {
    const audit = normalizeTerminalAudit(item);
    if (!audit) return;
    const identity = terminalAuditIdentity(audit);
    // Keep the latest representation. This matters when a locally streamed
    // audit is later replaced by the server-normalized entry during reload.
    auditsByIdentity.delete(identity);
    auditsByIdentity.set(identity, audit);
  });
  return [...auditsByIdentity.values()].slice(-MAX_TERMINAL_AUDITS);
}

/** Merge server evidence into a local draft without replacing its score. */
export function mergeTerminalAudits(local: unknown, server: unknown): TerminalAudit[] {
  return normalizeTerminalAudits([
    ...(Array.isArray(local) ? local : []),
    ...(Array.isArray(server) ? server : []),
  ]);
}

export function applyScoreOperations(score: Score, operations: ScoreOperation[]): Score | null {
  return operations.reduce<Score | null>((next, operation) => {
    if (!next) return null;
    const track = next.tracks.find(item => item.id === operation.trackId);
    if (!track) return null;
    if (operation.type === 'add-region') {
      if (next.tracks.some(item => item.regions.some(region => region.id === operation.region.id))) return null;
      return { ...next, tracks: next.tracks.map(item => item.id === operation.trackId ? { ...item, regions: [...item.regions, operation.region] } : item) };
    }
    if (!track.regions.some(region => region.id === operation.regionId)) return null;
    return { ...next, tracks: next.tracks.map(item => item.id === operation.trackId ? { ...item, regions: item.regions.filter(region => region.id !== operation.regionId) } : item) };
  }, score);
}

export type OperationApplicationStatus = 'applied' | 'conflicted' | 'blocked';

export function isVerifiedEditWorkflow(workflow: EditWorkflow | undefined): boolean {
  return workflow?.intent === 'edit' && workflow.status === 'verified';
}

function normalizedAgentName(value: string): string {
  return value.trim().toLowerCase().replace(/[\[\]():_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Supports backend `[track <track-id>]` progress aliases without guessing. */
export function matchesWorkflowAgent(agentId: string, agentName: string, emittedAgent: string): boolean {
  const target = normalizedAgentName(emittedAgent);
  const normalizedName = normalizedAgentName(agentName);
  if (target === normalizedName || target === `track ${normalizedName}` || target === `track agent ${normalizedName}`) return true;
  if (!agentId.startsWith("track-agent-")) return false;
  const trackId = normalizedAgentName(agentId.slice("track-agent-".length));
  const emittedTrackId = emittedAgent.match(/\btrack\s+(track-[a-z0-9_-]+)\b/i)?.[1];
  if (emittedTrackId && normalizedAgentName(emittedTrackId) === trackId) return true;
  return target === trackId || target === `track ${trackId}` || target === `track agent ${trackId}`;
}

/** Terminal workflow updates must clear a specialist's active treatment. */
export function isTerminalWorkflowProgress(stage: string, message: string): boolean {
  return /\b(completed?|complete|verified|verification|failed|failure|error|no[\s-]?change|no[\s-]?op|unchanged|skipped|cancelled|canceled|done)\b/i
    .test(`${stage} ${message}`);
}

type AbsoluteMidiEvent = {
  instrument: string;
  midiProgram: number;
  pitch: number;
  onset: number;
  duration: number;
  velocity: number;
};

/**
 * A score's semantic payload is its audible MIDI events, not UI identifiers,
 * labels, or ordering. Region-local starts are converted to absolute beats so
 * a renamed/reordered but otherwise identical region remains a true no-op.
 */
export function absoluteMidiEvents(score: Score): AbsoluteMidiEvent[] {
  return score.tracks
    .flatMap((track) => track.regions.flatMap((region) => region.notes.map((note) => ({
      instrument: track.instrument,
      midiProgram: track.midiProgram,
      pitch: note.pitch,
      onset: region.startBeat + note.startBeat,
      duration: note.durationBeats,
      velocity: note.velocity,
    }))))
    .sort((left, right) =>
      left.instrument.localeCompare(right.instrument) ||
      left.midiProgram - right.midiProgram ||
      left.pitch - right.pitch ||
      left.onset - right.onset ||
      left.duration - right.duration ||
      left.velocity - right.velocity,
    );
}

export function scoresMatch(left: Score, right: Score): boolean {
  const leftEvents = absoluteMidiEvents(left);
  const rightEvents = absoluteMidiEvents(right);
  return leftEvents.length === rightEvents.length && leftEvents.every((event, index) => {
    const candidate = rightEvents[index];
    return event.instrument === candidate.instrument &&
      event.midiProgram === candidate.midiProgram &&
      event.pitch === candidate.pitch &&
      event.onset === candidate.onset &&
      event.duration === candidate.duration &&
      event.velocity === candidate.velocity;
  });
}

/**
 * Keeps the application decision pure so an assistant response can never be
 * marked applied unless it was verified, based on the current revision, and
 * materially changed the local structured score.
 */
export function evaluateOperationApplication(input: {
  score: Score;
  currentRevision: number;
  baseRevision: number;
  operations: ScoreOperation[];
  trackProposals?: TrackProposal[];
  editWorkflow?: EditWorkflow;
}): { status: OperationApplicationStatus; score?: Score } {
  if (!isVerifiedEditWorkflow(input.editWorkflow)) return { status: 'blocked' };
  if (input.currentRevision !== input.baseRevision) return { status: 'conflicted' };
  const withMembership = input.trackProposals?.length
    ? applySelectedTrackProposals(input.score, input.trackProposals, input.trackProposals.map((proposal) => proposal.id))
    : input.score;
  const nextScore = withMembership ? applyScoreOperations(withMembership, input.operations) : null;
  if (!nextScore || (!input.trackProposals?.length && scoresMatch(input.score, nextScore))) return { status: 'conflicted' };
  return { status: 'applied', score: nextScore };
}

export function setOperationStatus(messages: LocalMessage[], messageId: string, status: LocalMessage['operationStatus']): LocalMessage[] {
  return messages.map(item => item.id === messageId ? { ...item, operationStatus: status } : item);
}

function protectPersistedUnverifiedOperations(messages: LocalMessage[]): LocalMessage[] {
  return messages.map((message, index) => {
    if (!message.operations?.length || message.operationStatus !== 'pending' || isVerifiedEditWorkflow(message.editWorkflow)) {
      return message;
    }
    const source = messages.slice(0, index).reverse().find((candidate) => candidate.role === 'user');
    return {
      ...message,
      operationStatus: 'blocked',
      retry: message.retry ?? (source ? {
        message: source.content,
        snippets: source.snippets ?? [],
        phase: 'composition',
      } : undefined),
    };
  });
}

export function restorePreviousScore(previous: Score | undefined): Score | null {
  return previous ?? null;
}

/**
 * Resolve an instrument to the catalog's canonical display name before
 * comparing it with another score or proposal. Legacy score snapshots may
 * still contain aliases such as "Piano", while new proposals use
 * "Upright Piano".
 */
export function canonicalInstrumentName(value: string): string | undefined {
  return findInstrument(value)?.name;
}

export function applyTrackProposal(score: Score, proposal: TrackProposal): Score | null {
  if (proposal.action === 'add') {
    // Instrument identity is authoritative. A numeric MIDI program can be
    // shared by unrelated banks (notably piano and GM percussion), so never
    // turn an unknown proposal into a different catalog sound by fallback.
    const playable = findInstrument(proposal.instrument);
    if (!playable || score.tracks.length >= 32 || score.tracks.some((track) => canonicalInstrumentName(track.instrument) === playable.name)) return null;
    return {
      ...score,
      tracks: [
        ...score.tracks,
        {
          id: `track-${proposal.id}`,
          name: playable.name,
          role: playable.role,
          instrument: playable.name,
          midiProgram: playable.midiProgram,
          regions: [],
        },
      ],
    };
  }
  if (!proposal.trackId || !score.tracks.some((track) => track.id === proposal.trackId)) return null;
  return {
    ...score,
    tracks: score.tracks.filter((track) => track.id !== proposal.trackId),
  };
}

/**
 * Apply an explicit membership selection as one transaction. The caller must
 * provide only unique proposal IDs that belong to this proposal set. Every
 * selected proposal is applied against the same working score; if any member
 * is invalid, no partially applied score is returned.
 */
export function applySelectedTrackProposals(
  score: Score,
  proposals: TrackProposal[],
  selectedIds: string[],
): Score | null {
  if (new Set(selectedIds).size !== selectedIds.length) return null;
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));
  if (proposalIds.size !== proposals.length) return null;
  if (selectedIds.some((id) => !proposalIds.has(id))) return null;
  if (proposals.length > 0 && selectedIds.length === 0) return null;

  const selected = new Set(selectedIds);
  let nextScore = score;
  for (const proposal of proposals) {
    if (!selected.has(proposal.id)) continue;
    const applied = applyTrackProposal(nextScore, proposal);
    if (!applied) return null;
    nextScore = applied;
  }
  return nextScore;
}

/**
 * Replace only the instrument metadata for a saved track. Region IDs and
 * note material are copied untouched so resolving an unsupported legacy sound
 * cannot erase the composer's existing work.
 */
export function replaceTrackInstrument(
  score: Score,
  trackId: string,
  instrumentValue: string,
): Score | null {
  const playable = findInstrument(instrumentValue);
  const track = score.tracks.find((candidate) => candidate.id === trackId);
  if (!playable || !track) return null;
  return {
    ...score,
    tracks: score.tracks.map((candidate) => candidate.id === trackId
      ? {
        ...candidate,
        role: playable.role,
        instrument: playable.name,
        midiProgram: playable.midiProgram,
      }
      : candidate),
  };
}

/**
 * Repair metadata for catalog identities when loading older score snapshots.
 * Keep the persisted label (for example, "Piano") so aliases remain
 * recognisable, while updating role/program to the current licensed mapping.
 * Unsupported identities are deliberately left untouched for the replacement
 * UI instead of being guessed from their old MIDI program.
 */
export function normalizeSavedScore(score: Score): Score {
  return {
    ...score,
    tracks: score.tracks.map((track) => {
      const playable = findInstrument(track.instrument);
      return playable
        ? { ...track, role: playable.role, midiProgram: playable.midiProgram }
        : track;
    }),
  };
}

function isMidiSnippet(value: unknown): value is MidiSnippet {
  if (typeof value !== 'object' || value === null) return false;
  const snippet = value as MidiSnippet;
  return typeof snippet.id === 'string' &&
    typeof snippet.tempo === 'number' &&
    typeof snippet.durationMs === 'number' &&
    Array.isArray(snippet.notes);
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as ConversationMessage;
  return (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' && message.content.length <= 4000;
}

function isApprovalContext(value: unknown): value is CompositionApprovalContext {
  if (typeof value !== 'object' || value === null) return false;
  const context = value as CompositionApprovalContext;
  return typeof context.originalMessage === 'string' &&
    context.originalMessage.length > 0 &&
    context.originalMessage.length <= 4000 &&
    Array.isArray(context.originalHistory) &&
    context.originalHistory.length <= 12 &&
    context.originalHistory.every(isConversationMessage) &&
    Array.isArray(context.originalMidi) &&
    context.originalMidi.every(isMidiSnippet) &&
    (context.selectedStyle === undefined || isSelectedStyle(context.selectedStyle)) &&
    Array.isArray(context.adviserRoster) &&
    context.adviserRoster.length <= 16 &&
     context.adviserRoster.every((item: unknown) => {
       const candidate = item as Record<string, unknown>;
       return typeof candidate?.agent === 'string' && typeof candidate?.group === 'string' && typeof candidate?.question === 'string';
     }) &&
    Array.isArray(context.adviserConsultations) &&
    context.adviserConsultations.length <= 16 &&
     context.adviserConsultations.every((item: unknown) => {
       const candidate = item as Record<string, unknown>;
       return typeof candidate?.agent === 'string' && typeof candidate?.group === 'string' &&
         typeof candidate?.question === 'string' && typeof candidate?.insight === 'string';
     }) &&
    typeof context.consumedBudget === 'object' && context.consumedBudget !== null &&
    Number.isInteger(context.consumedBudget.adviserConsultationsUsed) &&
    Number.isInteger(context.consumedBudget.trackWriterRoundsUsed) &&
    Number.isInteger(context.consumedBudget.refinementRoundsUsed) &&
    Number.isInteger(context.consumedBudget.operationRepairAttemptsUsed) &&
    typeof context.checkpointId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.checkpointId) &&
    Array.isArray(context.offeredTrackProposals) &&
    context.offeredTrackProposals.length <= 32 &&
    context.offeredTrackProposals.every(isTrackProposal) &&
    Array.isArray(context.declinedTrackProposals) &&
    context.declinedTrackProposals.length <= 32 &&
    context.declinedTrackProposals.every(isTrackProposal) &&
    Array.isArray(context.accumulatedApprovedTrackProposals) &&
    context.accumulatedApprovedTrackProposals.length <= 32 &&
    context.accumulatedApprovedTrackProposals.every(isTrackProposal) &&
    typeof context.signature === 'string' &&
    /^[a-f0-9]{64}$/.test(context.signature);
}

function isTrackProposal(value: unknown): value is TrackProposal {
  if (typeof value !== 'object' || value === null) return false;
  const proposal = value as TrackProposal;
  return typeof proposal.id === 'string' &&
    (proposal.action === 'add' || proposal.action === 'delete') &&
    typeof proposal.instrument === 'string' &&
    typeof proposal.role === 'string' &&
    Number.isInteger(proposal.midiProgram) &&
    typeof proposal.summary === 'string' &&
    typeof proposal.reason === 'string';
}

function isStyleSuggestion(value: unknown): value is StyleSuggestion {
  if (typeof value !== 'object' || value === null) return false;
  const suggestion = value as StyleSuggestion;
  return typeof suggestion.id === 'string' && suggestion.id.length >= 1 && suggestion.id.length <= STYLE_SUGGESTION_ID_MAX_LENGTH &&
    typeof suggestion.name === 'string' && suggestion.name.length >= 1 && suggestion.name.length <= STYLE_SUGGESTION_NAME_MAX_LENGTH &&
    typeof suggestion.description === 'string' && suggestion.description.length >= 1 && suggestion.description.length <= STYLE_SUGGESTION_DESCRIPTION_MAX_LENGTH &&
    typeof suggestion.agent === 'string' && suggestion.agent.length >= 1 && suggestion.agent.length <= STYLE_SUGGESTION_AGENT_MAX_LENGTH;
}

function isSelectedStyle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SELECTED_STYLE_MAX_LENGTH;
}

function normalizeOnboarding(value: unknown, fallback: WorkspaceOnboarding): WorkspaceOnboarding {
  if (typeof value !== 'object' || value === null) return fallback;
  const onboarding = value as Partial<WorkspaceOnboarding>;
  const phases: WorkspaceOnboardingPhase[] = ['style-needed', 'style-review', 'instrument-review', 'ready'];
  return {
    phase: phases.includes(onboarding.phase as WorkspaceOnboardingPhase)
      ? onboarding.phase as WorkspaceOnboardingPhase
      : fallback.phase,
    selectedStyle: isSelectedStyle(onboarding.selectedStyle) ? onboarding.selectedStyle : undefined,
    originatingMidi: Array.isArray(onboarding.originatingMidi)
      ? onboarding.originatingMidi.filter(isMidiSnippet)
      : fallback.originatingMidi,
  };
}

function normalizePendingProposals(value: unknown): PendingWorkflowProposal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PendingWorkflowProposal[] => {
    if (typeof item !== 'object' || item === null) return [];
    const proposal = item as PendingWorkflowProposal;
    const valid = typeof proposal.id === 'string' &&
      (proposal.kind === 'style' || proposal.kind === 'instruments' || proposal.kind === 'tracks') &&
       (proposal.status === 'pending' || proposal.status === 'approved' || proposal.status === 'rejected' || proposal.status === 'failed') &&
      typeof proposal.sourceMessageId === 'string' &&
      typeof proposal.sourceText === 'string' &&
      Array.isArray(proposal.originatingMidi) &&
      proposal.originatingMidi.every(isMidiSnippet) &&
       // Snapshots made before the approval-resume contract did not have
       // history/context. Keep them recoverable, but only new proposals can
       // resume a bounded adviser run.
       (proposal.originatingHistory === undefined ||
         (Array.isArray(proposal.originatingHistory) &&
           proposal.originatingHistory.length <= 12 &&
           proposal.originatingHistory.every(isConversationMessage))) &&
      (proposal.selectedStyle === undefined || isSelectedStyle(proposal.selectedStyle)) &&
      (!proposal.styleSuggestions || proposal.styleSuggestions.every(isStyleSuggestion)) &&
       (!proposal.trackProposals || proposal.trackProposals.every(isTrackProposal)) &&
       (proposal.approvalContext === undefined || isApprovalContext(proposal.approvalContext));
    return valid ? [{
      ...proposal,
      originatingHistory: proposal.originatingHistory ?? [],
    }] : [];
  });
}

function normalizeSavedMessage(message: LocalMessage): LocalMessage {
  return message.retry?.selectedStyle !== undefined && !isSelectedStyle(message.retry.selectedStyle)
    ? { ...message, retry: { ...message.retry, selectedStyle: undefined } }
    : message;
}

export function parseStoredProject(raw: string | null, fallback: StoredProject): StoredProject {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredProject>;
    const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).filter((item): item is LocalMessage =>
      typeof item === 'object' && item !== null &&
      typeof (item as LocalMessage).id === 'string' &&
      ((item as LocalMessage).role === 'user' || (item as LocalMessage).role === 'assistant') &&
      typeof (item as LocalMessage).content === 'string').map(normalizeSavedMessage);
    const undoStack = (Array.isArray(parsed.undoStack) ? parsed.undoStack : [])
      .filter((score): score is Score =>
        typeof score === 'object' &&
        score !== null &&
        Array.isArray((score as Score).tracks));
    const parsedScore = parsed.score?.tracks
      ? normalizeSavedScore(parsed.score)
      : fallback.score;
    const fallbackOnboarding = parsed.onboarding ?? (
      parsedScore.tracks.length > 0
        ? { phase: 'ready' as const, originatingMidi: [] }
        : fallback.onboarding
    );
    return {
      score: parsedScore,
      scoreRevision: Number.isInteger(parsed.scoreRevision) ? parsed.scoreRevision! : fallback.scoreRevision,
      messages: messages.length ? protectPersistedUnverifiedOperations(messages) : fallback.messages,
      undoStack,
      onboarding: normalizeOnboarding(fallbackOnboarding, fallback.onboarding),
      pendingProposals: normalizePendingProposals(parsed.pendingProposals),
      terminalAudits: normalizeTerminalAudits(parsed.terminalAudits ?? fallback.terminalAudits),
    };
  } catch {
    return fallback;
  }
}

export function exportWorkspaceSnapshot(project: StoredProject): WorkspaceSnapshot {
  return {
    version: 3,
    score: project.score,
    scoreRevision: project.scoreRevision,
    messages: project.messages,
    undoStack: project.undoStack,
    onboarding: project.onboarding,
    pendingProposals: project.pendingProposals,
    terminalAudits: normalizeTerminalAudits(project.terminalAudits),
  };
}

export function importWorkspaceSnapshot(
  snapshot: unknown,
  fallback: StoredProject,
): StoredProject {
  if (typeof snapshot !== 'object' || snapshot === null) return fallback;
  return parseStoredProject(JSON.stringify(snapshot), fallback);
}
