import "dotenv/config";
import { prisma } from "../lib/prisma";

type CountRow = { count: bigint | string | number };

async function count(query: TemplateStringsArray): Promise<number> {
  const rows = await prisma.$queryRaw<CountRow[]>(query);
  return Number(rows[0]?.count ?? 0);
}

async function main() {
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
    superAdmins,
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
      count`SELECT count(*)::bigint AS count
        FROM "UserRole" r LEFT JOIN "User" u ON u."openId" = r."openId"
        WHERE u.id IS NULL`,
      count`SELECT count(*)::bigint AS count FROM (
        SELECT "openId", role, team, "techGroup"
        FROM "UserRole"
        GROUP BY "openId", role, team, "techGroup"
        HAVING count(*) > 1
      ) duplicates`,
      count`SELECT count(*)::bigint AS count
        FROM "UserRole"
        WHERE NOT (
          (role = 'SUPER_ADMIN' AND team = '' AND "techGroup" = '')
          OR (role IN ('TEAM_ADMIN', 'FINANCE') AND team IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用') AND "techGroup" = '')
          OR (role IN ('TECH_GROUP_ADMIN', 'TEACHER') AND team = '' AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
        )`,
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
            (role = 'SYSTEM_ADMINISTRATOR' AND team = '' AND "techGroup" = '')
            OR (role = 'AUDITOR')
            OR (role = 'TEAM_ADMINISTRATOR' AND (
              (team IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用') AND "techGroup" = '')
              OR (team = '' AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
            ))
            OR (role = 'RESOURCE_MANAGER' AND (length(btrim(team)) > 0 OR length(btrim("techGroup")) > 0))
          )`,
      count`SELECT count(*)::bigint AS count
        FROM "SystemRoleAssignment"
        WHERE "revokedAt" IS NULL
          AND role = 'TEAM_ADMINISTRATOR'
          AND length(btrim(team)) > 0
          AND length(btrim("techGroup")) > 0`,
      count`SELECT count(*)::bigint AS count FROM "User"`,
      count`SELECT count(*)::bigint AS count
        FROM "UserRole"
        WHERE role = 'SUPER_ADMIN'`,
    ]);

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
    legacySuperAdministrators: superAdmins,
    ready:
      identityConflicts === 0 &&
      orphanRoles === 0 &&
      duplicateReimbursementRoles === 0 &&
      illegalReimbursementRoles === 0 &&
      duplicateProjectRoles === 0 &&
      illegalProjectRoles === 0 &&
      ambiguousProjectRoles === 0 &&
      (userCount === 0 || superAdmins > 0),
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
