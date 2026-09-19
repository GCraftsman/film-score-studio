import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, projectsTable } from "@workspace/db";
import type { TerminalComposeAudit } from "../routes/compose-diagnostics";

/**
 * Terminal audits are deliberately kept in the project document instead of a
 * second table. They describe a rejected staged candidate, not committed score
 * material. Keep this bound in one place because both audit appends and normal
 * document saves must enforce it.
 */
export const MAX_TERMINAL_AUDITS = 20;

const AUDIT_ID_MAX_LENGTH = 800;
const AUDIT_REASON_MAX_LENGTH = 10_000;
const AUDIT_EVIDENCE_MAX_ITEMS = 8;
const AUDIT_EVIDENCE_MAX_LENGTH = 5_000;
const AUDIT_SCOPE_MAX_ITEMS = 16;
const AUDIT_SCOPE_MAX_LENGTH = 800;
const AUDIT_CONSTRAINT_MAX_LENGTH = 10_000;

const terminalAuditCategory = z.enum(["malformed", "musical-rejection", "no-op", "unknown"]);
const terminalAuditCommitStatus = z.enum(["not-committed", "unchanged", "committed"]);

export type TerminalAudit = {
  workflowId: string;
  requestId: string;
  reason: string;
  evidence: string[];
  evaluatorCategory: z.infer<typeof terminalAuditCategory>;
  affectedScope: string[];
  expected?: string;
  observed?: string;
  candidateRevision?: number | string;
  correctionOutcome: string;
  commitStatus: z.infer<typeof terminalAuditCommitStatus>;
};

export class TerminalAuditValidationError extends Error {
  constructor(message = "Terminal audit was malformed or exceeded its bounds.") {
    super(message);
    this.name = "TerminalAuditValidationError";
  }
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result ? result.slice(0, maxLength) : undefined;
}

function textArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (values.length > maxItems) return undefined;
  const result = values.map((item) => text(item, maxLength));
  return result.every((item): item is string => Boolean(item)) ? result : undefined;
}

function constraint(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const values = textArray(value, AUDIT_EVIDENCE_MAX_ITEMS, AUDIT_CONSTRAINT_MAX_LENGTH);
    return values?.length ? values.join(" | ").slice(0, AUDIT_CONSTRAINT_MAX_LENGTH) : undefined;
  }
  return text(value, AUDIT_CONSTRAINT_MAX_LENGTH);
}

function category(value: unknown): TerminalAudit["evaluatorCategory"] | undefined {
  if (value === "no-musical-change") return "no-op";
  return terminalAuditCategory.safeParse(value).success
    ? value as TerminalAudit["evaluatorCategory"]
    : undefined;
}

/**
 * Whitelist the safe, content-free terminal-audit contract. In particular,
 * provider payloads, prompts, MIDI, credentials, and arbitrary nested request
 * data are never copied into the project JSONB.
 *
 * The workflow currently exposes expectedConstraints/observedConstraints and
 * no-musical-change internally; accept those names at this boundary while
 * storing the compact client-facing expected/observed and no-op forms.
 */
