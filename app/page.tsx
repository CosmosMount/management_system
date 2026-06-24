import { FolderKanban, Shield, ShoppingCart } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { NavCard } from "@/components/nav-card";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/permissions";
import { routes } from "@/lib/routes";

export default async function HomePage() {
  const session = await auth();
  const showAdmin =
    !!session?.user?.openId && (await isSuperAdmin(session.user.openId));

  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
          <PageTitle />

          <div className="flex w-full flex-col gap-4">
            <NavCard
              variant="wide"
              href={routes.procurement.root}
              title="采购管理"
              description="采购申请、订单审批、报销与统计看板"
              icon={ShoppingCart}
            />
            <NavCard
              variant="wide"
              href={routes.progress.root}
              title="进度管理"
              description="项目与任务跟踪、周报、验收与归档"
              icon={FolderKanban}
            />
            {showAdmin && (
              <NavCard
                variant="wide"
                href="/admin"
                title="权限管理"
                description="分配角色与同步飞书通讯录"
                icon={Shield}
              />
            )}
          </div>
        </main>
      </PageShell>
    </>
  );
}
