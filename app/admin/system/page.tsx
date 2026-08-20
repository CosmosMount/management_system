import { SystemSyncPanel } from "@/components/admin/system-sync-panel";
import { prisma } from "@/lib/prisma";

export default async function AdminSystemPage() {
  const [userCount, roleCount, assignedUsers] = await Promise.all([
    prisma.user.count({
      where: { account: { person: { is: { status: "ACTIVE" } } } },
    }),
    prisma.userRole.count({
      where: {
        revokedAt: null,
        role: { not: "SUPER_ADMIN" },
        account: { person: { is: { status: "ACTIVE" } } },
      },
    }),
    prisma.userRole.findMany({
      where: {
        revokedAt: null,
        role: { not: "SUPER_ADMIN" },
        account: { person: { is: { status: "ACTIVE" } } },
      },
      distinct: ["accountId"],
      select: { accountId: true },
    }),
  ]);

  return (
    <SystemSyncPanel
      userCount={userCount}
      roleCount={roleCount}
      assignedUserCount={assignedUsers.length}
    />
  );
}
