import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompositionRequest, EditWorkflow, Score, ScoreOperation } from '@workspace/api-client-react';
import {
  applyScoreOperations,
  applySelectedTrackProposals,
  applyTrackProposal,
  buildApprovedCompositionContinuation,
  buildCompositionRequest,
  canonicalInstrumentName,
  dedupeWorkflowEvents,
  evaluateOperationApplication,
  exportWorkspaceSnapshot,
  freshPlanRetryFromApprovalContext,
  hideWorkflowRoutingEvents,
  importWorkspaceSnapshot,
  isTerminalWorkflowProgress,
  matchesWorkflowAgent,
  normalizeSavedScore,
  normalizeTerminalAudits,
  parseStoredProject,
  replaceTrackInstrument,
  restorePreviousScore,
  scoresMatch,
  setOperationStatus,
} from './workspace-state.ts';

type CompositionRequestWithProject = CompositionRequest & { projectId?: string };

const score: Score = {
  tempo: 120, durationBeats: 8,
  tracks: [{ id: 'track', name: 'Track', role: 'strings', instrument: 'Strings', midiProgram: 48, regions: [] }],
};
const operation: ScoreOperation = {
  id: 'op', type: 'add-region', trackId: 'track', summary: 'Add',
  region: { id: 'region', name: 'Region', startBeat: 0, durationBeats: 4, dynamics: 'mf', articulation: 'sustain', notes: [{ pitch: 60, velocity: 80, startBeat: 0, durationBeats: 1, articulation: 'sustain' }] },
};
const pending = { id: 'message', role: 'assistant' as const, content: 'Proposal', operations: [operation], operationStatus: 'pending' as const, baseScoreRevision: 0 };

test('applies a pending operation without mutating the prior score', () => {
  const applied = applyScoreOperations(score, [operation]);
  assert.equal(score.tracks[0].regions.length, 0);
  assert.equal(applied?.tracks[0].regions[0].id, 'region');
  assert.equal(setOperationStatus([pending], 'message', 'applied')[0].operationStatus, 'applied');
});

test('rejects a proposal without changing score data', () => {
  assert.equal(setOperationStatus([pending], 'message', 'rejected')[0].operationStatus, 'rejected');
  assert.equal(score.tracks[0].regions.length, 0);
});

test('rejects cross-track collisions with existing and newly proposed region IDs', () => {
  const twoTrackScore: Score = {
    ...score,
    tracks: [
      ...score.tracks,
      { id: 'track-2', name: 'Track 2', role: 'brass', instrument: 'Brass', midiProgram: 60, regions: [{ ...operation.region, id: 'existing-on-track-2' }] },
    ],
  };
  assert.equal(applyScoreOperations(twoTrackScore, [{ ...operation, region: { ...operation.region, id: 'existing-on-track-2' } }]), null);
  assert.equal(applyScoreOperations(twoTrackScore, [
    operation,
    { ...operation, id: 'op-2', trackId: 'track-2' },
  ]), null);
});

test('undo restores the immutable score snapshot captured before apply', () => {
  const applied = applyScoreOperations(score, [operation]);
  assert.equal(applied?.tracks[0].regions.length, 1);
  const restored = restorePreviousScore(score);
  assert.deepEqual(restored, score);
  assert.equal(restored?.tracks[0].regions.length, 0);
});

test('reload parses persisted score, revision, operation status, and undo stack', () => {
  const applied = applyScoreOperations(score, [operation])!;
  const stored = JSON.stringify({
    score: applied,
    scoreRevision: 1,
    messages: setOperationStatus([pending], 'message', 'applied'),
    undoStack: [score],
  });
  const loaded = parseStoredProject(stored, {
    score,
    scoreRevision: 0,
    messages: [],
    undoStack: [],
    onboarding: { phase: 'style-needed', originatingMidi: [] },
    pendingProposals: [],
  });
  assert.equal(loaded.score.tracks[0].regions[0].id, 'region');
  assert.equal(loaded.scoreRevision, 1);
  assert.equal(loaded.messages[0].operationStatus, 'applied');
  assert.equal(loaded.undoStack.length, 1);
  assert.equal(loaded.undoStack[0].tracks[0].regions.length, 0);
});

test('track approvals are explicit and preserve empty regions until approved', () => {
  const proposal = {
    id: 'add-cello',
    action: 'add' as const,
    instrument: 'Cello',
    role: 'strings',
    midiProgram: 42,
    summary: 'Add cello',
    reason: 'Support the melody',
  };
  const next = applyTrackProposal(score, proposal);
  assert.equal(score.tracks.length, 1);
  assert.equal(next?.tracks.length, 2);
  assert.equal(next?.tracks[1].instrument, 'Cello');
  assert.equal(next?.tracks[1].regions.length, 0);
});

