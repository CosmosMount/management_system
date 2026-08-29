// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const APPROVAL_ADMINISTRATOR_PREFLIGHT_MIGRATION =
  "20260803115900_active_global_approval_administrator_preflight";
const DURABLE_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803115950_durable_global_approval_administrator_guard";
const REFINED_APPROVAL_ADMINISTRATOR_ROLE_GUARD_MIGRATION =
  "20260803115975_refine_global_approval_administrator_role_guard";
const SERIALIZED_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803115980_serialize_global_approval_administrator_guard";
const ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803115990_atomic_global_approval_administrator_guard";
const REFINED_ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803115992_refine_atomic_global_approval_administrator_guard";
const FINALIZE_ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803115995_finalize_atomic_global_approval_administrator_guard";
const TASK_ACCESS_MIGRATION =
  "20260803120000_task_global_visibility_participants_admin_approval";
const APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803123000_active_global_approval_administrator_guard";
const REMOVE_REFINED_APPROVAL_ADMINISTRATOR_ROLE_GUARD_MIGRATION =
  "20260803123050_remove_refined_global_approval_administrator_role_guard";
const REMOVE_DURABLE_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803123100_remove_durable_global_approval_administrator_guard";
const REMOVE_SERIALIZED_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION =
  "20260803123075_remove_serialized_global_approval_administrator_guard";
const CLEANUP_ALL_LEGACY_APPROVAL_ADMINISTRATOR_GUARDS_MIGRATION =
  "20260803123105_cleanup_all_legacy_global_approval_administrator_guards";
const REMOVE_RESIDUAL_APPROVAL_ADMINISTRATOR_GUARD_FUNCTION_MIGRATION =
  "20260803123110_remove_residual_global_approval_administrator_guard_function";

