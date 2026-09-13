import { useState, useCallback, useEffect, useRef } from 'react';
import {
  CompositionRequest,
  CompositionResponse,
  CompositionStreamEvent,
  CompositionApprovalContext,
  ConversationMessage,
  AgentConsultation,
  EditWorkflow,
  EditWorkflowEvent,
  EditWorkflowEventObservedType,
  MidiSnippet,
  Score,
  ScoreOperation,
  StyleSuggestion,
  TrackProposal,
  streamCompositionProgress,
} from '@workspace/api-client-react';
import {
  buildCompositionRequest,
  evaluateOperationApplication,
  isVerifiedEditWorkflow,
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
  parseStoredProject,
  replaceTrackInstrument,
  restorePreviousScore,
  isTerminalWorkflowProgress,
  matchesWorkflowAgent,
  setOperationStatus,
  buildApprovedCompositionContinuation,
  dedupeWorkflowEvents,
   freshPlanRetryFromApprovalContext,
  hideWorkflowRoutingEvents,
  mergeTerminalAudits,
  normalizeTerminalAudits,
  type TerminalAudit,
  type PendingWorkflowProposal,
  type StoredProject,
  type WorkspaceOnboarding,
  type WorkspaceSnapshot,
} from '@/lib/workspace-state';
import { findInstrument } from '@/lib/instrument-catalog';
import { workspaceStorageKeys } from '@/lib/project-manager';

export type AgentGroup = 'instrument' | 'style' | 'concept';

export type AgentState = {
  id: string;
  name: string;
  group: AgentGroup;
  status: 'idle' | 'active';
  insight?: string;
};

export type AudioAttachment = {
  id: string;
  durationMs: number;
  derivedMidi?: MidiSnippet;
  analysisDescription: string;
};

export type LocalMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  snippets?: MidiSnippet[];
  audioAttachments?: AudioAttachment[];
  consultations?: AgentConsultation[];
  operations?: ScoreOperation[];
  operationStatus?: 'pending' | 'applied' | 'rejected' | 'conflicted' | 'blocked';
  baseScoreRevision?: number;
  editWorkflow?: EditWorkflow;
  workflow?: 'style-intake' | 'instrument-approval' | 'composition';
  styleSuggestions?: StyleSuggestion[];
  trackProposals?: TrackProposal[];
  workflowProposalId?: string;
  terminalAudit?: TerminalAudit;
  retry?: {
    message: string;
    snippets: MidiSnippet[];
    selectedStyle?: string;
    phase?: CompositionRequest['phase'];
    approvedTrackProposalIds?: string[];
    approvedTrackProposals?: TrackProposal[];
    suppressUserMessage?: boolean;
    approvalContext?: CompositionApprovalContext;
    history?: ConversationMessage[];
    approvalProposalId?: string;
    /** A consumed approval capability must never be retried; this starts a new plan with its signed original source. */
    freshPlan?: boolean;
  };
};

export type Track = Score['tracks'][number];

type CompositionTerminalErrorPayload = {
  type: 'error';
  error: string;
  diagnostics?: unknown;
};

class CompositionTerminalError extends Error {
  readonly diagnostics?: unknown;

  constructor(message: string, diagnostics?: unknown) {
    super(message);
    this.name = 'CompositionTerminalError';
    this.diagnostics = diagnostics;
  }
}

const INITIAL_SCORE: Score = {
  tempo: 96,
  durationBeats: 64,
  tracks: [],
};

const STYLE_AGENTS: AgentState[] = [
  ['classical', 'Classical & Romantic'],
  ['modernist', 'Modernist & Avant-Garde'],
  ['jazz', 'Jazz & Big Band'],
  ['electronic', 'Electronic & Hybrid'],
  ['folk', 'Folk & World Traditions'],
  ['minimalism', 'Minimalism & Ambient'],
  ['cinematic', 'Contemporary Cinematic'],
].map(([id, name]) => ({ id, name, group: 'style', status: 'idle' as const }));

const CONCEPT_AGENTS: AgentState[] = [
  ['arc', 'Dramatic Arc'],
  ['theme', 'Theme & Leitmotif'],
  ['harmony', 'Harmony & Voice Leading'],
  ['rhythm', 'Rhythm & Kinetics'],
  ['texture', 'Texture & Register'],
  ['continuity', 'Continuity & Transitions'],
  ['pacing', 'Sync & Pacing'],
].map(([id, name]) => ({ id, name, group: 'concept', status: 'idle' as const }));

function agentsForScore(score: Score): AgentState[] {
  return [
    ...score.tracks.flatMap((track) => {
      const playable = findInstrument(track.instrument);
      return playable ? [{
        id: `track-agent-${track.id}`,
        name: playable.name,
        group: 'instrument' as const,
        status: 'idle' as const,
      }] : [];
    }),
    ...STYLE_AGENTS,
    ...CONCEPT_AGENTS,
  ];
}

const INITIAL_MESSAGE: LocalMessage = {
  id: 'init',
  role: 'assistant',
  content: 'Start with a melody, MIDI idea, or musical direction. I will ask a style specialist first, then show you instrument proposals before creating any tracks.',
};

function withWorkflowAudit(workflow: EditWorkflow | undefined, progress: EditWorkflowEvent[]): EditWorkflow | undefined {
  if (!workflow && progress.length === 0) return undefined;
  const baseWorkflow: EditWorkflow = workflow ?? {
    intent: 'edit',
    status: 'discussion',
    summary: 'The edit workflow returned no verified metadata. No score material was changed.',
    tasks: [],
    events: [],
    changedFiles: [],
  };
  // Keep the complete audit. The stream and final response commonly contain
  // the same event, so only exact duplicates are collapsed; distinct
  // attempt-1/attempt-2 diagnostics must never be truncated or coalesced.
  const events = hideWorkflowRoutingEvents(
    dedupeWorkflowEvents([...progress, ...baseWorkflow.events]),
  );
  return { ...baseWorkflow, tasks: baseWorkflow.tasks.slice(0, 5), events };
}

