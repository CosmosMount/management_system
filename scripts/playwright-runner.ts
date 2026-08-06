import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { cleanupPlaywrightDatabaseOwnership } from "./playwright-db-cleanup";
export { flattenPlaywrightErrorCauses } from "./playwright-error-reporting";
import {
  createPlaywrightOwnershipMarker,
  generatePlaywrightOwnershipSecret,
  removePlaywrightOwnershipMarker,
  resolvePlaywrightOwnershipMarker,
  type PlaywrightOwnershipMarker,
} from "./playwright-db-ownership-marker";
import {
  hasPlaywrightFeishuEgressGuardNodeOption,
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
  PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH,
  withPlaywrightFeishuEgressGuardNodeOptions,
} from "./playwright-feishu-egress-guard.mjs";
import {
  assertPlaywrightDatabaseConfirmations,
  assertPlaywrightDatabaseOutputs,
  assertPlaywrightRecreateOnlyEnvironment,
  createPlaywrightDatabaseOwnership,
  generatePlaywrightDatabaseOwnershipToken,
  resolvePlaywrightDatabaseOwnership,
  type PlaywrightDatabaseEnvironment,
  type PlaywrightDatabaseOwnership,
} from "./playwright-db-safety";

const CONTROLLED_BASE_URL = "http://127.0.0.1:3002";
const CONTROLLED_SERVER_PORT = "3002";
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 5_000;
const DEFAULT_FORCED_SHUTDOWN_MS = 5_000;
const DEFAULT_SERVER_READY_TIMEOUT_MS = 120_000;
const SERVER_READY_POLL_MS = 100;
const SERVER_PROBE_TIMEOUT_MS = 2_000;
const PROCESS_TREE_POLL_MS = 25;
const DANGEROUS_LONG_OPTIONS = [
  "--config",
  "--workers",
  "--fully-parallel",
] as const;
const FORMER_ENTRY_BYPASS_ENVIRONMENTS = [
  "PLAYWRIGHT_RUNNER_ENTRY_SIGNAL_SELF_TEST",
  "PLAYWRIGHT_RUNNER_ENTRY_IGNORE_SIGNAL_SELF_TEST",
  "PLAYWRIGHT_RUNNER_ENTRY_THROW_SIGNAL_SELF_TEST",
] as const;

type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];
type TimerHandle = ReturnType<typeof setTimeout>;

