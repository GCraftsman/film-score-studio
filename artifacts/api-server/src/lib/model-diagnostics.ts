/**
 * Bounded, content-free diagnostics for model completions.
 *
 * Diagnostics intentionally do not retain JSON.parse's error, prompts, or
 * response fields other than the small metadata allowlist below. A provider
 * response is untrusted data and can contain musical notes, user text,
 * credentials, or an accidental copy of a prompt. A non-enumerable response
 * string may be held only transiently by a ModelResponseError so the bounded
 * repair prompt can preserve an otherwise valid musical batch; it is never
 * part of the diagnostic or public/logged error.
 */

export type ProviderUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ProviderCompletionMetadata = {
  finishReason?: string;
  usage?: ProviderUsage;
  model?: string;
  providerRequestId?: string;
};

export type ModelCompletion = {
  content: string;
  metadata?: ProviderCompletionMetadata;
};

export type ModelResponseFailureCode =
  | "invalid-json"
  | "non-object-json"
  | "missing-operations"
  | "wrong-operations-type"
  | "empty-completion"
  | "provider-token-limit"
  | "provider-request-timeout"
  | "provider-refusal"
  | "provider-finish-reason";

export type EnvelopeShape = {
  keys: string[];
  types: Record<string, string>;
  unknownKeyCount: number;
};

export type ModelResponseDiagnostic = {
  code: ModelResponseFailureCode;
  reason: string;
  responseChars: number;
  envelope: EnvelopeShape;
  /** The bounded completion budget used for the failed request. */
  requestedTokens?: number;
  provider?: ProviderCompletionMetadata;
};

export type ModelCallStage = "initial" | "read" | "relay" | "repair";

export type ModelCallContext = {
  stage: ModelCallStage;
  agent?: string;
  taskId?: string;
  attempt?: string;
  /** Bounded request budget; safe to include in diagnostics and logs. */
  maxTokens?: number;
};

const MAX_MODEL_NAME = 96;
const MAX_REQUEST_ID = 128;
const MAX_FINISH_REASON = 40;
const MAX_ENVELOPE_KEYS = 24;
const MAX_USAGE = 1_000_000_000;
const TOKEN_LIMIT_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "token_limit",
  "token-limit",
]);

// Envelope keys are useful for debugging schema drift, but arbitrary keys can
// contain user content or secrets. Keep only keys from the response contracts.
const SAFE_ENVELOPE_KEYS = new Set([
  "response",
  "safeText",
  "intent",
  "tasks",
  "compact",
  "granularity",
  "taskMode",
  "summary",
  "operations",
  "editedFiles",
  "readRequests",
  "questions",
  "reply",
  "revision",
  "insight",
  "feedback",
  "needsRefinement",
  "affectedTrackIds",
  "pass",
  "reason",
  "correctionAgents",
  "winner",
  "styleSuggestions",
  "trackProposals",
  "membershipProposals",
  "instrumentNeeds",
  "instrumentProposals",
  "trackMembership",
  "trackAdditions",
  "trackDeletions",
  "trackChanges",
  "edits",
  "changes",
  "privateTrackFiles",
]);

function boundedToken(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > limit || !/^[a-z0-9._:-]+$/.test(normalized)) return undefined;
  return normalized;
}


function boundedProviderId(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > limit || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) return undefined;
  return normalized;
}

function boundedUsage(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const result: ProviderUsage = {};
  for (const [target, source] of [
    ["promptTokens", "prompt_tokens"],
    ["completionTokens", "completion_tokens"],
    ["totalTokens", "total_tokens"],
  ] as const) {
    const count = usage[source] ?? usage[target];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= MAX_USAGE) {
      result[target] = count;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Keep provider metadata safe enough to put in a structured log. Unknown
 * fields are deliberately ignored rather than copied through.
 */
export function safeProviderMetadata(value: unknown): ProviderCompletionMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  const result: ProviderCompletionMetadata = {};
  const rawFinishReason = metadata.finishReason ?? metadata.finish_reason;
  const finishReason = typeof rawFinishReason === "string" && rawFinishReason.trim()
    ? boundedToken(rawFinishReason, MAX_FINISH_REASON) ?? "other"
    : undefined;
  const model = boundedProviderId(metadata.model, MAX_MODEL_NAME);
  const providerRequestId = boundedProviderId(
    metadata.providerRequestId ?? metadata.provider_request_id ?? metadata.requestId ?? metadata.id,
    MAX_REQUEST_ID,
  );
  const usage = boundedUsage(metadata.usage);
  if (finishReason) result.finishReason = finishReason;
  if (model) result.model = model;
  if (providerRequestId) result.providerRequestId = providerRequestId;
  if (usage) result.usage = usage;
  return Object.keys(result).length ? result : undefined;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

export function envelopeShape(value: unknown): EnvelopeShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { keys: [], types: {}, unknownKeyCount: 0 };
  }
  const record = value as Record<string, unknown>;
  const keys: string[] = [];
  const types: Record<string, string> = {};
  let unknownKeyCount = 0;
  for (const key of Object.keys(record)) {
    if (!SAFE_ENVELOPE_KEYS.has(key)) {
      if (unknownKeyCount < MAX_ENVELOPE_KEYS) unknownKeyCount += 1;
      continue;
    }
    if (keys.length >= MAX_ENVELOPE_KEYS) continue;
    keys.push(key);
    types[key] = valueType(record[key]);
  }
  return { keys, types, unknownKeyCount };
}

