import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { MidiSnippet } from "@workspace/api-zod";

export type ApprovalContextValue = {
  originalMessage: string;
  originalHistory: unknown[];
  originalMidi: MidiSnippet[];
  selectedStyle?: string;
  adviserRoster: unknown[];
  adviserConsultations: unknown[];
  consumedBudget: {
    adviserConsultationsUsed: number;
    trackWriterRoundsUsed: number;
    refinementRoundsUsed: number;
    operationRepairAttemptsUsed: number;
  };
};

export type SignedApprovalContext = ApprovalContextValue & {
  checkpointId: string;
  offeredTrackProposals: unknown[];
  declinedTrackProposals: unknown[];
  accumulatedApprovedTrackProposals: unknown[];
  signature: string;
};

export class ApprovalContextIntegrityError extends Error {
  constructor(message = "The saved approval checkpoint could not be verified. Request a new composition plan before approving tracks.") {
    super(message);
    this.name = "ApprovalContextIntegrityError";
  }
}

function canonicalJson(value: unknown): string {
  // Match JSON transport semantics exactly: undefined object members disappear
  // and undefined array entries become null before a browser persists/reloads
  // the checkpoint.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function approvalSecret(): string {
  // CLERK_SECRET_KEY is already required to authenticate production requests.
  // Deployments may set the dedicated key to rotate approval signatures without
  // rotating Clerk credentials.
  const secret = process.env.COMPOSITION_APPROVAL_HMAC_SECRET ?? process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new ApprovalContextIntegrityError("Secure approval checkpoints are unavailable because the server signing secret is not configured.");
  }
  return secret;
}

function signaturePayload(
  userId: string,
  context: ApprovalContextValue,
  score: unknown,
  offeredTrackProposals: unknown[],
  checkpointId: string,
  declinedTrackProposals: unknown[],
  accumulatedApprovedTrackProposals: unknown[],
) {
  return {
    version: 1,
    userId,
    context,
    score,
    offeredTrackProposals,
    checkpointId,
    declinedTrackProposals,
    accumulatedApprovedTrackProposals,
  };
}

function sign(payload: unknown, secret = approvalSecret()): string {
  return createHmac("sha256", secret).update(canonicalJson(payload)).digest("hex");
}

function equalSignature(expected: string, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

export function signApprovalContext(
  context: ApprovalContextValue,
  userId: string,
  score: unknown,
  offeredTrackProposals: unknown[],
  declinedTrackProposals: unknown[] = [],
  accumulatedApprovedTrackProposals: unknown[] = [],
): SignedApprovalContext {
  const checkpointId = randomUUID();
  return {
    ...context,
    checkpointId,
    offeredTrackProposals,
    declinedTrackProposals,
    accumulatedApprovedTrackProposals,
    signature: sign(signaturePayload(
      userId, context, score, offeredTrackProposals, checkpointId, declinedTrackProposals, accumulatedApprovedTrackProposals,
    )),
  };
}

export function verifyApprovalContext(
  context: SignedApprovalContext,
  userId: string,
  score: unknown,
): {
  context: ApprovalContextValue;
  checkpointId: string;
  offeredTrackProposals: unknown[];
  declinedTrackProposals: unknown[];
  accumulatedApprovedTrackProposals: unknown[];
} {
  const {
    signature, checkpointId, offeredTrackProposals, declinedTrackProposals, accumulatedApprovedTrackProposals, ...unsigned
  } = context;
  const expected = sign(signaturePayload(
    userId, unsigned, score, offeredTrackProposals, checkpointId, declinedTrackProposals, accumulatedApprovedTrackProposals,
  ));
  if (!equalSignature(expected, signature)) throw new ApprovalContextIntegrityError();
  return { context, checkpointId, offeredTrackProposals, declinedTrackProposals, accumulatedApprovedTrackProposals };
}

/**
 * The signed offer may be approved in whole or in part, but each submitted
 * proposal must exactly match one server-signed offer. This prevents modified
 * instruments, track ids, or proposal summaries from piggybacking on a valid
 * checkpoint.
 */
export function assertApprovedProposalSubset(
  selectedProposals: unknown[] | undefined,
  selectedIds: string[] | undefined,
  offeredTrackProposals: unknown[],
): void {
  if (!selectedProposals || !selectedIds || selectedProposals.length !== selectedIds.length) {
    throw new ApprovalContextIntegrityError("The approval selection did not match its saved checkpoint.");
  }
  const ids = new Set(selectedIds);
  if (ids.size !== selectedIds.length) throw new ApprovalContextIntegrityError("The approval selection contained duplicate proposal IDs.");
  const offeredById = new Map<string, string>();
  for (const proposal of offeredTrackProposals) {
    if (!proposal || typeof proposal !== "object" || typeof (proposal as Record<string, unknown>).id !== "string") {
      throw new ApprovalContextIntegrityError();
    }
    offeredById.set((proposal as Record<string, unknown>).id as string, canonicalJson(proposal));
  }
  for (const proposal of selectedProposals) {
    if (!proposal || typeof proposal !== "object") throw new ApprovalContextIntegrityError("The approval selection was malformed.");
    const id = (proposal as Record<string, unknown>).id;
    if (typeof id !== "string" || !ids.has(id) || offeredById.get(id) !== canonicalJson(proposal)) {
      throw new ApprovalContextIntegrityError("The approval selection no longer matches the server-signed proposal.");
    }
  }
}

/**
 * The caller supplies an atomic durable claim (the route uses INSERT ... ON
 * CONFLICT DO NOTHING). Keeping the decision here makes replay behavior
 * directly testable without a database connection.
 */
export async function consumeApprovalCheckpoint(
  claim: () => Promise<boolean>,
): Promise<void> {
  if (!await claim()) {
    throw new ApprovalContextIntegrityError("This approval checkpoint was already consumed. Generate a new composition plan before trying again.");
  }
}

function membershipIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proposal = value as Record<string, unknown>;
  if ((proposal.action !== "add" && proposal.action !== "delete") || typeof proposal.instrument !== "string") return undefined;
  const trackId = proposal.action === "delete" && typeof proposal.trackId === "string" ? proposal.trackId.trim() : "";
  return `${proposal.action}|${proposal.instrument.trim().toLowerCase()}|${trackId}`;
}

