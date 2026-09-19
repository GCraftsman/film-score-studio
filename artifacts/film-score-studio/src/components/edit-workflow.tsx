import { useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, CircleDashed, Copy, FileMusic, MessageCircle, ShieldCheck } from 'lucide-react';
import type { EditWorkflow, EditWorkflowEvent } from '@workspace/api-client-react';
import type { TerminalAudit } from '@/lib/workspace-state';

type WorkflowProgressProps = {
  events: EditWorkflowEvent[];
  live?: boolean;
};

function EventRow({ event, live }: { event: EditWorkflowEvent; live?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const diagnostic = isOperationFormatDiagnostic(event);

  const copyDiagnostic = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setCopyFailed(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(formatDiagnostic(event));
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <li className={`flex gap-2.5 text-[10px] leading-relaxed ${diagnostic ? 'rounded-md border border-amber-500/25 bg-amber-500/5 p-2' : ''}`}>
      {diagnostic
        ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
        : <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-primary animate-pulse' : 'bg-primary/70'}`} />}
      <span className="min-w-0">
        <span className={`font-bold uppercase tracking-wider ${diagnostic ? 'text-amber-300' : 'text-primary/80'}`}>{event.stage}</span>
        {event.agent && <span className="ml-1.5 text-muted-foreground">· {event.agent}</span>}
        <span className={`block ${diagnostic ? 'text-amber-100' : 'text-muted-foreground'}`}>{event.message}</span>
        {event.files && event.files.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {event.files.map((file) => <span key={file} className="rounded border border-border bg-black/20 px-1.5 py-0.5 font-mono text-[9px] text-foreground/80">{file}</span>)}
          </span>
        )}
        {diagnostic && (
          <details className="mt-2 rounded border border-amber-500/20 bg-black/20">
            <summary className="cursor-pointer px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-amber-200/90">
              Inspect diagnostic
            </summary>
            <div className="border-t border-amber-500/15 p-2">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-amber-100/85">{formatDiagnostic(event)}</pre>
              <button
                type="button"
                onClick={() => void copyDiagnostic()}
                className="mt-2 inline-flex items-center gap-1.5 rounded border border-amber-500/30 px-2 py-1 text-[9px] font-bold text-amber-200 hover:bg-amber-500/10"
                aria-label={`Copy ${event.stage} diagnostic`}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied diagnostic' : 'Copy diagnostic'}
              </button>
              {copyFailed && <span className="ml-2 text-[9px] text-amber-300">Copy unavailable; select the diagnostic above.</span>}
            </div>
          </details>
        )}
      </span>
    </li>
  );
}

const OPERATION_FORMAT_STAGES = new Set([
  'agent-response-error',
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

function isOperationFormatDiagnostic(event: EditWorkflowEvent): boolean {
  return OPERATION_FORMAT_STAGES.has(event.stage) || PROVIDER_TIMEOUT_STAGES.has(event.stage);
}

function formatDiagnostic(event: EditWorkflowEvent): string {
  return JSON.stringify({
    stage: event.stage,
    message: event.message,
    ...(event.agent ? { agent: event.agent } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.files ? { files: event.files } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.index !== undefined ? { index: event.index } : {}),
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.fields !== undefined ? { fields: event.fields } : {}),
    ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
    ...(event.duplicateId !== undefined ? { duplicateId: event.duplicateId } : {}),
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
  }, null, 2);
}

export function WorkflowProgress({ events, live = false }: WorkflowProgressProps) {
  // Apply at render time too, so older saved audits do not show routing noise.
  events = events.filter((event) => event.stage !== 'intent-classified');
  if (events.length === 0) return null;
  return (
    <section className="rounded-lg border border-primary/20 bg-black/20 p-3 shadow-inner" aria-label="Live edit workflow" aria-live="polite">
      <div className="mb-2 flex items-center gap-2">
        <CircleDashed className={`h-3.5 w-3.5 text-primary ${live ? 'animate-spin' : ''}`} />
        <span className="text-[9px] font-bold uppercase tracking-widest text-primary">{live ? 'Orchestrator workflow' : 'Workflow audit'}</span>
      </div>
      <ol className="space-y-2">
        {events.map((event, index) => <EventRow key={`${event.stage}-${event.taskId ?? ''}-${index}`} event={event} live={live && index === events.length - 1} />)}
      </ol>
    </section>
  );
}

function terminalCategoryLabel(category: TerminalAudit['evaluatorCategory']): string {
  switch (category) {
    case 'malformed':
      return 'Malformed candidate';
    case 'musical-rejection':
      return 'Musical rejection';
    case 'no-op':
      return 'No-op / no musical change';
    default:
      return 'Evaluator review';
  }
}

function terminalCommitLabel(status: TerminalAudit['commitStatus']): string {
  switch (status) {
    case 'committed':
      return 'Candidate committed';
    case 'unchanged':
      return 'Saved score unchanged';
    default:
      return 'Candidate not committed';
  }
}

function TerminalAuditCard({ audit }: { audit: TerminalAudit }) {
  return (
    <article className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-[10px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold uppercase tracking-wider text-amber-300">{terminalCategoryLabel(audit.evaluatorCategory)}</span>
        <span className="rounded border border-amber-500/25 px-1.5 py-0.5 text-[9px] text-amber-200/90">{terminalCommitLabel(audit.commitStatus)}</span>
      </div>
      <p className="mt-1.5 leading-relaxed text-amber-100/90">{audit.reason}</p>
      <div className="mt-2 grid gap-1.5 text-[9px] text-muted-foreground sm:grid-cols-2">
        <div>
          <span className="font-bold uppercase tracking-wider text-amber-200/70">Affected track / scope</span>
          <span className="mt-0.5 block text-foreground/80">{audit.affectedScope.length > 0 ? audit.affectedScope.join(', ') : 'Not specified'}</span>
        </div>
        <div>
          <span className="font-bold uppercase tracking-wider text-amber-200/70">Candidate revision</span>
          <span className="mt-0.5 block text-foreground/80">{audit.candidateRevision ?? 'Not specified'}</span>
        </div>
      </div>
      {(audit.expected !== undefined || audit.observed !== undefined) && (
        <div className="mt-2 rounded border border-amber-500/20 bg-black/20 p-2">
          <span className="font-bold uppercase tracking-wider text-amber-200/80">Constraint review</span>
          <dl className="mt-1 space-y-1 text-[9px] leading-relaxed">
            {audit.expected !== undefined && <div><dt className="inline font-semibold text-amber-100/70">Expected: </dt><dd className="inline text-foreground/80">{audit.expected}</dd></div>}
            {audit.observed !== undefined && <div><dt className="inline font-semibold text-amber-100/70">Observed: </dt><dd className="inline text-foreground/80">{audit.observed}</dd></div>}
          </dl>
        </div>
      )}
      {audit.evidence.length > 0 && (
        <div className="mt-2">
          <span className="font-bold uppercase tracking-wider text-amber-200/70">Evidence</span>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/80">
            {audit.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
          </ul>
        </div>
      )}
      <div className="mt-2 border-t border-amber-500/15 pt-1.5 text-[9px] text-amber-100/75">
        <span className="font-semibold">Correction outcome:</span> {audit.correctionOutcome}
      </div>
    </article>
  );
}

export function TerminalAuditPanel({ audits }: { audits: TerminalAudit[] }) {
  if (audits.length === 0) return null;
  return (
    <section className="rounded-lg border border-amber-500/25 bg-black/20 p-3 shadow-inner" aria-label="Terminal evaluator audit">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
        <span className="text-[9px] font-bold uppercase tracking-widest text-amber-300">Evaluator rejection audit</span>
      </div>
      <div className="space-y-2">
        {audits.map((audit) => <TerminalAuditCard key={`${audit.workflowId}-${audit.requestId}-${audit.candidateRevision ?? ''}`} audit={audit} />)}
      </div>
    </section>
  );
}

export function EditWorkflowSummary({ workflow }: { workflow: EditWorkflow }) {
  const tasks = workflow.tasks.slice(0, 5);
  const verifiedEdit = workflow.intent === 'edit' && workflow.status === 'verified';
  const formatDiagnostics = workflow.events.filter(isOperationFormatDiagnostic);
  const formatExhausted = formatDiagnostics.some((event) => event.stage === 'operation-format-exhausted');
  const truncationExhausted = formatDiagnostics.some((event) => event.stage === 'operation-truncation-exhausted');
  const timeoutExhausted = formatDiagnostics.some((event) => event.stage === 'operation-timeout-exhausted');
  const timeoutRetry = formatDiagnostics.some((event) => event.stage === 'operation-timeout-error');
  const repairExhausted = formatExhausted || truncationExhausted || timeoutExhausted;
  const formatRecovered = formatDiagnostics.some((event) => event.stage === 'operation-format-recovered');

  return (
    <section className="mt-4 border-t border-primary/20 pt-3" aria-label="Verified edit workflow">
      <div className="mb-2 flex items-center gap-2">
        {verifiedEdit
          ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
          : repairExhausted
            ? <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
            : <MessageCircle className="h-3.5 w-3.5 text-primary" />}
        <span className={`text-[9px] font-bold uppercase tracking-widest ${verifiedEdit ? 'text-emerald-400' : repairExhausted ? 'text-amber-300' : 'text-primary'}`}>
           {verifiedEdit ? 'MIDI/timing validated modification' : repairExhausted ? timeoutExhausted ? 'Edit timeout error' : truncationExhausted ? 'Edit completion error' : 'Edit format error' : workflow.events.some((event) => event.stage === 'workflow-error') ? 'Score edit failed' : 'Routed discussion'}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{workflow.summary}</p>

       {formatRecovered && !timeoutRetry && (
        <div className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2.5 text-[10px] text-emerald-300">
          <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider"><CheckCircle2 className="h-3 w-3" /> Format repair recovered</span>
          <p className="mt-1 leading-relaxed text-emerald-200/80">The structural diagnostic and bounded repair are retained in the workflow audit above.</p>
        </div>
      )}
      {repairExhausted && (
        <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-[10px] text-amber-200">
          <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider"><AlertTriangle className="h-3 w-3" /> No score change made</span>
           <p className="mt-1 leading-relaxed text-amber-100/80">{timeoutExhausted ? 'The provider request timed out after bounded recovery attempts; no partial response was accepted.' : truncationExhausted ? 'The provider completion hit the bounded output limit; no partial response was accepted.' : 'The two-attempt format repair budget was exhausted.'} Inspect or copy each diagnostic above, then retry the original request.</p>
        </div>
      )}
       {!repairExhausted && timeoutRetry && (
         <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-[10px] text-amber-200">
           <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider"><AlertTriangle className="h-3 w-3" /> Provider retry in progress</span>
           <p className="mt-1 leading-relaxed text-amber-100/80">The provider request timed out; the bounded retry is being recorded as a timeout, not an edit-format failure.</p>
         </div>
       )}

      {tasks.length > 0 && (
        <ol className="mt-3 space-y-2" aria-label="Ordered specialist tasks">
          {tasks.map((task, index) => (
            <li key={task.id} className="rounded-md border border-border bg-black/20 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-primary/30 font-mono text-[8px] text-primary">{index + 1}</span>
                <span className="min-w-0 flex-1 text-[11px] font-semibold">{task.title}</span>
                <span className="text-[8px] uppercase tracking-wider text-muted-foreground">{task.priority} · {task.status}</span>
              </div>
              <p className="mt-1 pl-6 text-[10px] leading-relaxed text-muted-foreground">{task.summary}</p>
              {task.editedFiles.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 pl-6">
                  {task.editedFiles.map((file) => <span key={file} className="rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[9px] text-primary/90">{file}</span>)}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {workflow.events.length > 0 && <div className="mt-3"><WorkflowProgress events={workflow.events} /></div>}
      {verifiedEdit && (
        <div className="mt-3 rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2.5">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Verification complete</span>
          {workflow.changedFiles.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <FileMusic className="mt-0.5 h-3 w-3 text-emerald-400" />
              {workflow.changedFiles.map((file) => <span key={file} className="font-mono text-[9px] text-emerald-300">{file}</span>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}