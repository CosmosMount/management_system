// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const MIGRATION = "20260907120000_unify_work_segments";
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const ARCHIVES = ["LegacyWorkSegment", "LegacyWorkSegmentSource", "LegacyWorkSegmentChange"] as const;
const BUSINESS_TABLES = ["Account", "AccountIdentity", "SystemRoleAssignment", "Person", "Task", "TaskPlanVersion", "TaskMember"] as const;
const NOTICE_TABLES = ["NotificationOutbox", "NotificationOutboxRecipient", "InAppNotification"] as const;
const LIVE_FIELDS = [
  "id", "personId", "startAt", "endAt", "content", "taskId", "createdByAccountId",
  "updatedByAccountId", "deletedAt", "createdAt", "updatedAt",
] as const;
const CREATED_AT = "2026-08-01T01:02:03.123456Z";
const START_AT = "2026-08-02T00:00:00.123456Z";
const MIDDLE_AT = "2026-08-02T02:00:00.123456Z";
const END_AT = "2026-08-02T04:00:00.123456Z";
const UPDATED_AT = "2026-08-03T05:06:07.654321Z";
type SnapshotRow = { id: string } & Record<string, unknown>;
type SnapshotTable = typeof ARCHIVES[number] | typeof BUSINESS_TABLES[number] |
  typeof NOTICE_TABLES[number] | "WorkSegment" | "WorkSegmentSource" |
  "WorkSegmentChange" | "DomainAuditEvent" | "_prisma_migrations";

