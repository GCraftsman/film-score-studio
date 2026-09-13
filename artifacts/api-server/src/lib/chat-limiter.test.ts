import assert from "node:assert/strict";
import test from "node:test";
import {
  PacedLaunchLimiter,
  parseRetryAfter,
  providerRequestTimeoutMs,
  retryDelayMs,
} from "./chat-limiter.ts";

test("paces launches while allowing prior requests to remain in flight", async () => {
  let now = 0;
  const waits: number[] = [];
  const launches: number[] = [];
  const completions: Array<() => void> = [];
  const limiter = new PacedLaunchLimiter(
    150,
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );

  const requests = [0, 1, 2].map(() => limiter.schedule(() => {
    launches.push(now);
    return new Promise<void>((resolve) => completions.push(resolve));
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(launches, [0, 150, 300]);
  assert.deepEqual(waits, [150, 150]);
  assert.equal(completions.length, 3);

  completions.forEach((resolve) => resolve());
  await Promise.all(requests);
});

test("parses Retry-After and applies bounded deterministic jitter", () => {
  assert.equal(parseRetryAfter("1"), 1_000);
  assert.equal(parseRetryAfter("not-a-delay"), undefined);
  assert.equal(retryDelayMs(1, 1_000, 0), 1_000);
  assert.equal(retryDelayMs(1, 1_000, 1), 1_250);
  assert.equal(retryDelayMs(1, 60_000, 1), 10_000);
});

test("scales provider request deadlines for specialist budgets with a hard cap", () => {
  assert.ok(providerRequestTimeoutMs(16_000) > 30_000);
  assert.ok(providerRequestTimeoutMs(24_000) > providerRequestTimeoutMs(16_000));
  assert.ok(providerRequestTimeoutMs(32_000) > providerRequestTimeoutMs(24_000));
  assert.equal(providerRequestTimeoutMs(0), 30_000);
  assert.equal(providerRequestTimeoutMs(100_000), 240_000);
});