import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { composeRequestAbortController } from "../lib/compose-cancellation.ts";
import {
  composeRequestId,
  createComposeDiagnosticSink,
  terminalComposeAudit,
} from "./compose-diagnostics.ts";
import { chatDetailed, providerRequestTimeoutMs } from "../lib/xai-chat-completion.ts";
import { ModelResponseError } from "../lib/model-diagnostics.ts";
import type { WorkflowDiagnostic } from "../lib/composition-workflow.ts";

test("compose diagnostics retain numeric request correlation and emit exactly once for every phase", () => {
  assert.equal(composeRequestId(42), "42");
  assert.equal(composeRequestId("request-7"), "request-7");
  assert.equal(composeRequestId(undefined), undefined);

  const logs: Array<{ requestId: string | undefined; workflowId: string; diagnostic: WorkflowDiagnostic }> = [];
  const events: Array<{
    stage: string;
    code?: string;
    agent?: string;
    taskId?: string;
    attempt?: string;
    reason?: string;
    observedType?: string;
    observedLength?: number;
    maxLength?: number;
  }> = [];
  const sink = createComposeDiagnosticSink(
    composeRequestId(42),
    "workflow-7",
    (event) => events.push(event as typeof events[number]),
    (diagnostic, requestId, workflowId) => logs.push({ requestId, workflowId, diagnostic }),
  );
  const phases: WorkflowDiagnostic[] = [
    {
      stage: "initial", agent: "Safety preflight", code: "invalid-json",
      reason: "The specialist returned invalid JSON.", responseChars: 12,
      envelope: { keys: [], types: {}, unknownKeyCount: 0 },
    },
    {
      stage: "read", agent: "Piano (instrument, track track-1)", taskId: "task-1", code: "empty-completion",
      reason: "The specialist returned an empty completion.", responseChars: 0,
      envelope: { keys: [], types: {}, unknownKeyCount: 0 },
    },
    {
      stage: "relay", agent: "Harmony & Voice Leading", taskId: "task-1", code: "provider-refusal",
      reason: "The provider refused to return a completion.", responseChars: 4,
      envelope: { keys: [], types: {}, unknownKeyCount: 0 },
    },
    {
      stage: "repair", agent: "Piano (instrument, track track-1)", taskId: "task-1", attempt: "1/2",
      code: "wrong-operations-type", reason: "The specialist response operations field was not an array.",
      responseChars: 48, envelope: { keys: ["operations"], types: { operations: "object" }, unknownKeyCount: 0 },
      provider: { finishReason: "stop", model: "grok-4-fast", providerRequestId: "provider-1" },
    },
  ];

  phases.forEach(sink);

  assert.equal(logs.length, phases.length);
  assert.equal(events.length, phases.length);
  assert.deepEqual(logs.map((entry) => entry.requestId), ["42", "42", "42", "42"]);
  assert.deepEqual(logs.map((entry) => entry.workflowId), ["workflow-7", "workflow-7", "workflow-7", "workflow-7"]);
  assert.deepEqual(events.map((event) => event.stage), ["agent-response-error", "agent-response-error", "agent-response-error", "agent-response-error"]);
  assert.deepEqual(events.map((event) => event.code), phases.map((phase) => phase.code));
  assert.equal(events[3].attempt, "1/2");
  assert.equal(events[1].taskId, "task-1");
});

