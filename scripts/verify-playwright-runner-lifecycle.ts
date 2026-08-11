import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  cleanupPlaywrightDatabaseOwnership,
  setupPlaywrightDatabaseOwnership,
  type PlaywrightDatabaseCleanupDependencies,
  type PlaywrightDatabaseSetupDependencies,
} from "./playwright-db-cleanup";
import {
  assertPlaywrightMarkerMetadata,
  createPlaywrightOwnershipMarker,
  PLAYWRIGHT_OWNERSHIP_MARKER_MAX_BYTES,
  removePlaywrightOwnershipMarker,
  resolvePlaywrightOwnershipMarker,
  type PlaywrightOwnershipMarker,
} from "./playwright-db-ownership-marker";
import {
  createPlaywrightDatabaseOwnership,
  playwrightDatabaseNamesForToken,
  resolvePlaywrightDatabaseOwnership,
  type PlaywrightDatabaseOwnership,
} from "./playwright-db-safety";
import {
  assertOfficialPlaywrightEnvironment,
  controlledPlaywrightNodeOptions,
  createOfficialPlaywrightRunContext,
  defaultPlaywrightRunnerDependencies,
  flattenPlaywrightErrorCauses,
  playwrightSignalExitCode,
  runOfficialPlaywright,
  spawnControlledPlaywrightChild,
  type PlaywrightChild,
  type PlaywrightRunnerDependencies,
  type PlaywrightSignalSource,
} from "./playwright-runner";
import {
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH,
} from "./playwright-feishu-egress-guard.mjs";

const credentialSource =
  "postgresql://playwright_user:unit-secret@127.0.0.1:5432/static_path_is_ignored?sslmode=disable";
const terminationSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const formerEntryBypassEnvironments = [
  ["PLAYWRIGHT_RUNNER_ENTRY_SIGNAL_SELF_TEST", "SIGINT"],
  ["PLAYWRIGHT_RUNNER_ENTRY_IGNORE_SIGNAL_SELF_TEST", "true"],
  ["PLAYWRIGHT_RUNNER_ENTRY_THROW_SIGNAL_SELF_TEST", "true"],
] as const;
type TerminationSignal = (typeof terminationSignals)[number];

type RegisteredMarker = {
  cwd: string;
  marker: PlaywrightOwnershipMarker;
  ownership: PlaywrightDatabaseOwnership;
};

const registeredMarkers = new Map<string, RegisteredMarker>();

class FakeChild implements PlaywrightChild {
  private readonly events = new EventEmitter();
  private readonly onKill?: (signal: NodeJS.Signals) => boolean;
  private treeAlive: boolean;

  constructor(
    onKill?: (signal: NodeJS.Signals) => boolean,
    options: { treeAlive?: boolean } = {},
  ) {
    this.onKill = onKill;
    this.treeAlive = options.treeAlive ?? true;
  }

  emitError(error: Error, treeAlive = false): void {
    this.treeAlive = treeAlive;
    this.events.emit("error", error);
  }

  emitExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    treeAlive = false,
  ): void {
    this.treeAlive = treeAlive;
    this.events.emit("exit", exitCode, signal);
  }

  isTreeAlive(): boolean {
    return this.treeAlive;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.onKill?.(signal) ?? true;
  }

  onceError(listener: (error: Error) => void): void {
    this.events.once("error", listener);
  }

  onceExit(
    listener: (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): void {
    this.events.once("exit", listener);
  }

  setTreeAlive(value: boolean): void {
    this.treeAlive = value;
  }
}

class FakeSignalSource implements PlaywrightSignalSource {
  private readonly events = new EventEmitter();

  add(signal: TerminationSignal, listener: () => void): void {
    this.events.on(signal, listener);
  }

  emit(signal: TerminationSignal): void {
    this.events.emit(signal);
  }

  remove(signal: TerminationSignal, listener: () => void): void {
    this.events.off(signal, listener);
  }
}

function deterministicRandomBytes(byte: number): (size: number) => Uint8Array {
  return (size) => Buffer.alloc(size, byte);
}

function markerEnvironment(marker: PlaywrightOwnershipMarker): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PLAYWRIGHT_DB_OWNERSHIP_MARKER: marker.markerPath,
    PLAYWRIGHT_DB_OWNERSHIP_SECRET: marker.secret,
  };
}

function registerMarker(
  cwd: string,
  ownership: PlaywrightDatabaseOwnership,
  secret: string,
): PlaywrightOwnershipMarker {
  const marker = createPlaywrightOwnershipMarker(cwd, ownership, secret);
  registeredMarkers.set(marker.markerPath, { cwd, marker, ownership });
  return marker;
}

function discardRegisteredMarker(
  cwd: string,
  ownership: PlaywrightDatabaseOwnership,
  env: NodeJS.ProcessEnv,
  marker: PlaywrightOwnershipMarker,
): void {
  try {
    removePlaywrightOwnershipMarker(cwd, ownership, env, marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    registeredMarkers.delete(marker.markerPath);
  }
}

function discardMarkerForOwnership(ownership: PlaywrightDatabaseOwnership): void {
  const record = [...registeredMarkers.values()].find(
    (candidate) => candidate.ownership.token === ownership.token,
  );
  if (!record) return;
  discardRegisteredMarker(
    record.cwd,
    record.ownership,
    markerEnvironment(record.marker),
    record.marker,
  );
}

function baseDependencies(
  overrides: Partial<PlaywrightRunnerDependencies> = {},
): PlaywrightRunnerDependencies {
  const defaults = defaultPlaywrightRunnerDependencies(process.cwd());
  const dependencies: PlaywrightRunnerDependencies = {
    ...defaults,
    assertServerPortAvailable: async () => undefined,
    cleanup: async (ownership, env, marker) => {
      discardRegisteredMarker(process.cwd(), ownership, env, marker);
    },
    createOwnershipMarker: registerMarker,
    discardOwnershipMarker: discardRegisteredMarker,
    forcedShutdownMs: 10,
    gracefulShutdownMs: 10,
    randomBytes: deterministicRandomBytes(1),
    signalSource: new FakeSignalSource(),
    spawnPlaywright: () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emitExit(0, null));
      return child;
    },
    spawnServer: () => {
      const child = new FakeChild((signal) => {
        child.setTreeAlive(false);
        queueMicrotask(() => child.emitExit(null, signal));
        return true;
      });
      return child;
    },
    waitForServerReady: async () => undefined,
  };
  return { ...dependencies, ...overrides };
}

type EntryResult = {
  exitCode: number | null;
  output: string;
  signal: NodeJS.Signals | null;
};

async function runTypeScriptEntry(
  scriptPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = { ...process.env },
): Promise<EntryResult> {
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxBin, scriptPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOG_FORMAT: "json",
        PLAYWRIGHT_DATABASE_URL: credentialSource,
        PLAYWRIGHT_SOURCE_DATABASE_URL:
          "postgresql://must-not-connect.invalid/source",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) =>
      resolve({ exitCode, output, signal }),
    );
  });
}

function markerRootFiles(): string[] {
  const markerRoot = path.join(
    process.cwd(),
    ".tmp",
    "playwright-db-ownership",
  );
  return existsSync(markerRoot) ? readdirSync(markerRoot).sort() : [];
}