const OPERATION_FORMAT_STAGES = new Set([
  'operation-format-error',
  'operation-format-repair',
  'operation-format-recovered',
  'operation-format-exhausted',
  'operation-truncation-error',
  'operation-truncation-exhausted',
]);
const PROVIDER_TIMEOUT_STAGES = new Set([
  'operation-timeout-error',
  'operation-timeout-exhausted',
]);
const WORKFLOW_DIAGNOSTIC_STAGES = new Set([
  ...OPERATION_FORMAT_STAGES,
  ...PROVIDER_TIMEOUT_STAGES,
]);
const OBSERVED_DIAGNOSTIC_TYPES: ReadonlySet<EditWorkflowEventObservedType> = new Set([
  'string', 'number', 'boolean', 'object', 'array', 'null', 'unknown',
]);

function workflowDiagnosticFields(value: Record<string, unknown>): Pick<
  EditWorkflowEvent,
  'reason' | 'attempt' | 'index' | 'code' | 'fields' | 'targetId' | 'duplicateId' |
  'observedType' | 'observedLength' | 'maxLength' | 'outcome'
> {
  const observedType = typeof value.observedType === 'string' &&
    OBSERVED_DIAGNOSTIC_TYPES.has(value.observedType as EditWorkflowEventObservedType)
    ? value.observedType as EditWorkflowEventObservedType
    : undefined;
  return {
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.attempt === 'string' ? { attempt: value.attempt } : {}),
    ...(typeof value.index === 'number' ? { index: value.index } : {}),
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(Array.isArray(value.fields)
      ? { fields: value.fields.filter((field): field is string => typeof field === 'string') }
      : {}),
    ...(typeof value.targetId === 'string' ? { targetId: value.targetId } : {}),
    ...(typeof value.duplicateId === 'string' ? { duplicateId: value.duplicateId } : {}),
    ...(observedType ? { observedType } : {}),
    ...(typeof value.observedLength === 'number' && Number.isInteger(value.observedLength) &&
      value.observedLength >= 0 && value.observedLength <= 241
      ? { observedLength: value.observedLength } : {}),
    ...(value.maxLength === 240 ? { maxLength: 240 } : {}),
    ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
  };
}

function workflowEventFromStream(event: CompositionStreamEvent): EditWorkflowEvent | undefined {
  if (event.type === 'workflow-progress') {
    return {
      stage: event.stage,
      message: event.message,
      ...(event.agent ? { agent: event.agent } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.files ? { files: event.files } : {}),
      ...workflowDiagnosticFields(event as unknown as Record<string, unknown>),
    };
  }

  // Keep the client forward-compatible with bounded format diagnostics from
  // both current workflow-progress events and older/manual fixtures that may
  // put the stage directly in the event type.
  const candidate = event as unknown as Record<string, unknown>;
  const directStage = typeof candidate.stage === 'string'
    ? candidate.stage
    : typeof candidate.type === 'string' && WORKFLOW_DIAGNOSTIC_STAGES.has(candidate.type)
      ? candidate.type
      : undefined;
  if (!directStage || !WORKFLOW_DIAGNOSTIC_STAGES.has(directStage) || typeof candidate.message !== 'string') {
    return undefined;
  }
  return {
    stage: directStage,
    message: candidate.message,
    ...(typeof candidate.agent === 'string' ? { agent: candidate.agent } : {}),
    ...(typeof candidate.taskId === 'string' ? { taskId: candidate.taskId } : {}),
    ...(Array.isArray(candidate.files) ? { files: candidate.files.filter((file): file is string => typeof file === 'string') } : {}),
    ...workflowDiagnosticFields(candidate),
  };
}

function terminalAuditFromDiagnostics(value: unknown): TerminalAudit | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const nested = candidate.terminalAudit ?? candidate.audit ?? value;
  return normalizeTerminalAudits([nested])[0];
}

function terminalAuditEvent(audit: TerminalAudit): EditWorkflowEvent {
  return {
    stage: 'evaluation-failed',
    message: audit.reason,
    agent: 'Evaluator',
    reason: audit.reason,
    ...(audit.affectedScope.length > 0 ? { files: audit.affectedScope } : {}),
    code: audit.evaluatorCategory,
    outcome: audit.correctionOutcome,
  };
}

function hasOperationFormatFailure(workflow: EditWorkflow | undefined): boolean {
  return workflow?.events.some((event) =>
    event.stage === 'operation-format-exhausted' || event.stage === 'operation-truncation-exhausted',
  ) ?? false;
}

function hasProviderTimeoutFailure(workflow: EditWorkflow | undefined): boolean {
  return workflow?.events.some((event) => event.stage === 'operation-timeout-exhausted') ?? false;
}

function hasWorkflowFailure(workflow: EditWorkflow | undefined): boolean {
  return hasOperationFormatFailure(workflow) || hasProviderTimeoutFailure(workflow);
}

