import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import { projectStatusLabels } from "@/lib/progress-labels";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export default async function ProgressListPage() {
  const liveVersion = await getCurrentUserLiveVersion("progress");
  const projects = await prisma.project.findMany({
    where: { status: { notIn: ["COMPLETED", "CANCELED"] } },
    include: { _count: { select: { tasks: true } } },
    orderBy: { updatedAt: "desc" },
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
                        {project._count.tasks} 个任务
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

function formatScopeItem(value: string): string {
  return value || "未指定";
}
