import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { logger, withScriptLogging } from "../lib/logger";
import { quotePlaywrightDatabaseIdentifier } from "./playwright-db-cleanup";
import {
  installPlaywrightFeishuEgressGuard,
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV,
} from "./playwright-feishu-egress-guard.mjs";
import {
  assertPlaywrightMaintenanceConnection,
  maintenanceDatabaseUrl,
  type PlaywrightDatabaseOwnership,
} from "./playwright-db-safety";
import {
  assertOfficialPlaywrightEnvironment,
  createOfficialPlaywrightRunContext,
  defaultPlaywrightRunnerDependencies,
  runOfficialPlaywright,
  spawnControlledPlaywrightChild,
  type OfficialPlaywrightRunContext,
  type PlaywrightRunnerDependencies,
  type PlaywrightSignalSource,
} from "./playwright-runner";

type ScriptResult = {
  exitCode: number | null;
  markerFilesAfter: string[];
  markerFilesBefore: string[];
  signal: NodeJS.Signals | null;
};

const credentialSourceUrl = process.env.PLAYWRIGHT_DATABASE_URL?.trim();
if (!credentialSourceUrl) {
  throw new Error(
    "PLAYWRIGHT_DATABASE_URL is required as the credential source for the isolated safety rehearsal",
  );
}

function markerRootFiles(): string[] {
  const root = path.join(process.cwd(), ".tmp", "playwright-db-ownership");
  return existsSync(root) ? readdirSync(root).sort() : [];
}

function createRunContext(): OfficialPlaywrightRunContext {
  const dependencies = defaultPlaywrightRunnerDependencies();
  return createOfficialPlaywrightRunContext(
    { ...process.env, PLAYWRIGHT_DATABASE_URL: credentialSourceUrl },
    { ...dependencies, createRunId: randomUUID, randomBytes },
  );
}

async function runTypeScriptScript(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ScriptResult> {
  const markerFilesBefore = markerRootFiles();
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxBin, scriptPath], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return {
    ...result,
    markerFilesAfter: markerRootFiles(),
    markerFilesBefore,
  };
}

async function listExactDatabases(
  client: pg.Client,
  databaseNames: string[],
): Promise<string[]> {
  const result = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname",
    [databaseNames],
  );
  return result.rows.map((row) => row.datname);
}

async function listTokenDatabases(
  client: pg.Client,
  ownerships: PlaywrightDatabaseOwnership[],
): Promise<string[]> {
  const result = await client.query<{ datname: string }>(
    `
      SELECT datname
      FROM pg_database
      WHERE strpos(datname, $1) > 0 OR strpos(datname, $2) > 0
      ORDER BY datname
    `,
    [ownerships[0].token, ownerships[1].token],
  );
  return result.rows.map((row) => row.datname);
}

async function dropExactDatabase(
  client: pg.Client,
  databaseName: string,
): Promise<void> {
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [databaseName],
  );
  await client.query(
    `DROP DATABASE IF EXISTS ${quotePlaywrightDatabaseIdentifier(databaseName)}`,
  );
}

async function assertSetupRejectedBeforeMutation(
  client: pg.Client,
  label: string,
  env: NodeJS.ProcessEnv,
  firstRun: OfficialPlaywrightRunContext,
  sentinelDatabaseName: string,
): Promise<void> {
  const ownedNames = [
    firstRun.ownership.target.databaseName,
    firstRun.ownership.shadow.databaseName,
  ];
  assert.deepEqual(await listExactDatabases(client, ownedNames), []);
  const result = await runTypeScriptScript("scripts/setup-playwright-db.ts", env);
  assert.equal(result.signal, null, `${label}: setup terminated by signal`);
  assert.notEqual(result.exitCode, 0, `${label}: unsafe setup unexpectedly succeeded`);
  assert.deepEqual(result.markerFilesAfter, result.markerFilesBefore);
  assert.deepEqual(
    await listExactDatabases(client, ownedNames),
    [],
    `${label}: database mutation occurred before rejection`,
  );
  assert.deepEqual(
    await listExactDatabases(client, [sentinelDatabaseName]),
    [sentinelDatabaseName],
    `${label}: the similar-name sentinel was changed`,
  );
}

async function assertScriptSucceededWithoutMarkerChange(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await runTypeScriptScript(scriptPath, env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.markerFilesAfter, result.markerFilesBefore);
}

