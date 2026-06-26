import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { AppHeader } from "@/components/app-header";
import { BackLink } from "@/components/back-link";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { isSuperAdmin } from "@/lib/permissions";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }
  if (!(await isSuperAdmin(session.user.openId))) {
    redirect("/");
  }

  const liveVersion = await getCurrentUserLiveVersion("admin");

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
          <div className="space-y-6">
            <AdminNav />
            {children}
          </div>
        </main>
      </PageShell>
    </>
  );
}
