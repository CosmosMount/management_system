import { Client, type ClientConfig } from "pg";

const DATABASE_OPERATION_TIMEOUT_MS = 7_500;
const PENDING_OPERATION_TIMEOUT_MS = 15_000;
const CANCELLED_OPERATION_SETTLEMENT_TIMEOUT_MS = 7_500;

type DatabaseClientFactory = (config: ClientConfig) => Client;
type BackendSignal = "cancel" | "terminate";

type BackendSignalRunner = (input: {
  observer: Client;
  signal: BackendSignal;
  targetPids: readonly number[];
  send: () => Promise<void>;
}) => Promise<void>;

export async function connectDatabaseClient(
  name: string,
  createClient: DatabaseClientFactory = (config) => new Client(config),
) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("测试缺少 DATABASE_URL");
  const client = createClient({
    connectionString,
    application_name: `p5-r02-${name}`,
  });
  try {
    await client.connect();
    return client;
  } catch (connectError) {
    try {
      await closeDatabaseClient(client, false);
    } catch (cleanupError) {
      throw new AggregateError(
        [connectError, wrapCleanupError("连接失败后关闭数据库 client 失败", cleanupError)],
        "数据库连接失败，且 client 清理失败",
      );
    }
    throw connectError;
  }
}

export async function databaseBackendPid(client: Client) {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = result.rows[0]?.pid;
  if (!pid) throw new Error("无法取得 PostgreSQL backend pid");
  return pid;
}

export async function waitForDirectBlockers(
  observer: Client,
  blockerPid: number,
  expectedCount: number,
) {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      `WITH RECURSIVE "blocked"("pid") AS (
         SELECT "activity"."pid"
         FROM "pg_stat_activity" AS "activity"
         WHERE $1::int = ANY(pg_blocking_pids("activity"."pid"))
         UNION
         SELECT "activity"."pid"
         FROM "pg_stat_activity" AS "activity"
         JOIN "blocked" AS "blocker"
           ON "blocker"."pid" = ANY(pg_blocking_pids("activity"."pid"))
       )
       SELECT "pid" FROM "blocked" ORDER BY "pid" ASC`,
      [blockerPid],
    );
    const pids = [...new Set(result.rows.map((row) => row.pid))];
    if (pids.length >= expectedCount) return pids;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `未在期限内观察到 ${expectedCount} 个事务被 backend ${blockerPid} 阻塞`,
  );
}

export function startBarrierOperations<T>(
  operations: readonly (() => Promise<T>)[],
) {
  const pending = operations.map((operation) =>
    Promise.resolve().then(operation),
  );
  const settlement = Promise.allSettled(pending);
  return { pending, settlement };
}

export async function cleanupBarrierResources(input: {
  locker?: Client;
  observer?: Client;
  rollbackRequired: boolean;
  pendingSettlement?: Promise<PromiseSettledResult<unknown>[]>;
  pendingBackendPids?: readonly number[];
  pendingOperationTimeoutMs?: number;
  cancelledOperationSettlementTimeoutMs?: number;
  backendSignalRunner?: BackendSignalRunner;
  pendingHandled: boolean;
  primaryError: unknown;
}) {
  const cleanupErrors: Error[] = [];
  let lockerClosed = false;
  if (input.rollbackRequired && input.locker) {
    const locker = input.locker;
    const rollbackError = await captureCleanupError(
      cleanupErrors,
      "回滚 barrier 事务失败",
      () =>
        withTimeout(
          locker.query("ROLLBACK"),
          DATABASE_OPERATION_TIMEOUT_MS,
          "回滚 barrier 事务超时",
        ),
    );
    if (rollbackError) {
      await captureCleanupError(
        cleanupErrors,
        "回滚失败后强制关闭 barrier locker 失败",
        () => closeDatabaseClient(locker, true),
      );
      lockerClosed = true;
    }
  }
  if (!input.pendingHandled && input.pendingSettlement) {
    const settled = await settlePendingOperations({
      observer: input.observer,
      pendingSettlement: input.pendingSettlement,
      pendingBackendPids: input.pendingBackendPids ?? [],
      pendingOperationTimeoutMs:
        input.pendingOperationTimeoutMs ?? PENDING_OPERATION_TIMEOUT_MS,
      cancelledOperationSettlementTimeoutMs:
        input.cancelledOperationSettlementTimeoutMs ??
        CANCELLED_OPERATION_SETTLEMENT_TIMEOUT_MS,
      backendSignalRunner: input.backendSignalRunner,
      cleanupErrors,
    });
    for (const outcome of settled) {
      if (
        outcome.status === "rejected" &&
        outcome.reason !== input.primaryError
      ) {
        cleanupErrors.push(
          wrapCleanupError("pending operation 执行失败", outcome.reason),
        );
      }
    }
  }
  if (input.observer) {
    const observer = input.observer;
    await captureCleanupError(
      cleanupErrors,
      "关闭 barrier observer 失败",
      () => closeDatabaseClient(observer, false),
    );
  }
  if (input.locker && !lockerClosed) {
    const locker = input.locker;
    await captureCleanupError(
      cleanupErrors,
      "关闭 barrier locker 失败",
      () => closeDatabaseClient(locker, false),
    );
  }
  return cleanupErrors;
}

