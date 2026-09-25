import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchFeishu } from "../lib/feishu-http";

test("飞书请求保留调用方取消信号并增加超时", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input, init) => {
    capturedSignal = init?.signal;
    return Response.json({ code: 0 });
  }) as typeof fetch;
  try {
    await fetchFeishu("https://open.feishu.cn/mock", { signal: controller.signal });
    assert.ok(capturedSignal);
    assert.equal(capturedSignal.aborted, false);
    controller.abort();
    assert.equal(capturedSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
