import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import http, {
  get as httpGet,
  request as httpRequest,
} from "node:http";
import https, {
  get as httpsGet,
  request as httpsRequest,
} from "node:https";
import path from "path";
import { promisify } from "node:util";
import {
  uploadFeishuMessageFile,
  uploadFeishuMessageImage,
} from "../lib/feishu-im-upload";
import { postToFeishuWebhook } from "../lib/feishu-webhook";
import { storagePathToAbsolute } from "../lib/upload-paths";
import {
  hasPlaywrightFeishuEgressGuardNodeOption,
  isPlaywrightFeishuEgressGuardInstalled,
  PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
  PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH,
  withPlaywrightFeishuEgressGuardNodeOptions,
} from "../scripts/playwright-feishu-egress-guard.mjs";

const execFileAsync = promisify(execFile);
const NO_NETWORK_SENTINEL_CODE = "PLAYWRIGHT_NO_NETWORK_SENTINEL";
const NODE_REQUEST_PROBE_EXPECTATIONS = [
  {
    name: "default-http-request-host-port-feishu-raw-slash-bracket",
    shouldBlock: true,
  },
  {
    name: "default-http-get-host-port-safe-raw-url-bracket",
    shouldBlock: false,
  },
  {
    name: "default-https-request-hostname-port-feishu-case-dot",
    shouldBlock: true,
  },
  {
    name: "default-https-get-hostname-port-safe",
    shouldBlock: false,
  },
  {
    name: "named-http-request-hostname-priority-safe",
    shouldBlock: false,
  },
  {
    name: "named-http-get-hostname-priority-feishu",
    shouldBlock: true,
  },
  {
    name: "named-https-request-ipv4-host-port",
    shouldBlock: false,
  },
  {
    name: "named-https-get-bracketed-ipv6-host-port",
    shouldBlock: false,
  },
  {
    name: "default-http-request-bare-ipv6-hostname-port",
    shouldBlock: false,
  },
  {
    name: "default-http-get-bracketed-ipv6-hostname-port",
    shouldBlock: false,
  },
] as const;

