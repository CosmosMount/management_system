import Link from "next/link";
import { RefreshCw, ShieldCheck, Users, Wallet } from "lucide-react";
import { AdminMetric } from "@/components/admin/admin-metric";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currentBudgetPeriod } from "@/lib/import-procurement-budget";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export default async function AdminPage() {
  const [
    accountCount,
    activeAccountCount,
    disabledAccountCount,
    superAdminCount,
    projectAdminCount,
    groupLeaderRows,
    reimbursementRoleCount,
    budgetPoolCount,
  ] = await Promise.all([
    prisma.account.count(),
    prisma.account.count({ where: { projectAccessStatus: "ACTIVE" } }),
    prisma.account.count({ where: { projectAccessStatus: "DISABLED" } }),
    prisma.systemRoleAssignment.count({
      where: { role: "SUPER_ADMINISTRATOR", revokedAt: null },
    }),
    prisma.systemRoleAssignment.count({
      where: { role: "PROJECT_ADMINISTRATOR", revokedAt: null },
    }),
    prisma.systemRoleAssignment.findMany({
      where: { role: "GROUP_LEADER", revokedAt: null },
      distinct: ["accountId"],
      select: { accountId: true },
    }),
    prisma.userRole.count({
      where: { revokedAt: null, role: { not: "SUPER_ADMIN" } },
    }),
    prisma.procurementBudgetPool.count({
      where: { period: currentBudgetPeriod() },
    }),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <section className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AdminMetric
          icon={Users}
          label="统一账号"
          value={accountCount}
          detail="飞书统一身份"
        />
        <AdminMetric
          icon={Users}
          label="项目已启用"
          value={activeAccountCount}
          detail="可进入项目管理"
        />
        <AdminMetric
          icon={Users}
          label="项目已禁用"
          value={disabledAccountCount}
          detail="登录与报销不受影响"
        />
        <AdminMetric
          icon={ShieldCheck}
          label="超级管理员"
          value={superAdminCount}
          detail="跨报销与项目"
        />
        <AdminMetric
          icon={ShieldCheck}
          label="项目管理员"
          value={projectAdminCount}
          detail="全部项目业务权限"
        />
        <AdminMetric
          icon={ShieldCheck}
          label="组织组长"
          value={groupLeaderRows.length}
          detail="按车组或技术组授权"
        />
        <AdminMetric
          icon={ShieldCheck}
          label="报销角色"
          value={reimbursementRoleCount}
          detail="车组、技术组、老师与财务"
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
          href={routes.admin.accounts}
          icon={ShieldCheck}
          title="账号与权限"
          detail={`当前共有 ${reimbursementRoleCount} 条报销角色配置。`}
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
