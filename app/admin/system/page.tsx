import { SystemSyncPanel } from "@/components/admin/system-sync-panel";
import { prisma } from "@/lib/prisma";

export default async function AdminSystemPage() {
  const [userCount, roleCount, assignedUsers] = await Promise.all([
    prisma.user.count(),
    prisma.userRole.count(),
    prisma.userRole.findMany({
      distinct: ["openId"],
      select: { openId: true },
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
