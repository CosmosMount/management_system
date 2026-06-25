import Link from "next/link";
import { FolderKanban, LayoutDashboard, Plus, Archive } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { NavCard } from "@/components/nav-card";
import {
  MineScopeToggle,
  readMineSearchParam,
  withMine,
} from "@/components/progress/mine-scope-toggle";
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
import {
  canCreateProject,
  progressProjectMineWhere,
  progressProjectReadableWhere,
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles } from "@/lib/permissions";
import { routes } from "@/lib/routes";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProgressHomePage({ searchParams }: Props) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const mine = await readMineSearchParam(searchParams);
  const [liveVersion, roles] = await Promise.all([
    getCurrentUserLiveVersion("progress-list", undefined, { mine }),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
  ]);
  const showCreate = canCreateProject(roles);

  const projects = await prisma.project.findMany({
    where: {
      AND: [
        progressProjectReadableWhere(roles, userOpenId),
        mine ? progressProjectMineWhere(userOpenId) : {},
        { status: { notIn: ["COMPLETED", "CANCELED"] } },
      ],
    },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const visibleTaskCounts = await getVisibleTaskCounts(
    projects,
    roles,
    userOpenId,
    mine,
  );

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress-list"
        initialVersion={liveVersion}
        intervalMs={10000}
        mine={mine}
      />
      <PageShell>
        <ProgressPageLayout>
          <PageTitle subtitle="进度管理" />
          <div className="mb-6">
            <MineScopeToggle basePath={routes.progress.root} mine={mine} />
          </div>

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
              href={withMine(routes.progress.list, mine)}
              title="项目列表"
              description="查看全部进行中的项目"
              icon={FolderKanban}
            />
            <NavCard
              variant="wide"
              href={withMine(routes.progress.dashboard, mine)}
              title="任务看板"
              description="按状态查看全部任务，发现逾期与待验收"
              icon={LayoutDashboard}
            />
            <NavCard
              variant="wide"
              href={withMine(routes.progress.archive, mine)}
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
                href={withMine(routes.progress.list, mine)}
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
                            {formatScopeItem(p.techGroup)} ·{" "}
                            {visibleTaskCounts.get(p.id) ?? 0} 个任务
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

async function getVisibleTaskCounts(
  projects: Array<{
    id: string;
  }>,
  roles: Awaited<ReturnType<typeof getUserRoles>>,
  userOpenId?: string,
  mine = false,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const project of projects) {
    counts.set(project.id, 0);
  }

  const projectIds = projects.map((project) => project.id);
  const grouped =
    projectIds.length > 0
      ? await prisma.task.groupBy({
          by: ["projectId"],
          where: {
            AND: [
              progressTaskReadableWhere(roles, userOpenId),
              mine ? progressTaskMineWhere(userOpenId) : {},
              { projectId: { in: projectIds } },
            ],
          },
          _count: { _all: true },
        })
      : [];

  for (const row of grouped) {
    counts.set(row.projectId, row._count._all);
  }
  return counts;
}

function formatScopeItem(value: string): string {
  return value || "未指定";
}
