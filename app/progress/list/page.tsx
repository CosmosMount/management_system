import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import {
  MineScopeToggle,
  readMineSearchParam,
} from "@/components/progress/mine-scope-toggle";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import { projectStatusLabels } from "@/lib/progress-labels";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles } from "@/lib/permissions";
import {
  progressProjectMineWhere,
  progressProjectReadableWhere,
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProgressListPage({ searchParams }: Props) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const mine = await readMineSearchParam(searchParams);
  const [liveVersion, roles] = await Promise.all([
    getCurrentUserLiveVersion("progress-list", undefined, { mine }),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
  ]);
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
          <ProgressBackLink />
          <PageTitle subtitle="项目列表" />
          <MineScopeToggle
            basePath={routes.progress.list}
            mine={mine}
            className="mb-6"
          />
          {projects.length === 0 ? (
            <p className="text-muted-foreground">暂无活跃项目</p>
          ) : (
            <ul className="space-y-2">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={routes.progress.project(project.id)}
                    className="flex items-center justify-between rounded-lg border p-3 hover:border-primary/30"
                  >
                    <div>
                      <p className="font-medium">{project.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatScopeItem(project.team)} /{" "}
                        {formatScopeItem(project.techGroup)} ·{" "}
                        {visibleTaskCounts.get(project.id) ?? 0} 个任务
                      </p>
                    </div>
                    <Badge variant="secondary">
                      {projectStatusLabels[project.status]}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
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