test('unsupported saved tracks can be replaced without losing regions or notes', () => {
  const region = {
    id: 'legacy-region',
    name: 'Legacy phrase',
    startBeat: 2,
    durationBeats: 2,
    dynamics: 'mf' as const,
    articulation: 'sustain' as const,
    notes: [{ pitch: 64, velocity: 88, startBeat: 0, durationBeats: 1, articulation: 'sustain' as const }],
  };
  const legacy: Score = {
    ...score,
    tracks: [{
      id: 'legacy-track',
      name: 'Legacy',
      role: 'guitar',
      instrument: 'Tape Guitar',
      midiProgram: 27,
      regions: [region],
    }],
  };
  assert.equal(replaceTrackInstrument(legacy, 'legacy-track', 'cello')?.tracks[0].regions[0], region);
  const replaced = replaceTrackInstrument(legacy, 'legacy-track', 'cello')!;
  assert.equal(replaced.tracks[0].instrument, 'Cello');
  assert.equal(replaced.tracks[0].midiProgram, 42);
  assert.equal(replaced.tracks[0].regions[0].notes[0].pitch, 64);
  assert.equal(replaceTrackInstrument(legacy, 'legacy-track', 'Tape Guitar'), null);
});

test('saved catalog aliases keep their labels while receiving corrected MIDI metadata', () => {
  const saved: Score = {
    ...score,
    tracks: [
      { id: 'piano', name: 'Piano', role: 'keyboards', instrument: 'Piano', midiProgram: 0, regions: [] },
      { id: 'drums', name: 'Drums', role: 'percussion', instrument: 'Modern Drum Kit', midiProgram: 118, regions: [] },
      { id: 'legacy', name: 'Legacy', role: 'guitar', instrument: 'Tape Guitar', midiProgram: 27, regions: [] },
    ],
  };
  const normalized = normalizeSavedScore(saved);
  assert.equal(normalized.tracks[0].instrument, 'Piano');
  assert.equal(normalized.tracks[0].midiProgram, 0);
  assert.equal(normalized.tracks[1].midiProgram, 0);
  assert.equal(normalized.tracks[2].midiProgram, 27);
});

test('track proposal identity does not fall back to an unrelated MIDI program', () => {
  const unsupported = {
    id: 'bad-piano-label',
    action: 'add' as const,
    instrument: 'Unmapped Piano',
    role: 'keyboards',
    midiProgram: 0,
    summary: 'Unsupported',
    reason: 'No licensed mapping',
  };
  assert.equal(applyTrackProposal(score, unsupported), null);
});

test('workspace snapshots retain onboarding and pending originating MIDI', () => {
  const project = {
    score,
    scoreRevision: 2,
    messages: [pending],
    undoStack: [score],
    onboarding: { phase: 'style-review' as const, originatingMidi: [{
      id: 'melody',
      tempo: 120,
      durationMs: 500,
      notes: [{ note: 60, velocity: 90, startMs: 0, durationMs: 250 }],
    }] },
    pendingProposals: [],
  };
  const snapshot = exportWorkspaceSnapshot(project);
  const restored = importWorkspaceSnapshot(snapshot, project);
  assert.equal(snapshot.version, 3);
  assert.equal(restored.onboarding.phase, 'style-review');
  assert.equal(restored.onboarding.originatingMidi[0].notes[0].startMs, 0);
});

test('workspace snapshots retain every structured operation diagnostic field', () => {
  const diagnostic: EditWorkflow['events'][number] = {
    stage: 'operation-format-error',
    message: 'Initial validation failed for the proposed operation.',
    reason: 'operation summary must be a non-empty string with at most 240 characters',
    attempt: '1/2',
    index: 0,
    code: 'missing-target',
    fields: ['trackId', 'regionId'],
    targetId: 'track-missing',
    duplicateId: 'region-duplicate',
    observedType: 'string',
    observedLength: 241,
    maxLength: 240,
    outcome: 'retrying',
  };
  const workflow: EditWorkflow = {
    intent: 'edit',
    status: 'discussion',
    summary: 'The operation requires repair.',
    tasks: [],
    events: [diagnostic],
    changedFiles: [],
  };
  const message = {
    id: 'diagnostic-message',
    role: 'assistant' as const,
    content: 'The operation requires repair.',
    editWorkflow: workflow,
  };
  const project = {
    score,
    scoreRevision: 0,
    messages: [message],
    undoStack: [],
    onboarding: { phase: 'ready' as const, originatingMidi: [] },
    pendingProposals: [],
  };
  const restored = importWorkspaceSnapshot(exportWorkspaceSnapshot(project), project);
  assert.deepEqual(restored.messages[0].editWorkflow?.events[0], diagnostic);
});

