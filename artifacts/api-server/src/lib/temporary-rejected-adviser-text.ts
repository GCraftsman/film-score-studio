import type { RejectedAdviserTextDiagnostic } from "./composition-workflow.ts";

export const TEMP_REJECTED_ADVISER_TEXT_ENV = "TEMP_LOG_REJECTED_ADVISER_TEXT";
const MAX_LOGGED_ADVISER_TEXT_LENGTH = 5_000;

export type RequestScopedWarningLogger = {
  warn: (metadata: Record<string, unknown>, message: string) => void;
};

/**
 * This gate is deliberately evaluated at call time so tests and development
 * tooling can change the environment without reloading the logger module.
 * Production is always disabled, even if the temporary flag is accidentally
 * present in a production environment.
 */
export function temporaryRejectedAdviserTextLoggingEnabled(): boolean {
  return process.env.NODE_ENV !== "production" &&
    process.env[TEMP_REJECTED_ADVISER_TEXT_ENV] === "true";
}

/**
 * TODO(TEMPORARY SENSITIVE DIAGNOSTIC): remove this flag, callback, and log
 * path after adviser safety false positives are diagnosed and before release.
 */
export function logTemporaryRejectedAdviserText(
  requestLogger: RequestScopedWarningLogger,
  diagnostic: RejectedAdviserTextDiagnostic,
): boolean {
  if (!temporaryRejectedAdviserTextLoggingEnabled()) return false;
  const adviserText = diagnostic.text.slice(0, MAX_LOGGED_ADVISER_TEXT_LENGTH);
  requestLogger.warn({
    adviserText,
    originalLength: diagnostic.originalLength,
    truncated: diagnostic.truncated || adviserText.length < diagnostic.text.length ||
      diagnostic.originalLength > MAX_LOGGED_ADVISER_TEXT_LENGTH,
    agent: diagnostic.agent,
    phase: diagnostic.phase,
    field: diagnostic.field,
    attempt: diagnostic.attempt,
    ...(diagnostic.workflowId ? { workflowId: diagnostic.workflowId } : {}),
    ...(diagnostic.requestId ? { requestId: diagnostic.requestId } : {}),
  }, "TEMPORARY SENSITIVE DIAGNOSTIC: rejected adviser text after safety-screen-empty");
  return true;
}