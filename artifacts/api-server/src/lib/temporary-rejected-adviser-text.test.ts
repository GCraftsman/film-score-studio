import assert from "node:assert/strict";
import test from "node:test";
import {
  logTemporaryRejectedAdviserText,
  TEMP_REJECTED_ADVISER_TEXT_ENV,
  temporaryRejectedAdviserTextLoggingEnabled,
} from "./temporary-rejected-adviser-text.ts";

const diagnostic = {
  text: "raw rejected adviser insight",
  originalLength: 28,
  truncated: false,
  agent: "Contemporary Cinematic",
  phase: "initial" as const,
  field: "insight" as const,
  attempt: "initial",
  workflowId: "workflow-test",
  requestId: "request-test",
};

test("temporary rejected adviser text logging is gated and hard-disabled in production", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env[TEMP_REJECTED_ADVISER_TEXT_ENV];
  try {
    process.env.NODE_ENV = "development";
    process.env[TEMP_REJECTED_ADVISER_TEXT_ENV] = "true";
    assert.equal(temporaryRejectedAdviserTextLoggingEnabled(), true);
    process.env.NODE_ENV = "production";
    assert.equal(temporaryRejectedAdviserTextLoggingEnabled(), false);
    process.env.NODE_ENV = "development";
    process.env[TEMP_REJECTED_ADVISER_TEXT_ENV] = "false";
    assert.equal(temporaryRejectedAdviserTextLoggingEnabled(), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env[TEMP_REJECTED_ADVISER_TEXT_ENV];
    else process.env[TEMP_REJECTED_ADVISER_TEXT_ENV] = previousFlag;
  }
});

test("temporary rejected adviser text logger emits only the bounded diagnostic payload when enabled", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env[TEMP_REJECTED_ADVISER_TEXT_ENV];
  const calls: Array<{ metadata: Record<string, unknown>; message: string }> = [];
  try {
    process.env.NODE_ENV = "development";
    process.env[TEMP_REJECTED_ADVISER_TEXT_ENV] = "true";
    const longDiagnostic = {
      ...diagnostic,
      text: "x".repeat(5200),
      originalLength: 5200,
      truncated: true,
    };
    const logged = logTemporaryRejectedAdviserText({
      warn: (metadata, message) => calls.push({ metadata, message }),
    }, longDiagnostic);
    assert.equal(logged, true);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.metadata.adviserText as string).length, 5000);
    assert.equal(calls[0]?.metadata.originalLength, longDiagnostic.originalLength);
    assert.equal(calls[0]?.metadata.truncated, true);
    assert.equal(calls[0]?.metadata.workflowId, diagnostic.workflowId);
    assert.match(calls[0]?.message ?? "", /TEMPORARY SENSITIVE DIAGNOSTIC/);
    assert.doesNotMatch(JSON.stringify(calls[0]), /prompt|history|midi|credential|operations/i);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env[TEMP_REJECTED_ADVISER_TEXT_ENV];
    else process.env[TEMP_REJECTED_ADVISER_TEXT_ENV] = previousFlag;
  }
});
