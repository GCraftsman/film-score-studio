import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  AI_MUSIC_SAFETY_POLICY,
} from "./ai-music-safety.ts";
import {
  ModelResponseError,
  providerRequestTimeoutDiagnostic,
  safeProviderMetadata,
  type ModelCompletion,
} from "./model-diagnostics.ts";
import type { ModelMessage } from "./composition-workflow.ts";
import {
  CHAT_MAX_ATTEMPTS,
  parseRetryAfter,
  providerRequestTimeoutMs,
  retryDelayMs,
  xaiLaunchLimiter,
} from "./chat-limiter.ts";

export { providerRequestTimeoutMs };
export type ProviderFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function isProviderTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  // AbortSignal.timeout() uses TimeoutError in Node. The AbortError branch
  // covers fetch implementations that normalize timeout reasons while still
  // requiring an explicit timeout-shaped error rather than catching failures
  // from unrelated provider work.
  return name === "TimeoutError" ||
    (name === "AbortError" && /timeout|timed out/i.test(String((error as { message?: unknown }).message ?? "")));
}

/**
 * Execute one bounded xAI completion. Timeout failures are surfaced as a
 * content-free model diagnostic so the composition workflow, rather than this
 * transport helper, owns its two recovery attempts.
 */
export async function chatDetailed(
  connectors: ReplitConnectors,
  model: string,
  messages: ModelMessage[],
  maxTokens: number,
  jsonMode = false,
  injectedProxyFetch?: ProviderFetch,
): Promise<ModelCompletion> {
  const body = JSON.stringify({
    model,
    messages: [{ role: "system", content: AI_MUSIC_SAFETY_POLICY }, ...messages],
    temperature: 0.45,
    max_completion_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
  const proxyFetch = injectedProxyFetch ?? connectors.createProxyFetch("xai");
  for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt += 1) {
    const requestSignal = AbortSignal.timeout(providerRequestTimeoutMs(maxTokens));
    try {
      const response = await xaiLaunchLimiter.schedule(() => proxyFetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: requestSignal,
      }));
      if (response.ok) {
        const payload = await response.json() as {
          id?: unknown;
          model?: unknown;
          usage?: unknown;
          choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
        };
        const choice = payload.choices?.[0];
        const providerRequestId = response.headers.get("x-request-id")
          ?? response.headers.get("request-id")
          ?? response.headers.get("xai-request-id")
          ?? undefined;
        const metadata = safeProviderMetadata({
          finishReason: choice?.finish_reason,
          usage: payload.usage,
          model: payload.model,
          providerRequestId: providerRequestId ?? payload.id,
        });
        const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
        if (choice?.message?.refusal) {
          return {
            content,
            metadata: { ...metadata, finishReason: "refusal" },
          };
        }
        return { content, metadata };
      }
      // Do not include provider response bodies in errors or logs. They can
      // contain prompt echoes, user text, or secret-bearing diagnostics.
      await response.arrayBuffer();
      if (response.status === 429 && attempt < CHAT_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, parseRetryAfter(response.headers.get("retry-after")))));
        continue;
      }
      throw new Error(`xAI completion failed (${response.status})`);
    } catch (error) {
      // Keep acquisition and body decoding in the same timeout boundary. Do
      // not consume the workflow's two recovery attempts in this transport
      // layer. Other provider failures retain their existing behavior.
      if (isProviderTimeout(error) || requestSignal.aborted) {
        throw new ModelResponseError(providerRequestTimeoutDiagnostic());
      }
      throw error;
    }
  }
  throw new Error("xAI completion retry budget exhausted");
}