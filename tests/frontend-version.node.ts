import assert from "node:assert/strict";
import test from "node:test";
import nextConfig, { frontendVersion } from "../next.config";
import { FRONTEND_VERSION, frontendReloadBlocked, frontendReloadUrl, isFrontendVersion } from "../lib/frontend-version";

test("前端版本限定为发布标识，不接受空值、地址或任意返回对象", () => {
  assert.equal(isFrontendVersion(FRONTEND_VERSION), true);
  assert.match(frontendVersion, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
  assert.equal(process.env.NEXT_PUBLIC_FRONTEND_VERSION, frontendVersion);
  assert.equal(nextConfig.env?.NEXT_PUBLIC_FRONTEND_VERSION, frontendVersion);
  assert.equal(nextConfig.deploymentId, frontendVersion.replaceAll(".", "-"));
  assert.match(nextConfig.deploymentId!, /^[a-zA-Z0-9_-]+$/);
  for (const value of [null, {}, "", "https://example.com", "../login", "2026.09.11.1\n", "x".repeat(65)]) assert.equal(isFrontendVersion(value), false);
});

test("前端更新保留路径、重复筛选参数与锚点，只追加版本标记", () => {
  const original = "http://localhost:3001/progress/projects?mine=1&mine=0&status=&q=test#tasks";
  const updated = new URL(frontendReloadUrl(original, FRONTEND_VERSION));
  assert.equal(updated.pathname, "/progress/projects");
  assert.deepEqual(updated.searchParams.getAll("mine"), ["1", "0"]);
  assert.equal(updated.searchParams.get("status"), "");
  assert.equal(updated.searchParams.get("q"), "test");
  assert.equal(updated.hash, "#tasks");
  assert.equal(updated.searchParams.get("__frontend_version"), FRONTEND_VERSION);
});

test("前端更新用版本标记及刷新时间限流防止旧资源无限重刷", () => {
  const href = "http://localhost:3001/progress/projects";
  assert.equal(frontendReloadBlocked(href, FRONTEND_VERSION, null, 120_000), false);
  assert.equal(frontendReloadBlocked(href, FRONTEND_VERSION, "60001", 120_000), true);
  assert.equal(frontendReloadBlocked(href, FRONTEND_VERSION, "60000", 120_000), false);
  assert.equal(frontendReloadBlocked(href, FRONTEND_VERSION, "invalid", 120_000), false);
  assert.equal(frontendReloadBlocked(frontendReloadUrl(href, FRONTEND_VERSION), FRONTEND_VERSION, null, 120_000), true);
});