test("投入统一迁移完整归档、原子回滚、退役提醒及受控部署无 schema drift", async () => {
  test.setTimeout(300_000);
  const sourceUrl = localTestDatabaseUrl();
  const suffix = randomUUID().replaceAll("-", "");
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/unified_segments_${suffix}_test`;
  const shadowUrl = new URL(sourceUrl);
  shadowUrl.pathname = `/unified_segments_${suffix}_shadow_test`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  const createdDatabases: string[] = [];
  let target: Client | undefined;
  let temporaryRoot: string | undefined;
  await admin.connect();
  try {
    for (const databaseUrl of [targetUrl, shadowUrl]) {
      const name = databaseUrl.pathname.slice(1);
      if (!/^unified_segments_[a-f0-9]{32}(?:_shadow)?_test$/.test(name)) {
        throw new Error("拒绝创建非本测试专属数据库");
      }
      await admin.query(`CREATE DATABASE "${name}"`);
      createdDatabases.push(name);
    }
    temporaryRoot = await mkdtemp(await temporaryDirectoryPrefix());
    const configPath = await predecessorConfig(temporaryRoot);
    runCommand("npx", ["prisma", "migrate", "deploy", "--config", configPath], targetUrl, shadowUrl);
    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    const fixture = await seedHistory(target);
    const baseline = {
      segments: await rows(target, "WorkSegment"),
      sources: await rows(target, "WorkSegmentSource"),
      changes: await rows(target, "WorkSegmentChange"),
      audits: await rows(target, "DomainAuditEvent"),
      migrations: await rows(target, "_prisma_migrations"),
      business: await snapshots(target, BUSINESS_TABLES),
      notices: await snapshots(target, NOTICE_TABLES),
    };
    expect(baseline.segments).toHaveLength(18);
    expect(baseline.sources).toHaveLength(3);
    expect(baseline.changes).toHaveLength(18);
    expect(new Set(baseline.changes.map((change) => change.action))).toEqual(
      new Set(["CREATE", "UPDATE", "SPLIT", "MERGE", "CONFIRM", "CANCEL", "DELETE"]),
    );
    const expectedVisible = baseline.segments
      .filter((segment) => fixture.visibleIds.includes(segment.id))
      .map((segment) => Object.fromEntries(LIVE_FIELDS.map((field) => [field, segment[field]])));
    expect(expectedVisible).toHaveLength(8);
    const migrationSql = await readFile(path.join(MIGRATIONS_DIR, MIGRATION, "migration.sql"), "utf8");
    expect(migrationSql).toMatch(/^\s*BEGIN;/);
    expect(migrationSql).toMatch(/COMMIT;\s*$/);
    const migrationBody = migrationSql.replace(/^\s*BEGIN;/, "").replace(/COMMIT;\s*$/, "");
    await target.query("BEGIN");
    try {
      await target.query(migrationBody);
      expect(await rows(target, "LegacyWorkSegment")).toEqual(baseline.segments);
      await expect(target.query(`DO $$ BEGIN RAISE EXCEPTION 'unified migration rollback probe'; END $$;`))
        .rejects.toThrow("unified migration rollback probe");
    } finally {
      await target.query("ROLLBACK");
    }
    expect(await rows(target, "WorkSegment")).toEqual(baseline.segments);
    expect(await rows(target, "WorkSegmentSource")).toEqual(baseline.sources);
    expect(await rows(target, "WorkSegmentChange")).toEqual(baseline.changes);
    expect(await rows(target, "DomainAuditEvent")).toEqual(baseline.audits);
    expect(await rows(target, "_prisma_migrations")).toEqual(baseline.migrations);
    expect(await snapshots(target, NOTICE_TABLES)).toEqual(baseline.notices);
    expect(await snapshots(target, BUSINESS_TABLES)).toEqual(baseline.business);
    const rolledBackCatalog = await target.query(`SELECT
      to_regclass('"LegacyWorkSegment"') AS archive,
      to_regclass('"LegacyWorkSegmentSource"') AS source,
      to_regclass('"LegacyWorkSegmentChange"') AS change,
      to_regtype('"LegacyWorkSegmentType"') AS type,
      to_regtype('"LegacyWorkSegmentStatus"') AS status,
      to_regtype('"LegacyWorkSegmentChangeAction"') AS action,
      to_regprocedure('prevent_legacy_work_segment_mutation()') AS guard`);
    expect(rolledBackCatalog.rows).toEqual([{
      archive: null, source: null, change: null, type: null, status: null, action: null, guard: null,
    }]);

    runCommand("npm", ["run", "db:deploy"], targetUrl, shadowUrl);
    expect(await rows(target, "LegacyWorkSegment")).toEqual(baseline.segments);
    expect(await rows(target, "LegacyWorkSegmentSource")).toEqual(baseline.sources);
    expect(await rows(target, "LegacyWorkSegmentChange")).toEqual(baseline.changes);
    expect(await rows(target, "WorkSegment")).toEqual(expectedVisible);
    expect(await rows(target, "WorkSegmentChange")).toEqual([]);
    expect(await snapshots(target, BUSINESS_TABLES)).toEqual(baseline.business);
    const archiveForeignKeys = await target.query<{ source: string; target: string }>(`SELECT
      source.relname AS source, referenced.relname AS target
      FROM pg_constraint constraint_record
      JOIN pg_class source ON source.oid = constraint_record.conrelid
      JOIN pg_class referenced ON referenced.oid = constraint_record.confrelid
      WHERE constraint_record.contype = 'f' AND source.oid IN (
        '"LegacyWorkSegment"'::regclass, '"LegacyWorkSegmentSource"'::regclass,
        '"LegacyWorkSegmentChange"'::regclass)
      ORDER BY source.relname, constraint_record.conname`);
    expect(archiveForeignKeys.rows).toEqual([
      { source: "LegacyWorkSegment", target: "LegacyWorkSegment" },
      { source: "LegacyWorkSegmentChange", target: "LegacyWorkSegment" },
      { source: "LegacyWorkSegmentSource", target: "LegacyWorkSegment" },
      { source: "LegacyWorkSegmentSource", target: "LegacyWorkSegment" },
    ]);
    const audits = await rows(target, "DomainAuditEvent");
    expect(audits.filter((audit) => audit.id !== "migration:unify-work-segments:v1")).toEqual(baseline.audits);
    expect(audits.find((audit) => audit.id === "migration:unify-work-segments:v1")).toMatchObject({
      action: "pm.segment.migrated", source: "MIGRATION", actorAccountId: null, actorPersonId: null,
      before: { segments: baseline.segments.length, sources: baseline.sources.length, changes: baseline.changes.length },
      after: { segments: expectedVisible.length, legacyArchived: true },
    });
    await assertRetiredNotices(target, baseline.notices, fixture);
    const appliedMigration = await target.query(`SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations" WHERE migration_name = $1`, [MIGRATION]);
    expect(appliedMigration.rows).toEqual([{
      migration_name: MIGRATION, finished_at: expect.any(Date), rolled_back_at: null,
    }]);
    const deployedState = await snapshots(target, [
      ...ARCHIVES, ...NOTICE_TABLES, "WorkSegment", "WorkSegmentChange", "DomainAuditEvent", "_prisma_migrations",
    ]);
    runCommand("npm", ["run", "db:deploy"], targetUrl, shadowUrl);
    expect(await snapshots(target, [
      ...ARCHIVES, ...NOTICE_TABLES, "WorkSegment", "WorkSegmentChange", "DomainAuditEvent", "_prisma_migrations",
    ])).toEqual(deployedState);

    for (const table of ARCHIVES) {
      for (const statement of [
        `INSERT INTO "${table}" SELECT * FROM "${table}" LIMIT 1`,
        `UPDATE "${table}" SET id = id`,
        `DELETE FROM "${table}"`,
        `TRUNCATE TABLE "${table}" CASCADE`,
      ]) {
        await expectSqlFailure(target, statement, [], "P0001", /archives are read-only/);
      }
    }
    expect(await snapshots(target, ARCHIVES)).toEqual({
      LegacyWorkSegment: baseline.segments,
      LegacyWorkSegmentSource: baseline.sources,
      LegacyWorkSegmentChange: baseline.changes,
    });
    await assertLiveConstraints(target, fixture);
    expect(await rows(target, "WorkSegment")).toEqual(expectedVisible);
    expect(await snapshots(target, BUSINESS_TABLES)).toEqual(baseline.business);
    expect(await snapshots(target, NOTICE_TABLES)).toEqual({
      NotificationOutbox: deployedState.NotificationOutbox,
      NotificationOutboxRecipient: deployedState.NotificationOutboxRecipient,
      InAppNotification: deployedState.InAppNotification,
    });
    for (const from of [
      ["--from-config-datasource"],
      ["--from-migrations", "prisma/migrations"],
    ]) {
      runCommand("npx", ["prisma", "migrate", "diff", ...from,
        "--to-schema", "prisma/schema.prisma", "--exit-code"], targetUrl, shadowUrl);
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    if (target) {
      await target.query("ROLLBACK").catch((error: unknown) => cleanupErrors.push(error));
      await target.end().catch((error: unknown) => cleanupErrors.push(error));
    }
    for (const name of createdDatabases.reverse()) {
      try {
        await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
        await admin.query(`DROP DATABASE "${name}"`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
      .catch((error: unknown) => cleanupErrors.push(error));
    await admin.end().catch((error: unknown) => cleanupErrors.push(error));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "投入迁移测试隔离资源清理失败");
  }
});

function localTestDatabaseUrl() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^[A-Za-z0-9_]+_test$/.test(url.pathname.slice(1)) ||
      /prod(?:uction)?/i.test(url.pathname)) {
    throw new Error("拒绝在非本机 _test 数据库环境执行投入迁移回归");
  }
  url.search = "";
  return url;
}

