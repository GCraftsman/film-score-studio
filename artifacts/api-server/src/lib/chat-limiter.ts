export type Sleep = (milliseconds: number) => Promise<void>;
export type Clock = () => number;

const realSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("The provider request was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function sleepWithAbort(
  milliseconds: number,
  sleep: Sleep,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(milliseconds).then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * Reserves launch slots rather than waiting for work to finish. This keeps
 * requests in flight concurrently while ensuring that a burst of specialists
 * cannot exceed the provider's per-second request limit.
 */
export class PacedLaunchLimiter {
  private tail: Promise<void> = Promise.resolve();
  private nextLaunchAt = 0;
  private readonly intervalMs: number;
  private readonly now: Clock;
  private readonly sleep: Sleep;

  constructor(
    intervalMs = 150,
    now: Clock = () => Date.now(),
    sleep: Sleep = realSleep,
  ) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep;
  }

  schedule<T>(task: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const reservation = this.tail.then(async () => {
      throwIfAborted(signal);
      const waitMs = Math.max(0, this.nextLaunchAt - this.now());
      if (waitMs > 0) await sleepWithAbort(waitMs, this.sleep, signal);
      throwIfAborted(signal);
      this.nextLaunchAt = Math.max(this.nextLaunchAt, this.now()) + this.intervalMs;
    });
    // A task's completion must not hold the launch queue. Only reservation
    // failures block that individual call; the queue itself always advances.
    this.tail = reservation.then(() => undefined, () => undefined);
    return reservation.then(() => {
      throwIfAborted(signal);
      return task();
    });
  }
}

/** One process-wide gate shared by every xAI completion and model lookup. */
export const xaiLaunchLimiter = new PacedLaunchLimiter(150);

export const CHAT_MAX_ATTEMPTS = 4;
export const CHAT_RETRY_CAP_MS = 10_000;
export const CHAT_RETRY_JITTER_MS = 250;
export const CHAT_REQUEST_TIMEOUT_MS = 30_000;
export const PROVIDER_REQUEST_TIMEOUT_CAP_MS = 240_000;
export const PROVIDER_REQUEST_TIMEOUT_PER_TOKEN_MS = 5;

/**
 * Completion requests need more time as their bounded output budget grows.
 * Keep a thirty-second floor for small requests and a hard four-minute cap so
 * a provider call can never hold a workflow indefinitely.  This is pure and
 * deterministic so callers can use the same value for an AbortSignal and for
 * tests without waiting for a real clock.
 */
export function providerRequestTimeoutMs(maxTokens: number): number {
  const tokens = Number.isFinite(maxTokens) ? Math.max(0, Math.floor(maxTokens)) : 0;
  return Math.min(
    PROVIDER_REQUEST_TIMEOUT_CAP_MS,
    CHAT_REQUEST_TIMEOUT_MS + tokens * PROVIDER_REQUEST_TIMEOUT_PER_TOKEN_MS,
  );
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

/**
 * Retry-After is the floor, while a small bounded jitter prevents concurrent
 * requests from retrying on exactly the same provider tick.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs?: number,
  random = Math.random(),
): number {
  const exponentialMs = Math.min(
    CHAT_RETRY_CAP_MS,
    500 * 2 ** Math.max(0, attempt - 1),
  );
  const baseMs = retryAfterMs === undefined ? exponentialMs : Math.max(0, retryAfterMs);
  const jitterMs = Math.floor(Math.max(0, Math.min(1, random)) * CHAT_RETRY_JITTER_MS);
  return Math.min(CHAT_RETRY_CAP_MS, baseMs + jitterMs);
}