export type PlaywrightChild = {
  isTreeAlive(): boolean;
  kill(signal: NodeJS.Signals): boolean;
  onceError(listener: (error: Error) => void): void;
  onceExit(
    listener: (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): void;
};

export type PlaywrightSignalSource = {
  add(signal: ForwardedSignal, listener: () => void): void;
  remove(signal: ForwardedSignal, listener: () => void): void;
};

export type PlaywrightRunnerDependencies = {
  assertServerPortAvailable(): Promise<void>;
  cleanup(
    ownership: PlaywrightDatabaseOwnership,
    env: NodeJS.ProcessEnv,
    marker: PlaywrightOwnershipMarker,
  ): Promise<void>;
  clearTimer(handle: TimerHandle): void;
  createOwnershipMarker(
    cwd: string,
    ownership: PlaywrightDatabaseOwnership,
    secret: string,
  ): PlaywrightOwnershipMarker;
  createRunId(): string;
  cwd: string;
  discardOwnershipMarker(
    cwd: string,
    ownership: PlaywrightDatabaseOwnership,
    env: NodeJS.ProcessEnv,
    marker: PlaywrightOwnershipMarker,
  ): void;
  forcedShutdownMs: number;
  gracefulShutdownMs: number;
  platform: NodeJS.Platform;
  randomBytes(size: number): Uint8Array;
  serverReadyTimeoutMs: number;
  setTimer(listener: () => void, milliseconds: number): TimerHandle;
  signalSource: PlaywrightSignalSource;
  spawnPlaywright(args: string[], env: NodeJS.ProcessEnv): PlaywrightChild;
  spawnServer(env: NodeJS.ProcessEnv): PlaywrightChild;
  waitForServerReady(
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void>;
};

export type PlaywrightRunnerResult = {
  cleanupSucceeded: boolean;
  error?: unknown;
  exitCode: number;
  ownership: PlaywrightDatabaseOwnership;
  signal: NodeJS.Signals | null;
};

export type OfficialPlaywrightRunContext = {
  env: NodeJS.ProcessEnv;
  marker: PlaywrightOwnershipMarker;
  ownership: PlaywrightDatabaseOwnership;
};

type ChildOutcome =
  | { kind: "exit"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { error: Error; kind: "spawn-error" }
  | { kind: "termination-timeout"; signal: ForwardedSignal };

type ChildObserver = {
  isSettled(): boolean;
  promise: Promise<ChildOutcome>;
  settle(outcome: ChildOutcome): void;
};

type ControlledChild = {
  child: PlaywrightChild;
  gracefulSignalSent: boolean;
  observer: ChildObserver;
  role: "Playwright CLI" | "Playwright server";
};

type PhaseOutcome =
  | { kind: "child"; outcome: ChildOutcome; process: ControlledChild }
  | { error: Error; kind: "readiness-error" }
  | { kind: "ready" }
  | { kind: "requested-signal" };

export function playwrightSignalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function childOutcomeError(
  outcome: ChildOutcome,
  requestedSignal: ForwardedSignal | null,
  role = "Playwright child",
): Error | undefined {
  if (outcome.kind === "spawn-error") return outcome.error;
  if (outcome.kind === "termination-timeout") {
    return new Error(
      `Playwright child did not report exit after ${outcome.signal} and SIGKILL`,
    );
  }
  if (requestedSignal) {
    return new Error(`Playwright run was interrupted by ${requestedSignal}`);
  }
  if (outcome.signal) {
    return new Error(`${role} exited with signal ${outcome.signal}`);
  }
  if ((outcome.exitCode ?? 1) !== 0) {
    return new Error(
      `${role} exited with code ${outcome.exitCode ?? 1}`,
    );
  }
  return undefined;
}

function observeChild(child: PlaywrightChild): ChildObserver {
  let settled = false;
  let resolveOutcome: (outcome: ChildOutcome) => void = () => undefined;
  const promise = new Promise<ChildOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const settle = (outcome: ChildOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(outcome);
  };
  child.onceError((error) => settle({ error, kind: "spawn-error" }));
  child.onceExit((exitCode, signal) =>
    settle({ exitCode, kind: "exit", signal }),
  );
  return { isSettled: () => settled, promise, settle };
}

export function assertSafePlaywrightArguments(args: string[]): void {
  for (const arg of args) {
    if (
      DANGEROUS_LONG_OPTIONS.some(
        (option) => arg === option || arg.startsWith(`${option}=`),
      ) ||
      (arg.startsWith("-") && !arg.startsWith("--"))
    ) {
      throw new Error(
        "Playwright short options and config, worker, or fully-parallel overrides are disabled",
      );
    }
  }
}

export function controlledPlaywrightNodeOptions(cwd: string): string {
  const guardPath = path.resolve(
    cwd,
    "scripts",
    "playwright-feishu-egress-guard.mjs",
  );
  return [
    PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
    withPlaywrightFeishuEgressGuardNodeOptions("", guardPath),
  ].join(" ");
}

function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      "The official Playwright runner requires POSIX process-group termination",
    );
  }
}