async function temporaryDirectoryPrefix() {
  const parent = path.join(process.cwd(), ".tmp");
  await mkdir(parent, { recursive: true });
  return path.join(parent, "unified-segments-migration-");
}

async function predecessorConfig(temporaryRoot: string) {
  const directory = path.join(temporaryRoot, "migrations");
  await mkdir(directory);
  await cp(path.join(MIGRATIONS_DIR, "migration_lock.toml"), path.join(directory, "migration_lock.toml"));
  const predecessors = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name < MIGRATION).map((entry) => entry.name).sort();
  expect(predecessors.length).toBeGreaterThan(0);
  for (const predecessor of predecessors) {
    await cp(path.join(MIGRATIONS_DIR, predecessor), path.join(directory, predecessor), { recursive: true });
  }
  const configPath = path.join(temporaryRoot, "prisma.config.ts");
  await writeFile(configPath, `import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: ${JSON.stringify(path.join(process.cwd(), "prisma/schema.prisma"))},
  migrations: { path: ${JSON.stringify(directory)} },
  datasource: { url: process.env.DATABASE_URL, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL },
});\n`);
  return configPath;
}

function runCommand(command: string, args: string[], targetUrl: URL, shadowUrl: URL) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(), encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: targetUrl.toString(), SHADOW_DATABASE_URL: shadowUrl.toString(),
      DB_WAIT_MS: "10000", NOTIFICATION_DELIVERY_DISABLED: "true" },
  });
  expect(result.error, `${command} ${args.join(" ")}: ${String(result.error)}`).toBeUndefined();
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
}