test("Task access migration normalizes historical roles, backfills Segment members and retires scoped project roles", async () => {
  test.setTimeout(180_000);
  const sourceUrl = safeLocalTestDatabaseUrl();
  const sourceDatabaseName = sourceUrl.pathname.replace(/^\//, "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `${sourceDatabaseName.slice(0, 18)}_${suffix}_task_access_test`;
  if (!/^[A-Za-z0-9_]+_task_access_test$/.test(databaseName)) {
    throw new Error("Task access 临时数据库名称安全校验失败");
  }

  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let target: Client | null = null;
  let racer: Client | null = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();

    const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name < APPROVAL_ADMINISTRATOR_PREFLIGHT_MIGRATION,
      )
      .map((entry) => entry.name)
      .sort();
    for (const migrationName of migrationNames) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, migrationName, "migration.sql"),
        "utf8",
      );
      if (migrationName === "20260731121000_unified_account_backfill") {
        await executeMigrationSqlInTransaction(target, sql);
      } else {
        await executeMigrationSql(target, sql);
      }
    }

    const ids = fixtureIds();
    await seedLegacyTaskAccessData(target, ids);
    const migrationSql = await readFile(
      path.join(MIGRATIONS_DIR, TASK_ACCESS_MIGRATION, "migration.sql"),
      "utf8",
    );
    const approvalAdministratorPreflightSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        APPROVAL_ADMINISTRATOR_PREFLIGHT_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    const durableApprovalAdministratorGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        DURABLE_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    const atomicApprovalAdministratorGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    const finalizeAtomicApprovalAdministratorGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        FINALIZE_ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );

    await executeMigrationSqlInTransaction(
      target,
      approvalAdministratorPreflightSql,
    );

    // A writer that started before the atomic migration must finish before the
    // migration rechecks the invariant. The invalid commit is observed and the
    // irreversible Task migration remains untouched.
    racer = new Client({ connectionString: targetUrl.toString() });
    await racer.connect();
    const targetBackend = await target.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    await racer.query("BEGIN");
    await racer.query(
      `UPDATE "Account" SET "projectAccessStatus" = 'DISABLED' WHERE id = $1`,
      [ids.account],
    );
    const atomicGuardExpectation = expect(
      executeSelfTransactionalMigrationSql(
        target,
        finalizeAtomicApprovalAdministratorGuardSql,
      ),
    ).rejects.toThrow(
      /atomic global approval administrator finalization blocked/,
    );
    await waitForBackendLockWait(racer, targetBackend.rows[0]!.pid);
    await racer.query("COMMIT");
    await atomicGuardExpectation;
    await racer.query(
      `UPDATE "Account" SET "projectAccessStatus" = 'ACTIVE' WHERE id = $1`,
      [ids.account],
    );
    await expect(
      executeMigrationSqlInTransaction(target, migrationSql),
    ).rejects.toThrow(/have no active OWNER/);
    const legacyRoleValues = await target.query<{ value: string }>(
      `SELECT enumlabel AS value
       FROM pg_enum
       WHERE enumtypid = '"TaskMemberRole"'::regtype
       ORDER BY enumsortorder`,
    );
    expect(legacyRoleValues.rows.map((row) => row.value)).not.toContain(
      "PARTICIPANT",
    );

    await target.query(
      `INSERT INTO "TaskMember" (id, "taskId", "personId", role)
       VALUES ($1, $2, $3, 'OWNER')`,
      ["member-00-zero-owner-repair", ids.zeroOwnerTask, ids.ownerPersonA],
    );

    await target.query(
      `UPDATE "Account" SET "projectAccessStatus" = 'DISABLED' WHERE id = $1`,
      [ids.account],
    );
    await expect(
      executeMigrationSqlInTransaction(
        target,
        approvalAdministratorPreflightSql,
      ),
    ).rejects.toThrow(/no ACTIVE global administrator/);
    const schemaAfterPreflightFailure = await target.query<{
      policyColumns: string;
      approvalEnum: string | null;
      participantEnumValues: string;
      duplicateLeadRemovedAt: Date | null;
    }>(
      `SELECT
         (SELECT string_agg(column_name, ',' ORDER BY column_name)
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Task'
            AND column_name IN ('revisionApprovalMode', 'allowSelfReview')) AS "policyColumns",
         to_regtype('"RevisionApprovalMode"')::text AS "approvalEnum",
         (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
          FROM pg_enum
          WHERE enumtypid = '"TaskMemberRole"'::regtype) AS "participantEnumValues",
         (SELECT "removedAt" FROM "TaskMember" WHERE id = $1) AS "duplicateLeadRemovedAt"`,
      [ids.duplicateLeadMember],
    );
    expect(schemaAfterPreflightFailure.rows[0]).toEqual({
      policyColumns: "allowSelfReview,revisionApprovalMode",
      approvalEnum: '"RevisionApprovalMode"',
      participantEnumValues: "OWNER,LEAD,MEMBER,REVIEWER,VIEWER",
      duplicateLeadRemovedAt: null,
    });
    await target.query(
      `UPDATE "Account" SET "projectAccessStatus" = 'ACTIVE' WHERE id = $1`,
      [ids.account],
    );
    await target.query(
      `UPDATE "AccountIdentity" SET "openId" = '   ' WHERE "accountId" = $1`,
      [ids.account],
    );
    await expect(
      executeMigrationSqlInTransaction(
        target,
        approvalAdministratorPreflightSql,
      ),
    ).rejects.toThrow(/no default-tenant Feishu openId/);
    const legacyPolicyColumnCount = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'Task'
         AND column_name IN ('revisionApprovalMode', 'allowSelfReview')`,
    );
    expect(legacyPolicyColumnCount.rows[0]?.count).toBe("2");
    await target.query(
      `UPDATE "AccountIdentity" SET "openId" = $2 WHERE "accountId" = $1`,
      [ids.account, `ou_task_access_${ids.account}`],
    );
    await executeMigrationSqlInTransaction(
      target,
      approvalAdministratorPreflightSql,
    );

    // Reproduce an interrupted deploy: the read-only preflight was committed,
    // then the last usable administrator changed before the next migration.
    await target.query(
      `UPDATE "Account" SET "projectAccessStatus" = 'DISABLED' WHERE id = $1`,
      [ids.account],
    );
    await expect(
      executeMigrationSqlInTransaction(
        target,
        durableApprovalAdministratorGuardSql,
      ),
    ).rejects.toThrow(/no ACTIVE global administrator with a default-tenant Feishu openId/);
    const schemaAfterInterruptedDeploy = await target.query<{
      policyColumns: string;
      approvalEnum: string | null;
      taskMemberRoles: string;
    }>(
      `SELECT
         (SELECT string_agg(column_name, ',' ORDER BY column_name)
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Task'
            AND column_name IN ('revisionApprovalMode', 'allowSelfReview')) AS "policyColumns",
         to_regtype('"RevisionApprovalMode"')::text AS "approvalEnum",
         (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
          FROM pg_enum
          WHERE enumtypid = '"TaskMemberRole"'::regtype) AS "taskMemberRoles"`,
    );
    expect(schemaAfterInterruptedDeploy.rows[0]).toEqual({
      policyColumns: "allowSelfReview,revisionApprovalMode",
      approvalEnum: '"RevisionApprovalMode"',
      taskMemberRoles: "OWNER,LEAD,MEMBER,REVIEWER,VIEWER",
    });
    await target.query(
      `UPDATE "Account" SET "projectAccessStatus" = 'ACTIVE' WHERE id = $1`,
      [ids.account],
    );
    await executeMigrationSqlInTransaction(
      target,
      durableApprovalAdministratorGuardSql,
    );
    const refinedApprovalAdministratorRoleGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        REFINED_APPROVAL_ADMINISTRATOR_ROLE_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await executeMigrationSqlInTransaction(
      target,
      refinedApprovalAdministratorRoleGuardSql,
    );
    const serializedApprovalAdministratorGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        SERIALIZED_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await executeMigrationSqlInTransaction(
      target,
      serializedApprovalAdministratorGuardSql,
    );
    await executeMigrationSqlInTransaction(
      target,
      atomicApprovalAdministratorGuardSql,
    );
    await executeMigrationSqlInTransaction(
      target,
      await readFile(
        path.join(
          MIGRATIONS_DIR,
          REFINED_ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
          "migration.sql",
        ),
        "utf8",
      ),
    );
    await executeSelfTransactionalMigrationSql(
      target,
      finalizeAtomicApprovalAdministratorGuardSql,
    );

    // Once installed, the deferred constraint closes the remaining deployment
    // window for each table that can make the sole administrator unusable.
    await expect(
      target.query(
        `UPDATE "Account"
         SET "projectAccessStatus" = 'DISABLED'
         WHERE id = $1`,
        [ids.account],
      ),
    ).rejects.toThrow(/usable global approval administrator invariant violated/);
    await expect(
      target.query(
        `UPDATE "SystemRoleAssignment"
         SET "revokedAt" = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [ids.projectAdministratorRole],
      ),
    ).rejects.toThrow(/usable global approval administrator invariant violated/);
    await expect(
      target.query(
        `UPDATE "AccountIdentity" SET "openId" = '   ' WHERE "accountId" = $1`,
        [ids.account],
      ),
    ).rejects.toThrow(/usable global approval administrator invariant violated/);

    const guardedAdministrator = await target.query<{
      projectAccessStatus: string;
      revokedAt: Date | null;
      openId: string | null;
    }>(
      `SELECT
         account."projectAccessStatus"::text AS "projectAccessStatus",
         assignment."revokedAt" AS "revokedAt",
         identity."openId" AS "openId"
       FROM "Account" account
       JOIN "SystemRoleAssignment" assignment
         ON assignment."accountId" = account.id AND assignment.id = $2
       JOIN "AccountIdentity" identity
         ON identity."accountId" = account.id
        AND identity.provider = 'FEISHU'
        AND identity."tenantId" = 'default'
       WHERE account.id = $1`,
      [ids.account, ids.projectAdministratorRole],
    );
    expect(guardedAdministrator.rows).toEqual([
      {
        projectAccessStatus: "ACTIVE",
        revokedAt: null,
        openId: `ou_task_access_${ids.account}`,
      },
    ]);

    const concurrentAdministrator = {
      accountId: randomUUID(),
      assignmentId: randomUUID(),
      identityId: randomUUID(),
      openId: `ou_task_access_concurrent_${randomUUID()}`,
    };
    await target.query(
      `INSERT INTO "Account" (id, "updatedAt")
       VALUES ($1, CURRENT_TIMESTAMP)`,
      [concurrentAdministrator.accountId],
    );
    await target.query(
      `INSERT INTO "AccountIdentity"
         (id, "accountId", provider, "providerSubject", "tenantId", "openId", "updatedAt")
       VALUES ($1, $2, 'FEISHU', $3, 'default', $4, CURRENT_TIMESTAMP)`,
      [
        concurrentAdministrator.identityId,
        concurrentAdministrator.accountId,
        `open:${concurrentAdministrator.openId}`,
        concurrentAdministrator.openId,
      ],
    );
    await target.query(
      `INSERT INTO "SystemRoleAssignment"
         (id, "accountId", role, team, "techGroup")
       VALUES ($1, $2, 'PROJECT_ADMINISTRATOR', '', '')`,
      [
        concurrentAdministrator.assignmentId,
        concurrentAdministrator.accountId,
      ],
    );

    const concurrentClient = new Client({
      connectionString: targetUrl.toString(),
    });
    await concurrentClient.connect();
    try {
      await target.query("BEGIN");
      await concurrentClient.query("BEGIN");
      await target.query(
        `UPDATE "Account" SET "projectAccessStatus" = 'DISABLED' WHERE id = $1`,
        [ids.account],
      );
      await concurrentClient.query(
        `UPDATE "Account" SET "projectAccessStatus" = 'DISABLED' WHERE id = $1`,
        [concurrentAdministrator.accountId],
      );
      const concurrentCommits = await Promise.allSettled([
        target.query("COMMIT"),
        concurrentClient.query("COMMIT"),
      ]);
      expect(
        concurrentCommits.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejectedCommit = concurrentCommits.find(
        (result) => result.status === "rejected",
      );
      expect(rejectedCommit).toEqual(
        expect.objectContaining({
          reason: expect.objectContaining({
            message: expect.stringMatching(
              /usable global approval administrator invariant violated/,
            ),
          }),
        }),
      );
      await target.query("ROLLBACK").catch(() => undefined);
      await concurrentClient.query("ROLLBACK").catch(() => undefined);
    } finally {
      await concurrentClient.end();
    }

    const concurrentStatuses = await target.query<{ status: string }>(
      `SELECT "projectAccessStatus"::text AS status
       FROM "Account"
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[ids.account, concurrentAdministrator.accountId]],
    );
    expect(concurrentStatuses.rows.map((row) => row.status).sort()).toEqual([
      "ACTIVE",
      "DISABLED",
    ]);
    await target.query(
      `UPDATE "Account"
       SET "projectAccessStatus" = 'ACTIVE'
       WHERE id = ANY($1::text[])`,
      [[ids.account, concurrentAdministrator.accountId]],
    );

    await executeMigrationSqlInTransaction(target, migrationSql);

    const approvalAdministratorGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await executeMigrationSqlInTransaction(
      target,
      approvalAdministratorGuardSql,
    );
    await expect(
      target.query(
        `UPDATE "Account"
         SET "projectAccessStatus" = 'DISABLED'
         WHERE id = ANY($1::text[])`,
        [[ids.account, concurrentAdministrator.accountId]],
      ),
    ).rejects.toThrow(/usable global approval administrator invariant violated/);
    const removeDurableApprovalAdministratorGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        REMOVE_DURABLE_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    const removeRefinedApprovalAdministratorRoleGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        REMOVE_REFINED_APPROVAL_ADMINISTRATOR_ROLE_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await executeMigrationSqlInTransaction(
      target,
      removeRefinedApprovalAdministratorRoleGuardSql,
    );
    const removeSerializedApprovalAdministratorGuardSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        REMOVE_SERIALIZED_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await executeMigrationSqlInTransaction(
      target,
      removeSerializedApprovalAdministratorGuardSql,
    );
    await executeMigrationSqlInTransaction(
      target,
      removeDurableApprovalAdministratorGuardSql,
    );
    const cleanupAllLegacyApprovalAdministratorGuardsSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        CLEANUP_ALL_LEGACY_APPROVAL_ADMINISTRATOR_GUARDS_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await executeMigrationSqlInTransaction(
      target,
      cleanupAllLegacyApprovalAdministratorGuardsSql,
    );
    const removeResidualApprovalAdministratorGuardFunctionSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        REMOVE_RESIDUAL_APPROVAL_ADMINISTRATOR_GUARD_FUNCTION_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await executeMigrationSqlInTransaction(
      target,
      removeResidualApprovalAdministratorGuardFunctionSql,
    );
    const removedDeploymentGuard = await target.query<{
      functionName: string | null;
      triggerCount: string;
    }>(
      `SELECT
         to_regprocedure('"assert_usable_global_approval_administrator"()')::text AS "functionName",
         (SELECT count(*)::text
          FROM pg_trigger
          WHERE tgname IN (
            'Account_global_approval_administrator_guard',
            'AccountIdentity_global_approval_administrator_guard',
            'SystemRoleAssignment_global_approval_administrator_guard',
            'SystemRoleAssignment_global_administrator_update_guard',
            'SystemRoleAssignment_global_administrator_delete_guard',
            'Task_global_approval_administrator_guard'
          )) AS "triggerCount"`,
    );
    expect(removedDeploymentGuard.rows).toEqual([
      { functionName: null, triggerCount: "0" },
    ]);
    const permanentGuard = await target.query<{
      functionName: string | null;
      triggerCount: string;
    }>(
      `SELECT
         to_regprocedure('"assert_usable_global_approval_administrator_v2"()')::text AS "functionName",
         (SELECT count(*)::text
          FROM pg_trigger
          WHERE tgname IN (
            'Task_usable_global_administrator_insert_guard_v2',
            'Account_usable_global_administrator_update_guard_v2',
            'Account_usable_global_administrator_delete_guard_v2',
            'AccountIdentity_usable_global_administrator_update_guard_v2',
            'AccountIdentity_usable_global_administrator_delete_guard_v2',
            'SystemRoleAssignment_global_administrator_update_guard_v2',
            'SystemRoleAssignment_global_administrator_delete_guard_v2'
          )) AS "triggerCount"`,
    );
    expect(permanentGuard.rows).toEqual([
      {
        functionName: "assert_usable_global_approval_administrator_v2()",
        triggerCount: "7",
      },
    ]);
    await expect(
      target.query(
        `UPDATE "AccountIdentity"
         SET "openId" = CASE WHEN "accountId" = $1 THEN ' ' ELSE '  ' END
         WHERE "accountId" = ANY($2::text[])`,
        [ids.account, [ids.account, concurrentAdministrator.accountId]],
      ),
    ).rejects.toThrow(/usable global approval administrator invariant violated/);

    const activeMembers = await target.query<{
      id: string;
      personId: string;
      role: string;
    }>(
      `SELECT id, "personId", role::text AS role
       FROM "TaskMember"
       WHERE "taskId" = $1 AND "removedAt" IS NULL
       ORDER BY id`,
      [ids.task],
    );
    expect(activeMembers.rows).toEqual(
      expect.arrayContaining([
        { id: ids.ownerMemberA, personId: ids.ownerPersonA, role: "OWNER" },
        { id: ids.ownerMemberB, personId: ids.ownerPersonB, role: "OWNER" },
        {
          id: ids.duplicateLeadMember,
          personId: ids.duplicatePerson,
          role: "PARTICIPANT",
        },
        {
          id: `migration:task-access:v1:segment-member:${ids.task}:${ids.segmentPerson}`,
          personId: ids.segmentPerson,
          role: "PARTICIPANT",
        },
      ]),
    );
    expect(activeMembers.rows).toHaveLength(4);

    const retiredMembers = await target.query<{
      id: string;
      role: string;
      removedAt: Date | null;
    }>(
      `SELECT id, role::text AS role, "removedAt"
       FROM "TaskMember"
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[ids.duplicateMember, ids.reviewerMember, ids.historicalViewerMember]],
    );
    expect(retiredMembers.rows).toEqual([
      expect.objectContaining({
        id: ids.duplicateMember,
        role: "MEMBER",
        removedAt: expect.any(Date),
      }),
      expect.objectContaining({
        id: ids.reviewerMember,
        role: "REVIEWER",
        removedAt: expect.any(Date),
      }),
      expect.objectContaining({
        id: ids.historicalViewerMember,
        role: "VIEWER",
        removedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ]);

    const roles = await target.query<{
      id: string;
      revokedAt: Date | null;
    }>(
      `SELECT id, "revokedAt"
       FROM "SystemRoleAssignment"
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[ids.groupLeaderRole, ids.projectAdministratorRole]],
    );
    expect(roles.rows).toEqual([
      { id: ids.groupLeaderRole, revokedAt: expect.any(Date) },
      { id: ids.projectAdministratorRole, revokedAt: null },
    ]);

    const policyAudit = await target.query<{
      before: { revisionApprovalMode: string; allowSelfReview: boolean };
      after: { approvalPolicy: string };
      source: string;
    }>(
      `SELECT before, after, source::text AS source
       FROM "DomainAuditEvent"
       WHERE id = $1`,
      [`migration:task-access:v1:policy:${ids.task}`],
    );
    expect(policyAudit.rows).toEqual([
      {
        before: {
          revisionApprovalMode: "DIRECT_BY_OWNER",
          allowSelfReview: true,
        },
        after: { approvalPolicy: "GLOBAL_ADMINISTRATOR_ONLY" },
        source: "MIGRATION",
      },
    ]);
    const migrationAuditCount = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM "DomainAuditEvent"
       WHERE source = 'MIGRATION'
         AND id LIKE 'migration:task-access:v1:%'`,
    );
    expect(Number(migrationAuditCount.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(6);

    const removedSchema = await target.query<{
      policyColumns: string;
      approvalEnum: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'Task'
            AND column_name IN ('revisionApprovalMode', 'allowSelfReview')) AS "policyColumns",
         to_regtype('"RevisionApprovalMode"')::text AS "approvalEnum"`,
    );
    expect(removedSchema.rows).toEqual([
      { policyColumns: "0", approvalEnum: null },
    ]);
    const notificationCounts = await target.query<{
      inApp: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM "InAppNotification") AS "inApp",
         (SELECT count(*)::text FROM "NotificationOutbox") AS outbox`,
    );
    expect(notificationCounts.rows).toEqual([{ inApp: "0", outbox: "0" }]);
  } finally {
    await racer?.query("ROLLBACK").catch(() => undefined);
    await racer?.end().catch(() => undefined);
    await target?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

test("serialized deployment guard rejects the first Task when no usable administrator exists", async () => {
  test.setTimeout(120_000);
  const sourceUrl = safeLocalTestDatabaseUrl();
  const sourceDatabaseName = sourceUrl.pathname.replace(/^\//, "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `${sourceDatabaseName.slice(0, 18)}_${suffix}_first_task_guard_test`;
  if (!/^[A-Za-z0-9_]+_first_task_guard_test$/.test(databaseName)) {
    throw new Error("首条 Task 门禁临时数据库名称安全校验失败");
  }

  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let target: Client | null = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();

    const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name < APPROVAL_ADMINISTRATOR_PREFLIGHT_MIGRATION,
      )
      .map((entry) => entry.name)
      .sort();
    for (const migrationName of migrationNames) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, migrationName, "migration.sql"),
        "utf8",
      );
      if (migrationName === "20260731121000_unified_account_backfill") {
        await executeMigrationSqlInTransaction(target, sql);
      } else {
        await executeMigrationSql(target, sql);
      }
    }

    const ordinaryAccountId = randomUUID();
    await target.query(
      `INSERT INTO "Account" (id, "updatedAt") VALUES ($1, CURRENT_TIMESTAMP)`,
      [ordinaryAccountId],
    );
    for (const migrationName of [
      APPROVAL_ADMINISTRATOR_PREFLIGHT_MIGRATION,
      DURABLE_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
      REFINED_APPROVAL_ADMINISTRATOR_ROLE_GUARD_MIGRATION,
      SERIALIZED_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
      ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
      REFINED_ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
      FINALIZE_ATOMIC_APPROVAL_ADMINISTRATOR_GUARD_MIGRATION,
    ]) {
      await executeMigrationSqlInTransaction(
        target,
        await readFile(
          path.join(MIGRATIONS_DIR, migrationName, "migration.sql"),
          "utf8",
        ),
      );
    }

    await target.query("BEGIN");
    try {
      await target.query("SET CONSTRAINTS ALL DEFERRED");
      await insertTaskAndPlan(
        target,
        randomUUID(),
        randomUUID(),
        ordinaryAccountId,
        {
          title: "First Task must wait for a usable administrator",
          revisionApprovalMode: "REVIEW_REQUIRED",
          allowSelfReview: false,
        },
      );
      await expect(target.query("COMMIT")).rejects.toThrow(
        /usable global approval administrator invariant violated/,
      );
    } finally {
      await target.query("ROLLBACK").catch(() => undefined);
    }

    const taskCount = await target.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Task"`,
    );
    expect(taskCount.rows[0]?.count).toBe("0");
  } finally {
    await target?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

async function waitForBackendLockWait(client: Client, backendPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ waiting: boolean }>(
      `SELECT coalesce(wait_event_type = 'Lock', false) AS waiting
       FROM pg_stat_activity
       WHERE pid = $1`,
      [backendPid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("原子管理员门禁未在预期时间内等待并发写锁");
}

async function executeSelfTransactionalMigrationSql(
  client: Client,
  sql: string,
) {
  try {
    await executeMigrationSql(client, sql);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function safeLocalTestDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  const databaseName = url.pathname.replace(/^\//, "");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    !databaseName.endsWith("_test") ||
    /prod(?:uction)?/i.test(databaseName)
  ) {
    throw new Error("拒绝在非本机测试数据库执行 Task access migration 回归");
  }
  return url;
}

function fixtureIds() {
  return {
    account: randomUUID(),
    task: randomUUID(),
    plan: randomUUID(),
    zeroOwnerTask: randomUUID(),
    zeroOwnerPlan: randomUUID(),
    ownerPersonA: randomUUID(),
    ownerPersonB: randomUUID(),
    duplicatePerson: randomUUID(),
    reviewerPerson: randomUUID(),
    segmentPerson: randomUUID(),
    historicalPerson: randomUUID(),
    ownerMemberA: "member-01-owner-a",
    ownerMemberB: "member-02-owner-b",
    duplicateLeadMember: "member-03-duplicate-lead",
    duplicateMember: "member-04-duplicate-member",
    reviewerMember: "member-05-reviewer",
    historicalViewerMember: "member-06-historical-viewer",
    segment: randomUUID(),
    groupLeaderRole: "role-01-group-leader",
    projectAdministratorRole: "role-02-project-administrator",
  };
}

async function seedLegacyTaskAccessData(
  client: Client,
  ids: ReturnType<typeof fixtureIds>,
) {
  await client.query("BEGIN");
  try {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      'INSERT INTO "Account" (id, "updatedAt") VALUES ($1, CURRENT_TIMESTAMP)',
      [ids.account],
    );
    await client.query(
      `INSERT INTO "AccountIdentity"
         (id, "accountId", provider, "providerSubject", "tenantId", "openId", "updatedAt")
       VALUES ($1, $2, 'FEISHU', $3, 'default', $4, CURRENT_TIMESTAMP)`,
      [
        randomUUID(),
        ids.account,
        `open:task-access-${ids.account}`,
        `ou_task_access_${ids.account}`,
      ],
    );
    for (const [id, name] of [
      [ids.ownerPersonA, "Owner A"],
      [ids.ownerPersonB, "Owner B"],
      [ids.duplicatePerson, "Duplicate legacy member"],
      [ids.reviewerPerson, "Reviewer only"],
      [ids.segmentPerson, "Segment backfill"],
      [ids.historicalPerson, "Historical removed member"],
    ] as const) {
      await client.query(
        'INSERT INTO "Person" (id, "displayName", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)',
        [id, name],
      );
    }
    await insertTaskAndPlan(client, ids.task, ids.plan, ids.account, {
      title: "Legacy Task access fixture",
      revisionApprovalMode: "DIRECT_BY_OWNER",
      allowSelfReview: true,
    });
    await insertTaskAndPlan(
      client,
      ids.zeroOwnerTask,
      ids.zeroOwnerPlan,
      ids.account,
      {
        title: "Migration must block zero Owner",
        revisionApprovalMode: "REVIEW_REQUIRED",
        allowSelfReview: false,
      },
    );
    for (const [id, personId, role, removedAt] of [
      [ids.ownerMemberA, ids.ownerPersonA, "OWNER", null],
      [ids.ownerMemberB, ids.ownerPersonB, "OWNER", null],
      [ids.duplicateLeadMember, ids.duplicatePerson, "LEAD", null],
      [ids.duplicateMember, ids.duplicatePerson, "MEMBER", null],
      [ids.reviewerMember, ids.reviewerPerson, "REVIEWER", null],
      [
        ids.historicalViewerMember,
        ids.historicalPerson,
        "VIEWER",
        new Date("2026-01-01T00:00:00.000Z"),
      ],
    ] as const) {
      await client.query(
        `INSERT INTO "TaskMember"
           (id, "taskId", "personId", role, "removedAt")
         VALUES ($1, $2, $3, $4::"TaskMemberRole", $5)`,
        [id, ids.task, personId, role, removedAt],
      );
    }
    await client.query(
      `INSERT INTO "WorkSegment"
         (id, "personId", type, status, "startAt", "endAt", content,
          "taskId", "createdByAccountId", "updatedAt")
       VALUES ($1, $2, 'PLANNED', 'PLANNED', $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
      [
        ids.segment,
        ids.segmentPerson,
        new Date("2026-08-01T00:00:00.000Z"),
        new Date("2026-08-01T01:00:00.000Z"),
        "Segment requires participant backfill",
        ids.task,
        ids.account,
      ],
    );
    await client.query(
      `INSERT INTO "SystemRoleAssignment"
         (id, "accountId", role, team, "techGroup")
       VALUES
         ($1, $3, 'GROUP_LEADER', '英雄', ''),
         ($2, $3, 'PROJECT_ADMINISTRATOR', '', '')`,
      [ids.groupLeaderRole, ids.projectAdministratorRole, ids.account],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertTaskAndPlan(
  client: Client,
  taskId: string,
  planId: string,
  accountId: string,
  input: {
    title: string;
    revisionApprovalMode: "DIRECT_BY_OWNER" | "REVIEW_REQUIRED";
    allowSelfReview: boolean;
  },
) {
  await client.query(
    `INSERT INTO "Task"
       (id, title, "currentPlanVersionId", "revisionApprovalMode",
        "allowSelfReview", "createdByAccountId", "updatedAt")
     VALUES ($1, $2, $3, $4::"RevisionApprovalMode", $5, $6, CURRENT_TIMESTAMP)`,
    [
      taskId,
      input.title,
      planId,
      input.revisionApprovalMode,
      input.allowSelfReview,
      accountId,
    ],
  );
  await client.query(
    `INSERT INTO "TaskPlanVersion"
       (id, "taskId", "versionNo", status, reason, "createdByAccountId", "updatedAt")
     VALUES ($1, $2, 1, 'CURRENT', 'legacy fixture', $3, CURRENT_TIMESTAMP)`,
    [planId, taskId, accountId],
  );
}

async function executeMigrationSql(client: Client, sql: string) {
  for (const statement of splitPostgresStatements(sql)) {
    await client.query(statement);
  }
}

async function executeMigrationSqlInTransaction(client: Client, sql: string) {
  await client.query("BEGIN");
  try {
    await executeMigrationSql(client, sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function splitPostgresStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    current += char;
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        current += next;
        index += 1;
        blockCommentDepth += 1;
      } else if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockCommentDepth -= 1;
      }
      continue;
    }
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        current += dollarQuoteTag.slice(1);
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }
    if (singleQuoted) {
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += next;
      index += 1;
      blockCommentDepth = 1;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      continue;
    }
    if (char === '"') {
      doubleQuoted = true;
      continue;
    }
    if (char === "$") {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        current += tag.slice(1);
        index += tag.length - 1;
        dollarQuoteTag = tag;
        continue;
      }
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