export function assertOfficialPlaywrightEnvironment(
  env: PlaywrightDatabaseEnvironment,
  cwd = process.cwd(),
): PlaywrightDatabaseOwnership {
  assertSupportedPlatform(process.platform);
  assertPlaywrightRecreateOnlyEnvironment(env);
  const ownership = resolvePlaywrightDatabaseOwnership(env);
  assertPlaywrightDatabaseConfirmations(ownership, env);
  assertPlaywrightDatabaseOutputs(ownership, env);
  resolvePlaywrightOwnershipMarker(cwd, ownership, env);

  if (env.PLAYWRIGHT_BASE_URL !== CONTROLLED_BASE_URL) {
    throw new Error(`PLAYWRIGHT_BASE_URL must be ${CONTROLLED_BASE_URL}`);
  }
  if (env.PLAYWRIGHT_SERVER_PORT !== CONTROLLED_SERVER_PORT) {
    throw new Error(`PLAYWRIGHT_SERVER_PORT must be ${CONTROLLED_SERVER_PORT}`);
  }
  if (env.CHECKPOINT_DISABLE !== "1") {
    throw new Error("CHECKPOINT_DISABLE=1 is required for Playwright");
  }
  if (env.NOTIFICATION_DELIVERY_DISABLED !== "true") {
    throw new Error(
      "NOTIFICATION_DELIVERY_DISABLED=true is required for Playwright",
    );
  }
  if (env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] !== "true") {
    throw new Error("The Playwright Feishu egress guard must be enabled");
  }
  const expectedNodeOptions = controlledPlaywrightNodeOptions(cwd);
  const guardPath = path.resolve(
    cwd,
    "scripts",
    "playwright-feishu-egress-guard.mjs",
  );
  if (
    env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV] !== guardPath ||
    env.NODE_OPTIONS !== expectedNodeOptions ||
    !hasPlaywrightFeishuEgressGuardNodeOption(env.NODE_OPTIONS, guardPath)
  ) {
    throw new Error(
      "NODE_OPTIONS must contain only the cwd-bound official Playwright Feishu guard",
    );
  }
  if (!env[PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV]?.trim()) {
    throw new Error("The Playwright Feishu egress run identifier is required");
  }
  if (env.CONFIRM_SEND_FEISHU?.trim()) {
    throw new Error("CONFIRM_SEND_FEISHU must be unset for Playwright");
  }
  if (env.PLAYWRIGHT_REUSE_SERVER?.trim()) {
    throw new Error("PLAYWRIGHT_REUSE_SERVER must be unset");
  }
  if (env.PLAYWRIGHT_SKIP_WEBSERVER?.trim()) {
    throw new Error("PLAYWRIGHT_SKIP_WEBSERVER must be unset");
  }
  const probeOutput = env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV]?.trim();
  const probeRole = env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV]?.trim();
  if (
    Boolean(probeOutput) !== Boolean(probeRole) ||
    (probeOutput &&
      (probeOutput !==
        path.join(cwd, PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH) ||
        probeRole !== "server"))
  ) {
    throw new Error(
      "Playwright Feishu guard probe output must be unset or use the controlled server path",
    );
  }
  return ownership;
}

export function createOfficialPlaywrightEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  ownership: PlaywrightDatabaseOwnership,
  marker: PlaywrightOwnershipMarker,
  options: { cwd: string; runId: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sourceEnv };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV];
  delete env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV];
  for (const environmentName of FORMER_ENTRY_BYPASS_ENVIRONMENTS) {
    delete env[environmentName];
  }
  for (const environmentName of [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_SECURE",
    "SMTP_REQUIRE_TLS",
  ]) {
    delete env[environmentName];
  }

  env.CHECKPOINT_DISABLE = "1";
  env.CONFIRM_SEND_FEISHU = "";
  env.DATABASE_URL = ownership.target.url;
  env.NOTIFICATION_DELIVERY_DISABLED = "true";
  env.EMAIL_DELIVERY_ALLOWED_ADDRESSES = "";
  env.PLAYWRIGHT_BASE_URL = CONTROLLED_BASE_URL;
  env.PLAYWRIGHT_CONFIRM_RECREATE_DB = ownership.target.databaseName;
  env.PLAYWRIGHT_CONFIRM_RECREATE_SHADOW_DB =
    ownership.shadow.databaseName;
  env.PLAYWRIGHT_DATABASE_URL = ownership.target.url;
  env.PLAYWRIGHT_DB_OWNERSHIP_MARKER = marker.markerPath;
  env.PLAYWRIGHT_DB_OWNERSHIP_SECRET = marker.secret;
  env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN = ownership.token;
  env.PLAYWRIGHT_DB_SETUP_MODE = "recreate";
  env.PLAYWRIGHT_REUSE_SERVER = "";
  env.PLAYWRIGHT_SERVER_PORT = CONTROLLED_SERVER_PORT;
  env.PLAYWRIGHT_SHADOW_DATABASE_URL = ownership.shadow.url;
  env.PLAYWRIGHT_SKIP_WEBSERVER = "";
  env.PLAYWRIGHT_SOURCE_DATABASE_URL = "";
  env.SHADOW_DATABASE_URL = ownership.shadow.url;
  env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] = "true";
  env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV] = path.resolve(
    options.cwd,
    "scripts",
    "playwright-feishu-egress-guard.mjs",
  );
  env[PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV] = "";
  env[PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV] = options.runId;
  env.NODE_OPTIONS = controlledPlaywrightNodeOptions(options.cwd);

  assertOfficialPlaywrightEnvironment(env, options.cwd);
  return env;
}