test("compose request cancellation follows a disconnected response", () => {
  const request = Object.assign(new EventEmitter(), { complete: true });
  const response = Object.assign(new EventEmitter(), { writableEnded: false });
  const cancellation = composeRequestAbortController(request as never, response as never);
  response.emit("close");
  assert.equal(cancellation.signal.aborted, true);
  cancellation.dispose();
  // Disposal is idempotent and removes listeners even after cancellation.
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("compose diagnostic sink forwards only safe operation reason and constraints", () => {
  const diagnostic: WorkflowDiagnostic = {
    stage: "initial",
    agent: "Continuity & Transitions (instrument, track track-1)",
    taskId: "task-1",
    code: "invalid-field",
    reason: "operation summary must be a non-empty string with at most 1200 characters",
    responseChars: 1201,
    envelope: { keys: ["operations"], types: { operations: "array" }, unknownKeyCount: 0 },
    index: 0,
    fields: ["summary"],
    observedType: "string",
    observedLength: 1201,
    maxLength: 1200,
  };
  let emitted: unknown;
  let logged: WorkflowDiagnostic | undefined;
  const sink = createComposeDiagnosticSink(
    "request-1",
    "workflow-1",
    (event) => { emitted = event; },
    (value) => { logged = value; },
  );

  sink(diagnostic);

  assert.equal(logged?.reason, diagnostic.reason);
  assert.equal(logged?.index, 0);
  assert.deepEqual(logged?.fields, ["summary"]);
  assert.equal(logged?.observedType, "string");
  assert.equal(logged?.observedLength, 1201);
  assert.equal(logged?.maxLength, 1200);
  assert.doesNotMatch(JSON.stringify(logged), /private-summary|pitch|velocity|notes/);
  assert.deepEqual(emitted, {
    type: "workflow-progress",
    stage: "agent-response-error",
    message: "Specialist Continuity & Transitions (instrument, track track-1) returned invalid-field during initial: operation summary must be a non-empty string with at most 1200 characters",
    reason: diagnostic.reason,
    agent: diagnostic.agent,
    taskId: diagnostic.taskId,
    code: diagnostic.code,
    index: 0,
    fields: ["summary"],
    observedType: "string",
    observedLength: 1201,
    maxLength: 1200,
  });
  assert.doesNotMatch(JSON.stringify(emitted), /private-summary|pitch|velocity|notes/);
});

test("terminal compose audits retain bounded evaluator fields without provider payloads", () => {
  const audit = terminalComposeAudit(
    "workflow-terminal",
    "request-terminal",
    "The candidate was rejected.",
    [{
      stage: "evaluation-rejected",
      message: "safe evaluator event",
      reason: "The requested cadence was not observed.",
      evaluationKind: "musical-rejection",
      scope: "track",
      trackId: "track-1",
      candidateRevision: "candidate-123",
      expectedConstraints: ["Resolve on the final beat."],
      observedConstraints: ["No resolving final note was observed."],
      evidence: "track track-1 pitch 60 beat 4.00 duration 1.00 velocity 80",
      correctionOutcome: "No bounded correction remained.",
    } as WorkflowEvent],
  );
  assert.deepEqual(audit, {
    workflowId: "workflow-terminal",
    requestId: "request-terminal",
    reason: "The requested cadence was not observed.",
    evidence: ["track track-1 pitch 60 beat 4.00 duration 1.00 velocity 80"],
    evaluatorCategory: "musical-rejection",
    affectedScope: ["track", "track-1"],
    expected: "Resolve on the final beat.",
    observed: "No resolving final note was observed.",
    candidateRevision: "candidate-123",
    correctionOutcome: "No bounded correction remained.",
    commitStatus: "not-committed",
  });
  assert.doesNotMatch(JSON.stringify(audit), /prompt|provider|midi|credential/i);
});

test("chatDetailed lets an injected provider resolve before its scaled deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  const provider = async (_input: string, init?: RequestInit): Promise<Response> => {
    requestSignal = init?.signal as AbortSignal | undefined;
    await Promise.resolve();
    return {
      ok: true,
      headers: new Headers(),
      json: async () => ({
        model: "grok-4-fast",
        choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      }),
    } as Response;
  };
  const completion = await chatDetailed(
    {} as never,
    "grok-4-fast",
    [{ role: "user", content: "bounded request" }],
    32_000,
    true,
    provider,
  );
  assert.equal(completion.content, '{"ok":true}');
  assert.equal(requestSignal?.aborted, false);
  assert.ok(providerRequestTimeoutMs(32_000) > 30_000);
});

test("chatDetailed does not retry a provider timeout", async () => {
  let calls = 0;
  const provider = async (): Promise<Response> => {
    calls += 1;
    throw Object.assign(new Error("deadline"), { name: "TimeoutError" });
  };
  await assert.rejects(
    chatDetailed(
      {} as never,
      "grok-4-fast",
      [{ role: "user", content: "deadline" }],
      16_000,
      true,
      provider,
    ),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "provider-request-timeout" &&
      error.diagnostic.responseChars === 0 &&
      error.diagnostic.envelope.keys.length === 0,
  );
  assert.equal(calls, 1);
});

test("chatDetailed normalizes a timeout while decoding an ok response", async () => {
  let calls = 0;
  const provider = async (): Promise<Response> => {
    calls += 1;
    return {
      ok: true,
      headers: new Headers(),
      json: async () => {
        throw Object.assign(new Error("body deadline"), { name: "TimeoutError" });
      },
    } as Response;
  };
  await assert.rejects(
    chatDetailed(
      {} as never,
      "grok-4-fast",
      [{ role: "user", content: "body deadline" }],
      16_000,
      true,
      provider,
    ),
    (error: unknown) => error instanceof ModelResponseError &&
      error.diagnostic.code === "provider-request-timeout" &&
      error.diagnostic.responseChars === 0,
  );
  assert.equal(calls, 1);
});

test("chatDetailed forwards caller abort to the provider without retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  let providerSignal: AbortSignal | undefined;
  const provider = async (_input: string, init?: RequestInit): Promise<Response> => {
    calls += 1;
    providerSignal = init?.signal as AbortSignal | undefined;
    await new Promise<never>((_resolve, reject) => {
      providerSignal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("disconnected"), { name: "AbortError" }));
      }, { once: true });
    });
    throw new Error("unreachable");
  };
  const request = chatDetailed(
    {} as never,
    "grok-4-fast",
    [{ role: "user", content: "cancel this" }],
    16_000,
    true,
    provider,
    controller.signal,
  );
  // Let the shared limiter launch the injected provider before disconnecting.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(started);
      reject(new Error("injected provider did not launch"));
    }, 1_000);
    const started = setInterval(() => {
      if (providerSignal) {
        clearInterval(started);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
  });
  controller.abort();
  await assert.rejects(request, (error: unknown) =>
    error instanceof Error && error.name === "AbortError");
  assert.equal(calls, 1);
  assert.equal(providerSignal?.aborted, true);
});