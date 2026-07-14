import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Layers3,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { MineScopeToggle } from "@/components/progress/mine-scope-toggle";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import { projectStatusLabels } from "@/lib/progress-labels";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles } from "@/lib/permissions";
import { getStageReminderDueSoonDays } from "@/lib/progress-reminders";
import {
  compareProjectStageDeadlines,
  getProjectStageDeadlineState,
  type ProjectStageDeadlineState,
} from "@/lib/progress-stage-deadline";
import { getProjectStageOwnerNames } from "@/lib/progress-stage-owners";
import {
  progressProjectMineWhere,
  progressProjectReadableWhere,
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type DeadlineFilter = ProjectStageDeadlineState | "all";

const deadlineFilterOptions: Array<{
  key: DeadlineFilter;
  label: string;
  description: string;
  icon: typeof AlertTriangle;
}> = [
  { key: "all", label: "全部", description: "所有活跃项目", icon: Layers3 },
  { key: "overdue", label: "已超期", description: "当前阶段已过 DDL", icon: AlertTriangle },
  { key: "today", label: "今日到期", description: "当前阶段今天截止", icon: CalendarClock },
  { key: "dueSoon", label: "即将到期", description: "进入临期窗口", icon: Clock3 },
  { key: "normal", label: "正常推进", description: "尚未临期", icon: CheckCircle2 },
  { key: "none", label: "无当前阶段", description: "未启动或缺少 DDL", icon: CircleDashed },
];

export default async function ProgressListPage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const mine = readMineParam(params.mine);
  const deadlineFilter = readDeadlineFilter(params.deadline);
  const [liveVersion, roles, dueSoonDays] = await Promise.all([
    getCurrentUserLiveVersion("progress-list", undefined, { mine }),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
    getStageReminderDueSoonDays(),
  ]);
  const projects = await prisma.project.findMany({
    where: {
      AND: [
        progressProjectReadableWhere(roles, userOpenId),
        mine ? progressProjectMineWhere(userOpenId) : {},
        {
          status: {
            notIn: [
              "ESTABLISHING",
              "ESTABLISHMENT_REJECTED",
              "COMPLETED",
              "CANCELED",
            ],
          },
        },
      ],
    },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: {
        orderBy: { sortOrder: "asc" },
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  const visibleTaskCounts = await getVisibleTaskCounts(
    projects,
    roles,
    userOpenId,
    mine,
  );
  const now = new Date();
  const projectViews = projects
    .map((project) => ({
      project,
      deadline: getProjectStageDeadlineState(project, now, dueSoonDays),
      taskCount: visibleTaskCounts.get(project.id) ?? 0,
    }))
    .sort((a, b) => {
      const deadlineDiff = compareProjectStageDeadlines(a.deadline, b.deadline);
      if (deadlineDiff !== 0) return deadlineDiff;
      return b.project.updatedAt.getTime() - a.project.updatedAt.getTime();
    });
  const stats = getDeadlineStats(projectViews.map((item) => item.deadline.state));
  const visibleProjectViews = projectViews.filter(
    (item) => deadlineFilter === "all" || item.deadline.state === deadlineFilter,
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
            extraParams={{
              deadline: deadlineFilter === "all" ? undefined : deadlineFilter,
            }}
            className="mb-8"
          />

          {projects.length === 0 ? (
            <p className="text-muted-foreground">暂无活跃项目</p>
          ) : (
            <div className="space-y-6">
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {deadlineFilterOptions.map((option) => {
                  const Icon = option.icon;
                  const active = deadlineFilter === option.key;
                  return (
                    <Link
                      key={option.key}
                      href={buildDeadlineHref(option.key, mine)}
                      className={cn(
                        "rounded-lg border p-3 transition hover:border-primary/40 hover:bg-muted/30",
                        active && "border-primary bg-primary/5",
                        option.key !== "all" && deadlineSummaryTone(option.key),
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="truncate text-sm font-medium">
                            {option.label}
                          </span>
                        </div>
                        <span className="text-lg font-semibold">
                          {stats[option.key]}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {option.description}
                      </p>
                    </Link>
                  );
                })}
              </section>

              {visibleProjectViews.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  当前筛选下暂无项目
                </p>
              ) : (
                <ul className="space-y-3">
                  {visibleProjectViews.map(({ project, deadline, taskCount }) => (
                    <li key={project.id}>
                      <Link
                        href={routes.progress.project(project.id)}
                        className={cn(
                          "block rounded-lg border border-l-4 p-4 transition hover:border-primary/30",
                          deadlineCardTone(deadline.state),
                        )}
                      >
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate font-medium">{project.name}</p>
                              <DeadlineBadge
                                state={deadline.state}
                                label={deadline.label}
                              />
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {formatScopeItem(project.team)} /{" "}
                              {formatScopeItem(project.techGroup)} · {taskCount} 个任务
                            </p>
                            <p className="text-sm text-muted-foreground">
                              当前阶段：{deadline.stage?.name ?? "无"} · 负责人{" "}
                              {deadline.stage
                                ? getProjectStageOwnerNames(deadline.stage) || "未设置"
                                : "未设置"}
                            </p>
                            {deadline.dueAt && (
                              <p className="text-xs text-muted-foreground">
                                DDL {formatDateTime(deadline.dueAt)}
                              </p>
                            )}
                          </div>
                          <Badge variant="secondary" className="self-start">
                            {projectStatusLabels[project.status]}
                          </Badge>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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

function readMineParam(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.includes("1") : value === "1";
}

function readDeadlineFilter(value: string | string[] | undefined): DeadlineFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  return deadlineFilterOptions.some((option) => option.key === raw)
    ? (raw as DeadlineFilter)
    : "all";
}

function buildDeadlineHref(filter: DeadlineFilter, mine: boolean): string {
  const params = new URLSearchParams();
  if (mine) params.set("mine", "1");
  if (filter !== "all") params.set("deadline", filter);
  const query = params.toString();
  return query ? `${routes.progress.list}?${query}` : routes.progress.list;
}

function getDeadlineStats(states: ProjectStageDeadlineState[]) {
  const stats: Record<DeadlineFilter, number> = {
    all: states.length,
    overdue: 0,
    today: 0,
    dueSoon: 0,
    normal: 0,
    none: 0,
  };
  for (const state of states) {
    stats[state]++;
  }
  return stats;
}

function DeadlineBadge({
  state,
  label,
}: {
  state: ProjectStageDeadlineState;
  label: string;
}) {
  return (
    <Badge
      variant={state === "overdue" ? "destructive" : "outline"}
      className={deadlineBadgeTone(state)}
    >
      {label}
    </Badge>
  );
}

function deadlineSummaryTone(state: ProjectStageDeadlineState): string {
  switch (state) {
    case "overdue":
      return "border-destructive/30 bg-destructive/5 text-destructive";
    case "today":
      return "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/20 dark:text-orange-200";
    case "dueSoon":
      return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200";
    case "normal":
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200";
    case "none":
      return "border-border bg-muted/30 text-muted-foreground";
  }
}

function deadlineCardTone(state: ProjectStageDeadlineState): string {
  switch (state) {
    case "overdue":
      return "border-l-destructive bg-destructive/5 hover:border-l-destructive";
    case "today":
      return "border-l-orange-500 bg-orange-50/70 dark:bg-orange-950/20";
    case "dueSoon":
      return "border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/20";
    case "normal":
      return "border-l-emerald-500 bg-background";
    case "none":
      return "border-l-border bg-background";
  }
}

function deadlineBadgeTone(state: ProjectStageDeadlineState): string {
  switch (state) {
    case "overdue":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "today":
      return "border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-900/70 dark:bg-orange-950/40 dark:text-orange-200";
    case "dueSoon":
      return "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200";
    case "normal":
      return "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "none":
      return "border-border bg-muted/50 text-muted-foreground";
  }
}

function formatDateTime(value: Date): string {
  return value.toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