async function testDangerousCliRejectionAndForcedConfig(): Promise<void> {
  const dangerousArguments = [
    ["--config", "alternate.config.ts"],
    ["--config=alternate.config.ts"],
    ["-c", "alternate.config.ts"],
    ["-c=alternate.config.ts"],
    ["-calternate.config.ts"],
    ["--workers", "4"],
    ["--workers=4"],
    ["-j", "4"],
    ["-j=4"],
    ["-j4"],
    ["--fully-parallel"],
    ["--fully-parallel=true"],
    ["-xcalternate.config.ts"],
    ["-xc", "alternate.config.ts"],
    ["-xj4"],
    ["-xj", "4"],
  ];
  for (const args of dangerousArguments) {
    let spawnCalls = 0;
    let cleanupCalls = 0;
    const markerFilesBefore = markerRootFiles();
    await assert.rejects(() =>
      runOfficialPlaywright(
        { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
        args,
        baseDependencies({
          cleanup: async () => {
            cleanupCalls += 1;
          },
          spawnPlaywright: () => {
            spawnCalls += 1;
            return new FakeChild();
          },
        }),
      ),
    );
    assert.equal(spawnCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(markerRootFiles(), markerFilesBefore);

    const entryResult = await runTypeScriptEntry(
      "scripts/run-playwright.ts",
      args,
    );
    assert.equal(entryResult.signal, null);
    assert.notEqual(entryResult.exitCode, 0);
    assert.deepEqual(markerRootFiles(), markerFilesBefore);
  }

  let capturedArguments: string[] = [];
  const safeResult = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    ["tests/smoke.spec.ts", "--project=desktop"],
    baseDependencies({
      spawnPlaywright: (args) => {
        capturedArguments = args;
        const child = new FakeChild();
        queueMicrotask(() => child.emitExit(0, null));
        return child;
      },
    }),
  );
  assert.equal(safeResult.exitCode, 0);
  assert.equal(
    capturedArguments[0],
    `--config=${path.join(process.cwd(), "playwright.config.ts")}`,
  );
  assert.deepEqual(capturedArguments.slice(1), [
    "tests/smoke.spec.ts",
    "--project=desktop",
  ]);
}

async function testCloneEntryHardReject(): Promise<void> {
  const markerFilesBefore = markerRootFiles();
  const result = await runTypeScriptEntry(
    "scripts/copy-playwright-db-data.ts",
    [],
  );
  assert.equal(result.signal, null);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(markerRootFiles(), markerFilesBefore);
  const packageJson = readFileSync("package.json", "utf8");
  assert.ok(!packageJson.includes("copy-playwright-db-data"));
}

async function testFormerEntryBypassEnvironmentCannotSkipRunner(): Promise<void> {
  for (const [environmentName, hostileValue] of formerEntryBypassEnvironments) {
    const markerFilesBefore = markerRootFiles();
    const hostileProbePath = path.join(
      process.cwd(),
      ".tmp",
      `playwright-hostile-entry-probe-${randomUUID()}.jsonl`,
    );
    try {
      const result = await runTypeScriptEntry(
        "scripts/run-playwright.ts",
        [],
        {
          ...process.env,
          [environmentName]: hostileValue,
          NODE_OPTIONS: "",
          PLAYWRIGHT_DATABASE_URL:
            "postgresql://playwright_user@not-loopback.invalid/caller_path",
          [PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV]: "true",
          [PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV]: path.resolve(
            process.cwd(),
            "scripts",
            "playwright-feishu-egress-guard.mjs",
          ),
          [PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV]: hostileProbePath,
          [PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV]: "hostile",
        },
      );
      assert.equal(result.signal, null);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes("must point to localhost"));
      assert.ok(!result.output.includes("playwright.run.exit"));
      assert.ok(!existsSync(hostileProbePath));
      assert.deepEqual(markerRootFiles(), markerFilesBefore);
    } finally {
      rmSync(hostileProbePath, { force: true });
    }
  }
}

async function testUnsupportedPlatformRejectsBeforeMarker(): Promise<void> {
  const markerFilesBefore = markerRootFiles();
  let markerCreateCalls = 0;
  const dependencies = baseDependencies({ platform: "win32" });
  await assert.rejects(() =>
    runOfficialPlaywright(
      { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
      [],
      {
        ...dependencies,
        createOwnershipMarker: (...args) => {
          markerCreateCalls += 1;
          return registerMarker(...args);
        },
      },
    ),
  );
  assert.equal(markerCreateCalls, 0);
  assert.deepEqual(markerRootFiles(), markerFilesBefore);
}

async function testOccupiedServerPortRejectsBeforeMarker(): Promise<void> {
  assert.equal(await isPortListening(3003), false);
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(3003, "127.0.0.1", resolve);
  });
  const markerFilesBefore = markerRootFiles();
  let markerCreateCalls = 0;
  let serverSpawnCalls = 0;
  try {
    const defaultDependencies = defaultPlaywrightRunnerDependencies(
      process.cwd(),
    );
    await assert.rejects(
      () =>
        runOfficialPlaywright(
          { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
          [],
          baseDependencies({
            assertServerPortAvailable:
              defaultDependencies.assertServerPortAvailable,
            createOwnershipMarker: (...args) => {
              markerCreateCalls += 1;
              return registerMarker(...args);
            },
            spawnServer: () => {
              serverSpawnCalls += 1;
              return new FakeChild();
            },
          }),
        ),
      /already in use/,
    );
    assert.equal(markerCreateCalls, 0);
    assert.equal(serverSpawnCalls, 0);
    assert.deepEqual(markerRootFiles(), markerFilesBefore);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function testUniquePairsAndHostileEnvironmentNeutralization(): Promise<void> {
  const capturedEnvironments: NodeJS.ProcessEnv[] = [];
  const capturedServerEnvironments: NodeJS.ProcessEnv[] = [];
  let ownershipRandomCalls = 0;
  const sourceEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CHECKPOINT_DISABLE: "0",
    CONFIRM_SEND_FEISHU: "yes",
    DATABASE_URL: "postgresql://hostile.invalid/normal_database",
    NODE_OPTIONS: "--require=/tmp/hostile-preload.cjs --import=/tmp/hostile.mjs",
    NOTIFICATION_DELIVERY_DISABLED: "false",
    PLAYWRIGHT_BASE_URL: "http://example.com:9999",
    PLAYWRIGHT_CONFIRM_RECREATE_DB: "caller_target_test",
    PLAYWRIGHT_CONFIRM_RECREATE_SHADOW_DB: "caller_shadow_test",
    PLAYWRIGHT_DATABASE_URL: credentialSource,
    PLAYWRIGHT_DB_OWNERSHIP_MARKER: "/tmp/caller-marker",
    PLAYWRIGHT_DB_OWNERSHIP_SECRET:
      "caller_secret_must_not_control_the_runner",
    PLAYWRIGHT_DB_OWNERSHIP_TOKEN: "ffffffffffffffffffffffff",
    PLAYWRIGHT_DB_SETUP_MODE: "clone",
    PLAYWRIGHT_REUSE_SERVER: "true",
    PLAYWRIGHT_SERVER_PORT: "9999",
    PLAYWRIGHT_SHADOW_DATABASE_URL:
      "postgresql://hostile.invalid/caller_shadow_test",
    PLAYWRIGHT_SKIP_WEBSERVER: "true",
    PLAYWRIGHT_SOURCE_DATABASE_URL:
      "postgresql://hostile.invalid/source_database",
    SHADOW_DATABASE_URL: "postgresql://hostile.invalid/static_shadow",
    [PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV]:
      "--require=/tmp/older-hostile.cjs",
    [PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV]:
      "/tmp/hostile-playwright-feishu-egress-guard.mjs",
    [PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV]: "/tmp/hostile-probe.jsonl",
    [PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV]: "hostile",
    PLAYWRIGHT_RUNNER_ENTRY_SIGNAL_SELF_TEST: "SIGINT",
    PLAYWRIGHT_RUNNER_ENTRY_IGNORE_SIGNAL_SELF_TEST: "true",
    PLAYWRIGHT_RUNNER_ENTRY_THROW_SIGNAL_SELF_TEST: "true",
  };

  const run = async (byte: number) =>
    runOfficialPlaywright(
      sourceEnv,
      ["tests/smoke.spec.ts", "--project=desktop"],
      baseDependencies({
        randomBytes: (size) => {
          ownershipRandomCalls += 1;
          return deterministicRandomBytes(byte)(size);
        },
        spawnPlaywright: (_args, env) => {
          capturedEnvironments.push(env);
          const child = new FakeChild();
          queueMicrotask(() => child.emitExit(0, null));
          return child;
        },
        spawnServer: (env) => {
          capturedServerEnvironments.push(env);
          const child = new FakeChild((signal) => {
            child.setTreeAlive(false);
            queueMicrotask(() => child.emitExit(null, signal));
            return true;
          });
          return child;
        },
      }),
    );

  const first = await run(1);
  const second = await run(2);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(ownershipRandomCalls, 4);
  assert.notEqual(first.ownership.token, second.ownership.token);
  assert.equal(capturedServerEnvironments.length, 2);

  for (const [index, env] of capturedEnvironments.entries()) {
    const result = index === 0 ? first : second;
    const names = playwrightDatabaseNamesForToken(result.ownership.token);
    assert.equal(env.PLAYWRIGHT_DATABASE_URL, result.ownership.target.url);
    assert.equal(env.PLAYWRIGHT_SHADOW_DATABASE_URL, result.ownership.shadow.url);
    assert.equal(env.DATABASE_URL, result.ownership.target.url);
    assert.equal(env.SHADOW_DATABASE_URL, result.ownership.shadow.url);
    assert.equal(env.PLAYWRIGHT_CONFIRM_RECREATE_DB, names.target);
    assert.equal(env.PLAYWRIGHT_CONFIRM_RECREATE_SHADOW_DB, names.shadow);
    assert.equal(env.PLAYWRIGHT_DB_SETUP_MODE, "recreate");
    assert.equal(env.PLAYWRIGHT_SOURCE_DATABASE_URL, "");
    assert.equal(env.CONFIRM_SEND_FEISHU, "");
    assert.equal(env.PLAYWRIGHT_REUSE_SERVER, "");
    assert.equal(env.PLAYWRIGHT_SKIP_WEBSERVER, "");
    assert.equal(env.PLAYWRIGHT_BASE_URL, "http://127.0.0.1:3003");
    assert.equal(env.PLAYWRIGHT_SERVER_PORT, "3003");
    assert.equal(env.NOTIFICATION_DELIVERY_DISABLED, "true");
    assert.equal(env.CHECKPOINT_DISABLE, "1");
    assert.equal(env.NODE_OPTIONS, controlledPlaywrightNodeOptions(process.cwd()));
    assert.ok(!env.NODE_OPTIONS.includes("hostile"));
    assert.equal(
      env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV],
      path.resolve(
        process.cwd(),
        "scripts",
        "playwright-feishu-egress-guard.mjs",
      ),
    );
    assert.equal(env[PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV], "");
    assert.equal(env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV], undefined);
    assert.equal(env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV], undefined);
    for (const [environmentName] of formerEntryBypassEnvironments) {
      assert.equal(env[environmentName], undefined);
    }
    assert.ok(env.PLAYWRIGHT_DB_OWNERSHIP_MARKER?.includes(result.ownership.token));
    assert.equal(env.PLAYWRIGHT_DB_OWNERSHIP_SECRET?.length, 43);
    assert.ok(Buffer.byteLength(names.target, "utf8") <= 63);
    assert.ok(Buffer.byteLength(names.shadow, "utf8") <= 63);
    assert.ok(names.target.endsWith("_test"));
    assert.ok(names.shadow.endsWith("_test"));
    assert.ok(!env.PLAYWRIGHT_DATABASE_URL?.includes("static_path_is_ignored"));
    assert.ok(!env.PLAYWRIGHT_SHADOW_DATABASE_URL?.includes("hostile.invalid"));
  }

  for (const env of capturedServerEnvironments) {
    assert.equal(
      env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV],
      path.join(process.cwd(), PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH),
    );
    assert.equal(env[PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV], "server");
    assert.equal(env.NOTIFICATION_DELIVERY_DISABLED, "true");
    assert.equal(env.CHECKPOINT_DISABLE, "1");
    assert.equal(env.PLAYWRIGHT_BASE_URL, "http://127.0.0.1:3003");
    assert.equal(env.PLAYWRIGHT_SERVER_PORT, "3003");
    assert.equal(env.NODE_OPTIONS, controlledPlaywrightNodeOptions(process.cwd()));
    assert.ok(!env.NODE_OPTIONS.includes("hostile"));
  }
}

