import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AdminPanel } from "@/components/admin-panel";
import { BackLink } from "@/components/back-link";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { isSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export default async function AdminPage() {
  const liveVersion = await getCurrentUserLiveVersion("admin");
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }
  if (!(await isSuperAdmin(session.user.openId))) {
    redirect("/");
  }

  const [users, roles, acceptanceChecklistTemplates] = await Promise.all([
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.userRole.findMany({ orderBy: { role: "asc" } }),
    prisma.acceptanceChecklistTemplate.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="admin"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 p-4 py-8">
          <BackLink href="/" label="返回首页" />
          <PageTitle subtitle="管理员面板" />
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
            acceptanceChecklistTemplates={acceptanceChecklistTemplates.map(
              (template) => ({
                ...template,
                createdAt: template.createdAt.toISOString(),
                updatedAt: template.updatedAt.toISOString(),
              }),
            )}
          />
        </main>
      </PageShell>
    </>
  );
}
