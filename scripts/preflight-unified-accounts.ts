import "dotenv/config";
import { prisma } from "../lib/prisma";

type CountRow = { count: bigint | string | number };

async function count(query: TemplateStringsArray): Promise<number> {
  const rows = await prisma.$queryRaw<CountRow[]>(query);
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  const requiredUserAccountIdColumns = await count`SELECT count(*)::bigint AS count
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'User'
      AND column_name = 'accountId'
      AND is_nullable = 'NO'`;
  const unifiedAccountSchemaFinalized = requiredUserAccountIdColumns === 1;

  // Before the unified-account migration, reimbursement assignments are tied
  // to User.openId and every row represents current state. At current head,
  // accountId is authoritative, openId is only a historical snapshot, and
  // revoked rows are append-only history that may repeat a later active grant.
  const orphanRolesPromise = unifiedAccountSchemaFinalized
    ? count`SELECT count(*)::bigint AS count
        FROM "UserRole" r
        LEFT JOIN "Account" a ON a.id = r."accountId"
        WHERE r."revokedAt" IS NULL AND a.id IS NULL`
    : count`SELECT count(*)::bigint AS count
        FROM "UserRole" r LEFT JOIN "User" u ON u."openId" = r."openId"
        WHERE u.id IS NULL`;
  const duplicateReimbursementRolesPromise = unifiedAccountSchemaFinalized
    ? count`SELECT count(*)::bigint AS count FROM (
        SELECT "accountId", role, team, "techGroup"
        FROM "UserRole"
        WHERE "revokedAt" IS NULL
        GROUP BY "accountId", role, team, "techGroup"
        HAVING count(*) > 1
      ) duplicates`
    : count`SELECT count(*)::bigint AS count FROM (
        SELECT "openId", role, team, "techGroup"
        FROM "UserRole"
        GROUP BY "openId", role, team, "techGroup"
        HAVING count(*) > 1
      ) duplicates`;
  const illegalReimbursementRolesPromise = unifiedAccountSchemaFinalized
    ? count`SELECT count(*)::bigint AS count
        FROM "UserRole"
        WHERE "revokedAt" IS NULL
          AND NOT (
            (role IN ('TEAM_ADMIN', 'FINANCE') AND team IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用') AND "techGroup" = '')
            OR (role IN ('TECH_GROUP_ADMIN', 'TEACHER') AND team = '' AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
          )`
    : count`SELECT count(*)::bigint AS count
        FROM "UserRole"
        WHERE NOT (
          (role = 'SUPER_ADMIN' AND team = '' AND "techGroup" = '')
          OR (role IN ('TEAM_ADMIN', 'FINANCE') AND team IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用') AND "techGroup" = '')
          OR (role IN ('TECH_GROUP_ADMIN', 'TEACHER') AND team = '' AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
        )`;

  const [
    identityConflicts,
    usersNeedingAccounts,
    orphanRoles,
    duplicateReimbursementRoles,
    illegalReimbursementRoles,
    duplicateProjectRoles,
    illegalProjectRoles,
    ambiguousProjectRoles,
    userCount,
    legacySuperAdmins,
    activeUnifiedSuperAdministrators,
  ] = await Promise.all([
      count`SELECT count(*)::bigint AS count FROM (
        SELECT u.id
        FROM "User" u
        JOIN "AccountIdentity" i
          ON i."provider" = 'FEISHU'
          AND i."tenantId" = 'default'
          AND (i."openId" = u."openId" OR (u."unionId" IS NOT NULL AND i."unionId" = u."unionId"))
        GROUP BY u.id
        HAVING count(DISTINCT i."accountId") > 1
          OR count(DISTINCT i.id) > 1
      ) conflicts`,
      count`SELECT count(*)::bigint AS count
        FROM "User" u
        WHERE NOT EXISTS (
          SELECT 1 FROM "AccountIdentity" i
          WHERE i."provider" = 'FEISHU'
            AND i."tenantId" = 'default'
            AND (i."openId" = u."openId" OR (u."unionId" IS NOT NULL AND i."unionId" = u."unionId"))
        )`,
      orphanRolesPromise,
      duplicateReimbursementRolesPromise,
      illegalReimbursementRolesPromise,
      count`SELECT count(*)::bigint AS count FROM (
        SELECT "accountId", role, team, "techGroup"
        FROM "SystemRoleAssignment"
        WHERE "revokedAt" IS NULL
        GROUP BY "accountId", role, team, "techGroup"
        HAVING count(*) > 1
      ) duplicates`,
      count`SELECT count(*)::bigint AS count
        FROM "SystemRoleAssignment"
        WHERE "revokedAt" IS NULL
          AND NOT (
            (role::text IN (
              'SUPER_ADMINISTRATOR',
              'PROJECT_ADMINISTRATOR',
              'SYSTEM_ADMINISTRATOR'
            ) AND team = '' AND "techGroup" = '')
            OR (role::text = 'AUDITOR')
            OR (role::text = 'TEAM_ADMINISTRATOR' AND (
              (team IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用') AND "techGroup" = '')
              OR (team = '' AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
            ))
            OR (role::text = 'RESOURCE_MANAGER' AND (length(btrim(team)) > 0 OR length(btrim("techGroup")) > 0))
            OR (role::text = 'GROUP_LEADER' AND (
              (length(btrim(team)) > 0 AND "techGroup" = '')
              OR (team = '' AND length(btrim("techGroup")) > 0)
            ))
          )`,
      count`SELECT count(*)::bigint AS count
        FROM "SystemRoleAssignment"
        WHERE "revokedAt" IS NULL
          AND role::text = 'TEAM_ADMINISTRATOR'
          AND length(btrim(team)) > 0
          AND length(btrim("techGroup")) > 0`,
      count`SELECT count(*)::bigint AS count FROM "User"`,
      count`SELECT count(*)::bigint AS count
        FROM "UserRole"
        WHERE role = 'SUPER_ADMIN'`,
      count`SELECT count(*)::bigint AS count
        FROM "SystemRoleAssignment"
        WHERE "revokedAt" IS NULL
          AND role::text = 'SUPER_ADMINISTRATOR'
          AND btrim(team) = ''
          AND btrim("techGroup") = ''`,
    ]);

  const hasRequiredAdministrator = unifiedAccountSchemaFinalized
    ? activeUnifiedSuperAdministrators > 0
    : legacySuperAdmins > 0;

  const report = {
    identityConflicts,
    usersNeedingAccounts,
    orphanRoles,
    duplicateReimbursementRoles,
    illegalReimbursementRoles,
    duplicateProjectRoles,
    illegalProjectRoles,
    ambiguousProjectRoles,
    userCount,
    unifiedAccountSchemaFinalized,
    legacySuperAdministrators: legacySuperAdmins,
    activeUnifiedSuperAdministrators,
    ready:
      identityConflicts === 0 &&
      orphanRoles === 0 &&
      duplicateReimbursementRoles === 0 &&
      illegalReimbursementRoles === 0 &&
      duplicateProjectRoles === 0 &&
      illegalProjectRoles === 0 &&
      ambiguousProjectRoles === 0 &&
      (userCount === 0 || hasRequiredAdministrator),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
