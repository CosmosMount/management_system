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
import { getTaskDeadlineState } from "@/lib/progress-deadline";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import {
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
import { getProgressReminderRuleViews } from "@/lib/progress-reminders";
import { prisma } from "@/lib/prisma";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProgressDashboardPage({ searchParams }: Props) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const mine = await readMineSearchParam(searchParams);
  const [liveVersion, roles, reminderRules] = await Promise.all([
    getCurrentUserLiveVersion("progress-board", undefined, { mine }),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
    getProgressReminderRuleViews(),
  ]);
  const dueSoonDays =
    reminderRules.find((rule) => rule.kind === "TASK_DUE_SOON")?.params
      .dueSoonDays ?? 2;
  const now = new Date();
  const tasks = await prisma.task.findMany({
    where: {
      AND: [
        progressTaskReadableWhere(roles, userOpenId),
        mine ? progressTaskMineWhere(userOpenId) : {},
        { status: { notIn: ["ARCHIVED", "PROJECT_CANCELED"] } },
      ],
    },
    include: {
      project: { select: { name: true } },
      stage: { select: { name: true } },
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
    orderBy: [{ isOverdue: "desc" }, { dueAt: "asc" }],
  });

  const rows = tasks.map((t) => {
    const deadline = getTaskDeadlineState(
      {
        dueAt: t.dueAt,
        status: t.status,
        isOverdue: t.isOverdue,
      },
      now,
      dueSoonDays,
    );

    return {
      id: t.id,
      title: t.title,
      projectName: t.project.name,
      stageName: t.stage?.name ?? null,
      assigneeNames: getTaskAssigneeNames(t),
      team: t.team,
      techGroup: t.techGroup,
      taskTechGroups: getTaskTechGroups(t),
      urgency: t.urgency,
      importance: t.importance,
      status: t.status,
      isOverdue: deadline.state === "overdue",
      hasRisk: !!t.riskNote,
      dueAt: t.dueAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      deadlineState: deadline.state,
      deadlineLabel: deadline.label,
      daysDelta: deadline.daysDelta,
    };
  });

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
          <ProgressKanban tasks={rows} dueSoonDays={dueSoonDays} />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
