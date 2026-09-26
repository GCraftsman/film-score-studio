import { ReplitConnectors } from "@replit/connectors-sdk";
import type { ProviderFetch } from "./xai-chat-completion.ts";

/**
 * The composition workflow only needs a proxy-fetch factory for the "xai"
 * service. Both the Replit connector and the direct-key provider satisfy this
 * contract, so the workflow stays agnostic to which one is active.
 */
export interface XaiProvider {
  createProxyFetch(service: string): ProviderFetch;
}

const DEFAULT_XAI_BASE_URL = "https://api.x.ai";

function resolveDirectBaseUrl(): string {
  const configured = process.env.XAI_API_BASE_URL?.trim();
  return (configured ? configured : DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
}

/**
 * Talks to the xAI REST API directly with a bearer key instead of routing
 * through Replit's connector proxy. It mirrors the connector's proxy-fetch
 * contract: callers pass API-relative paths such as "/v1/chat/completions"
 * and "/v1/language-models", and the bearer credential is injected here.
 */
export class DirectXaiProvider implements XaiProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    apiKey: string,
    baseUrl: string = resolveDirectBaseUrl(),
    fetchImpl: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  createProxyFetch(_service: string): ProviderFetch {
    return (input, init) => {
      const url = /^https?:\/\//i.test(input)
        ? input
        : `${this.baseUrl}${input.startsWith("/") ? "" : "/"}${input}`;
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${this.apiKey}`);
      return this.fetchImpl(url, { ...init, headers });
    };
  }
}

/**
 * Prefer a direct xAI connection when XAI_API_KEY is configured; otherwise fall
 * back to the Replit connector so the app keeps working unchanged inside Replit.
 */
export function createXaiProvider(): XaiProvider {
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (apiKey) return new DirectXaiProvider(apiKey);
  return new ReplitConnectors();
}
