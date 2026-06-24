import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProgressKanban } from "@/components/progress/progress-kanban";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
import { prisma } from "@/lib/prisma";

export default async function ProgressDashboardPage() {
  const liveVersion = await getCurrentUserLiveVersion("progress");
  const tasks = await prisma.task.findMany({
    where: { status: { not: "ARCHIVED" } },
    include: {
      project: { select: { name: true } },
      stage: { select: { name: true } },
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
    orderBy: [{ isOverdue: "desc" }, { dueAt: "asc" }],
  });

  const rows = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    projectName: t.project.name,
    stageName: t.stage?.name ?? null,
    assigneeNames: getTaskAssigneeNames(t),
    team: t.team,
    techGroup: t.techGroup,
    category: t.category,
    urgency: t.urgency,
    status: t.status,
    isOverdue: t.isOverdue,
    hasRisk: !!t.riskNote,
    dueAt: t.dueAt.toISOString(),
  }));

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress"
        initialVersion={liveVersion}
        intervalMs={6000}
      />
      <PageShell>
        <ProgressPageLayout>
          <ProgressBackLink />
          <PageTitle subtitle="任务看板" />
          <ProgressKanban tasks={rows} />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