export function normalizeTerminalAudit(input: unknown): TerminalAudit {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TerminalAuditValidationError();
  }
  const value = input as Record<string, unknown>;
  const workflowId = text(value.workflowId, AUDIT_ID_MAX_LENGTH);
  // pino-http supplies request IDs in production, but a direct/test request
  // can legitimately omit one. Keep that fact explicit rather than dropping
  // an otherwise useful terminal audit.
  const requestId = text(value.requestId, AUDIT_ID_MAX_LENGTH) ?? "unavailable";
  const reason = text(value.reason, AUDIT_REASON_MAX_LENGTH);
  const evidence = textArray(value.evidence, AUDIT_EVIDENCE_MAX_ITEMS, AUDIT_EVIDENCE_MAX_LENGTH);
  const evaluatorCategory = category(value.evaluatorCategory ?? value.evaluationKind);
  const affectedScope = textArray(
    value.affectedScope ?? (
      value.scope === undefined
        ? undefined
        : [
          value.scope,
          ...(value.trackId === undefined ? [] : [`track:${String(value.trackId)}`]),
        ]
    ),
    AUDIT_SCOPE_MAX_ITEMS,
    AUDIT_SCOPE_MAX_LENGTH,
  );
  const expected = constraint(value.expected ?? value.expectedConstraints);
  const observed = constraint(value.observed ?? value.observedConstraints);
  const correctionOutcome = text(value.correctionOutcome, AUDIT_REASON_MAX_LENGTH);
  const commitStatus = terminalAuditCommitStatus.safeParse(value.commitStatus).success
    ? value.commitStatus as TerminalAudit["commitStatus"]
    : undefined;
  const candidateRevision = value.candidateRevision === undefined
    ? undefined
    : typeof value.candidateRevision === "number" &&
      Number.isInteger(value.candidateRevision) &&
      value.candidateRevision >= 0
      ? value.candidateRevision
      : text(value.candidateRevision, AUDIT_ID_MAX_LENGTH);

  if (!workflowId || !requestId || !reason || !evidence || !evaluatorCategory ||
    !affectedScope || !correctionOutcome || !commitStatus ||
    (value.expected !== undefined && !expected) ||
    (value.expectedConstraints !== undefined && !expected) ||
    (value.observed !== undefined && !observed) ||
    (value.observedConstraints !== undefined && !observed) ||
    (value.candidateRevision !== undefined && candidateRevision === undefined)) {
    throw new TerminalAuditValidationError();
  }

  return {
    workflowId,
    requestId,
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

/**
 * Return the current row's terminalAudits as an array. Invalid/missing legacy
 * values are treated as empty, while the outer bounded expression below keeps
 * even client-supplied legacy arrays at the server's 20-entry limit.
 */
function currentTerminalAudits(): SQL {
  return sql`CASE
    WHEN jsonb_typeof(${projectsTable.document}->'terminalAudits') = 'array'
      THEN ${projectsTable.document}->'terminalAudits'
    ELSE '[]'::jsonb
  END`;
}

function boundedTerminalAudits(source: SQL): SQL {
  return sql`(
    SELECT COALESCE(jsonb_agg(entry ORDER BY ordinal), '[]'::jsonb)
    FROM (
      SELECT entry, ordinal
      FROM jsonb_array_elements(${source}) WITH ORDINALITY AS entries(entry, ordinal)
      ORDER BY ordinal DESC
      LIMIT ${MAX_TERMINAL_AUDITS}
    ) AS bounded
  )`;
}

/**
 * Build the JSONB expression used by ordinary project PATCH saves. The
 * submitted document is the candidate body, but terminalAudits always come
 * from the row being updated. This makes a stale client save unable to erase
 * an audit appended concurrently by a failed compose request.
 */
export function preserveLatestTerminalAudits(document: Record<string, unknown>): SQL {
  return sql`jsonb_set(
    ${JSON.stringify(document)}::jsonb,
    '{terminalAudits}',
    ${boundedTerminalAudits(currentTerminalAudits())},
    true
  )`;
}

/**
 * Append one safe audit with a single owner-scoped UPDATE. PostgreSQL's row
 * lock and jsonb_set expression make concurrent appends atomic without
 * touching score, project version, or updated_at.
 *
 * `false` means the owner/project pair did not identify an owned project. It
 * is intentionally not an exception: composition failure handling must never
 * replace its original error with an audit lookup error.
 */
export async function persistTerminalAudit(
  ownerId: string,
  projectId: string,
  audit: TerminalComposeAudit | TerminalAudit,
): Promise<boolean> {
  if (!ownerId || !z.string().uuid().safeParse(projectId).success) {
    return false;
  }
  const normalized = normalizeTerminalAudit(audit);
  const nextAudits = boundedTerminalAudits(sql`${currentTerminalAudits()} || jsonb_build_array(${JSON.stringify(normalized)}::jsonb)`);
  const [updated] = await db.update(projectsTable).set({
    document: sql`jsonb_set(
      COALESCE(${projectsTable.document}, '{}'::jsonb),
      '{terminalAudits}',
      ${nextAudits},
      true
    )`,
  }).where(and(
    eq(projectsTable.id, projectId),
    eq(projectsTable.ownerId, ownerId),
  )).returning({ id: projectsTable.id });
  return Boolean(updated);
}

/**
 * Explicit ownership check for callers that need to distinguish a missing
 * project from a malformed audit before doing other work. The persistence
 * update above still performs its own atomic ownership check.
 */
export async function projectBelongsToOwner(ownerId: string, projectId: string): Promise<boolean> {
  if (!ownerId || !z.string().uuid().safeParse(projectId).success) return false;
  const [project] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(
    eq(projectsTable.id, projectId),
    eq(projectsTable.ownerId, ownerId),
  )).limit(1);
  return Boolean(project);
}