async function recoverMarkerAfterFailure(
  run: OfficialPlaywrightRunContext,
): Promise<void> {
  if (!existsSync(run.marker.markerPath)) return;
  defaultPlaywrightRunnerDependencies().discardOwnershipMarker(
    process.cwd(),
    run.ownership,
    run.env,
    run.marker,
  );
}

type SafetySignal = "SIGHUP" | "SIGINT" | "SIGTERM";

class SafetySignalSource implements PlaywrightSignalSource {
  private readonly events = new EventEmitter();

  add(signal: SafetySignal, listener: () => void): void {
    this.events.on(signal, listener);
  }

  emit(signal: SafetySignal): void {
    this.events.emit(signal);
  }

  remove(signal: SafetySignal, listener: () => void): void {
    this.events.off(signal, listener);
  }
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
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

async function verifyRealDetachedRunnerDatabaseLifecycle(
  maintenance: pg.Client,
): Promise<void> {
  const serverSource = String.raw`
    const fs = require("node:fs");
    const net = require("node:net");
    const { spawn } = require("node:child_process");
    const readyPath = process.argv[1];
    const eventPath = process.argv[2];
    const behavior = process.argv[3];
    const tsxBin = process.argv[4];
    const setup = spawn(process.execPath, [tsxBin, "scripts/setup-playwright-db.ts"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
    });
    setup.once("error", () => process.exit(70));
    setup.once("exit", (code, signal) => {
      if (signal || code !== 0) process.exit(code || 71);
      const server = net.createServer((_socket) => undefined);
      let shutdownStarted = false;
      const onSignal = (receivedSignal) => {
        fs.appendFileSync(eventPath, receivedSignal + "\n", "utf8");
        if (behavior !== "graceful" || shutdownStarted) return;
        shutdownStarted = true;
        setTimeout(() => server.close(() => process.exit(0)), 750);
      };
      process.on("SIGINT", () => onSignal("SIGINT"));
      process.on("SIGTERM", () => onSignal("SIGTERM"));
      process.on("SIGHUP", () => onSignal("SIGHUP"));
      server.listen(3002, "127.0.0.1", () => {
        fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid }), "utf8");
      });
      setInterval(() => undefined, 1000);
    });
  `;
  const cliSource = String.raw`
    const fs = require("node:fs");
    const readyPath = process.argv[1];
    const eventPath = process.argv[2];
    const mode = process.argv[3];
    const onSignal = (signal) => fs.appendFileSync(eventPath, signal + "\n", "utf8");
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGHUP", () => onSignal("SIGHUP"));
    fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid }), "utf8");
    if (mode === "natural-failure") setTimeout(() => process.exit(7), 50);
    else setInterval(() => undefined, 1000);
  `;

  for (const mode of [
    "natural-failure",
    "grace-timeout",
    "second-signal",
  ] as const) {
    assert.equal(await isPortListening(3002), false);
    const runId = randomUUID();
    const serverReadyPath = path.join(
      process.cwd(),
      ".tmp",
      `playwright-db-detached-server-${runId}.json`,
    );
    const serverEventPath = `${serverReadyPath}.events`;
    const cliReadyPath = path.join(
      process.cwd(),
      ".tmp",
      `playwright-db-detached-cli-${runId}.json`,
    );
    const cliEventPath = `${cliReadyPath}.events`;
    const signalSource = new SafetySignalSource();
    const defaults = defaultPlaywrightRunnerDependencies();
    let cleanupCalls = 0;
    let marker: OfficialPlaywrightRunContext["marker"] | undefined;
    let ownership: PlaywrightDatabaseOwnership | undefined;
    let runEnv: NodeJS.ProcessEnv | undefined;
    let serverPid: number | undefined;
    let cliPid: number | undefined;
    let scenarioError: unknown;
    const recoveryErrors: unknown[] = [];
    const readPid = (filePath: string): number =>
      (JSON.parse(readFileSync(filePath, "utf8")) as { pid: number }).pid;
    const hasEvent = (filePath: string, signal: SafetySignal): boolean =>
      existsSync(filePath) &&
      readFileSync(filePath, "utf8").split("\n").includes(signal);

    try {
      const dependencies: PlaywrightRunnerDependencies = {
        ...defaults,
        cleanup: async (ownedPair, env, ownedMarker) => {
          cleanupCalls += 1;
          assert.equal(processGroupIsAlive(serverPid), false);
          assert.equal(processGroupIsAlive(cliPid), false);
          assert.equal(await isPortListening(3002), false);
          assert.deepEqual(
            await listExactDatabases(maintenance, [
              ownedPair.target.databaseName,
              ownedPair.shadow.databaseName,
            ]),
            [
              ownedPair.shadow.databaseName,
              ownedPair.target.databaseName,
            ].sort(),
          );
          await defaults.cleanup(ownedPair, env, ownedMarker);
        },
        createOwnershipMarker: (cwd, ownedPair, secret) => {
          ownership = ownedPair;
          marker = defaults.createOwnershipMarker(cwd, ownedPair, secret);
          return marker;
        },
        forcedShutdownMs: 2_000,
        gracefulShutdownMs:
          mode === "second-signal" ? 2_000 : 1_000,
        serverReadyTimeoutMs: 10_000,
        signalSource,
        spawnPlaywright: (_args, env) => {
          runEnv = env;
          return spawnControlledPlaywrightChild(
            process.execPath,
            ["-e", cliSource, cliReadyPath, cliEventPath, mode],
            { cwd: process.cwd(), env, stdio: "ignore" },
          );
        },
        spawnServer: (env) => {
          runEnv = env;
          const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
          return spawnControlledPlaywrightChild(
            process.execPath,
            [
              "-e",
              serverSource,
              serverReadyPath,
              serverEventPath,
              mode === "natural-failure" ? "graceful" : "ignore",
              tsxBin,
            ],
            { cwd: process.cwd(), env, stdio: "ignore" },
          );
        },
        waitForServerReady: async (_env, signal) => {
          await waitForCondition(
            () => signal.aborted || existsSync(serverReadyPath),
            "the detached database server fixture to become ready",
          );
          if (signal.aborted) throw signal.reason;
          serverPid = readPid(serverReadyPath);
          assert.equal(await isPortListening(3002), true);
        },
      };
      const runPromise = runOfficialPlaywright(
        {
          ...process.env,
          CHECKPOINT_DISABLE: "1",
          NOTIFICATION_DELIVERY_DISABLED: "true",
          PLAYWRIGHT_DATABASE_URL: credentialSourceUrl,
        },
        [],
        dependencies,
      );

      await waitForCondition(
        () => existsSync(cliReadyPath),
        "the detached database CLI fixture to start",
      );
      cliPid = readPid(cliReadyPath);
      assert.ok(marker);
      assert.ok(ownership);
      assert.ok(existsSync(marker.markerPath));
      assert.deepEqual(
        await listExactDatabases(maintenance, [
          ownership.target.databaseName,
          ownership.shadow.databaseName,
        ]),
        [
          ownership.shadow.databaseName,
          ownership.target.databaseName,
        ].sort(),
      );

      if (mode !== "natural-failure") signalSource.emit("SIGTERM");
      await waitForCondition(
        () => hasEvent(serverEventPath, "SIGTERM"),
        "the detached database server fixture to observe SIGTERM",
      );
      if (mode !== "natural-failure") {
        await waitForCondition(
          () => hasEvent(cliEventPath, "SIGTERM"),
          "the detached database CLI fixture to observe SIGTERM",
        );
      }
      assert.equal(cleanupCalls, 0);
      assert.ok(existsSync(marker.markerPath));
      assert.equal(processGroupIsAlive(serverPid), true);
      assert.equal(await isPortListening(3002), true);
      assert.deepEqual(
        await listExactDatabases(maintenance, [
          ownership.target.databaseName,
          ownership.shadow.databaseName,
        ]),
        [
          ownership.shadow.databaseName,
          ownership.target.databaseName,
        ].sort(),
      );

      if (mode === "second-signal") signalSource.emit("SIGINT");
      const result = await runPromise;
      assert.equal(result.cleanupSucceeded, true);
      assert.equal(cleanupCalls, 1);
      assert.equal(result.signal, mode === "natural-failure" ? null : "SIGTERM");
      assert.equal(result.exitCode, mode === "natural-failure" ? 7 : 143);
      assert.equal(processGroupIsAlive(serverPid), false);
      assert.equal(processGroupIsAlive(cliPid), false);
      assert.equal(await isPortListening(3002), false);
      assert.ok(!existsSync(marker.markerPath));
      assert.deepEqual(
        await listExactDatabases(maintenance, [
          ownership.target.databaseName,
          ownership.shadow.databaseName,
        ]),
        [],
      );
      logger.info("playwright.db.detached_lifecycle.complete", {
        module: "playwright",
        action: "verifyDetachedPlaywrightDbLifecycle",
        mode,
        targetDatabaseName: ownership.target.databaseName,
        shadowDatabaseName: ownership.shadow.databaseName,
        cleanupCallCount: cleanupCalls,
        remainingDatabaseCount: 0,
        remainingMarkerCount: 0,
        portListening: false,
        processGroupCount: 0,
      });
    } catch (error) {
      scenarioError = error;
    }

    for (const pid of [serverPid, cliPid]) {
      if (!processGroupIsAlive(pid)) continue;
      try {
        process.kill(-(pid as number), "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          recoveryErrors.push(error);
        }
      }
    }
    let recoveryProcessGroupsQuiescent = true;
    if (
      scenarioError &&
      (processGroupIsAlive(serverPid) || processGroupIsAlive(cliPid))
    ) {
      try {
        await waitForCondition(
          () =>
            !processGroupIsAlive(serverPid) && !processGroupIsAlive(cliPid),
          `detached ${mode} recovery process groups to become quiescent`,
          2_000,
        );
      } catch (error) {
        recoveryProcessGroupsQuiescent = false;
        recoveryErrors.push(error);
      }
    }
    if (scenarioError && ownership && recoveryProcessGroupsQuiescent) {
      for (const databaseName of [
        ownership.shadow.databaseName,
        ownership.target.databaseName,
      ]) {
        try {
          await dropExactDatabase(maintenance, databaseName);
        } catch (error) {
          recoveryErrors.push(error);
        }
      }
    }
    if (
      marker &&
      ownership &&
      runEnv &&
      recoveryProcessGroupsQuiescent &&
      existsSync(marker.markerPath)
    ) {
      try {
        defaults.discardOwnershipMarker(
          process.cwd(),
          ownership,
          runEnv,
          marker,
        );
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
    rmSync(serverReadyPath, { force: true });
    rmSync(serverEventPath, { force: true });
    rmSync(cliReadyPath, { force: true });
    rmSync(cliEventPath, { force: true });

    if (scenarioError && recoveryErrors.length > 0) {
      throw new AggregateError(
        [scenarioError, ...recoveryErrors],
        `Detached ${mode} database lifecycle and recovery both failed`,
      );
    }
    if (scenarioError) throw scenarioError;
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        recoveryErrors,
        `Detached ${mode} database lifecycle recovery failed`,
      );
    }
  }
}

async function main(): Promise<void> {
  const markerFilesAtStart = markerRootFiles();
  const runs: OfficialPlaywrightRunContext[] = [];
  let firstRun: OfficialPlaywrightRunContext | undefined;
  let secondRun: OfficialPlaywrightRunContext | undefined;
  let maintenance: pg.Client | undefined;
  let maintenanceValidated = false;
  let runDatabaseNames: string[] = [];
  let ownerships: PlaywrightDatabaseOwnership[] = [];
  let sentinelDatabaseName = "";
  let rehearsalError: unknown;
  const cleanupFailures: unknown[] = [];
  let exactDatabaseRecoverySucceeded = true;

  try {
    firstRun = createRunContext();
    runs.push(firstRun);
    secondRun = createRunContext();
    runs.push(secondRun);
    assert.notEqual(firstRun.ownership.token, secondRun.ownership.token);

    Object.assign(process.env, firstRun.env);
    delete process.env.CONFIRM_SEND_FEISHU;
    delete process.env.PLAYWRIGHT_REUSE_SERVER;
    delete process.env.PLAYWRIGHT_SKIP_WEBSERVER;
    delete process.env.PLAYWRIGHT_SOURCE_DATABASE_URL;
    assertOfficialPlaywrightEnvironment(process.env);
    installPlaywrightFeishuEgressGuard();

    sentinelDatabaseName =
      `pw_${firstRun.ownership.token}_target_sentinel_test`;
    ownerships = [firstRun.ownership, secondRun.ownership];
    runDatabaseNames = [
      firstRun.ownership.target.databaseName,
      firstRun.ownership.shadow.databaseName,
      secondRun.ownership.target.databaseName,
      secondRun.ownership.shadow.databaseName,
      sentinelDatabaseName,
    ];

    logger.info("playwright.db.safety_rehearsal.start", {
      module: "playwright",
      action: "verifyPlaywrightDbSafety",
      firstTargetDatabaseName: firstRun.ownership.target.databaseName,
      firstShadowDatabaseName: firstRun.ownership.shadow.databaseName,
      secondTargetDatabaseName: secondRun.ownership.target.databaseName,
      secondShadowDatabaseName: secondRun.ownership.shadow.databaseName,
      sentinelDatabaseName,
      setupMode: "recreate",
      sourceCloneConfigured: false,
      notificationDeliveryDisabled: true,
      checkpointDisabled: true,
      feishuEgressDisabled:
        process.env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] === "true",
    });

    maintenance = new pg.Client({
      connectionString: maintenanceDatabaseUrl(firstRun.ownership.target.url),
    });
    await maintenance.connect();
    await assertPlaywrightMaintenanceConnection(
      maintenance,
      firstRun.ownership.target,
    );
    maintenanceValidated = true;
    assert.deepEqual(await listTokenDatabases(maintenance, ownerships), []);
    await maintenance.query(
      `CREATE DATABASE ${quotePlaywrightDatabaseIdentifier(sentinelDatabaseName)}`,
    );

    await assertSetupRejectedBeforeMutation(
      maintenance,
      "mismatched ownership secret",
      {
        ...firstRun.env,
        PLAYWRIGHT_DB_OWNERSHIP_SECRET:
          secondRun.env.PLAYWRIGHT_DB_OWNERSHIP_SECRET,
      },
      firstRun,
      sentinelDatabaseName,
    );
    await assertSetupRejectedBeforeMutation(
      maintenance,
      "clone/source settings",
      {
        ...firstRun.env,
        PLAYWRIGHT_DB_SETUP_MODE: "clone",
        PLAYWRIGHT_SOURCE_DATABASE_URL: credentialSourceUrl,
      },
      firstRun,
      sentinelDatabaseName,
    );

    const staticShadowUrl = new URL(firstRun.ownership.shadow.url);
    staticShadowUrl.pathname =
      `/${firstRun.ownership.target.databaseName}_shadow_test`;
    await assertSetupRejectedBeforeMutation(
      maintenance,
      "caller-selected static shadow",
      {
        ...firstRun.env,
        PLAYWRIGHT_CONFIRM_RECREATE_SHADOW_DB:
          staticShadowUrl.pathname.replace(/^\//, ""),
        PLAYWRIGHT_SHADOW_DATABASE_URL: staticShadowUrl.toString(),
        SHADOW_DATABASE_URL: staticShadowUrl.toString(),
      },
      firstRun,
      sentinelDatabaseName,
    );

    const markersBeforeConcurrentSetup = markerRootFiles();
    await Promise.all([
      assertScriptSucceededWithoutMarkerChange(
        "scripts/setup-playwright-db.ts",
        firstRun.env,
      ),
      assertScriptSucceededWithoutMarkerChange(
        "scripts/setup-playwright-db.ts",
        secondRun.env,
      ),
    ]);
    assert.deepEqual(markerRootFiles(), markersBeforeConcurrentSetup);
    assert.deepEqual(
      await listExactDatabases(maintenance, runDatabaseNames),
      [...runDatabaseNames].sort(),
    );

    const invalidCleanupResult = await runTypeScriptScript(
      "scripts/cleanup-playwright-db.ts",
      {
        ...firstRun.env,
        PLAYWRIGHT_DB_OWNERSHIP_SECRET:
          secondRun.env.PLAYWRIGHT_DB_OWNERSHIP_SECRET,
      },
    );
    assert.notEqual(invalidCleanupResult.exitCode, 0);
    assert.deepEqual(
      invalidCleanupResult.markerFilesAfter,
      invalidCleanupResult.markerFilesBefore,
    );
    assert.deepEqual(
      await listExactDatabases(maintenance, runDatabaseNames),
      [...runDatabaseNames].sort(),
    );

    const cloneResult = await runTypeScriptScript(
      "scripts/copy-playwright-db-data.ts",
      {
        ...firstRun.env,
        PLAYWRIGHT_SOURCE_DATABASE_URL: credentialSourceUrl,
      },
    );
    assert.notEqual(cloneResult.exitCode, 0);
    assert.deepEqual(cloneResult.markerFilesAfter, cloneResult.markerFilesBefore);

    const firstCleanup = await runTypeScriptScript(
      "scripts/cleanup-playwright-db.ts",
      firstRun.env,
    );
    assert.equal(firstCleanup.exitCode, 0);
    assert.equal(firstCleanup.signal, null);
    const firstMarkerFileName = path.basename(firstRun.marker.markerPath);
    assert.deepEqual(
      firstCleanup.markerFilesAfter,
      firstCleanup.markerFilesBefore.filter(
        (fileName) => fileName !== firstMarkerFileName,
      ),
    );
    assert.ok(!existsSync(firstRun.marker.markerPath));
    assert.deepEqual(
      await listExactDatabases(maintenance, runDatabaseNames),
      [
        secondRun.ownership.shadow.databaseName,
        secondRun.ownership.target.databaseName,
        sentinelDatabaseName,
      ].sort(),
    );

    const secondCleanup = await runTypeScriptScript(
      "scripts/cleanup-playwright-db.ts",
      secondRun.env,
    );
    assert.equal(secondCleanup.exitCode, 0);
    assert.equal(secondCleanup.signal, null);
    const secondMarkerFileName = path.basename(secondRun.marker.markerPath);
    assert.deepEqual(
      secondCleanup.markerFilesAfter,
      secondCleanup.markerFilesBefore.filter(
        (fileName) => fileName !== secondMarkerFileName,
      ),
    );
    assert.ok(!existsSync(secondRun.marker.markerPath));
    assert.deepEqual(
      await listExactDatabases(maintenance, runDatabaseNames),
      [sentinelDatabaseName],
    );
    await dropExactDatabase(maintenance, sentinelDatabaseName);
    assert.deepEqual(await listTokenDatabases(maintenance, ownerships), []);
    assert.deepEqual(markerRootFiles(), markerFilesAtStart);

    await verifyRealDetachedRunnerDatabaseLifecycle(maintenance);
    assert.deepEqual(markerRootFiles(), markerFilesAtStart);

    logger.info("playwright.db.safety_rehearsal.complete", {
      module: "playwright",
      action: "verifyPlaywrightDbSafety",
      firstTargetDatabaseName: firstRun.ownership.target.databaseName,
      firstShadowDatabaseName: firstRun.ownership.shadow.databaseName,
      secondTargetDatabaseName: secondRun.ownership.target.databaseName,
      secondShadowDatabaseName: secondRun.ownership.shadow.databaseName,
      sentinelDatabaseName,
      remainingDatabaseCount: 0,
      remainingMarkerCount: 0,
    });
  } catch (error) {
    rehearsalError = error;
  }

  if (maintenance && maintenanceValidated) {
    for (const databaseName of runDatabaseNames) {
      try {
        await dropExactDatabase(maintenance, databaseName);
      } catch (error) {
        cleanupFailures.push(error);
        exactDatabaseRecoverySucceeded = false;
      }
    }
    try {
      const remainingDatabases = await listTokenDatabases(maintenance, ownerships);
      if (remainingDatabases.length > 0) {
        exactDatabaseRecoverySucceeded = false;
        cleanupFailures.push(
          new Error(
            `Playwright database safety rehearsal left ${remainingDatabases.length} database(s) behind`,
          ),
        );
      }
    } catch (error) {
      cleanupFailures.push(error);
      exactDatabaseRecoverySucceeded = false;
    }
  }

  if (rehearsalError && exactDatabaseRecoverySucceeded) {
    for (const run of runs) {
      try {
        await recoverMarkerAfterFailure(run);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  } else if (rehearsalError) {
    cleanupFailures.push(
      new Error(
        "Ownership markers were retained because exact database recovery was incomplete",
      ),
    );
  } else if (runs.some((run) => existsSync(run.marker.markerPath))) {
    cleanupFailures.push(
      new Error("Successful database safety rehearsal left an ownership marker"),
    );
  }

  if (maintenance) {
    try {
      await maintenance.end();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (markerRootFiles().join("\0") !== markerFilesAtStart.join("\0")) {
    cleanupFailures.push(
      new Error("Database safety verifier changed the marker root contents"),
    );
  }

  const cleanupError =
    cleanupFailures.length > 0
      ? new AggregateError(
          cleanupFailures,
          "The safety rehearsal could not clean its exact databases and markers",
        )
      : undefined;
  if (rehearsalError && cleanupError) {
    throw new AggregateError(
      [rehearsalError, cleanupError],
      "The safety rehearsal and its exact cleanup both failed",
    );
  }
  if (rehearsalError) throw rehearsalError;
  if (cleanupError) throw cleanupError;
}

withScriptLogging("verify-playwright-db-safety", main).catch((error) => {
  logger.error("playwright.db.safety_rehearsal.failed", {
    module: "playwright",
    action: "verifyPlaywrightDbSafety",
    error,
  });
  process.exitCode = 1;
});