test('workspace snapshots retain provider timeout retry diagnostics', () => {
  const timeoutEvent: EditWorkflow['events'][number] = {
    stage: 'operation-timeout-exhausted',
    message: 'Provider request-timeout recovery exhausted; no partial response was accepted.',
    attempt: '2/2',
    code: 'provider-request-timeout',
    fields: ['response'],
    outcome: 'exhausted',
  };
  const workflow: EditWorkflow = {
    intent: 'edit',
    status: 'discussion',
    summary: 'The provider timed out during bounded recovery.',
    tasks: [],
    events: [timeoutEvent],
    changedFiles: [],
  };
  const project = {
    score,
    scoreRevision: 0,
    messages: [{
      id: 'timeout-message',
      role: 'assistant' as const,
      content: workflow.summary,
      editWorkflow: workflow,
    }],
    undoStack: [],
    onboarding: { phase: 'ready' as const, originatingMidi: [] },
    pendingProposals: [],
  };
  const restored = importWorkspaceSnapshot(exportWorkspaceSnapshot(project), project);
  assert.deepEqual(restored.messages[0].editWorkflow?.events[0], timeoutEvent);
});

test('post-approval composition requests carry the selected style directly', () => {
  const request = buildCompositionRequest({
    message: 'Continue the approved cue',
    phase: 'composition',
    projectId: 'project-16',
    selectedStyle: 'Electronic & Hybrid',
    approvedTrackProposalIds: ['keep-piano', 'remove-brass'],
    midiSnippets: [{
      id: 'melody',
      tempo: 120,
      durationMs: 500,
      notes: [{ note: 60, velocity: 90, startMs: 0, durationMs: 250 }],
    }],
    history: [{ role: 'user', content: 'Continue the approved cue' }],
    score,
  });
  assert.equal(request.selectedStyle, 'Electronic & Hybrid');
  assert.equal((request as CompositionRequestWithProject).projectId, 'project-16');
  assert.deepEqual(request.approvedTrackProposalIds, ['keep-piano', 'remove-brass']);
  assert.equal(request.history[0].content, 'Continue the approved cue');
});

test('every failed approval continuation is retried as a capability-free fresh plan', () => {
  const context = {
    originalMessage: 'Develop the attached melody.',
    originalHistory: [{ role: 'user', content: 'Develop the attached melody.' }],
    originalMidi: [],
    selectedStyle: 'Electronic & Hybrid',
    adviserRoster: [],
    adviserConsultations: [],
    consumedBudget: {
      adviserConsultationsUsed: 1,
      trackWriterRoundsUsed: 0,
      refinementRoundsUsed: 0,
      operationRepairAttemptsUsed: 0,
    },
    checkpointId: 'checkpoint',
    offeredTrackProposals: [],
    declinedTrackProposals: [],
    accumulatedApprovedTrackProposals: [],
    signature: 'a'.repeat(64),
  } as Parameters<typeof freshPlanRetryFromApprovalContext>[0];
  const retry = freshPlanRetryFromApprovalContext(context);
  const request = buildCompositionRequest({
    message: retry.message,
    phase: retry.phase!,
    selectedStyle: retry.selectedStyle,
    midiSnippets: retry.snippets,
    history: retry.history!,
    score,
  });
  assert.equal(retry.freshPlan, true);
  assert.equal(retry.approvalContext, undefined);
  assert.equal(retry.approvedTrackProposalIds, undefined);
  assert.equal(retry.approvedTrackProposals, undefined);
  assert.equal(request.approvalContext, undefined);
  assert.equal(request.approvedTrackProposalIds, undefined);
  assert.equal(request.message, context.originalMessage);
});

test('composition requests preserve the complete selected style description', () => {
  const selectedStyle = 'Minimal melody: Sparse single-line tune with occasional harmonic support, using gentle dynamics and a slow tempo to evoke calm introspection.';
  const request = buildCompositionRequest({
    message: 'Continue the approved cue',
    phase: 'instrument-approval',
    selectedStyle,
    midiSnippets: [],
    history: [],
    score,
  });
  assert.equal(request.selectedStyle, selectedStyle);
});