async function testHostileNodeOptionsNeverExecuteInRealChild(): Promise<void> {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.match(
    packageJson.scripts?.["test:e2e"] ?? "",
    /^NODE_OPTIONS='' tsx scripts\/run-playwright\.ts$/,
  );
  const hostileModulePath = path.join(
    process.cwd(),
    ".tmp",
    `playwright-hostile-preload-${randomUUID()}.cjs`,
  );
  const hostileOutputPath = `${hostileModulePath}.executed`;
  const hostileProbePath = `${hostileModulePath}.probe`;
  writeFileSync(
    hostileModulePath,
    `require("node:fs").writeFileSync(${JSON.stringify(hostileOutputPath)}, "executed")`,
    "utf8",
  );
  try {
    const result = await runOfficialPlaywright(
      {
        ...process.env,
        NODE_OPTIONS: `--require=${hostileModulePath}`,
        PLAYWRIGHT_DATABASE_URL: credentialSource,
        [PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV]: hostileProbePath,
        [PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV]: "hostile",
      },
      [],
      baseDependencies({
        spawnPlaywright: (_args, env) =>
          spawnControlledPlaywrightChild(
            process.execPath,
            ["--eval", "process.exit(0)"],
            { cwd: process.cwd(), env, stdio: "ignore" },
          ),
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.ok(!existsSync(hostileOutputPath));
    assert.ok(!existsSync(hostileProbePath));
  } finally {
    rmSync(hostileModulePath, { force: true });
    rmSync(hostileOutputPath, { force: true });
    rmSync(hostileProbePath, { force: true });
  }
}

function testOwnershipAndCredentialValidation(): void {
  const token = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const ownership = createPlaywrightDatabaseOwnership(credentialSource, token);
  assert.throws(
    () =>
      resolvePlaywrightDatabaseOwnership({
        PLAYWRIGHT_DATABASE_URL: ownership.target.url,
        PLAYWRIGHT_DB_OWNERSHIP_TOKEN: "bbbbbbbbbbbbbbbbbbbbbbbb",
        PLAYWRIGHT_SHADOW_DATABASE_URL: ownership.shadow.url,
      }),
    /do not encode/,
  );
  assert.doesNotThrow(() =>
    createPlaywrightDatabaseOwnership(
      "postgresql://playwright_user:unit-secret@[::1]:5432/template",
      token,
    ),
  );
  const differentAuthorityShadow = new URL(ownership.shadow.url);
  differentAuthorityShadow.hostname = "localhost";
  assert.throws(() =>
    resolvePlaywrightDatabaseOwnership({
      PLAYWRIGHT_DATABASE_URL: ownership.target.url,
      PLAYWRIGHT_DB_OWNERSHIP_TOKEN: token,
      PLAYWRIGHT_SHADOW_DATABASE_URL: differentAuthorityShadow.toString(),
    }),
  );

  for (const unsafeUrl of [
    "mysql://playwright_user:never-print-this@example.com/template",
    "postgresql://playwright_user:never-print-this@example.com/template",
    "postgresql://playwright_user:never-print-this@127.0.0.1/template?host=example.com",
  ]) {
    let validationError: unknown;
    try {
      createPlaywrightDatabaseOwnership(unsafeUrl, token);
    } catch (error) {
      validationError = error;
    }
    assert.ok(validationError instanceof Error);
    assert.ok(!validationError.message.includes("never-print-this"));
    assert.ok(!validationError.message.includes(unsafeUrl));
  }
}

function createMarkerTestContext(cwd: string, byte: number) {
  const token = Buffer.alloc(12, byte).toString("hex");
  const ownership = createPlaywrightDatabaseOwnership(credentialSource, token);
  const secret = Buffer.alloc(32, byte).toString("base64url");
  const marker = createPlaywrightOwnershipMarker(cwd, ownership, secret);
  const env = markerEnvironment(marker);
  return { env, marker, ownership };
}

function withMarkerSandbox(callback: (sandbox: string) => void): void {
  const sandbox = mkdtempSync(
    path.join(process.cwd(), ".tmp", "playwright-marker-verifier-"),
  );
  try {
    callback(sandbox);
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
  }
}

function testMarkerFilesystemSafety(): void {
  withMarkerSandbox((sandbox) => {
    const outside = path.join(sandbox, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, path.join(sandbox, ".tmp"), "dir");
    const ownership = createPlaywrightDatabaseOwnership(
      credentialSource,
      "111111111111111111111111",
    );
    assert.throws(() =>
      createPlaywrightOwnershipMarker(
        sandbox,
        ownership,
        Buffer.alloc(32, 1).toString("base64url"),
      ),
    );
    assert.deepEqual(readdirSync(outside), []);
  });

  withMarkerSandbox((sandbox) => {
    const temporaryDirectory = path.join(sandbox, ".tmp");
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    chmodSync(temporaryDirectory, 0o777);
    const ownership = createPlaywrightDatabaseOwnership(
      credentialSource,
      "121212121212121212121212",
    );
    assert.throws(() =>
      createPlaywrightOwnershipMarker(
        sandbox,
        ownership,
        Buffer.alloc(32, 2).toString("base64url"),
      ),
    );
    assert.ok(!existsSync(path.join(temporaryDirectory, "playwright-db-ownership")));
  });

  withMarkerSandbox((sandbox) => {
    const root = path.join(sandbox, ".tmp", "playwright-db-ownership");
    mkdirSync(root, { mode: 0o755, recursive: true });
    chmodSync(root, 0o755);
    const ownership = createPlaywrightDatabaseOwnership(
      credentialSource,
      "131313131313131313131313",
    );
    assert.throws(() =>
      createPlaywrightOwnershipMarker(
        sandbox,
        ownership,
        Buffer.alloc(32, 3).toString("base64url"),
      ),
    );
    assert.deepEqual(readdirSync(root), []);
  });

  assert.throws(() =>
    assertPlaywrightMarkerMetadata(
      { kind: "file", mode: 0o600, nlink: 1, size: 1, uid: 999_999 },
      {
        exactMode: 0o600,
        expectedKind: "file",
        expectedUid: typeof process.getuid === "function" ? process.getuid() : 0,
        requireSingleLink: true,
      },
    ),
  );

  withMarkerSandbox((sandbox) => {
    const context = createMarkerTestContext(sandbox, 4);
    const originalContent = readFileSync(context.marker.markerPath, "utf8");
    const aliasPath = `${context.marker.markerPath}.hardlink`;
    linkSync(context.marker.markerPath, aliasPath);
    assert.equal(lstatSync(context.marker.markerPath).nlink, 2);
    assert.throws(() =>
      resolvePlaywrightOwnershipMarker(sandbox, context.ownership, context.env),
    );
    unlinkSync(aliasPath);

    chmodSync(context.marker.markerPath, 0o644);
    assert.throws(() =>
      resolvePlaywrightOwnershipMarker(sandbox, context.ownership, context.env),
    );
    chmodSync(context.marker.markerPath, 0o600);

    writeFileSync(
      context.marker.markerPath,
      "x".repeat(PLAYWRIGHT_OWNERSHIP_MARKER_MAX_BYTES + 1),
    );
    assert.throws(() =>
      resolvePlaywrightOwnershipMarker(sandbox, context.ownership, context.env),
    );
    writeFileSync(context.marker.markerPath, "{}", "utf8");
    assert.throws(() =>
      resolvePlaywrightOwnershipMarker(sandbox, context.ownership, context.env),
    );
    writeFileSync(context.marker.markerPath, originalContent, "utf8");

    const symlinkTarget = `${context.marker.markerPath}.symlink-target`;
    renameSync(context.marker.markerPath, symlinkTarget);
    symlinkSync(symlinkTarget, context.marker.markerPath);
    assert.throws(() =>
      resolvePlaywrightOwnershipMarker(sandbox, context.ownership, context.env),
    );
    unlinkSync(context.marker.markerPath);
    renameSync(symlinkTarget, context.marker.markerPath);

    const resolvedBeforeSwap = resolvePlaywrightOwnershipMarker(
      sandbox,
      context.ownership,
      context.env,
    );
    const originalPath = `${context.marker.markerPath}.original`;
    renameSync(context.marker.markerPath, originalPath);
    writeFileSync(context.marker.markerPath, originalContent, { mode: 0o600 });
    assert.throws(() =>
      removePlaywrightOwnershipMarker(
        sandbox,
        context.ownership,
        context.env,
        resolvedBeforeSwap,
      ),
    );
    unlinkSync(context.marker.markerPath);
    renameSync(originalPath, context.marker.markerPath);
    removePlaywrightOwnershipMarker(
      sandbox,
      context.ownership,
      context.env,
      resolvedBeforeSwap,
    );
    assert.ok(!existsSync(context.marker.markerPath));
  });
}

function testPublicTokenAndGuardPathCannotForgeContext(): void {
  const dependencies = baseDependencies({ randomBytes: deterministicRandomBytes(8) });
  const context = createOfficialPlaywrightRunContext(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    dependencies,
  );
  try {
    assertOfficialPlaywrightEnvironment(context.env);
    const attackerSecret = Buffer.alloc(32, 9).toString("base64url");
    assert.throws(() =>
      dependencies.createOwnershipMarker(
        process.cwd(),
        context.ownership,
        attackerSecret,
      ),
    );
    assert.throws(() =>
      assertOfficialPlaywrightEnvironment({
        ...context.env,
        PLAYWRIGHT_DB_OWNERSHIP_SECRET: attackerSecret,
      }),
    );
    assert.throws(() =>
      assertOfficialPlaywrightEnvironment({
        ...context.env,
        NODE_OPTIONS:
          "--conditions=playwright-feishu-egress-node-options-sentinel " +
          "--import=file:///tmp/playwright-feishu-egress-guard.mjs",
      }),
    );
    assert.throws(() =>
      assertOfficialPlaywrightEnvironment({
        ...context.env,
        [PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV]: "/tmp/hostile.jsonl",
        [PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV]: "server",
      }),
    );
    assert.doesNotThrow(() =>
      assertOfficialPlaywrightEnvironment({
        ...context.env,
        [PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT_ENV]: path.join(
          process.cwd(),
          PLAYWRIGHT_FEISHU_EGRESS_SERVER_PROBE_PATH,
        ),
        [PLAYWRIGHT_FEISHU_EGRESS_PROBE_ROLE_ENV]: "server",
      }),
    );
  } finally {
    discardRegisteredMarker(
      process.cwd(),
      context.ownership,
      context.env,
      context.marker,
    );
  }
}

async function testDirectLifecycleCompensationAndMarkerRemoval(): Promise<void> {
  const createContext = (byte: number) => {
    const dependencies = baseDependencies({
      randomBytes: deterministicRandomBytes(byte),
    });
    return createOfficialPlaywrightRunContext(
      { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
      dependencies,
    );
  };

  const directSuccess = createContext(10);
  let directDropCalls = 0;
  const directCleanupDependencies: PlaywrightDatabaseCleanupDependencies = {
    databasesAreAbsent: async () => false,
    dropDatabases: async () => {
      directDropCalls += 1;
    },
    removeMarker: removePlaywrightOwnershipMarker,
    resolveMarker: resolvePlaywrightOwnershipMarker,
  };
  await cleanupPlaywrightDatabaseOwnership(
    directSuccess.ownership,
    directSuccess.env,
    process.cwd(),
    { expectedMarker: directSuccess.marker },
    directCleanupDependencies,
  );
  registeredMarkers.delete(directSuccess.marker.markerPath);
  assert.equal(directDropCalls, 1);
  assert.ok(!existsSync(directSuccess.marker.markerPath));
  let alreadyFinalizedChecks = 0;
  await cleanupPlaywrightDatabaseOwnership(
    directSuccess.ownership,
    directSuccess.env,
    process.cwd(),
    { allowAlreadyFinalized: true, expectedMarker: directSuccess.marker },
    {
      ...directCleanupDependencies,
      databasesAreAbsent: async () => {
        alreadyFinalizedChecks += 1;
        return true;
      },
      dropDatabases: async () => {
        throw new Error("already-finalized cleanup must not drop again");
      },
    },
  );
  assert.equal(alreadyFinalizedChecks, 1);

  const partialDrop = createContext(11);
  let partialRemoveCalls = 0;
  try {
    await assert.rejects(() =>
      cleanupPlaywrightDatabaseOwnership(
        partialDrop.ownership,
        partialDrop.env,
        process.cwd(),
        { expectedMarker: partialDrop.marker },
        {
          ...directCleanupDependencies,
          dropDatabases: async () => {
            throw new AggregateError(
              [new Error("shadow drop failed"), new Error("target drop failed")],
              "two exact drops failed",
            );
          },
          removeMarker: (...args) => {
            partialRemoveCalls += 1;
            removePlaywrightOwnershipMarker(...args);
          },
        },
      ),
    );
    assert.equal(partialRemoveCalls, 0);
    assert.ok(existsSync(partialDrop.marker.markerPath));
  } finally {
    discardRegisteredMarker(
      process.cwd(),
      partialDrop.ownership,
      partialDrop.env,
      partialDrop.marker,
    );
  }

  const unlinkFailure = createContext(12);
  const unlinkFailureRoot = path.dirname(unlinkFailure.marker.markerPath);
  let unlinkFailureDropCalls = 0;
  try {
    await assert.rejects(() =>
      cleanupPlaywrightDatabaseOwnership(
        unlinkFailure.ownership,
        unlinkFailure.env,
        process.cwd(),
        { expectedMarker: unlinkFailure.marker },
        {
          ...directCleanupDependencies,
          dropDatabases: async () => {
            unlinkFailureDropCalls += 1;
            chmodSync(unlinkFailureRoot, 0o500);
          },
        },
      ),
    );
    assert.equal(unlinkFailureDropCalls, 1);
    assert.ok(existsSync(unlinkFailure.marker.markerPath));
  } finally {
    chmodSync(unlinkFailureRoot, 0o700);
    discardRegisteredMarker(
      process.cwd(),
      unlinkFailure.ownership,
      unlinkFailure.env,
      unlinkFailure.marker,
    );
  }

  const setupPartial = createContext(13);
  const recreated: string[] = [];
  const compensated: string[] = [];
  const setupDependencies: PlaywrightDatabaseSetupDependencies = {
    cleanup: async (ownership, env, cwd, expectedMarker) => {
      compensated.push(
        ownership.target.databaseName,
        ownership.shadow.databaseName,
      );
      await cleanupPlaywrightDatabaseOwnership(
        ownership,
        env,
        cwd,
        { expectedMarker },
        directCleanupDependencies,
      );
      registeredMarkers.delete(expectedMarker.markerPath);
    },
    recreateDatabase: async (_ownership, databaseName) => {
      recreated.push(databaseName);
      if (databaseName === setupPartial.ownership.shadow.databaseName) {
        throw new Error("injected shadow create failure");
      }
    },
    resolveMarker: resolvePlaywrightOwnershipMarker,
  };
  await assert.rejects(() =>
    setupPlaywrightDatabaseOwnership(
      setupPartial.ownership,
      setupPartial.env,
      process.cwd(),
      setupDependencies,
    ),
  );
  assert.deepEqual(recreated, [
    setupPartial.ownership.target.databaseName,
    setupPartial.ownership.shadow.databaseName,
  ]);
  assert.deepEqual(
    new Set(compensated),
    new Set([
      setupPartial.ownership.target.databaseName,
      setupPartial.ownership.shadow.databaseName,
    ]),
  );
  assert.ok(!existsSync(setupPartial.marker.markerPath));

  const failedCompensation = createContext(14);
  try {
    await assert.rejects(
      () =>
        setupPlaywrightDatabaseOwnership(
          failedCompensation.ownership,
          failedCompensation.env,
          process.cwd(),
          {
            cleanup: async () => {
              throw new Error("injected exact compensation failure");
            },
            recreateDatabase: async (_ownership, databaseName) => {
              if (
                databaseName ===
                failedCompensation.ownership.shadow.databaseName
              ) {
                throw new Error("injected shadow create failure");
              }
            },
            resolveMarker: resolvePlaywrightOwnershipMarker,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(flattenPlaywrightErrorCauses(error).map(String), [
          "Error: injected shadow create failure",
          "Error: injected exact compensation failure",
        ]);
        return true;
      },
    );
    assert.ok(existsSync(failedCompensation.marker.markerPath));
  } finally {
    discardRegisteredMarker(
      process.cwd(),
      failedCompensation.ownership,
      failedCompensation.env,
      failedCompensation.marker,
    );
  }
}

async function runFailureScenario(options: {
  asyncSpawnError?: Error;
  childExitCode?: number;
  initialDatabases: (ownership: PlaywrightDatabaseOwnership) => string[];
  spawnError?: Error;
}): Promise<{ remaining: Set<string>; cleanupCalls: number; exitCode: number }> {
  const remaining = new Set<string>();
  let cleanupCalls = 0;
  const dependencies = baseDependencies();
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    {
      ...dependencies,
      cleanup: async (ownership, env, marker) => {
        cleanupCalls += 1;
        remaining.delete(ownership.target.databaseName);
        remaining.delete(ownership.shadow.databaseName);
        discardRegisteredMarker(process.cwd(), ownership, env, marker);
      },
      spawnPlaywright: (_args, env) => {
        if (options.spawnError) throw options.spawnError;
        const ownership = resolvePlaywrightDatabaseOwnership(env);
        for (const databaseName of options.initialDatabases(ownership)) {
          remaining.add(databaseName);
        }
        const child = new FakeChild();
        queueMicrotask(() => {
          if (options.asyncSpawnError) {
            child.emitError(options.asyncSpawnError);
          } else {
            child.emitExit(options.childExitCode ?? 1, null);
          }
        });
        return child;
      },
    },
  );
  return { cleanupCalls, exitCode: result.exitCode, remaining };
}

async function testFailureCleanup(): Promise<void> {
  const configFailure = await runFailureScenario({
    childExitCode: 2,
    initialDatabases: () => [],
  });
  assert.equal(configFailure.exitCode, 2);
  assert.equal(configFailure.cleanupCalls, 1);

  const shadowCreateFailure = await runFailureScenario({
    initialDatabases: (ownership) => [ownership.target.databaseName],
  });
  assert.equal(shadowCreateFailure.cleanupCalls, 1);
  assert.equal(shadowCreateFailure.remaining.size, 0);

  const testFailure = await runFailureScenario({
    childExitCode: 7,
    initialDatabases: (ownership) => [
      ownership.target.databaseName,
      ownership.shadow.databaseName,
    ],
  });
  assert.equal(testFailure.exitCode, 7);
  assert.equal(testFailure.cleanupCalls, 1);
  assert.equal(testFailure.remaining.size, 0);

  for (const failure of [
    { spawnError: new Error("injected synchronous spawn failure") },
    { asyncSpawnError: new Error("injected asynchronous spawn failure") },
  ]) {
    const result = await runFailureScenario({
      ...failure,
      initialDatabases: () => [],
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.cleanupCalls, 1);
  }
}

async function testNormalRunConvergesBothProcessGroups(): Promise<void> {
  const serverKillCalls: NodeJS.Signals[] = [];
  const cliKillCalls: NodeJS.Signals[] = [];
  let cleanupCalls = 0;
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      cleanup: async (ownership, env, marker) => {
        cleanupCalls += 1;
        discardRegisteredMarker(process.cwd(), ownership, env, marker);
      },
      spawnPlaywright: () => {
        const child = new FakeChild((signal) => {
          cliKillCalls.push(signal);
          return true;
        });
        queueMicrotask(() => child.emitExit(0, null));
        return child;
      },
      spawnServer: () => {
        const child = new FakeChild((signal) => {
          serverKillCalls.push(signal);
          child.setTreeAlive(false);
          queueMicrotask(() => child.emitExit(null, signal));
          return true;
        });
        return child;
      },
    }),
  );
  assert.deepEqual(cliKillCalls, []);
  assert.deepEqual(serverKillCalls, ["SIGTERM"]);
  assert.equal(cleanupCalls, 1);
  assert.equal(result.cleanupSucceeded, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
}

async function testGracefulSignalCleanup(signal: TerminationSignal): Promise<void> {
  const signalSource = new FakeSignalSource();
  let cleanupCalls = 0;
  const killCalls: NodeJS.Signals[] = [];
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      cleanup: async (ownership, env, marker) => {
        cleanupCalls += 1;
        discardRegisteredMarker(process.cwd(), ownership, env, marker);
      },
      signalSource,
      spawnPlaywright: () => {
        const child = new FakeChild((receivedSignal) => {
          killCalls.push(receivedSignal);
          queueMicrotask(() => child.emitExit(null, receivedSignal));
          return true;
        });
        queueMicrotask(() => signalSource.emit(signal));
        return child;
      },
    }),
  );
  assert.deepEqual(killCalls, [signal]);
  assert.equal(cleanupCalls, 1);
  assert.equal(result.cleanupSucceeded, true);
  assert.equal(result.signal, signal);
}

