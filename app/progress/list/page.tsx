import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
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
  canManageProject,
  progressProjectReadableWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export default async function ProgressListPage() {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const [liveVersion, roles] = await Promise.all([
    getCurrentUserLiveVersion("progress-list"),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
  ]);
  const projects = await prisma.project.findMany({
    where: {
      AND: [
        progressProjectReadableWhere(roles, userOpenId),
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
  );

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress-list"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <ProgressPageLayout>
          <ProgressBackLink />
          <PageTitle subtitle="项目列表" />
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
    team: string;
    techGroup: string;
    ownerOpenId: string;
    owners: Array<{ openId: string }>;
  }>,
  roles: Awaited<ReturnType<typeof getUserRoles>>,
  userOpenId?: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const managedProjectIds: string[] = [];
  const limitedProjectIds: string[] = [];
  for (const project of projects) {
    if (
        canManageProject(
        roles,
        { team: project.team, techGroup: project.techGroup },
        project.owners.length > 0
          ? project.owners.map((owner) => owner.openId)
          : [project.ownerOpenId],
        userOpenId,
      )
    ) {
      managedProjectIds.push(project.id);
    } else {
      limitedProjectIds.push(project.id);
    }
  }

  for (const projectId of [...managedProjectIds, ...limitedProjectIds]) {
    counts.set(projectId, 0);
  }

  const managedGrouped =
    managedProjectIds.length > 0
      ? await prisma.task.groupBy({
          by: ["projectId"],
          where: { projectId: { in: managedProjectIds }, deletedAt: null },
          _count: { _all: true },
        })
      : [];
  const limitedGrouped =
    limitedProjectIds.length > 0
      ? await prisma.task.groupBy({
          by: ["projectId"],
          where: {
            AND: [
              progressTaskReadableWhere(roles, userOpenId),
              { projectId: { in: limitedProjectIds } },
            ],
          },
          _count: { _all: true },
        })
      : [];

  for (const row of [...managedGrouped, ...limitedGrouped]) {
    counts.set(row.projectId, row._count._all);
  }
  return counts;
}

function formatScopeItem(value: string): string {
  return value || "未指定";
}