test('saved onboarding and pending style selections retain bounded descriptions', () => {
  const selectedStyle = 'Minimal melody: Sparse single-line tune with occasional harmonic support, using gentle dynamics and a slow tempo to evoke calm introspection.';
  const fallback = {
    score,
    scoreRevision: 0,
    messages: [],
    undoStack: [],
    onboarding: { phase: 'style-needed' as const, originatingMidi: [] },
    pendingProposals: [],
  };
  const restored = parseStoredProject(JSON.stringify({
    ...fallback,
    onboarding: { phase: 'instrument-review', selectedStyle, originatingMidi: [] },
    pendingProposals: [{
      id: 'style-proposal',
      kind: 'style',
      status: 'pending',
      sourceMessageId: 'source',
      sourceText: 'Compose a cue',
      originatingMidi: [],
      selectedStyle,
    }],
  }), fallback);
  assert.equal(restored.onboarding.selectedStyle, selectedStyle);
  assert.equal(restored.pendingProposals[0].selectedStyle, selectedStyle);

  const oversized = parseStoredProject(JSON.stringify({
    ...fallback,
    messages: [{
      id: 'retry-message',
      role: 'assistant',
      content: 'Retry',
      retry: { message: 'Compose a cue', snippets: [], selectedStyle: 'x'.repeat(1001) },
    }],
    onboarding: { phase: 'instrument-review', selectedStyle: 'x'.repeat(1001), originatingMidi: [] },
    pendingProposals: [{
      id: 'oversized-style-proposal',
      kind: 'style',
      status: 'pending',
      sourceMessageId: 'source',
      sourceText: 'Compose a cue',
      originatingMidi: [],
      selectedStyle: 'x'.repeat(1001),
    }],
  }), fallback);
  assert.equal(oversized.messages[0].retry?.selectedStyle, undefined);
  assert.equal(oversized.onboarding.selectedStyle, undefined);
  assert.deepEqual(oversized.pendingProposals, []);
});

test('approved continuation prompts force composition while retaining the original direction', () => {
  const continuation = buildApprovedCompositionContinuation('Write a four-bar piano ostinato with a quiet ending.');
  assert.match(continuation, /Continue the original composer request after approved instrument membership/);
  assert.match(continuation, /if it requested playable score material, continue to specialist generation/);
  assert.match(continuation, /Write a four-bar piano ostinato with a quiet ending\./);
});

test('membership-only approvals do not inject a note-generation instruction', () => {
  const continuation = buildApprovedCompositionContinuation('Add a piano track only; do not compose notes.');
  assert.match(continuation, /Treat the approval itself as complete membership bookkeeping/);
  assert.match(continuation, /Add a piano track only; do not compose notes\./);
  assert.doesNotMatch(continuation, /Create and verify the playable score material/);
});

test('approved empty membership is represented explicitly for a no-addition continuation', () => {
  const request = buildCompositionRequest({
    message: 'Continue the approved cue',
    phase: 'composition',
    selectedStyle: 'Original chamber style',
    approvedTrackProposalIds: [],
    midiSnippets: [],
    history: [],
    score,
  });
  assert.deepEqual(request.approvedTrackProposalIds, []);
});

test('workflow audit dedupes stream and terminal identity without dropping repair attempts', () => {
  const classification = { stage: 'intent-classified', message: 'Semantic intent classified as edit.', agent: 'Orchestrator' };
  const firstAttempt = {
    stage: 'operation-format-error',
    message: 'The operation needs repair.',
    attempt: '1/2',
    index: 0,
    code: 'missing-target',
  };
  const secondAttempt = { ...firstAttempt, attempt: '2/2', outcome: 'exhausted' as const };
  const merged = dedupeWorkflowEvents([classification, firstAttempt, firstAttempt, secondAttempt, classification]);
  assert.equal(merged.length, 3);
  assert.equal(hideWorkflowRoutingEvents(merged).length, 2);
  assert.deepEqual(hideWorkflowRoutingEvents(merged).map((event) => event.attempt), ['1/2', '2/2']);
});

test('verified edit workflows apply only when the local score revision and content are valid', () => {
  const verified: EditWorkflow = {
    intent: 'edit',
    status: 'verified',
    summary: 'Add a playable string phrase.',
    tasks: [],
    events: [],
    changedFiles: ['cue-01.mid'],
  };
  const applied = evaluateOperationApplication({
    score,
    currentRevision: 4,
    baseRevision: 4,
    operations: [operation],
    editWorkflow: verified,
  });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.score?.tracks[0].regions.length, 1);

  const stale = evaluateOperationApplication({
    score,
    currentRevision: 5,
    baseRevision: 4,
    operations: [operation],
    editWorkflow: verified,
  });
  assert.equal(stale.status, 'conflicted');

  const noOp = evaluateOperationApplication({
    score: applyScoreOperations(score, [operation])!,
    currentRevision: 4,
    baseRevision: 4,
    operations: [operation],
    editWorkflow: verified,
  });
  assert.equal(noOp.status, 'conflicted');
});

