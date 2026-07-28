import Link from "next/link";
import { RefreshCw, ShieldCheck, Users, Wallet } from "lucide-react";
import { AdminMetric } from "@/components/admin/admin-metric";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currentBudgetPeriod } from "@/lib/import-procurement-budget";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export default async function AdminPage() {
  const [
    userCount,
    assignedUserRows,
    superAdminCount,
    roleCount,
    budgetPoolCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.userRole.findMany({
      distinct: ["openId"],
      select: { openId: true },
    }),
    prisma.userRole.count({ where: { role: "SUPER_ADMIN" } }),
    prisma.userRole.count(),
    prisma.procurementBudgetPool.count({
      where: { period: currentBudgetPeriod() },
    }),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <section className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AdminMetric
          icon={Users}
          label="通讯录用户"
          value={userCount}
          detail={`${assignedUserRows.length} 人已有角色`}
        />
        <AdminMetric
          icon={ShieldCheck}
          label="全局管理"
          value={superAdminCount}
          detail="超级管理员"
        />
        <AdminMetric
          icon={Wallet}
          label="采购预算池"
          value={budgetPoolCount}
          detail={`${currentBudgetPeriod()} 周期`}
        />
      </section>

      <section className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <AdminEntryCard
          href={routes.admin.system}
          icon={RefreshCw}
          title="系统同步"
          detail="从飞书通讯录同步用户资料。"
        />
        <AdminEntryCard
          href={routes.admin.roles}
          icon={ShieldCheck}
          title="用户与角色"
          detail={`当前共有 ${roleCount} 条角色配置。`}
        />
        <AdminEntryCard
          href={routes.admin.budgetPools}
          icon={Wallet}
          title="采购预算池"
          detail={`导入车组+技术组预算，当前 ${budgetPoolCount} 条。`}
        />
      </section>
    </div>
  );
}

function AdminEntryCard({
  href,
  icon: Icon,
  title,
  detail,
}: {
  href: string;
  icon: typeof RefreshCw;
  title: string;
  detail: string;
}) {
  return (
    <Link href={href} className="block min-w-0">
      <Card className="h-full transition-colors hover:border-primary/40 hover:bg-muted/30">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {detail}
        </CardContent>
      </Card>
    </Link>
  );
}
