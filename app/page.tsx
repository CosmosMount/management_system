import {
  ClipboardList,
  FilePlus2,
  LayoutDashboard,
  Shield,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { NavCard } from "@/components/nav-card";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/permissions";

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

          <section className="mb-12">
            <h2 className="mb-5 text-xl font-semibold">采购报销管理</h2>
            <div className="flex w-full flex-col gap-4">
              <NavCard
                variant="wide"
                href="/apply"
                title="新建申请"
                description="填写采购明细并提交审批"
                icon={FilePlus2}
              />
              <NavCard
                variant="wide"
                href="/orders"
                title="订单列表"
                description="查看与管理全部采购订单"
                icon={ClipboardList}
              />
              <NavCard
                variant="wide"
                href="/dashboard"
                title="看板"
                description="采购汇总表，一览全部采购记录"
                icon={LayoutDashboard}
              />
            </div>
          </section>

          {showAdmin && (
            <section>
              <h2 className="mb-5 text-xl font-semibold">权限管理</h2>
              <div className="flex w-full flex-col gap-4">
                <NavCard
                  variant="wide"
                  href="/admin"
                  title="权限管理"
                  description="分配角色与同步飞书通讯录"
                  icon={Shield}
                />
              </div>
            </section>
          )}
        </main>
      </PageShell>
    </>
  );
}