async function rows(client: Client, table: SnapshotTable): Promise<SnapshotRow[]> {
  const result = await client.query<{ row: SnapshotRow }>(
    `SELECT to_jsonb(record) AS row FROM "${table}" record ORDER BY record.id`,
  );
  return result.rows.map((record) => record.row);
}

async function snapshots(client: Client, tables: readonly SnapshotTable[]) {
  const result: Partial<Record<SnapshotTable, SnapshotRow[]>> = {};
  for (const table of tables) result[table] = await rows(client, table);
  return result;
}

async function expectSqlFailure(client: Client, sql: string, parameters: unknown[], code: string, message?: RegExp) {
  await client.query("BEGIN");
  try {
    const failure = client.query(sql, parameters);
    await expect(failure).rejects.toMatchObject({ code });
    if (message) await expect(failure).rejects.toThrow(message);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function seedHistory(client: Client) {
  const fixture = {
    accountId: randomUUID(), personId: randomUUID(), taskId: randomUUID(), planId: randomUUID(),
    visibleIds: [] as string[], canceledOutboxIds: [] as string[], canceledRecipientIds: [] as string[],
    readInAppIds: [] as string[],
  };
  await client.query("BEGIN");
  try {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`INSERT INTO "Account" (id, "createdAt", "updatedAt") VALUES ($1, $2, $3)`,
      [fixture.accountId, CREATED_AT, UPDATED_AT]);
    await client.query(`INSERT INTO "Person" (id, "accountId", "displayName", "createdAt", "updatedAt")
      VALUES ($1, $2, '投入归档测试人员', $3, $4)`, [fixture.personId, fixture.accountId, CREATED_AT, UPDATED_AT]);
    await client.query(`INSERT INTO "AccountIdentity" (id, "accountId", provider, "providerSubject", "tenantId", "openId", "createdAt", "updatedAt")
      VALUES ($1, $2, 'FEISHU', $3, 'default', $3, $4, $5)`,
    [randomUUID(), fixture.accountId, `test-only-${fixture.accountId}`, CREATED_AT, UPDATED_AT]);
    await client.query(`INSERT INTO "SystemRoleAssignment" (id, "accountId", role, team, "techGroup", "revokedAt", "createdAt")
      VALUES ($1, $2, 'SUPER_ADMINISTRATOR', '', '', NULL, $3)`,
    [randomUUID(), fixture.accountId, CREATED_AT]);
    await client.query(`INSERT INTO "Task" (id, title, "currentPlanVersionId", "createdByAccountId", "createdAt", "updatedAt")
      VALUES ($1, '不应受投入迁移影响的任务', $2, $3, $4, $5)`,
    [fixture.taskId, fixture.planId, fixture.accountId, CREATED_AT, UPDATED_AT]);
    await client.query(`INSERT INTO "TaskPlanVersion" (id, "taskId", "versionNo", status, "createdByAccountId", "createdAt", "updatedAt")
      VALUES ($1, $2, 1, 'CURRENT', $3, $4, $5)`,
    [fixture.planId, fixture.taskId, fixture.accountId, CREATED_AT, UPDATED_AT]);
    await client.query(`INSERT INTO "TaskMember" (id, "taskId", "personId", role, "createdByAccountId")
      VALUES ($1, $2, $3, 'OWNER', $4)`, [randomUUID(), fixture.taskId, fixture.personId, fixture.accountId]);
    const segmentIds = new Map<string, string>();
    for (const type of ["PLANNED", "ACTUAL"]) {
      const statuses = type === "PLANNED"
        ? ["PLANNED", "IN_PROGRESS", "PENDING_CONFIRMATION", "CONFIRMED", "CANCELLED"]
        : ["CONFIRMED", "CANCELLED"];
      for (const status of statuses) {
        for (const deleted of [false, true]) {
          const key = `${type}:${status}:${deleted}`;
          const segmentId = await insertOldSegment(client, fixture, { type, status, deleted, content: key });
          segmentIds.set(key, segmentId);
          if (!deleted && (type === "ACTUAL" || !["CONFIRMED", "CANCELLED"].includes(status))) {
            fixture.visibleIds.push(segmentId);
          }
        }
      }
    }
    const fullPlan = segmentIds.get("PLANNED:CONFIRMED:false")!;
    const fullActual = segmentIds.get("ACTUAL:CONFIRMED:false")!;
    const partialPlan = await insertOldSegment(client, fixture, { type: "PLANNED", status: "CONFIRMED", content: "部分确认原计划" });
    const partialActual = await insertOldSegment(client, fixture, { type: "ACTUAL", status: "CONFIRMED", content: "部分实际", endAt: MIDDLE_AT });
    const remainder = await insertOldSegment(client, fixture, {
      type: "PLANNED", status: "PLANNED", content: "拆分后剩余时间", startAt: MIDDLE_AT, sourceSplitFromId: partialPlan,
    });
    const duplicate = await insertOldSegment(client, fixture, { type: "ACTUAL", status: "CONFIRMED", content: "ACTUAL:CONFIRMED:false" });
    fixture.visibleIds.push(partialActual, remainder, duplicate);
    for (const [planned, actual, endAt] of [
      [fullPlan, fullActual, END_AT], [partialPlan, partialActual, MIDDLE_AT],
      [segmentIds.get("PLANNED:CONFIRMED:true")!, segmentIds.get("ACTUAL:CONFIRMED:true")!, END_AT],
    ]) {
      await client.query(`INSERT INTO "WorkSegmentSource" (id, "plannedSegmentId", "actualSegmentId", "coveredStartAt", "coveredEndAt", "createdByAccountId", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), planned, actual, START_AT, endAt, fixture.accountId, CREATED_AT]);
    }
    const oldSegments = await rows(client, "WorkSegment");
    const actions = ["CREATE", "UPDATE", "SPLIT", "MERGE", "CONFIRM", "CANCEL", "DELETE"];
    for (const [index, segment] of oldSegments.entries()) {
      await client.query(`INSERT INTO "WorkSegmentChange" (id, "segmentId", action, before, after, reason, "actorAccountId", "createdAt")
        VALUES ($1, $2, $3, $4, $5, '原变更记录不可丢失', $6, $7)`,
      [randomUUID(), segment.id, actions[index % actions.length], index === 0 ? null : JSON.stringify(segment), JSON.stringify(segment), fixture.accountId, CREATED_AT]);
      await client.query(`INSERT INTO "DomainAuditEvent" (id, action, "entityType", "entityId", "actorAccountId", "actorPersonId", "taskId", before, after, reason, "createdAt")
        VALUES ($1, 'pm.segment.confirm', 'WorkSegment', $2, $3, $4, $5, $6, $6, '保留历史审计', $7)`,
      [randomUUID(), segment.id, fixture.accountId, fixture.personId, fixture.taskId, JSON.stringify(segment), CREATED_AT]);
    }
    await seedNotices(client, fixture);
    await client.query("COMMIT");
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof seedHistory>>;

async function insertOldSegment(client: Client, fixture: Pick<Fixture, "accountId" | "personId" | "taskId">, input: {
  type: string; status: string; content: string; deleted?: boolean; startAt?: string; endAt?: string; sourceSplitFromId?: string;
}) {
  const id = randomUUID();
  await client.query(`INSERT INTO "WorkSegment" (id, "personId", type, status, "startAt", "endAt", content, priority,
    "expectedOutput", "actualOutput", "taskId", "createdByAccountId", "updatedByAccountId", "sourceSplitFromId", "deletedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'HIGH', '预期输出完整保留', '实际输出完整保留', $8, $9, $10, $11, $12, $13, $14)`,
  [id, fixture.personId, input.type, input.status, input.startAt ?? START_AT, input.endAt ?? END_AT, input.content,
    input.status === "CANCELLED" ? null : fixture.taskId, fixture.accountId,
    input.deleted ? null : fixture.accountId, input.sourceSplitFromId ?? null, input.deleted ? UPDATED_AT : null, CREATED_AT, UPDATED_AT]);
  return id;
}

async function seedNotices(client: Client, fixture: Fixture) {
  const statuses = ["PENDING", "PROCESSING", "FAILED", "SENT", "CANCELED"];
  for (const channel of ["project-management", "unrelated-channel"]) {
    for (const type of ["segment_confirmation_due", "task_updated"]) {
      for (const status of statuses) {
        const outboxId = randomUUID();
        const retired = channel === "project-management" && type === "segment_confirmation_due";
        if (retired && ["PENDING", "PROCESSING", "FAILED"].includes(status)) fixture.canceledOutboxIds.push(outboxId);
        await client.query(`INSERT INTO "NotificationOutbox" (id, "eventKey", channel, type, payload, status, attempts,
          "lastError", "lockedUntil", "sentAt", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 2, '历史错误', $7, $8, $9, $10)`,
        [outboxId, `migration-test:${outboxId}`, channel, type, JSON.stringify({ kind: type, preserved: true }), status,
          status === "PROCESSING" ? END_AT : null, status === "SENT" ? UPDATED_AT : null, CREATED_AT, UPDATED_AT]);
        for (const recipientStatus of statuses) {
          const recipientId = randomUUID();
          if (retired && ["PENDING", "PROCESSING", "FAILED"].includes(recipientStatus)) fixture.canceledRecipientIds.push(recipientId);
          await client.query(`INSERT INTO "NotificationOutboxRecipient" (id, "outboxId", "openId", status, attempts,
            "lastError", "lockedUntil", "sentAt", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 2, '历史接收人错误', $5, $6, $7, $8)`,
          [recipientId, outboxId, `test-only-${recipientId}`, recipientStatus, recipientStatus === "PROCESSING" ? END_AT : null,
            recipientStatus === "SENT" ? UPDATED_AT : null, CREATED_AT, UPDATED_AT]);
        }
      }
    }
  }
  for (const scenario of ["payload", "event-key", "already-read", "unrelated", "wrong-category", "near-match"]) {
    const id = randomUUID();
    if (["payload", "event-key"].includes(scenario)) fixture.readInAppIds.push(id);
    const eventKey = scenario === "event-key" ? `pm:segment:confirmation_due:${id}`
      : scenario === "near-match" ? `pm:segment:confirmationXdue:${id}` : `migration-test:${id}`;
    const kind = ["payload", "already-read", "wrong-category"].includes(scenario) ? "segment_confirmation_due" : "task_updated";
    await client.query(`INSERT INTO "InAppNotification" (id, "eventKey", "recipientAccountId", category, title,
      summary, "entityType", "entityId", payload, "readAt", "createdAt")
      VALUES ($1, $2, $3, $4, '历史通知', '不得改写通知正文', 'WorkSegment', $5, $6, $7, $8)`,
    [id, eventKey, fixture.accountId, scenario === "wrong-category" ? "TASK" : "WORK_SEGMENT",
      fixture.visibleIds[0], JSON.stringify({ kind }), scenario === "already-read" ? UPDATED_AT : null, CREATED_AT]);
  }
}

async function assertRetiredNotices(client: Client, baseline: Awaited<ReturnType<typeof snapshots>>, fixture: Fixture) {
  for (const [table, changedIds] of [
    ["NotificationOutbox", fixture.canceledOutboxIds], ["NotificationOutboxRecipient", fixture.canceledRecipientIds],
  ] as const) {
    const expected = (baseline[table] ?? []).map((row) => changedIds.includes(row.id)
      ? { ...row, status: "CANCELED", lockedUntil: null, lastError: "投入确认功能已退役，不再投递", updatedAt: expect.any(String) }
      : row);
    const actual = await rows(client, table);
    expect(actual).toEqual(expected);
    for (const row of actual.filter((item) => changedIds.includes(item.id))) {
      expect(row.updatedAt).not.toEqual(baseline[table]?.find((item) => item.id === row.id)?.updatedAt);
    }
  }
  expect(await rows(client, "InAppNotification")).toEqual((baseline.InAppNotification ?? []).map((row) =>
    fixture.readInAppIds.includes(row.id) ? { ...row, readAt: expect.any(String) } : row));
}

async function assertLiveConstraints(client: Client, fixture: Fixture) {
  const liveId = randomUUID();
  const insert = `INSERT INTO "WorkSegment" (id, "personId", "startAt", "endAt", content, "taskId", "createdByAccountId", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
  const parameters = [liveId, fixture.personId, START_AT, END_AT, "无需计划实际分类的新投入", fixture.taskId, fixture.accountId, UPDATED_AT];
  await client.query("BEGIN");
  try {
    await client.query(insert, parameters);
    await client.query(`UPDATE "WorkSegment" SET content = '直接编辑内容', "startAt" = $2, "endAt" = $3,
      "taskId" = NULL, "updatedByAccountId" = $4 WHERE id = $1`,
    [liveId, "2030-01-01T00:00:00Z", "2030-01-01T01:00:00Z", fixture.accountId]);
    expect((await client.query(`SELECT content, "taskId" FROM "WorkSegment" WHERE id = $1`, [liveId])).rows)
      .toEqual([{ content: "直接编辑内容", taskId: null }]);
    for (const action of ["CREATE", "UPDATE", "DELETE"]) {
      await client.query(`INSERT INTO "WorkSegmentChange" (id, "segmentId", action, "actorAccountId") VALUES ($1, $2, $3, $4)`,
        [randomUUID(), liveId, action, fixture.accountId]);
    }
    await client.query(`UPDATE "WorkSegment" SET "deletedAt" = $2 WHERE id = $1`, [liveId, UPDATED_AT]);
    expect((await client.query(`SELECT "deletedAt" IS NOT NULL AS deleted FROM "WorkSegment" WHERE id = $1`, [liveId])).rows)
      .toEqual([{ deleted: true }]);
    expect((await client.query(`SELECT count(*)::int AS count FROM "WorkSegmentChange" WHERE "segmentId" = $1`, [liveId])).rows)
      .toEqual([{ count: 3 }]);
    await client.query("SAVEPOINT restrict_delete");
    await expect(client.query(`DELETE FROM "WorkSegment" WHERE id = $1`, [liveId])).rejects.toMatchObject({ code: "23503" });
    await client.query("ROLLBACK TO SAVEPOINT restrict_delete");
  } finally {
    await client.query("ROLLBACK");
  }
  for (const [position, value, code] of [
    [3, START_AT, "23514"], [3, CREATED_AT, "23514"], [4, "   ", "23514"],
    [1, randomUUID(), "23503"], [5, randomUUID(), "23503"], [6, randomUUID(), "23503"],
  ] as const) {
    const invalid = [...parameters];
    invalid[position] = value;
    await expectSqlFailure(client, insert, invalid, code);
  }
  await expectSqlFailure(client,
    `INSERT INTO "WorkSegmentChange" (id, "segmentId", action) VALUES ($1, $2, 'CREATE')`,
    [randomUUID(), randomUUID()], "23503");
  await expectSqlFailure(client,
    `INSERT INTO "WorkSegmentChange" (id, "segmentId", action) VALUES ($1, $2, 'CONFIRM')`,
    [randomUUID(), fixture.visibleIds[0]], "22P02");
}