function hasOperationFormatRetry(workflow: EditWorkflow | undefined): boolean {
  if (!workflow) return false;
  if (workflow.events.some((event) => event.stage === 'operation-format-recovered')) return false;
  return workflow.events.some((event) =>
    event.stage === 'operation-format-error' ||
    event.stage === 'operation-format-exhausted' ||
    event.stage === 'operation-truncation-error' ||
    event.stage === 'operation-truncation-exhausted' ||
    event.stage === 'operation-timeout-error' ||
    event.stage === 'operation-timeout-exhausted',
  );
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function workflowFailureAudit(
  error: unknown,
  progress: EditWorkflowEvent[],
  terminalAudit?: TerminalAudit,
): EditWorkflow {
  const message = failureMessage(error, 'The scoring workflow could not complete. Please try again.');
  const events = hideWorkflowRoutingEvents(dedupeWorkflowEvents([
    ...progress,
    ...(terminalAudit ? [terminalAuditEvent(terminalAudit)] : []),
  ]));
  if (
    events.length === 0 ||
    (events[events.length - 1]?.stage !== 'operation-format-exhausted' &&
      events[events.length - 1]?.stage !== 'operation-truncation-exhausted' &&
      events[events.length - 1]?.stage !== 'operation-timeout-exhausted' &&
      events[events.length - 1]?.stage !== 'evaluation-failed')
  ) {
    events.push({
      stage: 'workflow-error',
      message,
      agent: 'Orchestrator',
    });
  }
  return {
    intent: 'edit',
    status: 'discussion',
    summary: message,
    tasks: [],
    events,
    changedFiles: [],
  };
}

async function composeWithProgress(
  request: CompositionRequest,
  onEvent: (event: CompositionStreamEvent) => void,
): Promise<CompositionResponse> {
  const response = await streamCompositionProgress(request, {
    responseType: 'stream',
    headers: {
      Accept: 'application/x-ndjson',
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Composition request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: CompositionResponse | undefined;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as CompositionStreamEvent | CompositionTerminalErrorPayload;
    onEvent(event);
    if (event.type === 'result') result = event.result;
    if (event.type === 'error') {
      throw new CompositionTerminalError(
        event.error,
        (event as CompositionTerminalErrorPayload).diagnostics,
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  consumeLine(buffer);
  if (!result) throw new Error('Composition stream ended without a result');
  return result;
}

function loadStoredProject(userId?: string | null): StoredProject {
  try {
    const keys = workspaceStorageKeys(userId);
    const stored = window.localStorage.getItem(keys.document);
    const extrasRaw = window.localStorage.getItem(keys.extras);
    let storedWithExtras = stored;
    if (stored && extrasRaw) {
      try {
        const core = JSON.parse(stored) as Record<string, unknown>;
        const extras = JSON.parse(extrasRaw) as Record<string, unknown>;
        storedWithExtras = JSON.stringify({
          ...core,
          onboarding: core.onboarding ?? extras.onboarding,
          pendingProposals: core.pendingProposals ?? extras.pendingProposals,
          terminalAudits: core.terminalAudits ?? extras.terminalAudits,
        });
      } catch {
        // Preserve the valid core document if optional extras were corrupted.
      }
    }
    const project = parseStoredProject(storedWithExtras, {
      score: INITIAL_SCORE,
      scoreRevision: 0,
      messages: [INITIAL_MESSAGE],
      undoStack: [],
      onboarding: {
        phase: 'style-needed',
        originatingMidi: [],
      },
      pendingProposals: [],
      terminalAudits: [],
    });
    return {
      ...project,
      onboarding: project.score.tracks.length > 0 && project.onboarding.phase === 'style-needed'
        ? { ...project.onboarding, phase: 'ready' as const }
        : project.onboarding,
      messages: project.messages.map(message => message.id === INITIAL_MESSAGE.id
        ? INITIAL_MESSAGE
        : message),
    };
  } catch {
    return {
      score: INITIAL_SCORE,
      scoreRevision: 0,
      messages: [INITIAL_MESSAGE],
      undoStack: [],
      onboarding: { phase: 'style-needed', originatingMidi: [] },
      pendingProposals: [],
      terminalAudits: [],
    };
  }
}

export function useWorkspace(userId?: string | null, projectId?: string | null) {
  const initialProject = useRef(loadStoredProject(userId)).current;
  const [score, setScore] = useState<Score>(initialProject.score);
  const [scoreRevision, setScoreRevision] = useState(initialProject.scoreRevision);
  const [agents, setAgents] = useState<AgentState[]>(agentsForScore(initialProject.score));
  const [messages, setMessages] = useState<LocalMessage[]>(initialProject.messages);
  const [onboarding, setOnboarding] = useState<WorkspaceOnboarding>(initialProject.onboarding);
  const [pendingProposals, setPendingProposals] = useState<PendingWorkflowProposal[]>(initialProject.pendingProposals);
  const [terminalAudits, setTerminalAudits] = useState<TerminalAudit[]>(
    normalizeTerminalAudits(initialProject.terminalAudits),
  );
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [workflowProgress, setWorkflowProgress] = useState<EditWorkflowEvent[]>([]);
  const undoStackRef = useRef<Score[]>(initialProject.undoStack);
  const composingRef = useRef(false);
  const requestIdRef = useRef(0);
  const scoreRevisionRef = useRef(initialProject.scoreRevision);
  const scoreRef = useRef(initialProject.score);
  const onboardingRef = useRef(initialProject.onboarding);
  const pendingProposalsRef = useRef(initialProject.pendingProposals);
  const terminalAuditsRef = useRef<TerminalAudit[]>(
    normalizeTerminalAudits(initialProject.terminalAudits),
  );
  const messagesRef = useRef(initialProject.messages);
  const workflowProgressRef = useRef<EditWorkflowEvent[]>([]);
  const approvedContinuationsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    onboardingRef.current = onboarding;
  }, [onboarding]);

  useEffect(() => {
    pendingProposalsRef.current = pendingProposals;
  }, [pendingProposals]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    setAgents((current) => agentsForScore(score).map((agent) => {
      const previous = current.find((item) => item.id === agent.id);
      return previous ? { ...agent, status: previous.status, insight: previous.insight } : agent;
    }));
  }, [score]);

  useEffect(() => {
    const keys = workspaceStorageKeys(userId);
    try {
      window.localStorage.setItem(keys.document, JSON.stringify({
        score,
        scoreRevision,
        messages,
        undoStack: undoStackRef.current,
        onboarding,
        pendingProposals,
        terminalAudits,
      }));
    } catch (error) {
      console.warn('Could not persist the Film Score Studio conversation', error);
    }
  }, [messages, onboarding, pendingProposals, score, scoreRevision, terminalAudits, userId]);

  const appendTerminalAudit = useCallback((audit: TerminalAudit) => {
    const next = mergeTerminalAudits(terminalAuditsRef.current, [audit]);
    terminalAuditsRef.current = next;
    setTerminalAudits(next);
  }, []);

  const applyOperations = useCallback((messageId: string) => {
    const messageIndex = messages.findIndex(item => item.id === messageId);
    const message = messages[messageIndex];
    if (!message?.operations?.length || message.operationStatus !== 'pending') return;
    const application = evaluateOperationApplication({
      score: scoreRef.current,
      currentRevision: scoreRevisionRef.current,
      baseRevision: message.baseScoreRevision ?? scoreRevisionRef.current,
      operations: message.operations,
      editWorkflow: message.editWorkflow,
    });
    if (application.status !== 'applied' || !application.score) {
      const source = messages.slice(0, messageIndex).reverse().find((item) => item.role === 'user');
      setMessages(current => current.map(item => item.id === messageId ? {
        ...item,
        operationStatus: application.status,
        retry: application.status === 'blocked' && !item.editWorkflow
          ? item.retry ?? (source ? {
            message: source.content,
            snippets: source.snippets ?? [],
            phase: 'composition',
          } : undefined)
          : item.retry,
      } : item));
      return;
    }
    undoStackRef.current.push(scoreRef.current);
    const nextRevision = scoreRevisionRef.current + 1;
    scoreRevisionRef.current = nextRevision;
    scoreRef.current = application.score;
    setScore(application.score);
    setScoreRevision(nextRevision);
    setMessages(current => current.map(item => {
      if (item.id === messageId) return { ...item, operationStatus: 'applied' };
      return item.operationStatus === 'pending' ? { ...item, operationStatus: 'conflicted' } : item;
    }));
  }, [messages]);

  const rejectOperations = useCallback((messageId: string) => {
    setMessages(current => setOperationStatus(current, messageId, 'rejected'));
  }, []);

  const addTrack = useCallback((track: Track) => {
    if (!track.id || !track.instrument || scoreRef.current.tracks.some((item) => item.id === track.id)) {
      return false;
    }
    const nextScore = { ...scoreRef.current, tracks: [...scoreRef.current.tracks, { ...track, regions: [...track.regions] }] };
    undoStackRef.current.push(scoreRef.current);
    scoreRef.current = nextScore;
    setScore(nextScore);
    const nextRevision = scoreRevisionRef.current + 1;
    scoreRevisionRef.current = nextRevision;
    setScoreRevision(nextRevision);
    return true;
  }, []);

  const deleteTrack = useCallback((trackId: string) => {
    if (!scoreRef.current.tracks.some((track) => track.id === trackId)) return false;
    const nextScore = {
      ...scoreRef.current,
      tracks: scoreRef.current.tracks.filter((track) => track.id !== trackId),
    };
    undoStackRef.current.push(scoreRef.current);
    scoreRef.current = nextScore;
    setScore(nextScore);
    const nextRevision = scoreRevisionRef.current + 1;
    scoreRevisionRef.current = nextRevision;
    setScoreRevision(nextRevision);
    return true;
  }, []);

  const replaceTrack = useCallback((trackId: string, instrumentId: string) => {
    const nextScore = replaceTrackInstrument(scoreRef.current, trackId, instrumentId);
    if (!nextScore) return false;
    undoStackRef.current.push(scoreRef.current);
    scoreRef.current = nextScore;
    setScore(nextScore);
    const nextRevision = scoreRevisionRef.current + 1;
    scoreRevisionRef.current = nextRevision;
    setScoreRevision(nextRevision);
    return true;
  }, []);

  const setPendingProposalStatus = useCallback((proposalId: string, status: PendingWorkflowProposal['status']) => {
    setPendingProposals((current) => {
      const next = current.map((proposal) =>
        proposal.id === proposalId ? { ...proposal, status } : proposal,
      );
      // Keep the synchronous ref in lockstep with the state update. Approval
      // controls can fire twice before React commits the next render.
      pendingProposalsRef.current = next;
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    const previous = restorePreviousScore(undoStackRef.current.pop());
    if (previous) {
      const nextRevision = scoreRevisionRef.current + 1;
      scoreRevisionRef.current = nextRevision;
      scoreRef.current = previous;
      setScore(previous);
      setScoreRevision(nextRevision);
      setMessages(current => current.map(item => item.operationStatus === 'pending' ? { ...item, operationStatus: 'conflicted' } : item));
    }
  }, []);

  const sendMessage = useCallback(async (
    text: string,
    snippets: MidiSnippet[],
    audioAttachments: AudioAttachment[] = [],
    selectedStyle?: string,
    phaseOverride?: CompositionRequest['phase'],
    approvedTrackProposalIds?: string[],
    approvedTrackProposals?: TrackProposal[],
    options: {
      suppressUserMessage?: boolean;
      approvalContext?: CompositionApprovalContext;
      history?: ConversationMessage[];
      approvalProposalId?: string;
    } = {},
  ) => {
    if ((!text.trim() && snippets.length === 0 && audioAttachments.length === 0) || composingRef.current) return;

    composingRef.current = true;
    const requestId = ++requestIdRef.current;
    const baseScoreRevision = scoreRevisionRef.current;
    const currentScore = scoreRef.current;
    const userMsg: LocalMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: text,
        snippets: snippets.length > 0 ? [...snippets] : undefined,
        audioAttachments: audioAttachments.length > 0 ? [...audioAttachments] : undefined,
    };
    if (!options.suppressUserMessage) {
      setMessages(prev => [...prev, userMsg]);
    }
    setIsComposing(true);
    workflowProgressRef.current = [];
    setWorkflowProgress([]);
    setAgents(prev => prev.map(a => ({ ...a, status: 'idle', insight: undefined })));

    const derivedSnippets = audioAttachments.map(a => a.derivedMidi).filter(Boolean) as MidiSnippet[];
    const combinedSnippets = [...snippets, ...derivedSnippets];
    const audioContextText = audioAttachments.length > 0
      ? '\n\n' + audioAttachments.map(a => `[Audio Input Analysis: ${a.analysisDescription}]`).join('\n')
      : '';
    const sourceText = text + audioContextText;
    const combinedMessages: ConversationMessage[] = [...messagesRef.current, ...(options.suppressUserMessage ? [] : [userMsg])]
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-12);
    const requestHistory = options.history ?? combinedMessages;
    const isStyleFirst = onboardingRef.current.phase === 'style-needed' && currentScore.tracks.length === 0;
    const requestPhase = phaseOverride ?? (isStyleFirst ? 'style-intake' : 'composition');

    const request = buildCompositionRequest({
      message: sourceText,
      phase: requestPhase,
      projectId: projectId ?? undefined,
      selectedStyle,
      approvedTrackProposalIds,
      approvedTrackProposals,
      approvalContext: options.approvalContext,
      midiSnippets: combinedSnippets,
      history: requestHistory,
      score: currentScore,
    });

    try {
        const res = await composeWithProgress(request, (event) => {
          if (requestIdRef.current !== requestId) return;
          if (event.type === 'specialists-selected') {
            setAgents(prev => prev.map(agent => ({
              ...agent,
              status: 'idle',
              insight: undefined,
            })));
          } else if (event.type === 'specialist-started') {
            setAgents(prev => prev.map(agent => ({
              ...agent,
              status: matchesWorkflowAgent(agent.id, agent.name, event.agent) ? 'active' : agent.status,
            })));
          } else if (event.type === 'specialist-completed') {
            setAgents(prev => prev.map(agent => ({
              ...agent,
              status: matchesWorkflowAgent(agent.id, agent.name, event.agent) ? 'idle' : agent.status,
            })));
           } else {
             const progressEvent = workflowEventFromStream(event);
             if (!progressEvent) return;
             workflowProgressRef.current = [...workflowProgressRef.current, progressEvent];
              setWorkflowProgress(hideWorkflowRoutingEvents(workflowProgressRef.current));
             if (progressEvent.agent) {
               const workflowAgent = progressEvent.agent;
               const terminal = isTerminalWorkflowProgress(progressEvent.stage, progressEvent.message);
              setAgents(prev => prev.map(agent => ({
                ...agent,
                status: matchesWorkflowAgent(agent.id, agent.name, workflowAgent)
                  ? (terminal ? 'idle' : 'active')
                  : agent.status,
              })));
            }
          }
        });
             const editWorkflow = withWorkflowAudit(res.editWorkflow, workflowProgressRef.current);
             let operationStatus: LocalMessage['operationStatus'];
              const verifiedTrackMembership = isVerifiedEditWorkflow(editWorkflow)
                ? res.trackProposals
               : [];
              if (res.operations.length > 0 || verifiedTrackMembership.length > 0) {
               const application = evaluateOperationApplication({
                 score: scoreRef.current,
                 currentRevision: scoreRevisionRef.current,
                 baseRevision: baseScoreRevision,
                 operations: res.operations,
                   trackProposals: verifiedTrackMembership,
                 editWorkflow,
               });
               operationStatus = application.status;
               if (application.status === 'applied' && application.score) {
                    undoStackRef.current.push(scoreRef.current);
                  const nextRevision = scoreRevisionRef.current + 1;
                  scoreRevisionRef.current = nextRevision;
                    scoreRef.current = application.score;
                   setScore(application.score);
                  setScoreRevision(nextRevision);
              }
              } else if (hasWorkflowFailure(editWorkflow)) {
               operationStatus = 'blocked';
            }
             const workflowProposalId = `workflow-${Date.now()}`;
             const hasStyleGate = res.workflow === 'style-intake' && res.styleSuggestions.length > 0;
             // A continuation includes the membership ids just approved by the
             // composer. Do not present those same gates again if a backend
             // echoes them while producing the verified score edit.
             const trackProposals = isVerifiedEditWorkflow(editWorkflow)
               ? res.trackProposals
               : approvedTrackProposalIds
               ? res.trackProposals.filter((proposal) => !approvedTrackProposalIds.includes(proposal.id))
               : res.trackProposals;
             const hasTrackProposals = !isVerifiedEditWorkflow(editWorkflow) && trackProposals.length > 0;
             const asstMsg: LocalMessage = {
                id: Date.now().toString(),
                role: 'assistant',
                content: res.response,
                consultations: res.consultations,
                operations: res.operations,
                operationStatus,
                baseScoreRevision,
                editWorkflow,
                  retry: (res.operations.length > 0 && !res.editWorkflow) || hasOperationFormatRetry(editWorkflow) ? {
                  message: sourceText,
                  snippets: combinedSnippets,
                  selectedStyle,
                  phase: requestPhase,
                  approvedTrackProposalIds,
                   approvedTrackProposals,
                   suppressUserMessage: options.suppressUserMessage,
                    approvalContext: options.approvalContext,
                    history: requestHistory,
                    approvalProposalId: options.approvalProposalId,
                } : undefined,
                 workflow: res.workflow,
                 styleSuggestions: res.styleSuggestions,
                 trackProposals,
                 workflowProposalId: hasStyleGate || hasTrackProposals ? workflowProposalId : undefined,
            };
             if (hasStyleGate || hasTrackProposals) {
               const workflowProposal: PendingWorkflowProposal = {
                 id: workflowProposalId,
                  kind: hasStyleGate
                    ? 'style'
                    : requestPhase === 'instrument-approval'
                      ? 'instruments'
                      : 'tracks',
                 status: 'pending',
                 sourceMessageId: userMsg.id,
                 sourceText,
                 originatingMidi: combinedSnippets,
                  originatingHistory: requestHistory,
                  selectedStyle: request.selectedStyle,
                 styleSuggestions: res.styleSuggestions,
                  trackProposals,
                   approvalContext: res.approvalContext,
               };
               setPendingProposals(current => [...current.filter(item => item.status !== 'pending'), workflowProposal]);
             }
             if (hasStyleGate) {
               setOnboarding({
                 phase: 'style-review',
                 originatingMidi: combinedSnippets,
               });
             } else if (res.workflow === 'composition') {
               setOnboarding(current => ({
                 ...current,
                 phase: 'ready',
                 originatingMidi: combinedSnippets.length ? combinedSnippets : current.originatingMidi,
               }));
             }
            setMessages(prev => [
              ...prev.map(item => operationStatus === 'applied' && item.operationStatus === 'pending'
                ? { ...item, operationStatus: 'conflicted' as const }
                : item),
              asstMsg,
            ]);
              if (options.approvalProposalId) setPendingProposalStatus(options.approvalProposalId, 'approved');
    } catch (error) {
               const terminalAudit = error instanceof CompositionTerminalError
                 ? terminalAuditFromDiagnostics(error.diagnostics)
                 : undefined;
               if (terminalAudit) appendTerminalAudit(terminalAudit);
              const editWorkflow = workflowFailureAudit(error, workflowProgressRef.current, terminalAudit);
               // Submission may have reached the server and atomically claimed
               // its capability before any later failure is returned. Never
               // retry an approval continuation with the old checkpoint.
               const approvalContinuationFailure = Boolean(options.approvalContext);
              const errorMsg: LocalMessage = {
                id: Date.now().toString(),
                role: 'assistant',
                content: error instanceof Error
                  ? error.message
                  : 'Network error communicating with the orchestrator. Please try again.',
                   operationStatus: terminalAudit || hasWorkflowFailure(editWorkflow) ? 'blocked' : undefined,
                 editWorkflow,
                  terminalAudit,
                  retry: approvalContinuationFailure
                    ? freshPlanRetryFromApprovalContext(options.approvalContext!)
                    : {
                  message: sourceText,
                  snippets: combinedSnippets,
                  selectedStyle,
                  phase: requestPhase,
                  approvedTrackProposalIds,
                   approvedTrackProposals,
                   suppressUserMessage: options.suppressUserMessage,
                    approvalContext: options.approvalContext,
                    history: requestHistory,
                    approvalProposalId: options.approvalProposalId,
                },
             };
             setMessages(prev => [...prev, errorMsg]);
              if (options.approvalProposalId) setPendingProposalStatus(options.approvalProposalId, 'failed');
    } finally {
      if (requestIdRef.current === requestId) {
        setAgents(prev => prev.map(a => ({ ...a, status: 'idle', insight: undefined })));
        setIsComposing(false);
        composingRef.current = false;
      }
    }
    }, [appendTerminalAudit, projectId]);

  const retryMessage = useCallback((message: LocalMessage) => {
    if (!message.retry || composingRef.current) return;
    setMessages((current) => current.map((item) =>
      item.id === message.id ? { ...item, retry: undefined } : item,
    ));
    void sendMessage(
      message.retry.message,
      message.retry.snippets,
      [],
      message.retry.selectedStyle,
      message.retry.phase,
       message.retry.freshPlan ? undefined : message.retry.approvedTrackProposalIds,
       message.retry.freshPlan ? undefined : message.retry.approvedTrackProposals,
       {
         suppressUserMessage: message.retry.suppressUserMessage,
          approvalContext: message.retry.freshPlan ? undefined : message.retry.approvalContext,
         history: message.retry.history,
          approvalProposalId: message.retry.freshPlan ? undefined : message.retry.approvalProposalId,
       },
    );
  }, [sendMessage]);

  const selectStyle = useCallback(async (proposalId: string, style: string) => {
    const proposal = pendingProposalsRef.current.find((item) => item.id === proposalId && item.kind === 'style');
    if (!proposal || !style.trim() || composingRef.current) return;
    composingRef.current = true;
    const requestId = ++requestIdRef.current;
    const baseScoreRevision = scoreRevisionRef.current;
    const selectionMessage: LocalMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: `Selected style: ${style}`,
      snippets: proposal.originatingMidi,
    };
    setMessages((current) => [...current, selectionMessage]);
    setOnboarding((current) => ({ ...current, phase: 'instrument-review', selectedStyle: style }));
    setPendingProposalStatus(proposalId, 'approved');
    setIsComposing(true);
    workflowProgressRef.current = [];
    setWorkflowProgress([]);
    setAgents((current) => current.map((agent) => ({ ...agent, status: 'idle', insight: undefined })));
    const requestHistory: ConversationMessage[] = [...messagesRef.current, selectionMessage]
      .map((message) => ({ role: message.role, content: message.content }))
      .slice(-12);
    try {
      const request = buildCompositionRequest({
        message: proposal.sourceText,
        phase: 'instrument-approval',
        projectId: projectId ?? undefined,
        selectedStyle: style,
        midiSnippets: proposal.originatingMidi,
         history: requestHistory,
        score: scoreRef.current,
      });
      const result = await composeWithProgress(request, (event) => {
        if (requestIdRef.current !== requestId) return;
        if (event.type === 'specialists-selected') {
          setAgents((current) => current.map((agent) => ({ ...agent, status: 'idle', insight: undefined })));
        } else if (event.type === 'specialist-started') {
          setAgents((current) => current.map((agent) => matchesWorkflowAgent(agent.id, agent.name, event.agent) ? { ...agent, status: 'active' } : agent));
        } else if (event.type === 'specialist-completed') {
          setAgents((current) => current.map((agent) => matchesWorkflowAgent(agent.id, agent.name, event.agent) ? { ...agent, status: 'idle' } : agent));
         } else {
           const progressEvent = workflowEventFromStream(event);
           if (!progressEvent) return;
           workflowProgressRef.current = [...workflowProgressRef.current, progressEvent];
            setWorkflowProgress(hideWorkflowRoutingEvents(workflowProgressRef.current));
           if (progressEvent.agent) {
             const workflowAgent = progressEvent.agent;
             const terminal = isTerminalWorkflowProgress(progressEvent.stage, progressEvent.message);
            setAgents((current) => current.map((agent) => matchesWorkflowAgent(agent.id, agent.name, workflowAgent)
              ? { ...agent, status: terminal ? 'idle' : 'active' }
              : agent));
          }
        }
      });
      const editWorkflow = withWorkflowAudit(result.editWorkflow, workflowProgressRef.current);
      let operationStatus: LocalMessage['operationStatus'];
        const verifiedTrackMembership = isVerifiedEditWorkflow(editWorkflow)
          ? result.trackProposals
         : [];
        if (result.operations.length > 0 || verifiedTrackMembership.length > 0) {
        const application = evaluateOperationApplication({
          score: scoreRef.current,
          currentRevision: scoreRevisionRef.current,
          baseRevision: baseScoreRevision,
          operations: result.operations,
            trackProposals: verifiedTrackMembership,
          editWorkflow,
        });
        operationStatus = application.status;
        if (application.status === 'applied' && application.score) {
          undoStackRef.current.push(scoreRef.current);
          scoreRef.current = application.score;
          setScore(application.score);
          const nextRevision = scoreRevisionRef.current + 1;
          scoreRevisionRef.current = nextRevision;
          setScoreRevision(nextRevision);
        }
        } else if (hasWorkflowFailure(editWorkflow)) {
         operationStatus = 'blocked';
      }
      const workflowProposalId = `workflow-${Date.now()}`;
      const workflowMessage: LocalMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: result.response,
        consultations: result.consultations,
        operations: result.operations,
        operationStatus,
        editWorkflow,
         retry: (result.operations.length > 0 && !result.editWorkflow) || hasOperationFormatRetry(editWorkflow) ? {
          message: proposal.sourceText,
          snippets: proposal.originatingMidi,
          selectedStyle: style,
          phase: 'instrument-approval',
          history: requestHistory,
        } : undefined,
        workflow: result.workflow,
        trackProposals: result.trackProposals,
        styleSuggestions: result.styleSuggestions,
        workflowProposalId,
        baseScoreRevision,
      };
      setMessages((current) => [...current, workflowMessage]);
      const workflowProposal: PendingWorkflowProposal = {
        id: workflowProposalId,
        kind: 'instruments',
        status: 'pending',
        sourceMessageId: proposal.sourceMessageId,
        sourceText: proposal.sourceText,
        originatingMidi: proposal.originatingMidi,
        originatingHistory: proposal.originatingHistory,
        selectedStyle: style,
        trackProposals: result.trackProposals,
         approvalContext: result.approvalContext,
      };
      setPendingProposals((current) => [...current, workflowProposal]);
    } catch (error) {
       const terminalAudit = error instanceof CompositionTerminalError
         ? terminalAuditFromDiagnostics(error.diagnostics)
         : undefined;
       if (terminalAudit) appendTerminalAudit(terminalAudit);
       const editWorkflow = workflowFailureAudit(error, workflowProgressRef.current, terminalAudit);
      setMessages((current) => [...current, {
        id: `${Date.now()}-error`,
        role: 'assistant',
        content: error instanceof Error ? error.message : 'The instrument review could not complete. Please try again.',
           operationStatus: terminalAudit || hasWorkflowFailure(editWorkflow) ? 'blocked' : undefined,
         editWorkflow,
          terminalAudit,
          retry: {
            message: proposal.sourceText,
            snippets: proposal.originatingMidi,
            selectedStyle: style,
            phase: 'instrument-approval',
           history: requestHistory,
          },
      }]);
    } finally {
      if (requestIdRef.current === requestId) {
        setAgents((current) => current.map((agent) => ({ ...agent, status: 'idle', insight: undefined })));
        setIsComposing(false);
        composingRef.current = false;
      }
    }
    }, [appendTerminalAudit, projectId, setPendingProposalStatus]);

  const approveTrackProposals = useCallback((proposalId: string, approvedIds: string[]) => {
    const pending = pendingProposalsRef.current.find((item) => item.id === proposalId);
    if (
      !pending ||
      pending.status !== 'pending' ||
      pending.kind === 'style' ||
      composingRef.current ||
      approvedContinuationsRef.current.has(proposalId)
    ) return;
    const proposals = pending.trackProposals ?? [];
    const proposalIds = new Set(proposals.map((proposal) => proposal.id));
    if (
      new Set(approvedIds).size !== approvedIds.length ||
      approvedIds.some((id) => !proposalIds.has(id)) ||
      new Set(proposals.map((proposal) => proposal.id)).size !== proposals.length
    ) {
      setMessages((current) => [...current, {
        id: `${Date.now()}-approval-error`,
        role: 'assistant',
        content: 'These instrument approvals are not part of the current proposal. No tracks were changed.',
      }]);
      return;
    }
    const approvedMembership = proposals.filter((proposal) => approvedIds.includes(proposal.id));
    // Approval only authorizes membership. No add/delete is made against the
    // live score here: the writer round receives the complete proposal set and
    // a verified staged candidate applies membership plus MIDI atomically.
    approvedContinuationsRef.current.add(proposalId);
    setPendingProposalStatus(proposalId, 'approved');
    setOnboarding((current) => ({ ...current, phase: 'ready' }));
    if (pending.kind === 'instruments' || pending.kind === 'tracks') {
      // The original message and every originating MIDI event are deliberately
      // sent again after explicit membership approval. The approved ids stop
      // this continuation from reopening the same membership gate; additions
      // are committed only when the verified result is applied atomically.
      const continuation = buildApprovedCompositionContinuation(pending.sourceText);
      const selectedStyle = pending.selectedStyle ?? onboardingRef.current.selectedStyle;
      // This is an internal continuation, not a new composer message. Keep
      // the original request in history and preserve the source MIDI/style,
      // but do not render a synthetic user bubble.
      void sendMessage(
        continuation,
        pending.originatingMidi,
        [],
        selectedStyle,
        'composition',
         approvedIds,
          approvedMembership,
        {
          suppressUserMessage: true,
          approvalContext: pending.approvalContext,
          history: pending.originatingHistory,
          approvalProposalId: proposalId,
        },
      );
    }
  }, [sendMessage, setPendingProposalStatus]);

  const rejectTrackProposals = useCallback((proposalId: string) => {
    const pending = pendingProposalsRef.current.find((item) => item.id === proposalId);
    if (!pending || pending.status !== 'pending') return;
    setPendingProposalStatus(proposalId, 'rejected');
    if (pending.kind === 'style') {
      setOnboarding((current) => ({ ...current, phase: 'style-needed' }));
    } else {
      setOnboarding((current) => ({ ...current, phase: 'ready' }));
    }
    setMessages((current) => [...current, {
      id: `${Date.now()}-approval-rejected`,
      role: 'assistant',
      content: 'Instrument membership proposal rejected. The saved score was left unchanged.',
      editWorkflow: {
        intent: 'discussion',
        status: 'discussion',
        summary: 'Instrument membership proposal rejected. The saved score was left unchanged.',
        tasks: [],
        events: [{
          stage: 'membership-rejected',
          message: 'Composer rejected the pending track additions or removals; no staged score was applied.',
          agent: 'Orchestrator',
        }],
        changedFiles: [],
      },
    }]);
  }, [setPendingProposalStatus]);

  const exportSnapshot = useCallback((): WorkspaceSnapshot => exportWorkspaceSnapshot({
    score: scoreRef.current,
    scoreRevision: scoreRevisionRef.current,
    messages,
    undoStack: undoStackRef.current,
    onboarding: onboardingRef.current,
    pendingProposals: pendingProposalsRef.current,
    terminalAudits: terminalAuditsRef.current,
  }), [messages]);

  const importSnapshot = useCallback((snapshot: unknown): boolean => {
    const imported = importWorkspaceSnapshot(snapshot, {
      score: INITIAL_SCORE,
      scoreRevision: 0,
      messages: [INITIAL_MESSAGE],
      undoStack: [],
      onboarding: { phase: 'style-needed', originatingMidi: [] },
      pendingProposals: [],
      terminalAudits: [],
    });
    scoreRef.current = imported.score;
    scoreRevisionRef.current = imported.scoreRevision;
    onboardingRef.current = imported.onboarding;
    pendingProposalsRef.current = imported.pendingProposals;
    terminalAuditsRef.current = normalizeTerminalAudits(imported.terminalAudits);
    undoStackRef.current = imported.undoStack;
    setScore(imported.score);
    setScoreRevision(imported.scoreRevision);
    setMessages(imported.messages);
    setOnboarding(imported.onboarding);
    setPendingProposals(imported.pendingProposals);
    setTerminalAudits(terminalAuditsRef.current);
    return true;
  }, []);

  return {
    score,
    tracks: score.tracks,
    agents,
    messages,
    onboarding,
    pendingProposals,
    terminalAudits,
    sendMessage,
    retryMessage,
    selectStyle,
    approveTrackProposals,
    rejectTrackProposals,
    addTrack,
    deleteTrack,
    replaceTrack,
    playhead,
    setPlayhead,
    isPlaying,
    setIsPlaying,
    isComposing,
    workflowProgress,
    applyOperations,
    rejectOperations,
    undo,
    canUndo: undoStackRef.current.length > 0,
    exportSnapshot,
    importSnapshot,
  };
}