function baseDiagnostic(
  code: ModelResponseFailureCode,
  reason: string,
  responseChars: number,
  value?: unknown,
  provider?: ProviderCompletionMetadata,
): ModelResponseDiagnostic {
  return {
    code,
    reason,
    responseChars: Math.max(0, Math.min(Math.floor(responseChars), 10_000_000)),
    envelope: envelopeShape(value),
    ...(provider ? { provider } : {}),
  };
}

export class ModelResponseError extends Error {
  readonly diagnostic: ModelResponseDiagnostic;
  /**
   * Kept non-enumerable and only for the bounded repair prompt. Never include
   * this field in a log or public error. It is intentionally absent from the
   * diagnostic object.
   */
  rawResponse?: string;

  constructor(diagnostic: ModelResponseDiagnostic) {
    super(diagnostic.reason);
    this.name = "ModelResponseError";
    this.diagnostic = diagnostic;
  }
}

export function attachRawResponse(error: ModelResponseError, raw: string): void {
  Object.defineProperty(error, "rawResponse", {
    configurable: true,
    enumerable: false,
    value: raw,
    writable: false,
  });
}

export function emptyCompletionDiagnostic(
  responseChars = 0,
  provider?: ProviderCompletionMetadata,
): ModelResponseDiagnostic {
  return baseDiagnostic(
    "empty-completion",
    "The specialist returned an empty completion.",
    responseChars,
    undefined,
    provider,
  );
}

export function providerFinishReasonDiagnostic(
  finishReason: string,
  responseChars: number,
  provider?: ProviderCompletionMetadata,
): ModelResponseDiagnostic {
  const code: ModelResponseFailureCode = TOKEN_LIMIT_FINISH_REASONS.has(finishReason)
    ? "provider-token-limit"
    : finishReason === "refusal"
      ? "provider-refusal"
      : "provider-finish-reason";
  const reason = code === "provider-token-limit"
    ? "The provider stopped at its completion token limit before returning a complete response. No partial musical response was accepted; retry with a shorter scope or a more concise request."
    : code === "provider-refusal"
      ? "The provider refused to return a completion."
      : "The provider returned a non-success completion finish reason.";
  return baseDiagnostic(code, reason, responseChars, undefined, provider);
}

/**
 * A request deadline contains no provider response and therefore cannot carry
 * response text, envelope fields, or partial musical content into diagnostics.
 */
export function providerRequestTimeoutDiagnostic(): ModelResponseDiagnostic {
  return baseDiagnostic(
    "provider-request-timeout",
    "The provider request exceeded its bounded deadline before returning a response.",
    0,
  );
}

/**
 * Normalize either a legacy string model result or the optional detailed
 * result. Detailed completions are preferred, while old test and service
 * models that return strings remain supported.
 */
export function normalizeModelCompletion(value: unknown): ModelCompletion {
  if (typeof value === "string") return { content: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { content: "", metadata: undefined };
  }
  const result = value as Record<string, unknown>;
  const content = typeof result.content === "string"
    ? result.content
    : typeof result.text === "string"
      ? result.text
      : typeof result.raw === "string"
        ? result.raw
      : "";
  return {
    content,
    metadata: safeProviderMetadata(result.metadata ?? result),
  };
}

export function parseModelJson(
  raw: string,
  options: { requireOperations?: boolean; provider?: ProviderCompletionMetadata } = {},
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Never retain or expose SyntaxError.message: some runtimes include a
    // response excerpt in it.
    throw new ModelResponseError(baseDiagnostic(
      "invalid-json",
      "The specialist returned invalid JSON.",
      raw.length,
      undefined,
      options.provider,
    ));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelResponseError(baseDiagnostic(
      "non-object-json",
      "The specialist returned JSON that was not an object.",
      raw.length,
      parsed,
      options.provider,
    ));
  }
  const object = parsed as Record<string, unknown>;
  if (options.requireOperations && !Object.prototype.hasOwnProperty.call(object, "operations")) {
    throw new ModelResponseError(baseDiagnostic(
      "missing-operations",
      "The specialist response object did not include operations.",
      raw.length,
      object,
      options.provider,
    ));
  }
  if (options.requireOperations && !Array.isArray(object.operations)) {
    throw new ModelResponseError(baseDiagnostic(
      "wrong-operations-type",
      "The specialist response operations field was not an array.",
      raw.length,
      object,
      options.provider,
    ));
  }
  return object;
}

export function throwForCompletionFailure(
  completion: ModelCompletion,
): void {
  const provider = completion.metadata;
  const responseChars = completion.content.length;
  const finishReason = provider?.finishReason;
  if (finishReason && finishReason !== "stop") {
    throw new ModelResponseError(providerFinishReasonDiagnostic(finishReason, responseChars, provider));
  }
  if (!completion.content.trim()) {
    throw new ModelResponseError(emptyCompletionDiagnostic(responseChars, provider));
  }
}

export function diagnosticSummary(
  diagnostic: { reason: string; code: string; requestedTokens?: number },
  context: ModelCallContext,
): string {
  const specialist = context.agent ? `Specialist ${context.agent}` : "The scoring provider";
  const attempt = context.attempt ? ` (attempt ${context.attempt})` : "";
  const budget = diagnostic.requestedTokens !== undefined
    ? ` Requested completion budget: ${diagnostic.requestedTokens} tokens.`
    : "";
  return `${specialist} returned ${diagnostic.code} during ${context.stage}${attempt}: ${diagnostic.reason}${budget}`;
}