test('discussion workflows cannot apply score operations', () => {
  const discussion: EditWorkflow = {
    intent: 'discussion',
    status: 'discussion',
    summary: 'Compare two orchestration options.',
    tasks: [],
    events: [],
    changedFiles: [],
  };
  const result = evaluateOperationApplication({
    score,
    currentRevision: 0,
    baseRevision: 0,
    operations: [operation],
    editWorkflow: discussion,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.score, undefined);
});

test('unverified responses fail closed and persisted pending edits become retryable', () => {
  const unverified = evaluateOperationApplication({
    score,
    currentRevision: 0,
    baseRevision: 0,
    operations: [operation],
  });
  assert.equal(unverified.status, 'blocked');

  const restored = parseStoredProject(JSON.stringify({
    score,
    scoreRevision: 0,
    messages: [
      { id: 'user', role: 'user', content: 'Add an accent', snippets: [] },
      pending,
    ],
    undoStack: [],
    onboarding: { phase: 'ready', originatingMidi: [] },
    pendingProposals: [],
  }), {
    score,
    scoreRevision: 0,
    messages: [],
    undoStack: [],
    onboarding: { phase: 'style-needed', originatingMidi: [] },
    pendingProposals: [],
  });
  assert.equal(restored.messages[1].operationStatus, 'blocked');
  assert.equal(restored.messages[1].retry?.message, 'Add an accent');
});

test('workflow progress aliases track agents and clears terminal activity', () => {
  assert.equal(matchesWorkflowAgent('track-agent-violin-1', 'Violins', '[track violin-1]'), true);
  assert.equal(matchesWorkflowAgent('track-agent-track-1', 'Piano', 'Piano (instrument, track track-1)'), true);
  assert.equal(matchesWorkflowAgent('track-agent-violin-1', 'Violins', 'Violins'), true);
  assert.equal(matchesWorkflowAgent('track-agent-violin-1', 'Violins', '[track Violins]'), true);
  assert.equal(matchesWorkflowAgent('track-agent-violin-1', 'Violins', '[track cello-1]'), false);
  assert.equal(isTerminalWorkflowProgress('task-completed', 'Verification passed.'), true);
  assert.equal(isTerminalWorkflowProgress('editing', 'Writing a counterline.'), false);
});

test('renamed identical regions are semantic MIDI no-ops', () => {
  const original = applyScoreOperations(score, [operation])!;
  const renamedAndReordered: Score = {
    ...original,
    tracks: original.tracks.map((track) => ({
      ...track,
      id: 'new-track-id',
      name: 'Renamed string section',
      regions: track.regions.map((region) => ({
        ...region,
        id: 'renamed-region',
        name: 'Different editorial label',
        notes: [...region.notes].reverse(),
      })),
    })),
  };
  assert.equal(scoresMatch(original, renamedAndReordered), true);
  const noOp = evaluateOperationApplication({
    score: original,
    currentRevision: 2,
    baseRevision: 2,
    operations: [],
    editWorkflow: {
      intent: 'edit',
      status: 'verified',
      summary: 'Only labels changed.',
      tasks: [],
      events: [],
      changedFiles: [],
    },
  });
  assert.equal(noOp.status, 'conflicted');
});

test('workspace snapshots retain the final workflow audit and edited MIDI files', () => {
  const editWorkflow: EditWorkflow = {
    intent: 'edit',
    status: 'verified',
    summary: 'Verified a brass accent.',
    tasks: [{
      id: 'task-1',
      title: 'Write accent',
      priority: 'high',
      status: 'complete',
      summary: 'Added the accent at the cut.',
      editedFiles: ['accent.mid'],
    }],
    events: [{ stage: 'verification', message: 'Timing and pitch checks passed.', files: ['accent.mid'] }],
    changedFiles: ['accent.mid'],
  };
  const stored = JSON.stringify({
    score,
    scoreRevision: 1,
    messages: [{ ...pending, editWorkflow, operationStatus: 'applied' }],
    undoStack: [score],
    onboarding: { phase: 'ready', originatingMidi: [] },
    pendingProposals: [],
  });
  const restored = parseStoredProject(stored, {
    score,
    scoreRevision: 0,
    messages: [],
    undoStack: [],
    onboarding: { phase: 'style-needed', originatingMidi: [] },
    pendingProposals: [],
  });
  assert.equal(restored.messages[0].editWorkflow?.events[0].stage, 'verification');
  assert.deepEqual(restored.messages[0].editWorkflow?.changedFiles, ['accent.mid']);
});

test('workspace reload keeps the final evaluator reason available for retry', () => {
  const reason = 'the corrected phrase still lacks a resolving final note';
  const editWorkflow: EditWorkflow = {
    intent: 'edit',
    status: 'discussion',
    summary: reason,
    tasks: [],
    events: [{
      stage: 'evaluation-failed',
      message: reason,
      agent: 'Evaluator',
      taskId: 'task-1',
    }],
    changedFiles: [],
  };
  const retry = {
    message: 'Write a phrase with a resolving cadence.',
    snippets: [],
    phase: 'composition' as const,
  };
  const project = {
    score,
    scoreRevision: 0,
    messages: [{
      id: 'failed-evaluation',
      role: 'assistant' as const,
      content: reason,
      editWorkflow,
      retry,
    }],
    undoStack: [],
    onboarding: { phase: 'ready' as const, originatingMidi: [] },
    pendingProposals: [],
  };

  const restored = importWorkspaceSnapshot(exportWorkspaceSnapshot(project), project);
  assert.equal(restored.messages[0].editWorkflow?.summary, reason);
  assert.equal(restored.messages[0].editWorkflow?.events[0].message, reason);
  assert.equal(restored.messages[0].retry?.message, retry.message);
  assert.equal(restored.messages[0].retry?.phase, 'composition');
});

test('terminal evaluator audits survive an approval-stage save without changing score or revision', () => {
  const terminalAudit = {
    workflowId: 'workflow-16',
    requestId: 'request-16',
    reason: 'The candidate does not resolve the requested cadence.',
    evidence: ['Final phrase ends without the expected resolution.'],
    evaluatorCategory: 'musical-rejection',
    affectedScope: ['track-piano', 'bar-4'],
    expected: 'Resolve on the final beat.',
    observed: 'No resolving final note was observed.',
    candidateRevision: 7,
    correctionOutcome: 'No bounded correction remained.',
    commitStatus: 'unchanged',
  } as const;
  const fallback = {
    score,
    scoreRevision: 4,
    messages: [],
    undoStack: [],
    onboarding: { phase: 'ready' as const, originatingMidi: [] },
    pendingProposals: [],
  };
  const approvalStageDocument = {
    ...fallback,
    onboarding: { phase: 'instrument-review' as const, originatingMidi: [] },
    pendingProposals: [{
      id: 'approval-stage',
      kind: 'tracks' as const,
      status: 'pending' as const,
      sourceMessageId: 'source',
      sourceText: 'Develop the cue.',
      originatingMidi: [],
      originatingHistory: [],
      trackProposals: [],
    }],
    terminalAudits: [terminalAudit],
  };
  const restored = parseStoredProject(JSON.stringify(approvalStageDocument), fallback);
  assert.deepEqual(restored.score, score);
  assert.equal(restored.scoreRevision, 4);
  assert.equal(restored.onboarding.phase, 'instrument-review');
  assert.equal(restored.pendingProposals[0]?.status, 'pending');
  assert.deepEqual(restored.terminalAudits, [terminalAudit]);

  const reloaded = importWorkspaceSnapshot(exportWorkspaceSnapshot(restored), fallback);
  assert.deepEqual(reloaded.score, score);
  assert.equal(reloaded.scoreRevision, 4);
  assert.deepEqual(reloaded.terminalAudits, [terminalAudit]);
});

test('terminal audit normalization keeps safe categories distinct and bounds incoming evidence', () => {
  const valid = {
    workflowId: 'workflow',
    requestId: 'request',
    reason: 'Malformed staged candidate.',
    evidence: ['Missing required region target.'],
    evaluatorCategory: 'malformed',
    affectedScope: ['track-1'],
    correctionOutcome: 'No candidate committed.',
    commitStatus: 'not-committed',
  };
  const noOp = { ...valid, evaluatorCategory: 'no-musical-change' };
  const longReason = { ...valid, reason: 'r'.repeat(2200) };
  const longConstraint = { ...valid, expected: 'e'.repeat(2200) };
  const longEvidence = { ...valid, evidence: ['x'.repeat(1200)] };
  const longCorrection = { ...valid, correctionOutcome: 'c'.repeat(220) };
  const replacement = { ...valid, reason: 'Server-normalized replacement.' };
  const backendShape = {
    workflowId: 'workflow-backend',
    reason: 'The staged candidate was unchanged.',
    evidence: 'No rendered MIDI difference was observed.',
    evaluationKind: 'no-musical-change',
    scope: 'overall',
    expectedConstraints: ['Introduce a playable musical change.'],
    observedConstraints: ['No rendered MIDI difference was observed.'],
    correctionOutcome: 'No bounded correction remained.',
    commitStatus: 'not-committed',
  };
  assert.equal(normalizeTerminalAudits([valid])[0]?.evaluatorCategory, 'malformed');
  assert.equal(normalizeTerminalAudits([noOp])[0]?.evaluatorCategory, 'no-op');
  assert.equal(normalizeTerminalAudits([backendShape])[0]?.evaluatorCategory, 'no-op');
  assert.deepEqual(normalizeTerminalAudits([backendShape])[0]?.affectedScope, ['overall']);
  assert.equal(normalizeTerminalAudits([longReason])[0]?.reason.length, 2000);
  assert.equal(normalizeTerminalAudits([longConstraint])[0]?.expected?.length, 2000);
  assert.equal(normalizeTerminalAudits([longEvidence])[0]?.evidence[0]?.length, 1000);
  assert.equal(normalizeTerminalAudits([longCorrection])[0]?.correctionOutcome.length, 160);
  assert.equal(normalizeTerminalAudits([valid, replacement])[0]?.reason, replacement.reason);
  const boundedHistory = Array.from({ length: 21 }, (_, index) => ({
    ...valid,
    workflowId: `workflow-${index}`,
  }));
  const retainedHistory = normalizeTerminalAudits(boundedHistory);
  assert.equal(retainedHistory.length, 20);
  assert.equal(retainedHistory[0]?.workflowId, 'workflow-1');
});

test('track proposal comparisons canonicalize legacy instrument aliases', () => {
  const savedWithLegacyPiano: Score = {
    ...score,
    tracks: [{
      ...score.tracks[0],
      id: 'piano',
      name: 'Piano',
      instrument: 'Piano',
      role: 'keyboards',
      midiProgram: 0,
    }],
  };
  assert.equal(canonicalInstrumentName('Piano'), 'Upright Piano');
  assert.equal(canonicalInstrumentName('Upright Piano'), 'Upright Piano');
  assert.equal(applyTrackProposal(savedWithLegacyPiano, {
    id: 'add-piano',
    action: 'add',
    instrument: 'Upright Piano',
    role: 'keyboards',
    midiProgram: 0,
    summary: 'Add piano',
    reason: 'The existing piano should be reused.',
  }), null);
});

test('selected track membership is rejected atomically for duplicate or unknown IDs', () => {
  const cello = {
    id: 'add-cello',
    action: 'add' as const,
    instrument: 'Cello',
    role: 'strings',
    midiProgram: 42,
    summary: 'Add cello',
    reason: 'Support the melody',
  };
  const violin = {
    id: 'add-violin',
    action: 'add' as const,
    instrument: 'Violin',
    role: 'strings',
    midiProgram: 40,
    summary: 'Add violin',
    reason: 'Add a counterline',
  };
  assert.equal(applySelectedTrackProposals(score, [cello, violin], ['add-cello'])?.tracks[1].instrument, 'Cello');
  assert.equal(applySelectedTrackProposals(score, [cello, violin], ['add-cello', 'add-cello']), null);
  assert.equal(applySelectedTrackProposals(score, [cello, violin], ['add-cello', 'missing']), null);
  assert.equal(score.tracks.length, 1);
});

test('selected track membership does not partially apply when one member is invalid', () => {
  const scoreWithLegacyPiano: Score = {
    ...score,
    tracks: [
      ...score.tracks,
      { id: 'piano', name: 'Piano', role: 'keyboards', instrument: 'Piano', midiProgram: 0, regions: [] },
    ],
  };
  const cello = {
    id: 'add-cello',
    action: 'add' as const,
    instrument: 'Cello',
    role: 'strings',
    midiProgram: 42,
    summary: 'Add cello',
    reason: 'Support the melody',
  };
  const duplicatePiano = {
    id: 'add-piano',
    action: 'add' as const,
    instrument: 'Piano',
    role: 'keyboards',
    midiProgram: 0,
    summary: 'Add piano',
    reason: 'The existing piano should be reused.',
  };
  const result = applySelectedTrackProposals(scoreWithLegacyPiano, [cello, duplicatePiano], ['add-cello', 'add-piano']);
  assert.equal(result, null);
  assert.equal(scoreWithLegacyPiano.tracks.length, 2);
});

test('verified membership applies approved additions and deletions atomically with staged MIDI', () => {
  const cello = {
    id: 'add-cello',
    action: 'add' as const,
    instrument: 'Cello',
    role: 'strings',
    midiProgram: 42,
    summary: 'Add cello',
    reason: 'Support the phrase',
  };
  const removeStrings = {
    id: 'remove-strings',
    action: 'delete' as const,
    trackId: 'track',
    instrument: 'Strings',
    role: 'strings',
    midiProgram: 48,
    summary: 'Remove strings',
    reason: 'Use cello instead',
  };
  const celloOperation: ScoreOperation = {
    ...operation,
    id: 'cello-operation',
    trackId: 'track-add-cello',
    region: { ...operation.region, id: 'cello-region' },
  };
  const result = evaluateOperationApplication({
    score,
    currentRevision: 3,
    baseRevision: 3,
    trackProposals: [cello, removeStrings],
    operations: [celloOperation],
    editWorkflow: {
      intent: 'edit',
      status: 'verified',
      summary: 'Verified staged score.',
      tasks: [],
      events: [],
      changedFiles: ['cello-region.mid'],
    },
  });
  assert.equal(score.tracks.length, 1, 'approval alone cannot mutate the live score');
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.score?.tracks.map((track) => track.instrument), ['Cello']);
  assert.equal(result.score?.tracks[0].regions[0].id, 'cello-region');
});