async function testKillFalseStillCleans(): Promise<void> {
  const signalSource = new FakeSignalSource();
  const killCalls: NodeJS.Signals[] = [];
  let cleanupCalls = 0;
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      cleanup: async (ownership, env, marker) => {
        cleanupCalls += 1;
        discardRegisteredMarker(process.cwd(), ownership, env, marker);
      },
      signalSource,
      spawnPlaywright: () => {
        const child = new FakeChild((signal) => {
          killCalls.push(signal);
          if (signal === "SIGKILL") child.setTreeAlive(false);
          return false;
        });
        queueMicrotask(() => signalSource.emit("SIGTERM"));
        return child;
      },
    }),
  );
  assert.deepEqual(killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(cleanupCalls, 1);
  assert.equal(result.signal, "SIGTERM");
  assert.ok(result.error instanceof Error);
}

async function testIgnoredAndRepeatedSignals(): Promise<void> {
  const ignoredSignalSource = new FakeSignalSource();
  const ignoredKillCalls: NodeJS.Signals[] = [];
  const ignoredResult = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      signalSource: ignoredSignalSource,
      spawnPlaywright: () => {
        const child = new FakeChild((signal) => {
          ignoredKillCalls.push(signal);
          if (signal === "SIGKILL") {
            child.setTreeAlive(false);
            queueMicrotask(() => child.emitExit(null, "SIGKILL"));
          }
          return true;
        });
        queueMicrotask(() => ignoredSignalSource.emit("SIGINT"));
        return child;
      },
    }),
  );
  assert.deepEqual(ignoredKillCalls, ["SIGINT", "SIGKILL"]);
  assert.equal(ignoredResult.signal, "SIGINT");

  const repeatedSignalSource = new FakeSignalSource();
  const repeatedKillCalls: NodeJS.Signals[] = [];
  const repeatedResult = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      gracefulShutdownMs: 1_000,
      signalSource: repeatedSignalSource,
      spawnPlaywright: () => {
        const child = new FakeChild((signal) => {
          repeatedKillCalls.push(signal);
          if (signal === "SIGKILL") {
            child.setTreeAlive(false);
            queueMicrotask(() => child.emitExit(null, "SIGKILL"));
          }
          return true;
        });
        queueMicrotask(() => {
          repeatedSignalSource.emit("SIGTERM");
          queueMicrotask(() => repeatedSignalSource.emit("SIGTERM"));
        });
        return child;
      },
    }),
  );
  assert.deepEqual(repeatedKillCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(repeatedResult.signal, "SIGTERM");
}

