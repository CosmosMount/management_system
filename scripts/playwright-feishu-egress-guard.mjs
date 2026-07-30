import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL, urlToHttpOptions } from "node:url";

export const PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV =
  "PLAYWRIGHT_FEISHU_EGRESS_DISABLED";
export const PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE =
  "PLAYWRIGHT_FEISHU_EGRESS_BLOCKED";
export const PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV =
  "PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS";
export const PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL =
  "--conditions=playwright-feishu-egress-node-options-sentinel";
export const PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV =
  "PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT";
export const PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV =
  "PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE";
export const PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV =
  "PLAYWRIGHT_FEISHU_EGRESS_RUN_ID";
export const PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH =
  ".tmp/playwright-feishu-egress-server-preload.jsonl";

const installMarkerKey =
  "management-system.playwright-feishu-egress-guard";
const probeMarkerKey =
  "management-system.playwright-feishu-egress-guard-probe";

const installMarker = Symbol.for(installMarkerKey);
const probeMarker = Symbol.for(probeMarkerKey);

function normalizeHostname(hostname) {
  const value = String(hostname).trim();
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket !== -1) {
      return value
        .slice(1, closingBracket)
        .toLowerCase()
        .replace(/\.+$/, "");
    }
  }

  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  const withoutPort =
    firstColon !== -1 && firstColon === lastColon
      ? value.slice(0, firstColon)
      : value;
  return withoutPort.toLowerCase().replace(/\.+$/, "");
}

function isFeishuHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "feishu.cn" ||
    normalized.endsWith(".feishu.cn") ||
    normalized === "larksuite.com" ||
    normalized.endsWith(".larksuite.com") ||
    normalized === "larksuite.cn" ||
    normalized.endsWith(".larksuite.cn")
  );
}

function toUrl(input) {
  if (input instanceof URL) return input;
  if (typeof Request !== "undefined" && input instanceof Request) {
    return new URL(input.url);
  }
  if (typeof input === "string") return new URL(input);
  return null;
}

function toRequestHostname(args) {
  const input = args[0];
  let requestOptions;
  if (input instanceof URL || typeof input === "string") {
    requestOptions = urlToHttpOptions(
      input instanceof URL ? input : new URL(input),
    );
    const overrides = args[1];
    if (overrides && typeof overrides === "object") {
      requestOptions = { ...requestOptions, ...overrides };
    }
  } else if (input && typeof input === "object") {
    requestOptions = input;
  } else {
    return null;
  }

  const hostname = requestOptions.hostname || requestOptions.host;
  if (!hostname) return null;
  return normalizeHostname(hostname);
}

function blockedError() {
  const error = new Error(
    `${PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE}: automated tests must explicitly mock Feishu API requests`,
  );
  error.code = PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE;
  return error;
}

function guardUrl(url) {
  if (url && isFeishuHostname(url.hostname)) {
    throw blockedError();
  }
}

function guardRequestArgs(args) {
  const hostname = toRequestHostname(args);
  if (hostname && isFeishuHostname(hostname)) {
    throw blockedError();
  }
}

function wrapNodeRequest(module) {
  const originalRequest = module.request;
  const originalGet = module.get;

  module.request = function guardedRequest(...args) {
    guardRequestArgs(args);
    return originalRequest.apply(this, args);
  };
  module.get = function guardedGet(...args) {
    guardRequestArgs(args);
    return originalGet.apply(this, args);
  };
}

function hasNodeOption(nodeOptions, expectedOption) {
  return (nodeOptions?.trim() ?? "").split(/\s+/).includes(expectedOption);
}

function recordGuardPreloadProbe() {
  const outputPath = process.env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV];
  const role = process.env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV];
  if (!outputPath && !role) return;
  if (!outputPath || !role) {
    throw new Error(
      `${PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV} and ${PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV} must be configured together`,
    );
  }
  if (!globalThis[installMarker]) {
    throw new Error(
      `${PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE}: ${role} process started without the Playwright Feishu egress guard`,
    );
  }
  if (globalThis[probeMarker]) return;

  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  const originalNodeOptions =
    process.env[PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV]?.trim() ??
    "";
  const originalOptionsPreserved =
    !originalNodeOptions ||
    nodeOptions === originalNodeOptions ||
    nodeOptions.startsWith(`${originalNodeOptions} `);
  const entrypoint = path.basename(process.argv[1] ?? "");
  const evidence = {
    role,
    runId: process.env[PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV] ?? "",
    pid: process.pid,
    parentPid: process.ppid,
    isNextDevProcess:
      entrypoint === "next" && process.argv.slice(2).includes("dev"),
    guardInstalled: true,
    guardImportPresent:
      hasPlaywrightFeishuEgressGuardNodeOption(nodeOptions),
    nodeOptionsSentinelPresent: hasNodeOption(
      nodeOptions,
      PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
    ),
    checkpointDisabled: process.env.CHECKPOINT_DISABLE === "1",
    notificationDeliveryDisabled:
      process.env.NOTIFICATION_DELIVERY_DISABLED === "true",
    originalNodeOptionsPresent: originalNodeOptions.length > 0,
    originalNodeOptionsPreserved: originalOptionsPreserved,
  };

  mkdirSync(path.dirname(outputPath), { recursive: true });
  appendFileSync(outputPath, `${JSON.stringify(evidence)}\n`, "utf8");
  globalThis[probeMarker] = true;
}

export function isPlaywrightFeishuEgressGuardInstalled() {
  return globalThis[installMarker] === true;
}

export function installPlaywrightFeishuEgressGuard() {
  if (process.env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] !== "true") {
    throw new Error(
      `${PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV}=true is required before installing the Playwright Feishu egress guard`,
    );
  }
  if (globalThis[installMarker]) return;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = function guardedFetch(input, init) {
      try {
        guardUrl(toUrl(input));
      } catch (error) {
        return Promise.reject(error);
      }
      return originalFetch.call(this, input, init);
    };
  }

  wrapNodeRequest(http);
  wrapNodeRequest(https);
  syncBuiltinESMExports();
  globalThis[installMarker] = true;
  recordGuardPreloadProbe();
}

export function withPlaywrightFeishuEgressGuardNodeOptions(
  nodeOptions,
  modulePath,
) {
  const importOption = `--import=${pathToFileURL(modulePath).href}`;
  const current = nodeOptions?.trim() ?? "";
  if (hasNodeOption(current, importOption)) return current;
  return [current, importOption].filter(Boolean).join(" ");
}

export function hasPlaywrightFeishuEgressGuardNodeOption(
  nodeOptions,
  modulePath,
) {
  if (modulePath) {
    return hasNodeOption(
      nodeOptions,
      `--import=${pathToFileURL(modulePath).href}`,
    );
  }
  return (nodeOptions?.trim() ?? "").split(/\s+/).some(
    (option) =>
      option.startsWith("--import=") &&
      option.includes("playwright-feishu-egress-guard.mjs"),
  );
}

if (process.env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] === "true") {
  installPlaywrightFeishuEgressGuard();
}