export function createOfficialPlaywrightServerEnvironment(
  env: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  const serverEnv: NodeJS.ProcessEnv = {
    ...env,
    [PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV]: path.join(
      cwd,
      PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH,
    ),
    [PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV]: "server",
    FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES:
      env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES?.trim() || "李棋轩",
  };
  assertOfficialPlaywrightEnvironment(serverEnv, cwd);
  return serverEnv;
}

export function createOfficialPlaywrightRunContext(
  sourceEnv: NodeJS.ProcessEnv,
  dependencies: Pick<
    PlaywrightRunnerDependencies,
    | "createOwnershipMarker"
    | "createRunId"
    | "cwd"
    | "discardOwnershipMarker"
    | "randomBytes"
  >,
): OfficialPlaywrightRunContext {
  const credentialSourceUrl = sourceEnv.PLAYWRIGHT_DATABASE_URL?.trim();
  if (!credentialSourceUrl) {
    throw new Error(
      "PLAYWRIGHT_DATABASE_URL is required as a local PostgreSQL credential source",
    );
  }
  const token = generatePlaywrightDatabaseOwnershipToken(
    dependencies.randomBytes,
  );
  const ownership = createPlaywrightDatabaseOwnership(
    credentialSourceUrl,
    token,
  );
  const secret = generatePlaywrightOwnershipSecret(dependencies.randomBytes);
  const marker = dependencies.createOwnershipMarker(
    dependencies.cwd,
    ownership,
    secret,
  );
  const markerEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_DB_OWNERSHIP_MARKER: marker.markerPath,
    PLAYWRIGHT_DB_OWNERSHIP_SECRET: marker.secret,
  };
  try {
    const env = createOfficialPlaywrightEnvironment(
      sourceEnv,
      ownership,
      marker,
      {
        cwd: dependencies.cwd,
        runId: dependencies.createRunId(),
      },
    );
    return { env, marker, ownership };
  } catch (error) {
    try {
      dependencies.discardOwnershipMarker(
        dependencies.cwd,
        ownership,
        markerEnvironment,
        marker,
      );
    } catch (discardError) {
      throw new AggregateError(
        [error, discardError],
        "Playwright environment validation and marker rollback both failed",
      );
    }
    throw error;
  }
}

function officialPlaywrightArguments(cwd: string, args: string[]): string[] {
  return [`--config=${path.join(cwd, "playwright.config.ts")}`, ...args];
}

export function spawnControlledPlaywrightChild(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio?: "ignore" | "inherit";
  },
): PlaywrightChild {
  assertSupportedPlatform(process.platform);
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: options.stdio ?? "inherit",
  });
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    if (child.pid === undefined) return child.kill(signal);
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  return {
    isTreeAlive: () => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    },
    kill: signalGroup,
    onceError: (listener) => child.once("error", listener),
    onceExit: (listener) => child.once("exit", listener),
  };
}