async function testPreChildRepeatedSignals(): Promise<void> {
  for (const signals of [
    ["SIGINT", "SIGINT"],
    ["SIGHUP", "SIGTERM"],
  ] as TerminationSignal[][]) {
    const signalSource = new FakeSignalSource();
    const killCalls: NodeJS.Signals[] = [];
    const result = await runOfficialPlaywright(
      { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
      [],
      baseDependencies({
        signalSource,
        spawnPlaywright: () => {
          const child = new FakeChild((signal) => {
            killCalls.push(signal);
            if (signal === "SIGKILL") {
              child.setTreeAlive(false);
              queueMicrotask(() => child.emitExit(null, "SIGKILL"));
            }
            return true;
          });
          signalSource.emit(signals[0]);
          signalSource.emit(signals[1]);
          return child;
        },
      }),
    );
    assert.deepEqual(killCalls, ["SIGKILL"]);
    assert.equal(result.signal, signals[0]);
  }
}

async function testSignalSpawnErrorRaceCleansOnce(): Promise<void> {
  const signalSource = new FakeSignalSource();
  let cleanupCalls = 0;
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      cleanup: async (ownership, env, marker) => {
        cleanupCalls += 1;
        discardRegisteredMarker(process.cwd(), ownership, env, marker);
      },
      signalSource,
      spawnPlaywright: () => {
        const child = new FakeChild(() => true);
        queueMicrotask(() => {
          signalSource.emit("SIGHUP");
          queueMicrotask(() => child.emitError(new Error("spawn race")));
        });
        return child;
      },
    }),
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(result.signal, "SIGHUP");
}