export function distinctMembershipProposals(proposals: unknown[]): unknown[] {
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    const identity = membershipIdentity(proposal);
    return Boolean(identity) && !seen.has(identity!) && (seen.add(identity!), true);
  });
}

export function accumulateApprovedMembershipProposals(
  previous: unknown[],
  current: unknown[],
): unknown[] {
  const ids = new Set<string>();
  const identities = new Set<string>();
  const result: unknown[] = [];
  for (const proposal of [...previous, ...current]) {
    const identity = membershipIdentity(proposal);
    const id = proposal && typeof proposal === "object" ? (proposal as Record<string, unknown>).id : undefined;
    if (!identity || typeof id !== "string" || !id || ids.has(id) || identities.has(identity)) {
      throw new ApprovalContextIntegrityError("The accumulated approved membership was invalid. Request a new composition plan.");
    }
    ids.add(id);
    identities.add(identity);
    result.push(proposal);
  }
  return result;
}

/**
 * A model can accidentally reuse an earlier proposal id. Exact reissues are
 * already-authorized membership and are omitted; a different proposal must
 * remain visible for a new explicit decision, so it receives a fresh id
 * rather than being swallowed by an id-only filter.
 */
export function reconcileNewMembershipProposals(
  proposed: unknown[],
  accumulated: unknown[],
): unknown[] {
  const byId = new Map<string, unknown>();
  const usedIds = new Set<string>();
  for (const proposal of accumulated) {
    const id = proposal && typeof proposal === "object" ? (proposal as Record<string, unknown>).id : undefined;
    if (typeof id === "string" && id) {
      byId.set(id, proposal);
      usedIds.add(id);
    }
  }

  return proposed.flatMap((proposal) => {
    const id = proposal && typeof proposal === "object" ? (proposal as Record<string, unknown>).id : undefined;
    if (typeof id !== "string" || !id) return [proposal];
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, proposal);
      usedIds.add(id);
      return [proposal];
    }
    if (canonicalJson(existing) === canonicalJson(proposal)) return [];

    let replacementId = `proposal-${randomUUID()}`;
    while (usedIds.has(replacementId)) replacementId = `proposal-${randomUUID()}`;
    const reissued = { ...(proposal as Record<string, unknown>), id: replacementId };
    byId.set(replacementId, reissued);
    usedIds.add(replacementId);
    return [reissued];
  });
}

/**
 * A partial approval is also an explicit rejection of the other offered
 * members. Do not surface the same member as a fresh automatic proposal on
 * the continuation; a later composer request may intentionally open a new
 * plan and offer it again.
 */
export function suppressRejectedMembershipProposals(
  proposed: unknown[],
  declined: unknown[],
): { allowed: unknown[]; suppressed: unknown[] } {
  const declinedIdentities = new Set(declined.map(membershipIdentity).filter((value): value is string => Boolean(value)));
  const allowed: unknown[] = [];
  const suppressed: unknown[] = [];
  for (const proposal of proposed) {
    if (declinedIdentities.has(membershipIdentity(proposal) ?? "")) suppressed.push(proposal);
    else allowed.push(proposal);
  }
  return { allowed, suppressed };
}