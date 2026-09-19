type AbortableRequest = {
  complete?: boolean;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type AbortableResponse = {
  writableEnded?: boolean;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

/**
 * A stream request has two useful disconnect notifications: the incoming
 * request can be aborted while its body is being read, and the outgoing
 * response can close while the workflow is still producing events. Keep
 * these listeners scoped to one route invocation so provider calls can share
 * the same signal without leaking listeners between compositions.
 */
export function composeRequestAbortController(
  req: AbortableRequest,
  res: AbortableResponse,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onRequestClose = () => {
    if (!req.complete) abort();
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  req.once("close", onRequestClose);
  res.once("close", onResponseClose);
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener("aborted", abort);
      req.removeListener("close", onRequestClose);
      res.removeListener("close", onResponseClose);
    },
  };
}
