import assert from "node:assert/strict";
import test from "node:test";
import { DirectXaiProvider, createXaiProvider } from "./xai-provider.ts";

test("direct provider targets the xAI API with bearer auth for relative paths", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const provider = new DirectXaiProvider("sk-test-key", "https://api.x.ai", fakeFetch);
  const proxyFetch = provider.createProxyFetch("xai");
  await proxyFetch("/v1/language-models", { method: "GET" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/language-models");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-test-key");
});

test("direct provider preserves caller headers and trims a trailing base slash", async () => {
  let observed: { url: string; init?: RequestInit } | undefined;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    observed = { url: String(url), init };
    return new Response("{}");
  }) as typeof fetch;

  const provider = new DirectXaiProvider("sk-test-key", "https://api.x.ai/", fakeFetch);
  const proxyFetch = provider.createProxyFetch("xai");
  await proxyFetch("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(observed?.url, "https://api.x.ai/v1/chat/completions");
  const headers = new Headers(observed?.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer sk-test-key");
});

test("createXaiProvider prefers the direct key when XAI_API_KEY is set", () => {
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "sk-test-key";
  try {
    assert.ok(createXaiProvider() instanceof DirectXaiProvider);
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test("createXaiProvider falls back to the Replit connector without a key", () => {
  const previous = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    assert.equal(createXaiProvider() instanceof DirectXaiProvider, false);
  } finally {
    if (previous !== undefined) process.env.XAI_API_KEY = previous;
  }
});