async function testUnquiescentTreeSkipsDatabaseCleanup(): Promise<void> {
  let cleanupCalls = 0;
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      cleanup: async () => {
        cleanupCalls += 1;
      },
      forcedShutdownMs: 5,
      gracefulShutdownMs: 5,
      spawnPlaywright: () => {
        const child = new FakeChild(() => true);
        queueMicrotask(() => child.emitExit(0, null, true));
        return child;
      },
    }),
  );
  try {
    assert.equal(cleanupCalls, 0);
    assert.equal(result.cleanupSucceeded, false);
    assert.equal(result.exitCode, 1);
    assert.ok(
      flattenPlaywrightErrorCauses(result.error).some((error) =>
        String(error).includes("remained alive"),
      ),
    );
  } finally {
    discardMarkerForOwnership(result.ownership);
  }
}

async function testUnquiescentServerSkipsDatabaseCleanup(): Promise<void> {
  let cleanupCalls = 0;
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      cleanup: async () => {
        cleanupCalls += 1;
      },
      forcedShutdownMs: 5,
      gracefulShutdownMs: 5,
      spawnServer: () => new FakeChild(() => true),
    }),
  );
  try {
    assert.equal(cleanupCalls, 0);
    assert.equal(result.cleanupSucceeded, false);
    assert.equal(result.exitCode, 1);
    assert.ok(
      flattenPlaywrightErrorCauses(result.error).some((error) =>
        String(error).includes(
          "Playwright server process tree remained alive after SIGKILL",
        ),
      ),
    );
    const record = [...registeredMarkers.values()].find(
      (candidate) => candidate.ownership.token === result.ownership.token,
    );
    assert.ok(record);
    assert.ok(existsSync(record.marker.markerPath));
  } finally {
    discardMarkerForOwnership(result.ownership);
  }
}

async function testServerFailureTerminatesCliBeforeCleanup(): Promise<void> {
  let cleanupCalls = 0;
  const cliKillCalls: NodeJS.Signals[] = [];
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      cleanup: async (ownership, env, marker) => {
        cleanupCalls += 1;
        discardRegisteredMarker(process.cwd(), ownership, env, marker);
      },
      spawnPlaywright: () => {
        const child = new FakeChild((signal) => {
          cliKillCalls.push(signal);
          child.setTreeAlive(false);
          queueMicrotask(() => child.emitExit(null, signal));
          return true;
        });
        return child;
      },
      spawnServer: () => {
        const child = new FakeChild();
        setTimeout(
          () => child.emitError(new Error("injected server failure")),
          0,
        );
        return child;
      },
    }),
  );
  assert.deepEqual(cliKillCalls, ["SIGTERM"]);
  assert.equal(cleanupCalls, 1);
  assert.equal(result.cleanupSucceeded, true);
  assert.equal(result.exitCode, 1);
  assert.ok(
    flattenPlaywrightErrorCauses(result.error).some((error) =>
      String(error).includes("injected server failure"),
    ),
  );
}