test('approval reload retains original source, adviser context, budget, and rejected or failed state', () => {
  const sourceMidi = [{
    id: 'source-melody',
    tempo: 112,
    durationMs: 1250,
    notes: [
      { note: 60, velocity: 88, startMs: 0, durationMs: 250 },
      { note: 67, velocity: 74, startMs: 500, durationMs: 400 },
    ],
  }];
  const approvalContext = {
    originalMessage: 'Develop the attached melody with a restrained strings answer.',
    originalHistory: [{ role: 'user' as const, content: 'Develop the attached melody with a restrained strings answer.' }],
    originalMidi: sourceMidi,
    selectedStyle: 'Quiet chamber: a transparent, restrained string palette.',
    adviserRoster: [{ agent: 'Texture & Register', group: 'concept' as const, question: 'How should register support the melody?' }],
    adviserConsultations: [{
      agent: 'Texture & Register',
      group: 'concept' as const,
      question: 'How should register support the melody?',
      insight: 'Keep the answer below the source melody.',
    }],
    consumedBudget: {
      adviserConsultationsUsed: 1,
      trackWriterRoundsUsed: 0,
      refinementRoundsUsed: 0,
      operationRepairAttemptsUsed: 1,
    },
    checkpointId: "db2a6a1a-4f3d-4a2c-9f99-9fd2d4b32bf2",
    offeredTrackProposals: [],
    declinedTrackProposals: [],
    accumulatedApprovedTrackProposals: [],
    signature: "a".repeat(64),
  };
  const fallback = {
    score,
    scoreRevision: 0,
    messages: [],
    undoStack: [],
    onboarding: { phase: 'ready' as const, originatingMidi: [] },
    pendingProposals: [],
  };
  const restored = parseStoredProject(JSON.stringify({
    ...fallback,
    pendingProposals: [{
      id: 'membership-pause',
      kind: 'tracks',
      status: 'failed',
      sourceMessageId: 'source-message',
      sourceText: approvalContext.originalMessage,
      originatingMidi: sourceMidi,
      originatingHistory: approvalContext.originalHistory,
      selectedStyle: approvalContext.selectedStyle,
      trackProposals: [],
      approvalContext,
    }, {
      id: 'rejected-membership',
      kind: 'tracks',
      status: 'rejected',
      sourceMessageId: 'source-message',
      sourceText: approvalContext.originalMessage,
      originatingMidi: sourceMidi,
      originatingHistory: approvalContext.originalHistory,
      trackProposals: [],
      approvalContext,
    }],
  }), fallback);
  assert.equal(restored.pendingProposals[0].status, 'failed');
  assert.deepEqual(restored.pendingProposals[0].originatingMidi, sourceMidi);
  assert.deepEqual(restored.pendingProposals[0].originatingHistory, approvalContext.originalHistory);
  assert.equal(restored.pendingProposals[0].approvalContext?.consumedBudget.operationRepairAttemptsUsed, 1);
  assert.equal(restored.pendingProposals[0].approvalContext?.adviserConsultations[0].insight, 'Keep the answer below the source melody.');
  assert.equal(restored.pendingProposals[1].status, 'rejected');
});