function defaultSpawnPlaywright(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): PlaywrightChild {
  const playwrightCli = path.join(
    cwd,
    "node_modules",
    "@playwright",
    "test",
    "cli.js",
  );
  return spawnControlledPlaywrightChild(
    process.execPath,
    [playwrightCli, "test", ...args],
    { cwd, env },
  );
}

function defaultSpawnServer(
  cwd: string,
  env: NodeJS.ProcessEnv,
): PlaywrightChild {
  const tsxBin = path.join(cwd, "node_modules", ".bin", "tsx");
  return spawnControlledPlaywrightChild(
    process.execPath,
    [tsxBin, "scripts/start-playwright-server.ts"],
    { cwd, env },
  );
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Playwright server readiness was aborted"));
      return;
    }
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal.reason ?? new Error("Playwright server readiness was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function probeControlledServer(
  baseUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  const probeAbort = new AbortController();
  const abortProbe = () => probeAbort.abort(signal.reason);
  signal.addEventListener("abort", abortProbe, { once: true });
  const probeTimeout = setTimeout(
    () => probeAbort.abort(new Error("Playwright server probe timed out")),
    SERVER_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      redirect: "manual",
      signal: probeAbort.signal,
    });
    return response.status >= 200 && response.status < 500;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  } finally {
    clearTimeout(probeTimeout);
    signal.removeEventListener("abort", abortProbe);
  }
}

