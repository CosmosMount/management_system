import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AdminPanel } from "@/components/admin-panel";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }
  if (!(await isSuperAdmin(session.user.openId))) {
    redirect("/");
  }

  const [users, roles] = await Promise.all([
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.userRole.findMany({ orderBy: { role: "asc" } }),
  ]);

  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto max-w-6xl flex-1 p-4 py-8">
          <PageTitle subtitle="权限管理" />
          <AdminPanel
            users={users.map((u) => ({
              ...u,
              createdAt: u.createdAt.toISOString(),
            }))}
            roles={roles.map((r) => ({
              ...r,
              team: r.team ?? "",
              techGroup: r.techGroup ?? "",
            }))}
          />
        </main>
      </PageShell>
    </>
  );
}