async function testSignalsConvergeServerAndCliGroups(): Promise<void> {
  for (const mode of ["grace-timeout", "second-signal"] as const) {
    const signalSource = new FakeSignalSource();
    const serverKillCalls: NodeJS.Signals[] = [];
    const cliKillCalls: NodeJS.Signals[] = [];
    const controlledChild = (killCalls: NodeJS.Signals[]) => {
      const child = new FakeChild((signal) => {
        killCalls.push(signal);
        if (signal === "SIGKILL") {
          child.setTreeAlive(false);
          queueMicrotask(() => child.emitExit(null, signal));
        }
        return true;
      });
      return child;
    };
    const result = await runOfficialPlaywright(
      { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
      [],
      baseDependencies({
        gracefulShutdownMs: mode === "grace-timeout" ? 5 : 1_000,
        signalSource,
        spawnPlaywright: () => {
          const child = controlledChild(cliKillCalls);
          queueMicrotask(() => {
            signalSource.emit("SIGTERM");
            if (mode === "second-signal") {
              queueMicrotask(() => signalSource.emit("SIGINT"));
            }
          });
          return child;
        },
        spawnServer: () => controlledChild(serverKillCalls),
      }),
    );
    assert.deepEqual(serverKillCalls, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(cliKillCalls, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.cleanupSucceeded, true);
  }
}

async function testPreServerRepeatedSignalsAvoidCliSpawn(): Promise<void> {
  const signalSource = new FakeSignalSource();
  const serverKillCalls: NodeJS.Signals[] = [];
  let cliSpawnCalls = 0;
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    baseDependencies({
      signalSource,
      spawnPlaywright: () => {
        cliSpawnCalls += 1;
        return new FakeChild();
      },
      spawnServer: () => {
        signalSource.emit("SIGHUP");
        signalSource.emit("SIGTERM");
        const child = new FakeChild((signal) => {
          serverKillCalls.push(signal);
          child.setTreeAlive(false);
          queueMicrotask(() => child.emitExit(null, signal));
          return true;
        });
        return child;
      },
    }),
  );
  assert.equal(cliSpawnCalls, 0);
  assert.deepEqual(serverKillCalls, ["SIGKILL"]);
  assert.equal(result.signal, "SIGHUP");
  assert.equal(result.cleanupSucceeded, true);
}

async function testCleanupFailureAggregation(): Promise<void> {
  const cleanupError = new AggregateError(
    [new Error("shadow drop root cause"), new Error("target drop root cause")],
    "injected cleanup failure",
  );
  const dependencies = baseDependencies({
    cleanup: async () => {
      throw cleanupError;
    },
    spawnPlaywright: () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emitExit(9, null));
      return child;
    },
  });
  const result = await runOfficialPlaywright(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
    [],
    dependencies,
  );
  try {
    assert.equal(result.exitCode, 1);
    assert.equal(result.cleanupSucceeded, false);
    assert.ok(result.error instanceof AggregateError);
    assert.deepEqual(
      flattenPlaywrightErrorCauses(result.error).map(String),
      [
        "Error: Playwright CLI exited with code 9",
        "Error: shadow drop root cause",
        "Error: target drop root cause",
      ],
    );
  } finally {
    discardMarkerForOwnership(result.ownership);
  }
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processGroupIsAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function testRealDescendantPortQuiescence(): Promise<void> {
  assert.equal(await isPortListening(3003), false);
  const readyPath = path.join(
    process.cwd(),
    ".tmp",
    `playwright-descendant-ready-${randomUUID()}.json`,
  );
  let cleanupObserved = false;
  let descendantPid: number | undefined;
  const descendantSource = String.raw`
    const fs = require("node:fs");
    const net = require("node:net");
    const readyPath = process.argv[1];
    const server = net.createServer();
    server.listen(3003, "127.0.0.1", () => {
      fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid }), "utf8");
    });
    setInterval(() => undefined, 1000);
  `;
  const parentSource = String.raw`
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const readyPath = process.argv[1];
    const descendantSource = process.argv[2];
    spawn(process.execPath, ["-e", descendantSource, readyPath], {
      env: process.env,
      stdio: "ignore",
    });
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (fs.existsSync(readyPath)) {
        clearInterval(timer);
        process.exit(0);
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        process.exit(2);
      }
    }, 10);
  `;
  try {
    const result = await runOfficialPlaywright(
      { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
      [],
      baseDependencies({
        cleanup: async (ownership, env, marker) => {
          cleanupObserved = true;
          assert.ok(existsSync(readyPath));
          descendantPid = JSON.parse(readFileSync(readyPath, "utf8")).pid as number;
          assert.equal(await isPortListening(3003), false);
          discardRegisteredMarker(process.cwd(), ownership, env, marker);
        },
        forcedShutdownMs: 2_000,
        gracefulShutdownMs: 2_000,
        spawnPlaywright: (_args, env) =>
          spawnControlledPlaywrightChild(
            process.execPath,
            ["-e", parentSource, readyPath, descendantSource],
            { cwd: process.cwd(), env, stdio: "ignore" },
          ),
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(cleanupObserved, true);
    assert.equal(await isPortListening(3003), false);
  } finally {
    if (descendantPid) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(readyPath, { force: true });
  }
}

async function testRealDetachedServerLifecycle(): Promise<void> {
  const serverSource = String.raw`
    const fs = require("node:fs");
    const net = require("node:net");
    const readyPath = process.argv[1];
    const eventPath = process.argv[2];
    const behavior = process.argv[3];
    const server = net.createServer((_socket) => undefined);
    let shutdownStarted = false;
    const onSignal = (signal) => {
      fs.appendFileSync(eventPath, signal + "\n", "utf8");
      if (behavior !== "graceful" || shutdownStarted) return;
      shutdownStarted = true;
      setTimeout(() => server.close(() => process.exit(0)), 200);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGHUP", () => onSignal("SIGHUP"));
    server.listen(3003, "127.0.0.1", () => {
      fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid }), "utf8");
    });
    setInterval(() => undefined, 1000);
  `;
  const cliSource = String.raw`
    const fs = require("node:fs");
    const readyPath = process.argv[1];
    const eventPath = process.argv[2];
    const mode = process.argv[3];
    const onSignal = (signal) => {
      fs.appendFileSync(eventPath, signal + "\n", "utf8");
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGHUP", () => onSignal("SIGHUP"));
    fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid }), "utf8");
    if (mode === "natural-failure") {
      setTimeout(() => process.exit(7), 50);
    } else {
      setInterval(() => undefined, 1000);
    }
  `;

  for (const mode of [
    "natural-failure",
    "grace-timeout",
    "second-signal",
  ] as const) {
    assert.equal(await isPortListening(3003), false);
    const runId = randomUUID();
    const serverReadyPath = path.join(
      process.cwd(),
      ".tmp",
      `playwright-detached-server-ready-${runId}.json`,
    );
    const serverEventPath = `${serverReadyPath}.events`;
    const cliReadyPath = path.join(
      process.cwd(),
      ".tmp",
      `playwright-detached-cli-ready-${runId}.json`,
    );
    const cliEventPath = `${cliReadyPath}.events`;
    const signalSource = new FakeSignalSource();
    const ownedDatabases = new Set<string>();
    let cleanupCalls = 0;
    let marker: PlaywrightOwnershipMarker | undefined;
    let ownershipForRun: PlaywrightDatabaseOwnership | undefined;
    let serverPid: number | undefined;
    let cliPid: number | undefined;

    const readPid = (filePath: string): number =>
      (JSON.parse(readFileSync(filePath, "utf8")) as { pid: number }).pid;
    const hasEvent = (filePath: string, signal: NodeJS.Signals): boolean =>
      existsSync(filePath) &&
      readFileSync(filePath, "utf8").split("\n").includes(signal);

    try {
      const runPromise = runOfficialPlaywright(
        { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
        [],
        baseDependencies({
          cleanup: async (ownership, env, ownedMarker) => {
            cleanupCalls += 1;
            assert.ok(marker);
            assert.equal(ownedMarker.markerPath, marker.markerPath);
            assert.ok(existsSync(marker.markerPath));
            assert.equal(processGroupIsAlive(serverPid), false);
            assert.equal(processGroupIsAlive(cliPid), false);
            assert.equal(await isPortListening(3003), false);
            assert.deepEqual(
              ownedDatabases,
              new Set([
                ownership.target.databaseName,
                ownership.shadow.databaseName,
              ]),
            );
            ownedDatabases.clear();
            discardRegisteredMarker(
              process.cwd(),
              ownership,
              env,
              ownedMarker,
            );
          },
          createOwnershipMarker: (cwd, ownership, secret) => {
            ownershipForRun = ownership;
            marker = registerMarker(cwd, ownership, secret);
            return marker;
          },
          forcedShutdownMs: 2_000,
          gracefulShutdownMs:
            mode === "second-signal" ? 2_000 : 300,
          serverReadyTimeoutMs: 5_000,
          signalSource,
          spawnPlaywright: (_args, env) => {
            return spawnControlledPlaywrightChild(
              process.execPath,
              ["-e", cliSource, cliReadyPath, cliEventPath, mode],
              { cwd: process.cwd(), env, stdio: "ignore" },
            );
          },
          spawnServer: (env) => {
            const ownership = resolvePlaywrightDatabaseOwnership(env);
            ownedDatabases.add(ownership.target.databaseName);
            ownedDatabases.add(ownership.shadow.databaseName);
            return spawnControlledPlaywrightChild(
              process.execPath,
              [
                "-e",
                serverSource,
                serverReadyPath,
                serverEventPath,
                mode === "natural-failure" ? "graceful" : "ignore",
              ],
              { cwd: process.cwd(), env, stdio: "ignore" },
            );
          },
          waitForServerReady: async (_env, signal) => {
            await waitForCondition(
              () => signal.aborted || existsSync(serverReadyPath),
              "the real detached server to become ready",
            );
            if (signal.aborted) throw signal.reason;
            serverPid = readPid(serverReadyPath);
            assert.equal(await isPortListening(3003), true);
          },
        }),
      );

      await waitForCondition(
        () => existsSync(cliReadyPath),
        "the real detached CLI to start",
      );
      cliPid = readPid(cliReadyPath);
      assert.ok(marker);
      assert.ok(existsSync(marker.markerPath));
      assert.equal(ownedDatabases.size, 2);

      if (mode !== "natural-failure") signalSource.emit("SIGTERM");
      await waitForCondition(
        () => hasEvent(serverEventPath, "SIGTERM"),
        "the detached server to observe SIGTERM",
      );
      if (mode !== "natural-failure") {
        await waitForCondition(
          () => hasEvent(cliEventPath, "SIGTERM"),
          "the detached CLI to observe SIGTERM",
        );
      }
      assert.equal(cleanupCalls, 0);
      assert.ok(existsSync(marker.markerPath));
      assert.equal(ownedDatabases.size, 2);
      assert.equal(processGroupIsAlive(serverPid), true);
      assert.equal(await isPortListening(3003), true);

      if (mode === "second-signal") signalSource.emit("SIGINT");
      const result = await runPromise;
      assert.equal(cleanupCalls, 1);
      assert.equal(result.cleanupSucceeded, true);
      assert.equal(result.signal, mode === "natural-failure" ? null : "SIGTERM");
      assert.equal(result.exitCode, mode === "natural-failure" ? 7 : 143);
      assert.equal(ownedDatabases.size, 0);
      assert.ok(!existsSync(marker.markerPath));
      assert.equal(processGroupIsAlive(serverPid), false);
      assert.equal(processGroupIsAlive(cliPid), false);
      assert.equal(await isPortListening(3003), false);
    } finally {
      for (const pid of [serverPid, cliPid]) {
        if (!processGroupIsAlive(pid)) continue;
        try {
          process.kill(-(pid as number), "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (processGroupIsAlive(serverPid) || processGroupIsAlive(cliPid)) {
        await waitForCondition(
          () =>
            !processGroupIsAlive(serverPid) && !processGroupIsAlive(cliPid),
          `the detached ${mode} verifier process groups to become quiescent`,
          2_000,
        );
      }
      rmSync(serverReadyPath, { force: true });
      rmSync(serverEventPath, { force: true });
      rmSync(cliReadyPath, { force: true });
      rmSync(cliEventPath, { force: true });
      if (ownershipForRun && marker && existsSync(marker.markerPath)) {
        discardMarkerForOwnership(ownershipForRun);
      }
    }
  }
}

async function testEntryFinalizerSignalSemanticsAndRecursiveLogs(): Promise<void> {
  for (const signal of terminationSignals) {
    const markerFilesBefore = markerRootFiles();
    const result = await runTypeScriptEntry(
      "scripts/verify-playwright-runner-finalizer-entry.ts",
      [signal, "normal"],
      {
        ...process.env,
        NODE_OPTIONS: "",
      },
    );
    if (result.signal) {
      assert.equal(result.signal, signal);
      assert.equal(result.exitCode, null);
    } else {
      assert.equal(result.exitCode, playwrightSignalExitCode(signal));
    }
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.output.includes(`"exitCode":${playwrightSignalExitCode(signal)}`));
    assert.ok(result.output.includes(`"signal":"${signal}"`));
    assert.ok(result.output.includes("shadow drop failed"));
    assert.ok(result.output.includes("target drop failed"));
    assert.ok(result.output.includes("[REDACTED]"));
    assert.ok(!result.output.includes("do-not-log"));
    assert.deepEqual(markerRootFiles(), markerFilesBefore);
  }

  const ignoredSignal = await runTypeScriptEntry(
    "scripts/verify-playwright-runner-finalizer-entry.ts",
    ["SIGINT", "ignore"],
    {
      ...process.env,
      NODE_OPTIONS: "",
    },
  );
  assert.equal(ignoredSignal.signal, null);
  assert.equal(ignoredSignal.exitCode, 130);

  const thrownSignal = await runTypeScriptEntry(
    "scripts/verify-playwright-runner-finalizer-entry.ts",
    ["SIGTERM", "throw"],
    {
      ...process.env,
      NODE_OPTIONS: "",
    },
  );
  assert.equal(thrownSignal.signal, null);
  assert.equal(thrownSignal.exitCode, 143);
  assert.ok(thrownSignal.output.includes("playwright.run.signal_retrigger_failed"));
}

async function testConcurrentOwnershipIsolation(): Promise<void> {
  const databases = new Set<string>();
  const removedByToken = new Map<string, string[]>();
  const run = (byte: number) => {
    const dependencies = baseDependencies({
      randomBytes: deterministicRandomBytes(byte),
    });
    return runOfficialPlaywright(
      { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSource },
      [],
      {
        ...dependencies,
        cleanup: async (ownership, env, marker) => {
          const removed: string[] = [];
          for (const databaseName of [
            ownership.target.databaseName,
            ownership.shadow.databaseName,
          ]) {
            if (databases.delete(databaseName)) removed.push(databaseName);
          }
          removedByToken.set(ownership.token, removed);
          discardRegisteredMarker(process.cwd(), ownership, env, marker);
        },
        spawnPlaywright: (_args, env) => {
          const ownership = resolvePlaywrightDatabaseOwnership(env);
          databases.add(ownership.target.databaseName);
          databases.add(ownership.shadow.databaseName);
          const child = new FakeChild();
          queueMicrotask(() => child.emitExit(0, null));
          return child;
        },
      },
    );
  };
  const [first, second] = await Promise.all([run(20), run(21)]);
  assert.equal(databases.size, 0);
  assert.deepEqual(
    new Set(removedByToken.get(first.ownership.token)),
    new Set([
      first.ownership.target.databaseName,
      first.ownership.shadow.databaseName,
    ]),
  );
  assert.deepEqual(
    new Set(removedByToken.get(second.ownership.token)),
    new Set([
      second.ownership.target.databaseName,
      second.ownership.shadow.databaseName,
    ]),
  );
}

async function cleanupRegisteredMarkers(): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const record of [...registeredMarkers.values()]) {
    try {
      discardRegisteredMarker(
        record.cwd,
        record.ownership,
        markerEnvironment(record.marker),
        record.marker,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const markerFilesBefore = markerRootFiles();
  let testError: unknown;
  try {
    await testDangerousCliRejectionAndForcedConfig();
    await testCloneEntryHardReject();
    await testFormerEntryBypassEnvironmentCannotSkipRunner();
    await testUnsupportedPlatformRejectsBeforeMarker();
    await testOccupiedServerPortRejectsBeforeMarker();
    await testUniquePairsAndHostileEnvironmentNeutralization();
    await testHostileNodeOptionsNeverExecuteInRealChild();
    testOwnershipAndCredentialValidation();
    testMarkerFilesystemSafety();
    testPublicTokenAndGuardPathCannotForgeContext();
    await testDirectLifecycleCompensationAndMarkerRemoval();
    await testFailureCleanup();
    await testNormalRunConvergesBothProcessGroups();
    for (const signal of terminationSignals) {
      await testGracefulSignalCleanup(signal);
    }
    await testKillFalseStillCleans();
    await testIgnoredAndRepeatedSignals();
    await testPreChildRepeatedSignals();
    await testSignalSpawnErrorRaceCleansOnce();
    await testUnquiescentTreeSkipsDatabaseCleanup();
    await testUnquiescentServerSkipsDatabaseCleanup();
    await testServerFailureTerminatesCliBeforeCleanup();
    await testSignalsConvergeServerAndCliGroups();
    await testPreServerRepeatedSignalsAvoidCliSpawn();
    await testCleanupFailureAggregation();
    await testRealDescendantPortQuiescence();
    await testRealDetachedServerLifecycle();
    await testEntryFinalizerSignalSemanticsAndRecursiveLogs();
    await testConcurrentOwnershipIsolation();
  } catch (error) {
    testError = error;
  }

  const cleanupErrors = await cleanupRegisteredMarkers();
  try {
    assert.deepEqual(markerRootFiles(), markerFilesBefore);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (testError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors],
      "Lifecycle verification and verifier marker cleanup both failed",
    );
  }
  if (testError) throw testError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Lifecycle verifier left ownership markers behind",
    );
  }
  console.log("Playwright runner entry and lifecycle safety checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
