import Link from "next/link";
import { FolderKanban, LayoutDashboard, Plus, Archive } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { NavCard } from "@/components/nav-card";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { projectStatusLabels } from "@/lib/progress-labels";
import { prisma } from "@/lib/prisma";
import { canCreateProject } from "@/lib/permissions-progress";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles } from "@/lib/permissions";
import { routes } from "@/lib/routes";

export default async function ProgressHomePage() {
  const liveVersion = await getCurrentUserLiveVersion("progress");
  const session = await auth();
  const roles = session?.user?.openId
    ? await getUserRoles(session.user.openId)
    : [];
  const showCreate = canCreateProject(roles);

  const projects = await prisma.project.findMany({
    where: { status: { notIn: ["COMPLETED", "CANCELED"] } },
    include: { _count: { select: { tasks: true } } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <ProgressPageLayout>
          <PageTitle subtitle="进度管理" />

          <div className="mb-10 flex w-full flex-col gap-4">
            {showCreate && (
              <NavCard
                variant="wide"
                href={routes.progress.new}
                title="新建项目"
                description="创建项目并配置生命周期阶段"
                icon={Plus}
              />
            )}
            <NavCard
              variant="wide"
              href={routes.progress.list}
              title="项目列表"
              description="查看全部进行中的项目"
              icon={FolderKanban}
            />
            <NavCard
              variant="wide"
              href={routes.progress.dashboard}
              title="任务看板"
              description="按状态查看全部任务，发现逾期与待验收"
              icon={LayoutDashboard}
            />
            <NavCard
              variant="wide"
              href={routes.progress.archive}
              title="归档检索"
              description="查看已完成、已取消项目与已归档任务"
              icon={Archive}
            />
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2">
                <FolderKanban className="h-5 w-5" />
                活跃项目
              </CardTitle>
              <Link
                href={routes.progress.list}
                className="text-sm text-primary hover:underline"
              >
                查看全部
              </Link>
            </CardHeader>
            <CardContent>
              {projects.length === 0 ? (
                <p className="text-muted-foreground">暂无项目</p>
              ) : (
                <ul className="space-y-2">
                  {projects.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={routes.progress.project(p.id)}
                        className="flex items-center justify-between rounded-lg border p-3 hover:border-primary/30"
                      >
                        <div>
                          <p className="font-medium">{p.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {formatScopeItem(p.team)} /{" "}
                            {formatScopeItem(p.techGroup)} · {p._count.tasks} 个任务
                          </p>
                        </div>
                        <Badge variant="secondary">
                          {projectStatusLabels[p.status]}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}

function formatScopeItem(value: string): string {
  return value || "未指定";
}
