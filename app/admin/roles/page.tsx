import { RolesPanel } from "@/components/admin/roles-panel";
import { prisma } from "@/lib/prisma";

export default async function AdminRolesPage() {
  const [users, roles] = await Promise.all([
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.userRole.findMany({ orderBy: { role: "asc" } }),
  ]);

  return (
    <RolesPanel
      users={users.map((user) => ({
        ...user,
        createdAt: user.createdAt.toISOString(),
      }))}
      roles={roles.map((role) => ({
        ...role,
        team: role.team ?? "",
        techGroup: role.techGroup ?? "",
      }))}
    />
  );
}