async function waitForControlledServerReady(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const baseUrl = env.PLAYWRIGHT_BASE_URL;
  if (baseUrl !== CONTROLLED_BASE_URL) {
    throw new Error(`PLAYWRIGHT_BASE_URL must be ${CONTROLLED_BASE_URL}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    if (await probeControlledServer(baseUrl, signal)) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await abortableDelay(Math.min(SERVER_READY_POLL_MS, remainingMs), signal);
  }
  if (signal.aborted) {
    throw signal.reason ?? new Error("Playwright server readiness was aborted");
  }
  throw new Error(
    `Playwright server did not become ready within ${timeoutMs}ms`,
  );
}

async function assertControlledServerPortAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: 3002 });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(500, () =>
      finish(
        new Error(
          "Unable to prove that the controlled Playwright server port is available",
        ),
      ),
    );
    socket.once("connect", () =>
      finish(
        new Error(
          "127.0.0.1:3002 is already in use; refusing to create Playwright database ownership",
        ),
      ),
    );
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish();
      else finish(error);
    });
  });
}

export function defaultPlaywrightRunnerDependencies(
  cwd = process.cwd(),
): PlaywrightRunnerDependencies {
  return {
    assertServerPortAvailable: assertControlledServerPortAvailable,
    cleanup: (ownership, env, marker) =>
      cleanupPlaywrightDatabaseOwnership(
        ownership,
        env,
        cwd,
        { allowAlreadyFinalized: true, expectedMarker: marker },
      ),
    clearTimer: (handle) => clearTimeout(handle),
    createOwnershipMarker: createPlaywrightOwnershipMarker,
    createRunId: randomUUID,
    cwd,
    discardOwnershipMarker: (markerCwd, ownership, env, marker) =>
      removePlaywrightOwnershipMarker(markerCwd, ownership, env, marker),
    forcedShutdownMs: DEFAULT_FORCED_SHUTDOWN_MS,
    gracefulShutdownMs: DEFAULT_GRACEFUL_SHUTDOWN_MS,
    platform: process.platform,
    randomBytes,
    serverReadyTimeoutMs: DEFAULT_SERVER_READY_TIMEOUT_MS,
    setTimer: (listener, milliseconds) => setTimeout(listener, milliseconds),
    signalSource: {
      add: (signal, listener) => process.on(signal, listener),
      remove: (signal, listener) => process.off(signal, listener),
    },
    spawnPlaywright: (args, env) => defaultSpawnPlaywright(cwd, args, env),
    spawnServer: (env) => defaultSpawnServer(cwd, env),
    waitForServerReady: waitForControlledServerReady,
  };
}

async function waitForChildTreeExit(
  child: PlaywrightChild,
  timeoutMs: number,
  dependencies: PlaywrightRunnerDependencies,
  inspectionErrors: Error[],
): Promise<boolean> {
  let inspectionErrorRecorded = false;
  const treeIsAlive = (): boolean => {
    try {
      return child.isTreeAlive();
    } catch (error) {
      if (!inspectionErrorRecorded) {
        inspectionErrors.push(
          error instanceof Error
            ? error
            : new Error("Unable to inspect the Playwright process tree"),
        );
        inspectionErrorRecorded = true;
      }
      return true;
    }
  };
  if (!treeIsAlive()) return true;

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: TimerHandle | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (pollTimer) dependencies.clearTimer(pollTimer);
      dependencies.clearTimer(timeoutTimer);
      resolve(value);
    };
    const poll = () => {
      if (!treeIsAlive()) {
        finish(true);
        return;
      }
      pollTimer = dependencies.setTimer(
        poll,
        Math.min(PROCESS_TREE_POLL_MS, Math.max(1, timeoutMs)),
      );
    };
    const timeoutTimer = dependencies.setTimer(
      () => finish(!treeIsAlive()),
      timeoutMs,
    );
    poll();
  });
}

async function ensureChildTreeQuiescent(
  process: ControlledChild | null,
  forceImmediately: boolean,
  dependencies: PlaywrightRunnerDependencies,
): Promise<Error[]> {
  if (!process) return [];
  const { child, role } = process;
  const errors: Error[] = [];
  const treeAlive = (): boolean => {
    try {
      return child.isTreeAlive();
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error
          : new Error(`Unable to inspect the ${role} process tree`),
      );
      return true;
    }
  };
  const sendSignal = (signal: NodeJS.Signals): void => {
    try {
      const accepted = child.kill(signal);
      if (!accepted && treeAlive()) {
        errors.push(
          new Error(`${role} process tree rejected ${signal}`),
        );
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error
          : new Error(`Unable to send ${signal} to ${role} process tree`),
      );
    }
  };

  if (!treeAlive()) return errors;
  if (!forceImmediately && !process.gracefulSignalSent) {
    sendSignal("SIGTERM");
    process.gracefulSignalSent = true;
  }
  if (!forceImmediately) {
    if (
      await waitForChildTreeExit(
        child,
        dependencies.gracefulShutdownMs,
        dependencies,
        errors,
      )
    ) {
      return errors;
    }
  }
  sendSignal("SIGKILL");
  if (
    !(await waitForChildTreeExit(
      child,
      dependencies.forcedShutdownMs,
      dependencies,
      errors,
    ))
  ) {
    errors.push(
      new Error(`${role} process tree remained alive after SIGKILL`),
    );
  }
  return errors;
}

export async function runOfficialPlaywright(
  sourceEnv: NodeJS.ProcessEnv,
  args: string[],
  dependencies: PlaywrightRunnerDependencies,
): Promise<PlaywrightRunnerResult> {
  assertSupportedPlatform(dependencies.platform);
  assertSafePlaywrightArguments(args);
  await dependencies.assertServerPortAvailable();
  const { env, marker, ownership } = createOfficialPlaywrightRunContext(
    sourceEnv,
    dependencies,
  );

  const processes: ControlledChild[] = [];
  let serverProcess: ControlledChild | null = null;
  let cliProcess: ControlledChild | null = null;
  let cliOutcome: ChildOutcome | null = null;
  let lifecycleError: Error | undefined;
  let requestedSignal: ForwardedSignal | null = null;
  let receivedSignalCount = 0;
  let forcedTerminationStarted = false;
  const signalForwardErrors: Error[] = [];
  const signalListeners = new Map<ForwardedSignal, () => void>();
  let resolveRequestedSignal: () => void = () => undefined;
  const requestedSignalPromise = new Promise<void>((resolve) => {
    resolveRequestedSignal = resolve;
  });
  const readinessAbort = new AbortController();

  const recordKillError = (error: unknown) => {
    signalForwardErrors.push(
      error instanceof Error
        ? error
        : new Error("Failed to terminate a controlled Playwright process"),
    );
  };

  const signalProcess = (
    process: ControlledChild,
    signal: NodeJS.Signals,
  ): void => {
    try {
      const accepted = process.child.kill(signal);
      if (!accepted && process.child.isTreeAlive()) {
        signalForwardErrors.push(
          new Error(`${process.role} process tree rejected ${signal}`),
        );
      }
    } catch (error) {
      recordKillError(error);
    }
    if (signal !== "SIGKILL") process.gracefulSignalSent = true;
  };

  const applyPendingTermination = (process: ControlledChild) => {
    if (!requestedSignal) return;
    if (receivedSignalCount >= 2) {
      forcedTerminationStarted = true;
      signalProcess(process, "SIGKILL");
      return;
    }
    if (!process.gracefulSignalSent) signalProcess(process, requestedSignal);
  };

  const registerProcess = (
    role: ControlledChild["role"],
    child: PlaywrightChild,
  ): ControlledChild => {
    const process = {
      child,
      gracefulSignalSent: false,
      observer: observeChild(child),
      role,
    };
    processes.push(process);
    applyPendingTermination(process);
    return process;
  };

  const receiveSignal = (signal: ForwardedSignal) => {
    receivedSignalCount += 1;
    if (!requestedSignal) {
      requestedSignal = signal;
      resolveRequestedSignal();
      readinessAbort.abort(new Error(`Playwright run interrupted by ${signal}`));
    }
    if (receivedSignalCount >= 2) forcedTerminationStarted = true;
    for (const process of processes) applyPendingTermination(process);
  };

  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => receiveSignal(signal);
    signalListeners.set(signal, listener);
    dependencies.signalSource.add(signal, listener);
  }

  try {
    try {
      const serverEnv = createOfficialPlaywrightServerEnvironment(
        env,
        dependencies.cwd,
      );
      serverProcess = registerProcess(
        "Playwright server",
        dependencies.spawnServer(serverEnv),
      );

      const startupOutcome = await Promise.race<PhaseOutcome>([
        dependencies
          .waitForServerReady(
            serverEnv,
            readinessAbort.signal,
            dependencies.serverReadyTimeoutMs,
          )
          .then<PhaseOutcome, PhaseOutcome>(
            () => ({ kind: "ready" }),
            (error: unknown) => ({
              error:
                error instanceof Error
                  ? error
                  : new Error("Playwright server readiness failed"),
              kind: "readiness-error",
            }),
          ),
        serverProcess.observer.promise.then<PhaseOutcome>((outcome) => ({
          kind: "child",
          outcome,
          process: serverProcess as ControlledChild,
        })),
        requestedSignalPromise.then<PhaseOutcome>(() => ({
          kind: "requested-signal",
        })),
      ]);

      if (startupOutcome.kind === "readiness-error") {
        if (!requestedSignal) lifecycleError = startupOutcome.error;
      } else if (startupOutcome.kind === "child") {
        lifecycleError =
          childOutcomeError(
            startupOutcome.outcome,
            null,
            startupOutcome.process.role,
          ) ?? new Error("Playwright server exited before becoming ready");
      } else if (startupOutcome.kind === "ready" && !requestedSignal) {
        let serverAlive = false;
        try {
          serverAlive = serverProcess.child.isTreeAlive();
        } catch (error) {
          lifecycleError =
            error instanceof Error
              ? error
              : new Error("Unable to inspect the Playwright server process tree");
        }
        if (!serverAlive && !lifecycleError) {
          lifecycleError = new Error(
            "Playwright server exited after readiness and before CLI startup",
          );
        }

        if (!lifecycleError) {
          cliProcess = registerProcess(
            "Playwright CLI",
            dependencies.spawnPlaywright(
              officialPlaywrightArguments(dependencies.cwd, args),
              env,
            ),
          );
          const executionOutcome = await Promise.race<PhaseOutcome>([
            cliProcess.observer.promise.then<PhaseOutcome>((outcome) => ({
              kind: "child",
              outcome,
              process: cliProcess as ControlledChild,
            })),
            serverProcess.observer.promise.then<PhaseOutcome>((outcome) => ({
              kind: "child",
              outcome,
              process: serverProcess as ControlledChild,
            })),
            requestedSignalPromise.then<PhaseOutcome>(() => ({
              kind: "requested-signal",
            })),
          ]);
          if (executionOutcome.kind === "child") {
            if (executionOutcome.process === cliProcess) {
              cliOutcome = executionOutcome.outcome;
            } else {
              lifecycleError =
                childOutcomeError(
                  executionOutcome.outcome,
                  null,
                  executionOutcome.process.role,
                ) ?? new Error("Playwright server exited while tests were running");
            }
          }
        }
      }
    } catch (error) {
      lifecycleError =
        error instanceof Error
          ? error
          : new Error("Unable to start a controlled Playwright process");
    }

    readinessAbort.abort(new Error("Playwright server readiness is complete"));
    const treeErrors = (
      await Promise.all(
        processes.map((process) =>
          ensureChildTreeQuiescent(
            process,
            forcedTerminationStarted || receivedSignalCount >= 2,
            dependencies,
          ),
        ),
      )
    ).flat();

    let cleanupError: unknown;
    let cleanupSucceeded = false;
    if (treeErrors.length === 0) {
      try {
        await dependencies.cleanup(ownership, env, marker);
        cleanupSucceeded = true;
      } catch (error) {
        cleanupError = error;
      }
    } else {
      cleanupError = new Error(
        "Exact database cleanup was skipped because every controlled Playwright process tree was not proven quiescent",
      );
    }

    const effectiveSignal =
      requestedSignal ?? (cliOutcome?.kind === "exit" ? cliOutcome.signal : null);
    const originalError =
      lifecycleError ??
      (cliOutcome
        ? childOutcomeError(cliOutcome, requestedSignal, "Playwright CLI")
        : requestedSignal
          ? new Error(`Playwright run was interrupted by ${requestedSignal}`)
          : undefined);
    if (
      cleanupError ||
      signalForwardErrors.length > 0 ||
      treeErrors.length > 0 ||
      lifecycleError
    ) {
      const errors: unknown[] = [];
      if (originalError) errors.push(originalError);
      errors.push(...signalForwardErrors, ...treeErrors);
      if (cleanupError) errors.push(cleanupError);
      return {
        cleanupSucceeded,
        error:
          errors.length === 1
            ? errors[0]
            : new AggregateError(
                errors,
                "Playwright execution, process-tree shutdown, and exact database cleanup did not all succeed",
              ),
        exitCode: effectiveSignal
          ? playwrightSignalExitCode(effectiveSignal)
          : 1,
        ownership,
        signal: effectiveSignal,
      };
    }

    if (cliOutcome?.kind === "spawn-error") {
      return {
        cleanupSucceeded: true,
        error: cliOutcome.error,
        exitCode: 1,
        ownership,
        signal: effectiveSignal,
      };
    }
    if (effectiveSignal) {
      return {
        cleanupSucceeded: true,
        exitCode: playwrightSignalExitCode(effectiveSignal),
        ownership,
        signal: effectiveSignal,
      };
    }
    return {
      cleanupSucceeded: true,
      exitCode:
        cliOutcome?.kind === "exit" ? (cliOutcome.exitCode ?? 1) : 1,
      ownership,
      signal: null,
    };
  } finally {
    readinessAbort.abort(new Error("Playwright runner finalized"));
    for (const [signal, listener] of signalListeners) {
      dependencies.signalSource.remove(signal, listener);
    }
  }
}