test.describe("Feishu delivery safety guard", () => {
  const originalFetch = globalThis.fetch;
  const originalPlaywrightDatabaseUrl = process.env.PLAYWRIGHT_DATABASE_URL;
  const originalOAuthAppId = process.env.FEISHU_APP_ID;
  const originalOAuthAppSecret = process.env.FEISHU_APP_SECRET;
  const originalNotificationAppId = process.env.FEISHU_NOTIFICATION_APP_ID;
  const originalNotificationAppSecret = process.env.FEISHU_NOTIFICATION_APP_SECRET;
  const originalApprovalAppId = process.env.FEISHU_APPROVAL_APP_ID;
  const originalApprovalAppSecret = process.env.FEISHU_APPROVAL_APP_SECRET;
  const uploadDir = "playwright/feishu-delivery-guard";
  const imagePublicPath = `/${path.posix.join("uploads", uploadDir, "image.png")}`;
  const filePublicPath = `/${path.posix.join("uploads", uploadDir, "file.pdf")}`;
  let fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

  test.beforeEach(async () => {
    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    delete process.env.CONFIRM_SEND_FEISHU;
    process.env.PLAYWRIGHT_DATABASE_URL =
      process.env.PLAYWRIGHT_DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/management_system_test";
    process.env.FEISHU_APP_ID = "oauth-app";
    process.env.FEISHU_APP_SECRET = "oauth-secret";
    process.env.FEISHU_NOTIFICATION_APP_ID = "notification-app";
    process.env.FEISHU_NOTIFICATION_APP_SECRET = "notification-secret";
    process.env.FEISHU_APPROVAL_APP_ID = "approval-app";
    process.env.FEISHU_APPROVAL_APP_SECRET = "approval-secret";

    const absoluteUploadDir = storagePathToAbsolute(uploadDir);
    await mkdir(absoluteUploadDir, { recursive: true });
    await writeFile(storagePathToAbsolute(`${uploadDir}/image.png`), "fake-png");
    await writeFile(storagePathToAbsolute(`${uploadDir}/file.pdf`), "fake-pdf");

    fetchCalls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ input, init });
      if (url.includes("/auth/v3/app_access_token/internal")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "mock-token" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/im/v1/images")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { image_key: "mock-image-key" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/im/v1/files")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { file_key: "mock-file-key" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ code: 0, msg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  test.afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.CONFIRM_SEND_FEISHU;
    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    restoreEnv("PLAYWRIGHT_DATABASE_URL", originalPlaywrightDatabaseUrl);
    restoreEnv("FEISHU_APP_ID", originalOAuthAppId);
    restoreEnv("FEISHU_APP_SECRET", originalOAuthAppSecret);
    restoreEnv("FEISHU_NOTIFICATION_APP_ID", originalNotificationAppId);
    restoreEnv("FEISHU_NOTIFICATION_APP_SECRET", originalNotificationAppSecret);
    restoreEnv("FEISHU_APPROVAL_APP_ID", originalApprovalAppId);
    restoreEnv("FEISHU_APPROVAL_APP_SECRET", originalApprovalAppSecret);
    await rm(storagePathToAbsolute(uploadDir), { recursive: true, force: true });
  });

  test("NOTIFICATION_DELIVERY_DISABLED blocks Feishu webhook fetch", async () => {
    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      "playwright-secret",
      { msg_type: "text", content: { text: "should not send" } },
    );

    expect(fetchCalls).toHaveLength(0);
  });

  test("worker blocks unmocked Feishu requests without a network fallback", async () => {
    globalThis.fetch = originalFetch;
    const abortController = new AbortController();
    abortController.abort(createNoNetworkSentinel());
    const httpsAgent = createNoNetworkHttpsAgent();

    await expect(
      fetch("https://open.feishu.cn/open-apis/playwright-unmocked-probe", {
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
    });
    let guardedHttpsError: unknown;
    try {
      https.get("https://open.feishu.cn/open-apis/playwright-unmocked-probe", {
        agent: httpsAgent,
        path: "/open-apis/private?access_token=must-not-leak",
      });
    } catch (error) {
      guardedHttpsError = error;
    }
    expect(guardedHttpsError).toMatchObject({
      code: PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
      message: `${PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE}: automated tests must explicitly mock Feishu API requests`,
    });
    expect((guardedHttpsError as Error).message).not.toContain("private");
    expect((guardedHttpsError as Error).message).not.toContain("must-not-leak");
    expect(isPlaywrightFeishuEgressGuardInstalled()).toBe(true);
    httpsAgent.destroy();

    expectNodeRequestProbeResults(runLocalNodeRequestProbes(), true);
  });

  test("controlled Next server processes preload the guard independently", async () => {
    const runId = process.env[PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV];
    expect(runId).toBeTruthy();
    const probePath = path.join(
      process.cwd(),
      PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH,
    );

    await expect
      .poll(async () => {
        const evidence = await readServerProbeEvidence(probePath, runId ?? "");
        return evidence.some((record) => record.isNextDevProcess);
      })
      .toBe(true);

    const evidence = await readServerProbeEvidence(probePath, runId ?? "");
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((record) => record.role === "server")).toBe(true);
    expect(evidence.every((record) => record.pid !== process.pid)).toBe(true);
    expect(evidence.every((record) => record.guardInstalled)).toBe(true);
    expect(evidence.every((record) => record.guardImportPresent)).toBe(true);
    expect(evidence.every((record) => record.nodeOptionsSentinelPresent)).toBe(
      true,
    );
    expect(evidence.every((record) => record.checkpointDisabled)).toBe(true);
    expect(
      evidence.every((record) => record.notificationDeliveryDisabled),
    ).toBe(true);
    expect(evidence.every((record) => record.originalNodeOptionsPreserved)).toBe(
      true,
    );
    expect(evidence.some((record) => record.originalNodeOptionsPresent)).toBe(
      Boolean(
        process.env[
          PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV
        ]?.trim(),
      ),
    );
  });

  test("an ordinary child process inherits the preload and blocks locally", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", childProcessProbeSource],
      {
        cwd: process.cwd(),
        env: { ...process.env },
      },
    );
    const evidence = JSON.parse(stdout.trim()) as ChildProbeEvidence;

    expect(evidence.pid).not.toBe(process.pid);
    expect(evidence.guardInstalled).toBe(true);
    expect(evidence.fetchErrorCode).toBe(
      PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
    );
    expect(evidence.httpsErrorCode).toBe(
      PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
    );
    expect(evidence.namedEsmErrorCodes).toEqual([
      PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
      PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
      PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
      PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE,
    ]);
    expect(evidence.urlOptionsOverrideErrorCodes).toEqual(
      Array(8).fill(PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE),
    );
    expect(evidence.safeHostnameOverrideErrorCodes).toEqual([
      NO_NETWORK_SENTINEL_CODE,
      NO_NETWORK_SENTINEL_CODE,
    ]);
    expectNodeRequestProbeResults(evidence.nodeRequestProbeResults, true);
    expect(evidence.guardImportPresent).toBe(true);
    expect(evidence.nodeOptionsSentinelPresent).toBe(true);
    expect(evidence.checkpointDisabled).toBe(true);
    expect(evidence.notificationDeliveryDisabled).toBe(true);
    expect(evidence.originalNodeOptionsPreserved).toBe(true);
  });

  test("the no-guard probe fallback is local and never opens a socket", async () => {
    const env = { ...process.env };
    env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] = "false";
    env.NODE_OPTIONS = (env.NODE_OPTIONS ?? "")
      .split(/\s+/)
      .filter(
        (option) =>
          option && !option.includes("playwright-feishu-egress-guard.mjs"),
      )
      .join(" ");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", childProcessProbeSource],
      { cwd: process.cwd(), env },
    );
    const evidence = JSON.parse(stdout.trim()) as ChildProbeEvidence;

    expect(evidence.guardInstalled).toBe(false);
    expect([
      NO_NETWORK_SENTINEL_CODE,
      "ABORT_ERR",
      "AbortError",
    ]).toContain(evidence.fetchErrorCode);
    expect(evidence.httpsErrorCode).toBe(NO_NETWORK_SENTINEL_CODE);
    expect(evidence.namedEsmErrorCodes).toEqual([
      NO_NETWORK_SENTINEL_CODE,
      NO_NETWORK_SENTINEL_CODE,
      NO_NETWORK_SENTINEL_CODE,
      NO_NETWORK_SENTINEL_CODE,
    ]);
    expect(evidence.urlOptionsOverrideErrorCodes).toEqual(
      Array(8).fill(NO_NETWORK_SENTINEL_CODE),
    );
    expect(evidence.safeHostnameOverrideErrorCodes).toEqual([
      NO_NETWORK_SENTINEL_CODE,
      NO_NETWORK_SENTINEL_CODE,
    ]);
    expectNodeRequestProbeResults(evidence.nodeRequestProbeResults, false);
    expect(evidence.guardImportPresent).toBe(false);
  });

  test("runner NODE_OPTIONS helper and worker preserve existing options", () => {
    const guardPath = path.join(
      process.cwd(),
      "scripts",
      "playwright-feishu-egress-guard.mjs",
    );
    const existingNodeOptions = "--no-warnings";
    const nodeOptions = withPlaywrightFeishuEgressGuardNodeOptions(
      existingNodeOptions,
      guardPath,
    );

    expect(nodeOptions.split(/\s+/)).toContain(existingNodeOptions);
    expect(hasPlaywrightFeishuEgressGuardNodeOption(nodeOptions, guardPath)).toBe(
      true,
    );
    expect(process.env.NODE_OPTIONS?.split(/\s+/)).toContain(
      PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
    );
    expect(process.env.CHECKPOINT_DISABLE).toBe("1");
    const runnerOriginalNodeOptions =
      process.env[
        PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV
      ]?.trim() ?? "";
    if (runnerOriginalNodeOptions) {
      expect(
        process.env.NODE_OPTIONS === runnerOriginalNodeOptions ||
          process.env.NODE_OPTIONS?.startsWith(`${runnerOriginalNodeOptions} `),
      ).toBe(true);
    }
  });

  test("explicit bypass allows Feishu webhook fetch in controlled tests", async () => {
    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      undefined,
      { msg_type: "text", content: { text: "mock send" } },
      { ignoreDeliveryDisabled: true },
    );

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0]?.input)).toContain("/open-apis/bot/v2/hook/");
  });

  test("CONFIRM_SEND_FEISHU alone does not bypass test delivery disable", async () => {
    process.env.CONFIRM_SEND_FEISHU = "true";

    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      undefined,
      { msg_type: "text", content: { text: "should still not send" } },
    );

    expect(fetchCalls).toHaveLength(0);
  });

  test("NOTIFICATION_DELIVERY_DISABLED blocks Feishu IM media upload fetches", async () => {
    const imageKey = await uploadFeishuMessageImage(imagePublicPath, "notification");
    const fileKey = await uploadFeishuMessageFile(filePublicPath, "approval");

    expect(imageKey).toBeNull();
    expect(fileKey).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test("explicit bypass allows Feishu IM media upload fetches in controlled tests", async () => {
    const imageKey = await uploadFeishuMessageImage(imagePublicPath, "notification", {
      ignoreDeliveryDisabled: true,
    });
    const fileKey = await uploadFeishuMessageFile(filePublicPath, "approval", {
      ignoreDeliveryDisabled: true,
    });

    expect(imageKey).toBe("mock-image-key");
    expect(fileKey).toBe("mock-file-key");
    expect(fetchCalls.map((call) => String(call.input))).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/images",
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/files",
    ]);
  });

  test("explicit bypass is ignored in non-test app processes without human confirmation", async () => {
    delete process.env.PLAYWRIGHT_DATABASE_URL;

    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      undefined,
      { msg_type: "text", content: { text: "should still not send" } },
      { ignoreDeliveryDisabled: true },
    );

    expect(fetchCalls).toHaveLength(0);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createNoNetworkSentinel() {
  return Object.assign(new Error(NO_NETWORK_SENTINEL_CODE), {
    code: NO_NETWORK_SENTINEL_CODE,
  });
}

function createNoNetworkHttpsAgent() {
  const agent = new https.Agent();
  Object.defineProperty(agent, "addRequest", {
    value: () => {
      throw createNoNetworkSentinel();
    },
  });
  return agent;
}

interface NodeRequestProbeResult {
  name: string;
  shouldBlock: boolean;
  errorCode: string;
  agentReached: boolean;
  requestTargetPreserved: boolean;
  callbackPreserved: boolean;
}

type LocalNodeRequestProbeDefinition = {
  name: (typeof NODE_REQUEST_PROBE_EXPECTATIONS)[number]["name"];
  shouldBlock: boolean;
  transport: "http" | "https";
  invoke: (
    options: http.RequestOptions,
    callback: () => void,
  ) => http.ClientRequest;
  options: http.RequestOptions;
  requestTarget: string;
};

function runLocalNodeRequestProbes(): NodeRequestProbeResult[] {
  const definitions: LocalNodeRequestProbeDefinition[] = [
    {
      name: "default-http-request-host-port-feishu-raw-slash-bracket",
      shouldBlock: true,
      transport: "http",
      invoke: (options, callback) => http.request(options, callback),
      options: { protocol: "http:", host: "open.feishu.cn:443" },
      requestTarget: "//[",
    },
    {
      name: "default-http-get-host-port-safe-raw-url-bracket",
      shouldBlock: false,
      transport: "http",
      invoke: (options, callback) => http.get(options, callback),
      options: { protocol: "http:", host: "safe.invalid:80" },
      requestTarget: "http://[",
    },
    {
      name: "default-https-request-hostname-port-feishu-case-dot",
      shouldBlock: true,
      transport: "https",
      invoke: (options, callback) => https.request(options, callback),
      options: {
        protocol: "https:",
        hostname: "OPEN.FEISHU.CN.",
        port: 443,
      },
      requestTarget: "http://[",
    },
    {
      name: "default-https-get-hostname-port-safe",
      shouldBlock: false,
      transport: "https",
      invoke: (options, callback) => https.get(options, callback),
      options: { protocol: "https:", hostname: "safe.invalid", port: 443 },
      requestTarget: "//[",
    },
    {
      name: "named-http-request-hostname-priority-safe",
      shouldBlock: false,
      transport: "http",
      invoke: (options, callback) => httpRequest(options, callback),
      options: {
        protocol: "http:",
        hostname: "safe.invalid",
        host: "open.feishu.cn:80",
        port: 80,
      },
      requestTarget: "//[",
    },
    {
      name: "named-http-get-hostname-priority-feishu",
      shouldBlock: true,
      transport: "http",
      invoke: (options, callback) => httpGet(options, callback),
      options: {
        protocol: "http:",
        hostname: "OPEN.FEISHU.CN.",
        host: "safe.invalid:80",
        port: 80,
      },
      requestTarget: "http://[",
    },
    {
      name: "named-https-request-ipv4-host-port",
      shouldBlock: false,
      transport: "https",
      invoke: (options, callback) => httpsRequest(options, callback),
      options: { protocol: "https:", host: "127.0.0.1:443" },
      requestTarget: "http://[",
    },
    {
      name: "named-https-get-bracketed-ipv6-host-port",
      shouldBlock: false,
      transport: "https",
      invoke: (options, callback) => httpsGet(options, callback),
      options: { protocol: "https:", host: "[::1]:443" },
      requestTarget: "//[",
    },
    {
      name: "default-http-request-bare-ipv6-hostname-port",
      shouldBlock: false,
      transport: "http",
      invoke: (options, callback) => http.request(options, callback),
      options: { protocol: "http:", hostname: "::1", port: 80 },
      requestTarget: "//[",
    },
    {
      name: "default-http-get-bracketed-ipv6-hostname-port",
      shouldBlock: false,
      transport: "http",
      invoke: (options, callback) => http.get(options, callback),
      options: { protocol: "http:", hostname: "[::1]", port: 80 },
      requestTarget: "http://[",
    },
  ];

  return definitions.map(runLocalNodeRequestProbe);
}

function runLocalNodeRequestProbe(
  definition: LocalNodeRequestProbeDefinition,
): NodeRequestProbeResult {
  const callback = () => undefined;
  const agent =
    definition.transport === "https" ? new https.Agent() : new http.Agent();
  let agentReached = false;
  let requestTargetPreserved = false;
  let callbackPreserved = false;

  Object.defineProperty(agent, "addRequest", {
    value: (request: http.ClientRequest) => {
      agentReached = true;
      requestTargetPreserved = request.path === definition.requestTarget;
      callbackPreserved = request.listeners("response").includes(callback);
      if (!requestTargetPreserved || !callbackPreserved) {
        throw Object.assign(new Error("Playwright request probe arguments changed"), {
          code: "PLAYWRIGHT_REQUEST_PROBE_ARGUMENTS_CHANGED",
        });
      }
      throw createNoNetworkSentinel();
    },
  });

  let errorCode = "NO_ERROR";
  try {
    definition.invoke(
      {
        ...definition.options,
        path: definition.requestTarget,
        agent,
      },
      callback,
    );
  } catch (error) {
    errorCode = readErrorCode(error);
  } finally {
    agent.destroy();
  }

  return {
    name: definition.name,
    shouldBlock: definition.shouldBlock,
    errorCode,
    agentReached,
    requestTargetPreserved,
    callbackPreserved,
  };
}

function expectNodeRequestProbeResults(
  results: NodeRequestProbeResult[],
  guardInstalled: boolean,
) {
  expect(
    results.map(({ name, shouldBlock }) => ({ name, shouldBlock })),
  ).toEqual(NODE_REQUEST_PROBE_EXPECTATIONS);
  for (const result of results) {
    const blocked = guardInstalled && result.shouldBlock;
    expect(result.errorCode, result.name).toBe(
      blocked
        ? PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE
        : NO_NETWORK_SENTINEL_CODE,
    );
    expect(result.agentReached, result.name).toBe(!blocked);
    expect(result.requestTargetPreserved, result.name).toBe(!blocked);
    expect(result.callbackPreserved, result.name).toBe(!blocked);
  }
}

function readErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "UNKNOWN_ERROR";
  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  if (typeof candidate.name === "string") return candidate.name;
  return "UNKNOWN_ERROR";
}

