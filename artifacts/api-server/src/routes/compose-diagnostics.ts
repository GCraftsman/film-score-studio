import { diagnosticSummary } from "../lib/model-diagnostics.ts";
import type {
  WorkflowDiagnostic,
  WorkflowEvent,
} from "../lib/composition-workflow.ts";

type TerminalWorkflowEvent = WorkflowEvent & {
  evaluatorCategory?: TerminalComposeAudit["evaluatorCategory"];
  evaluationKind?: string;
  affectedScope?: string[];
  scope?: string;
  trackId?: string;
  expected?: string;
  expectedConstraints?: string[];
  observed?: string;
  observedConstraints?: string[];
  candidateRevision?: string;
  correctionOutcome?: string;
  commitStatus?: TerminalComposeAudit["commitStatus"];
  evidence?: string | string[];
};

export type ComposeProgressEvent =
  | {
    type: "workflow-progress";
    stage: string;
    message: string;
    reason?: string;
    agent?: string;
    taskId?: string;
    files?: string[];
    attempt?: string;
    index?: number;
    code?: string;
    fields?: string[];
    targetId?: string;
    duplicateId?: string;
    observedType?: string;
    observedLength?: number;
    maxLength?: number;
    outcome?: string;
  }
  | { type: "result"; result: unknown }
  | { type: "error"; error: string; diagnostics?: TerminalComposeAudit };

export type TerminalComposeAudit = {
  workflowId: string;
  requestId?: string;
  reason: string;
  evidence: string[];
  evaluatorCategory: "malformed" | "musical-rejection" | "no-op" | "unknown";
  affectedScope: string[];
  expected?: string;
  observed?: string;
  candidateRevision?: string;
  correctionOutcome: string;
  commitStatus: "not-committed";
};

/** Input events have already passed the workflow's prose safety screening.
 * Copy only diagnostic fields, never arbitrary errors or provider envelopes. */
export function terminalComposeAudit(
  workflowId: string, requestId: string | undefined,
  reason: string, events: WorkflowEvent[],
): TerminalComposeAudit {
  const terminalEvents = events as TerminalWorkflowEvent[];
  const evaluation = [...terminalEvents].reverse().find(event => event.evaluationKind || event.evaluatorCategory);
  const correction = [...terminalEvents].reverse().find(event => event.correctionOutcome || event.outcome);
  const evidence = typeof evaluation?.evidence === "string"
    ? [evaluation.evidence]
    : Array.isArray(evaluation?.evidence)
      ? evaluation.evidence.filter((value): value is string => typeof value === "string")
      : [];
  const expectedConstraints = evaluation?.expectedConstraints?.filter(
    (value): value is string => typeof value === "string",
  );
  const observedConstraints = evaluation?.observedConstraints?.filter(
    (value): value is string => typeof value === "string",
  );
  const expected = typeof evaluation?.expected === "string"
    ? evaluation.expected
    : (expectedConstraints?.length ? expectedConstraints.join(" | ") : undefined);
  const observed = typeof evaluation?.observed === "string"
    ? evaluation.observed
    : (observedConstraints?.length ? observedConstraints.join(" | ") : undefined);
  const evaluatorCategory: TerminalComposeAudit["evaluatorCategory"] =
    evaluation?.evaluatorCategory ??
    (evaluation?.evaluationKind === "no-musical-change"
      ? "no-op"
      : evaluation?.evaluationKind === "malformed" || evaluation?.evaluationKind === "musical-rejection"
        ? evaluation.evaluationKind
        : events.some(event => /format-error|agent-response-error/.test(event.stage)) ? "malformed" : "unknown");
  const affectedScope = (
    evaluation?.affectedScope ??
    [evaluation?.scope, evaluation?.trackId].filter((value): value is string => typeof value === "string" && value.length > 0)
  ).filter((value): value is string => typeof value === "string");
  const safeReason = typeof evaluation?.reason === "string" ? evaluation.reason : reason;
  const safeCandidateRevision = typeof evaluation?.candidateRevision === "string"
    ? evaluation.candidateRevision
    : undefined;
  const safeCorrectionOutcome = typeof correction?.correctionOutcome === "string"
    ? correction.correctionOutcome
    : typeof correction?.outcome === "string"
      ? correction.outcome
      : "not-attempted";
  return {
    workflowId,
    ...(requestId ? { requestId: requestId.slice(0, 160) } : {}),
    reason: safeReason.slice(0, 2000),
    evidence: evidence.slice(0, 8).map(value => value.slice(0, 1000)),
    evaluatorCategory,
    affectedScope: affectedScope.slice(0, 16).map(value => value.slice(0, 160)),
    ...(expected ? { expected: expected.slice(0, 2000) } : {}),
    ...(observed ? { observed: observed.slice(0, 2000) } : {}),
    ...(safeCandidateRevision ? { candidateRevision: safeCandidateRevision.slice(0, 160) } : {}),
    correctionOutcome: safeCorrectionOutcome.slice(0, 160),
    commitStatus: "not-committed",
  };
}

export function workflowProgress(event: WorkflowEvent): ComposeProgressEvent {
  const terminalEvent = event as TerminalWorkflowEvent;
  return {
    type: "workflow-progress",
    stage: event.stage,
    message: event.message,
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.agent ? { agent: event.agent } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.files ? { files: event.files } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.index !== undefined ? { index: event.index } : {}),
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.fields !== undefined ? { fields: event.fields } : {}),
    ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
    ...(event.duplicateId !== undefined ? { duplicateId: event.duplicateId } : {}),
    ...(event.observedType !== undefined ? { observedType: event.observedType } : {}),
    ...(event.observedLength !== undefined ? { observedLength: event.observedLength } : {}),
    ...(event.maxLength !== undefined ? { maxLength: event.maxLength } : {}),
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(terminalEvent.evaluationKind ? {
      evaluationKind: terminalEvent.evaluationKind,
      evaluatorCategory: terminalEvent.evaluatorCategory,
      scope: terminalEvent.scope,
      trackId: terminalEvent.trackId,
      affectedScope: terminalEvent.affectedScope,
      candidateRevision: terminalEvent.candidateRevision,
      expectedConstraints: terminalEvent.expectedConstraints,
      observedConstraints: terminalEvent.observedConstraints,
      expected: terminalEvent.expected,
      observed: terminalEvent.observed,
      evidence: terminalEvent.evidence,
      correctionOutcome: terminalEvent.correctionOutcome,
      commitStatus: terminalEvent.commitStatus,
    } : {}),
  };
}

export function composeRequestId(id: unknown): string | undefined {
  return id === undefined || id === null ? undefined : String(id);
}

export function createComposeDiagnosticSink(
  requestId: string | undefined,
  workflowId: string,
  emit: (event: ComposeProgressEvent) => void,
  logDiagnostic: (
    diagnostic: WorkflowDiagnostic,
    requestId: string | undefined,
    workflowId: string,
  ) => void,
): (diagnostic: WorkflowDiagnostic) => void {
  return (diagnostic) => {
    logDiagnostic(diagnostic, requestId, workflowId);
    emit(workflowProgress({
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
    }));
  };
}