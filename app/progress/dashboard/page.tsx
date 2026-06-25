import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProgressKanban } from "@/components/progress/progress-kanban";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import {
  MineScopeToggle,
  readMineSearchParam,
} from "@/components/progress/mine-scope-toggle";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles } from "@/lib/permissions";
import {
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
import { prisma } from "@/lib/prisma";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProgressDashboardPage({ searchParams }: Props) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const mine = await readMineSearchParam(searchParams);
  const [liveVersion, roles] = await Promise.all([
    getCurrentUserLiveVersion("progress-board", undefined, { mine }),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
  ]);
  const tasks = await prisma.task.findMany({
    where: {
      AND: [
        progressTaskReadableWhere(roles, userOpenId),
        mine ? progressTaskMineWhere(userOpenId) : {},
        { status: { not: "ARCHIVED" } },
      ],
    },
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
        scope="progress-board"
        initialVersion={liveVersion}
        intervalMs={6000}
        mine={mine}
      />
      <PageShell>
        <ProgressPageLayout>
          <ProgressBackLink />
          <PageTitle subtitle="任务看板" />
          <MineScopeToggle
            basePath="/progress/dashboard"
            mine={mine}
            className="mb-6"
          />
          <ProgressKanban tasks={rows} />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