interface ServerProbeEvidence {
  role: string;
  runId: string;
  pid: number;
  isNextDevProcess: boolean;
  guardInstalled: boolean;
  guardImportPresent: boolean;
  nodeOptionsSentinelPresent: boolean;
  checkpointDisabled: boolean;
  notificationDeliveryDisabled: boolean;
  originalNodeOptionsPresent: boolean;
  originalNodeOptionsPreserved: boolean;
}

async function readServerProbeEvidence(
  probePath: string,
  runId: string,
): Promise<ServerProbeEvidence[]> {
  const contents = await readFile(probePath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ServerProbeEvidence)
    .filter((record) => record.runId === runId);
}

interface ChildProbeEvidence {
  pid: number;
  guardInstalled: boolean;
  fetchErrorCode: string;
  httpsErrorCode: string;
  namedEsmErrorCodes: string[];
  urlOptionsOverrideErrorCodes: string[];
  safeHostnameOverrideErrorCodes: string[];
  nodeRequestProbeResults: NodeRequestProbeResult[];
  guardImportPresent: boolean;
  nodeOptionsSentinelPresent: boolean;
  checkpointDisabled: boolean;
  notificationDeliveryDisabled: boolean;
  originalNodeOptionsPreserved: boolean;
}

const childProcessProbeSource = String.raw`
  import http, {
    get as httpGet,
    request as httpRequest,
  } from "node:http";
  import https, {
    get as httpsGet,
    request as httpsRequest,
  } from "node:https";

  const guardCode = "${PLAYWRIGHT_FEISHU_EGRESS_ERROR_CODE}";
  const sentinelCode = "${NO_NETWORK_SENTINEL_CODE}";
  const installMarker = Symbol.for("management-system.playwright-feishu-egress-guard");
  const sentinel = () => Object.assign(new Error(sentinelCode), { code: sentinelCode });
  const controller = new AbortController();
  controller.abort(sentinel());
  const fetchErrorCode = await fetch(
    "https://open.feishu.cn./open-apis/child-fetch-probe",
    { signal: controller.signal },
  ).then(
    () => "NO_ERROR",
    (error) => error?.code ?? error?.name ?? "UNKNOWN_ERROR",
  );
  const agent = new https.Agent();
  agent.addRequest = () => { throw sentinel(); };
  let httpsErrorCode = "NO_ERROR";
  try {
    https.request({
      protocol: "https:",
      hostname: "OPEN.LARKSUITE.COM.",
      path: "/open-apis/child-https-probe",
      agent,
    }, () => {});
  } catch (error) {
    httpsErrorCode = error?.code ?? error?.name ?? "UNKNOWN_ERROR";
  } finally {
    agent.destroy();
  }
  const httpAgent = new http.Agent();
  httpAgent.addRequest = () => { throw sentinel(); };
  const namedHttpsAgent = new https.Agent();
  namedHttpsAgent.addRequest = () => { throw sentinel(); };
  const captureSyncErrorCode = (probe) => {
    try {
      probe();
      return "NO_ERROR";
    } catch (error) {
      return error?.code ?? error?.name ?? "UNKNOWN_ERROR";
    }
  };
  const runNodeRequestProbe = (definition) => {
    const callback = () => undefined;
    const agent = new definition.Agent();
    let agentReached = false;
    let requestTargetPreserved = false;
    let callbackPreserved = false;
    agent.addRequest = (request) => {
      agentReached = true;
      requestTargetPreserved = request.path === definition.requestTarget;
      callbackPreserved = request.listeners("response").includes(callback);
      if (!requestTargetPreserved || !callbackPreserved) {
        const error = new Error("Playwright request probe arguments changed");
        error.code = "PLAYWRIGHT_REQUEST_PROBE_ARGUMENTS_CHANGED";
        throw error;
      }
      throw sentinel();
    };
    const errorCode = captureSyncErrorCode(() => definition.invoke(
      {
        ...definition.options,
        path: definition.requestTarget,
        agent,
      },
      callback,
    ));
    agent.destroy();
    return {
      name: definition.name,
      shouldBlock: definition.shouldBlock,
      errorCode,
      agentReached,
      requestTargetPreserved,
      callbackPreserved,
    };
  };
  const nodeRequestProbeResults = [
    runNodeRequestProbe({
      name: "default-http-request-host-port-feishu-raw-slash-bracket",
      shouldBlock: true,
      Agent: http.Agent,
      invoke: (options, callback) => http.request(options, callback),
      options: { protocol: "http:", host: "open.feishu.cn:443" },
      requestTarget: "//[",
    }),
    runNodeRequestProbe({
      name: "default-http-get-host-port-safe-raw-url-bracket",
      shouldBlock: false,
      Agent: http.Agent,
      invoke: (options, callback) => http.get(options, callback),
      options: { protocol: "http:", host: "safe.invalid:80" },
      requestTarget: "http://[",
    }),
    runNodeRequestProbe({
      name: "default-https-request-hostname-port-feishu-case-dot",
      shouldBlock: true,
      Agent: https.Agent,
      invoke: (options, callback) => https.request(options, callback),
      options: {
        protocol: "https:",
        hostname: "OPEN.FEISHU.CN.",
        port: 443,
      },
      requestTarget: "http://[",
    }),
    runNodeRequestProbe({
      name: "default-https-get-hostname-port-safe",
      shouldBlock: false,
      Agent: https.Agent,
      invoke: (options, callback) => https.get(options, callback),
      options: { protocol: "https:", hostname: "safe.invalid", port: 443 },
      requestTarget: "//[",
    }),
    runNodeRequestProbe({
      name: "named-http-request-hostname-priority-safe",
      shouldBlock: false,
      Agent: http.Agent,
      invoke: (options, callback) => httpRequest(options, callback),
      options: {
        protocol: "http:",
        hostname: "safe.invalid",
        host: "open.feishu.cn:80",
        port: 80,
      },
      requestTarget: "//[",
    }),
    runNodeRequestProbe({
      name: "named-http-get-hostname-priority-feishu",
      shouldBlock: true,
      Agent: http.Agent,
      invoke: (options, callback) => httpGet(options, callback),
      options: {
        protocol: "http:",
        hostname: "OPEN.FEISHU.CN.",
        host: "safe.invalid:80",
        port: 80,
      },
      requestTarget: "http://[",
    }),
    runNodeRequestProbe({
      name: "named-https-request-ipv4-host-port",
      shouldBlock: false,
      Agent: https.Agent,
      invoke: (options, callback) => httpsRequest(options, callback),
      options: { protocol: "https:", host: "127.0.0.1:443" },
      requestTarget: "http://[",
    }),
    runNodeRequestProbe({
      name: "named-https-get-bracketed-ipv6-host-port",
      shouldBlock: false,
      Agent: https.Agent,
      invoke: (options, callback) => httpsGet(options, callback),
      options: { protocol: "https:", host: "[::1]:443" },
      requestTarget: "//[",
    }),
    runNodeRequestProbe({
      name: "default-http-request-bare-ipv6-hostname-port",
      shouldBlock: false,
      Agent: http.Agent,
      invoke: (options, callback) => http.request(options, callback),
      options: { protocol: "http:", hostname: "::1", port: 80 },
      requestTarget: "//[",
    }),
    runNodeRequestProbe({
      name: "default-http-get-bracketed-ipv6-hostname-port",
      shouldBlock: false,
      Agent: http.Agent,
      invoke: (options, callback) => http.get(options, callback),
      options: { protocol: "http:", hostname: "[::1]", port: 80 },
      requestTarget: "http://[",
    }),
  ];
  const namedEsmErrorCodes = [
    captureSyncErrorCode(() => httpRequest(
      new URL("http://OPEN.FEISHU.CN./open-apis/named-request-url"),
      { agent: httpAgent },
    )),
    captureSyncErrorCode(() => httpGet({
      protocol: "http:",
      hostname: "OPEN.LARKSUITE.COM.",
      path: "/open-apis/named-get-options",
      agent: httpAgent,
    }, () => {})),
    captureSyncErrorCode(() => httpsRequest(
      new URL("https://OPEN.LARKSUITE.CN./open-apis/named-request-url"),
      { agent: namedHttpsAgent },
    )),
    captureSyncErrorCode(() => httpsGet({
      protocol: "https:",
      hostname: "OPEN.FEISHU.CN.",
      path: "/open-apis/named-get-options",
      agent: namedHttpsAgent,
    }, () => {})),
  ];
  const urlOptionsOverrideErrorCodes = [
    captureSyncErrorCode(() => http.request(
      "http://127.0.0.1:9/safe-default-http-request",
      {
        protocol: "http:",
        hostname: "OPEN.FEISHU.CN.",
        port: 80,
        path: "/open-apis/default-http-request-options-override",
        agent: httpAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => http.get(
      new URL("http://127.0.0.1:9/safe-default-http-get"),
      {
        protocol: "http:",
        hostname: undefined,
        host: "OPEN.LARKSUITE.COM.",
        port: 80,
        path: undefined,
        pathname: "/open-apis/default-http-get-options-override",
        agent: httpAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => https.request(
      "https://127.0.0.1:9/safe-default-https-request",
      {
        protocol: "https:",
        hostname: "OPEN.LARKSUITE.CN.",
        port: 443,
        path: "/open-apis/default-https-request-options-override",
        agent: namedHttpsAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => https.get(
      new URL("https://127.0.0.1:9/safe-default-https-get"),
      {
        protocol: "https:",
        hostname: "OPEN.FEISHU.CN.",
        port: 443,
        path: "/open-apis/default-https-get-options-override",
        agent: namedHttpsAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => httpRequest(
      "http://127.0.0.1:9/safe-named-http-request",
      {
        protocol: "http:",
        hostname: "OPEN.LARKSUITE.COM.",
        port: 80,
        path: "/open-apis/named-http-request-options-override",
        agent: httpAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => httpGet(
      new URL("http://127.0.0.1:9/safe-named-http-get"),
      {
        protocol: "http:",
        hostname: "OPEN.FEISHU.CN.",
        port: 80,
        path: "/open-apis/named-http-get-options-override",
        agent: httpAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => httpsRequest(
      "https://127.0.0.1:9/safe-named-https-request",
      {
        protocol: "https:",
        hostname: "OPEN.LARKSUITE.CN.",
        port: 443,
        path: "/open-apis/named-https-request-options-override",
        agent: namedHttpsAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => httpsGet(
      new URL("https://127.0.0.1:9/safe-named-https-get"),
      {
        protocol: "https:",
        hostname: "OPEN.FEISHU.CN.",
        port: 443,
        path: "/open-apis/named-https-get-options-override",
        agent: namedHttpsAgent,
      },
      () => {},
    )),
  ];
  const safeHostnameOverrideErrorCodes = [
    captureSyncErrorCode(() => http.get(
      "http://OPEN.FEISHU.CN./open-apis/sensitive-default-path",
      {
        hostname: "127.0.0.1",
        port: 9,
        path: "/local-sentinel",
        agent: httpAgent,
      },
      () => {},
    )),
    captureSyncErrorCode(() => httpsRequest(
      new URL("https://OPEN.LARKSUITE.COM./open-apis/sensitive-named-path"),
      {
        hostname: "localhost",
        port: 9,
        path: "/local-sentinel",
        agent: namedHttpsAgent,
      },
      () => {},
    )),
  ];
  httpAgent.destroy();
  namedHttpsAgent.destroy();
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  const originalNodeOptions =
    process.env["${PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV}"]?.trim() ?? "";
  const originalNodeOptionsPreserved =
    !originalNodeOptions ||
    nodeOptions === originalNodeOptions ||
    nodeOptions.startsWith(originalNodeOptions + " ");
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    guardInstalled: globalThis[installMarker] === true,
    fetchErrorCode,
    httpsErrorCode,
    namedEsmErrorCodes,
    urlOptionsOverrideErrorCodes,
    safeHostnameOverrideErrorCodes,
    nodeRequestProbeResults,
    guardImportPresent: nodeOptions.split(/\s+/).some((option) =>
      option.startsWith("--import=") &&
      option.includes("playwright-feishu-egress-guard.mjs"),
    ),
    nodeOptionsSentinelPresent: nodeOptions.split(/\s+/).includes(
      "${PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL}",
    ),
    checkpointDisabled: process.env.CHECKPOINT_DISABLE === "1",
    notificationDeliveryDisabled:
      process.env.NOTIFICATION_DELIVERY_DISABLED === "true",
    originalNodeOptionsPreserved,
    expectedGuardCode: guardCode,
  }));
`;
