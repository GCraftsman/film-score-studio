import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelResponseError,
  parseModelJson,
  providerRequestTimeoutDiagnostic,
  throwForCompletionFailure,
} from "./model-diagnostics.ts";

test("keeps truncated JSON distinct from a non-object response without exposing parser text", () => {
  const raw = `{"operations":[{"summary":"private MIDI note pitch 60"}]`;
  assert.throws(
    () => parseModelJson(raw, { requireOperations: true }),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "invalid-json" &&
      error.diagnostic.responseChars === raw.length &&
      error.diagnostic.envelope.keys.length === 0 &&
      !error.message.includes(raw) &&
      !error.message.includes("pitch 60"),
  );
  assert.throws(
    () => parseModelJson("[1,2,3]", { requireOperations: true }),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "non-object-json",
  );
});

test("distinguishes missing operations from an operations value with the wrong type", () => {
  assert.throws(
    () => parseModelJson('{"summary":"safe"}', { requireOperations: true }),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "missing-operations",
  );
  assert.throws(
    () => parseModelJson('{"operations":{"id":"secret"}}', { requireOperations: true }),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "wrong-operations-type" &&
      error.diagnostic.envelope.types.operations === "object",
  );
});

test("classifies empty and provider-truncated completions while preserving bounded metadata", () => {
  assert.throws(
    () => throwForCompletionFailure({
      content: "partial response",
      metadata: {
        finishReason: "length",
        model: "grok-4-fast",
        providerRequestId: "req-123",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
    }),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "provider-token-limit" &&
      error.diagnostic.provider?.finishReason === "length" &&
      error.diagnostic.provider?.usage?.completionTokens === 20,
  );
  assert.throws(
    () => throwForCompletionFailure({ content: " \n", metadata: { finishReason: "stop" } }),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "empty-completion",
  );
});

test("does not retain arbitrary envelope keys or response values in diagnostics", () => {
  const raw = JSON.stringify({
    operations: [],
    promptEchoWithSecret: "Authorization: Bearer should-not-appear",
    notes: [{ pitch: 60, velocity: 80 }],
  });
  assert.throws(
    () => parseModelJson(raw.slice(0, -1), { requireOperations: true }),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.envelope.keys.length === 0 &&
      error.diagnostic.envelope.unknownKeyCount === 0 &&
      !JSON.stringify(error.diagnostic).includes("Bearer") &&
      !JSON.stringify(error.diagnostic).includes("pitch"),
  );
});

test("represents provider request timeout as content-free diagnostics", () => {
  const diagnostic = providerRequestTimeoutDiagnostic();
  assert.deepEqual(diagnostic, {
    code: "provider-request-timeout",
    reason: "The provider request exceeded its bounded deadline before returning a response.",
    responseChars: 0,
    envelope: { keys: [], types: {}, unknownKeyCount: 0 },
  });
  const error = new ModelResponseError(diagnostic);
  assert.equal(error.message.includes("response"), true);
  assert.equal(JSON.stringify(error.diagnostic).includes("partial"), false);
});