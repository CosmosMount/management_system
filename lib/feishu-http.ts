const DEFAULT_FEISHU_TIMEOUT_MS = 15_000;

export function fetchFeishu(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_FEISHU_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const inputSignal = input instanceof Request ? input.signal : null;
  const callerSignal = init?.signal ?? inputSignal;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}