async function settlePendingOperations(input: {
  observer?: Client;
  pendingSettlement: Promise<PromiseSettledResult<unknown>[]>;
  pendingBackendPids: readonly number[];
  pendingOperationTimeoutMs: number;
  cancelledOperationSettlementTimeoutMs: number;
  backendSignalRunner?: BackendSignalRunner;
  cleanupErrors: Error[];
}) {
  try {
    return await withTimeout(
      input.pendingSettlement,
      Math.max(1, input.pendingOperationTimeoutMs),
      "等待 pending operation 超时",
    );
  } catch (error) {
    input.cleanupErrors.push(
      wrapCleanupError("等待 pending operation 失败", error),
    );
  }

  await captureCleanupError(
    input.cleanupErrors,
    "取消超时 pending operation 的数据库 backend 失败",
    async () => {
      if (!input.observer) throw new Error("缺少 barrier observer 连接");
      await signalPendingBackends(
        input.observer,
        input.pendingBackendPids,
        "cancel",
        input.backendSignalRunner,
      );
    },
  );

  try {
    return await withTimeout(
      input.pendingSettlement,
      Math.max(1, input.cancelledOperationSettlementTimeoutMs),
      "取消 backend 后 pending operation 仍未结束",
    );
  } catch (error) {
    input.cleanupErrors.push(
      wrapCleanupError("取消 backend 后等待 pending operation 失败", error),
    );
  }

  await captureCleanupError(
    input.cleanupErrors,
    "终止未响应取消的 pending operation backend 失败",
    async () => {
      if (!input.observer) throw new Error("缺少 barrier observer 连接");
      await signalPendingBackends(
        input.observer,
        input.pendingBackendPids,
        "terminate",
        input.backendSignalRunner,
      );
    },
  );

  // 终止精确跟踪的测试 backend 后不再以超时返回：cleanup 必须观察到
  // Prisma 事务 settlement，避免失败用例的后台事务污染后续串行测试。
  return input.pendingSettlement;
}

export async function signalPendingBackends(
  observer: Client,
  pendingBackendPids: readonly number[],
  signal: BackendSignal,
  backendSignalRunner: BackendSignalRunner = async ({ send }) => send(),
) {
  const targetPids = [
    ...new Set(
      pendingBackendPids.filter(
        (pid) => Number.isSafeInteger(pid) && pid > 0,
      ),
    ),
  ];
  if (targetPids.length === 0) {
    throw new Error("没有可安全取消的 pending database backend pid");
  }
  if (targetPids.length !== pendingBackendPids.length) {
    throw new Error("pending database backend pid 非法或重复");
  }

  const identity = await observer.query<{
    databaseName: string;
    observerPid: number;
  }>(
    `SELECT current_database() AS "databaseName",
            pg_backend_pid() AS "observerPid"`,
  );
  const databaseName = identity.rows[0]?.databaseName;
  const observerPid = identity.rows[0]?.observerPid;
  if (!databaseName?.endsWith("_test")) {
    throw new Error("拒绝在非 _test 数据库取消 backend");
  }
  if (!observerPid || targetPids.includes(observerPid)) {
    throw new Error("拒绝取消 barrier observer 自身 backend");
  }

  const activities = await observer.query<{
    pid: number;
    databaseName: string | null;
    backendType: string;
  }>(
    `SELECT "pid",
            "datname" AS "databaseName",
            "backend_type" AS "backendType"
       FROM "pg_stat_activity"
      WHERE "pid" = ANY($1::int[])`,
    [targetPids],
  );
  const unsafe = activities.rows.find(
    (activity) =>
      activity.databaseName !== databaseName ||
      activity.backendType !== "client backend",
  );
  if (unsafe) {
    throw new Error(`拒绝取消非当前测试数据库 client backend ${unsafe.pid}`);
  }
  const activeTargetPids = activities.rows.map((activity) => activity.pid);
  if (activeTargetPids.length === 0) return;

  const signalFunction =
    signal === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend";
  await backendSignalRunner({
    observer,
    signal,
    targetPids: activeTargetPids,
    send: async () => {
      const signalled = await observer.query<{
        pid: number;
        signalled: boolean;
      }>(
        `SELECT "activity"."pid",
                ${signalFunction}("activity"."pid") AS "signalled"
           FROM "pg_stat_activity" AS "activity"
          WHERE "activity"."pid" = ANY($1::int[])
            AND "activity"."datname" = current_database()
            AND "activity"."backend_type" = 'client backend'
            AND "activity"."pid" <> pg_backend_pid()`,
        [activeTargetPids],
      );
      const failedPids = signalled.rows
        .filter((row) => !row.signalled)
        .map((row) => row.pid);
      if (failedPids.length > 0) {
        throw new Error(
          `${signalFunction} 未处理 backend ${failedPids.join(",")}`,
        );
      }
    },
  });
}

export function throwBarrierErrors(
  hasPrimaryError: boolean,
  primaryError: unknown,
  cleanupErrors: Error[],
) {
  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "barrier 主操作失败，且清理存在附加错误",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "barrier 清理失败");
  }
}

async function closeDatabaseClient(client: Client, force: boolean) {
  const closeErrors: unknown[] = [];
  if (force) {
    try {
      client.connection.stream.destroy();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  try {
    await withTimeout(
      client.end(),
      DATABASE_OPERATION_TIMEOUT_MS,
      "关闭数据库 client 超时",
    );
  } catch (error) {
    closeErrors.push(error);
    if (!force) {
      try {
        client.connection.stream.destroy();
      } catch (destroyError) {
        closeErrors.push(destroyError);
      }
    }
  }
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw new AggregateError(closeErrors, "关闭数据库 client 失败");
  }
}

async function captureCleanupError(
  errors: Error[],
  message: string,
  operation: () => Promise<unknown>,
) {
  try {
    await operation();
    return false;
  } catch (error) {
    errors.push(wrapCleanupError(message, error));
    return true;
  }
}

function wrapCleanupError(message: string, cause: unknown) {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
