import "dotenv/config";
import { prisma } from "../lib/prisma";

async function main() {
  const [
    accountCount,
    userCount,
    linkedUserCount,
    userAccountIdIsRequired,
    superAdministratorCount,
    projectAdministratorCount,
    activeReimbursementRoleCount,
    activeLegacyReimbursementSuperAdminCount,
    migrationAuditCount,
  ] = await Promise.all([
    prisma.account.count(),
    prisma.user.count(),
    prisma.$queryRaw<Array<{ linkedUserCount: bigint }>>`
      SELECT COUNT("accountId") AS "linkedUserCount" FROM "User"
    `.then((rows) => Number(rows[0]?.linkedUserCount ?? 0)),
    prisma.$queryRaw<Array<{ isNullable: "YES" | "NO" }>>`
      SELECT is_nullable AS "isNullable"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'User'
        AND column_name = 'accountId'
    `.then((rows) => rows[0]?.isNullable === "NO"),
    prisma.systemRoleAssignment.count({
      where: { role: "SUPER_ADMINISTRATOR", revokedAt: null },
    }),
    prisma.systemRoleAssignment.count({
      where: { role: "PROJECT_ADMINISTRATOR", revokedAt: null },
    }),
    prisma.userRole.count({
      where: { role: { not: "SUPER_ADMIN" }, revokedAt: null },
    }),
    prisma.userRole.count({
      where: { role: "SUPER_ADMIN", revokedAt: null },
    }),
    prisma.domainAuditEvent.count({ where: { source: "MIGRATION" } }),
  ]);

  const report = {
    accountCount,
    userCount,
    linkedUserCount,
    userAccountIdIsRequired,
    superAdministratorCount,
    projectAdministratorCount,
    activeReimbursementRoleCount,
    activeLegacyReimbursementSuperAdminCount,
    migrationAuditCount,
    ready:
      linkedUserCount === userCount &&
      userAccountIdIsRequired &&
      activeLegacyReimbursementSuperAdminCount === 0 &&
      (userCount === 0 || superAdministratorCount > 0),
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
