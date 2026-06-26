import Link from "next/link";
import {
  BellRing,
  ClipboardCheck,
  FolderKanban,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { AdminMetric } from "@/components/admin/admin-metric";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export default async function AdminPage() {
  const [
    userCount,
    assignedUserRows,
    superAdminCount,
    projectManagerCount,
    roleCount,
    acceptanceCount,
    reminderCount,
    enabledReminderCount,
    templateCount,
    enabledTemplateCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.userRole.findMany({
      distinct: ["openId"],
      select: { openId: true },
    }),
    prisma.userRole.count({ where: { role: "SUPER_ADMIN" } }),
    prisma.userRole.count({ where: { role: "PROJECT_MANAGER" } }),
    prisma.userRole.count(),
    prisma.acceptanceChecklistTemplate.count(),
    prisma.progressReminderRule.count(),
    prisma.progressReminderRule.count({ where: { enabled: true } }),
    prisma.projectTemplate.count(),
    prisma.projectTemplate.count({ where: { enabled: true } }),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <section className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <AdminMetric
          icon={Users}
          label="通讯录用户"
          value={userCount}
          detail={`${assignedUserRows.length} 人已有角色`}
        />
        <AdminMetric
          icon={ShieldCheck}
          label="全局管理"
          value={superAdminCount + projectManagerCount}
          detail={`超管 ${superAdminCount} · 项管 ${projectManagerCount}`}
        />
        <AdminMetric
          icon={ClipboardCheck}
          label="验收条例"
          value={acceptanceCount}
          detail="任务创建时可快捷加入"
        />
        <AdminMetric
          icon={BellRing}
          label="进度提醒"
          value={enabledReminderCount}
          detail={`共 ${reminderCount} 条规则，可自动或手动催促`}
        />
        <AdminMetric
          icon={FolderKanban}
          label="项目模板"
          value={enabledTemplateCount}
          detail={`共 ${templateCount} 个模板，新建项目时可套用`}
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
          href={routes.admin.reminders}
          icon={BellRing}
          title="进度提醒"
          detail="配置自动提醒规则并查看最近提醒 outbox。"
        />
        <AdminEntryCard
          href={routes.admin.projectTemplates}
          icon={FolderKanban}
          title="项目模板"
          detail="创建和维护项目阶段模板。"
        />
        <AdminEntryCard
          href={routes.admin.acceptance}
          icon={ClipboardCheck}
          title="验收条例"
          detail="维护任务验收 checklist 快捷项。"
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
