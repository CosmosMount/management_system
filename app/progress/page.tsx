import Link from "next/link";
import type { Prisma } from "@prisma/client";
import {
  Archive,
  ClipboardCheck,
  FolderKanban,
  LayoutDashboard,
  Plus,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { NavCard } from "@/components/nav-card";
import {
  ProjectEstablishmentPanel,
  type ProjectEstablishmentView,
} from "@/components/progress/project-establishment-panel";
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
import { getProjectStageOwnerNames } from "@/lib/progress-stage-owners";
import {
  canRequestProjectEstablishment,
  canReviewProjectEstablishment,
  isAssignee,
  isProjectManager,
  isProgressSuperAdmin,
  isTeamLead,
  isTechGroupLead,
  progressProjectMineWhere,
  progressProjectReadableWhere,
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles } from "@/lib/permissions";
import { getStageReminderDueSoonDays } from "@/lib/progress-reminders";
import {
  compareProjectStageDeadlines,
  getProjectStageDeadlineState,
  type ProjectStageDeadlineState,
} from "@/lib/progress-stage-deadline";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProgressHomePage({ searchParams }: Props) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const mine = await readMineSearchParam(searchParams);
  const [liveVersion, roles, dueSoonDays] = await Promise.all([
    getCurrentUserLiveVersion("progress-list", undefined, { mine }),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
    getStageReminderDueSoonDays(),
  ]);
  const showCreate = canRequestProjectEstablishment(userOpenId);

  const [projects, establishmentViews] = await Promise.all([
    prisma.project.findMany({
      where: {
        AND: [
          progressProjectReadableWhere(roles, userOpenId),
          mine ? progressProjectMineWhere(userOpenId) : {},
          {
            status: {
              notIn: [
                "ESTABLISHING",
              "ESTABLISHMENT_REJECTED",
              "ESTABLISHMENT_WITHDRAWN",
                "COMPLETED",
                "CANCELED",
              ],
            },
          },
        ],
      },
      include: {
        owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        stages: {
          orderBy: { sortOrder: "asc" },
          include: {
            owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    getProjectEstablishmentViews(roles, userOpenId),
  ]);
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
    })
    .slice(0, 20);

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
                title="提交立项"
                description="提交项目计划，通过立项后再启动项目"
                icon={Plus}
              />
            )}
            <NavCard
              variant="wide"
              href={routes.progress.approvals}
              title="审批看板"
              description="集中查看当前账号需要处理的项目审批"
              icon={ClipboardCheck}
            />
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

          <ProjectEstablishmentPanel projects={establishmentViews} />

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
                  {projectViews.map(({ project, deadline, taskCount }) => (
                    <li key={project.id}>
                      <Link
                        href={routes.progress.project(project.id)}
                        className={cn(
                          "flex flex-col gap-3 rounded-lg border border-l-4 p-3 transition hover:border-primary/30 sm:flex-row sm:items-center sm:justify-between",
                          deadlineCardTone(deadline.state),
                        )}
                      >
                        <div className="min-w-0">
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
                          <p className="truncate text-xs text-muted-foreground">
                            当前阶段：{deadline.stage?.name ?? "无"}
                          </p>
                        </div>
                        <Badge variant="secondary" className="self-start sm:self-center">
                          {projectStatusLabels[project.status]}
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

async function getProjectEstablishmentViews(
  roles: Awaited<ReturnType<typeof getUserRoles>>,
  userOpenId?: string,
): Promise<ProjectEstablishmentView[]> {
  if (!userOpenId) return [];
  const canViewRejectedDrafts = isProgressSuperAdmin(roles);
  const visibilityWhere: Prisma.ProjectWhereInput[] = [
    { requesterOpenId: userOpenId },
    { status: "ESTABLISHING" },
  ];
  if (canViewRejectedDrafts) {
    visibilityWhere.push({ status: "ESTABLISHMENT_REJECTED" });
    visibilityWhere.push({ status: "ESTABLISHMENT_WITHDRAWN" });
  }
  const projects = await prisma.project.findMany({
    where: {
      OR: visibilityWhere,
      status: {
        in: [
          "ESTABLISHING",
          "ESTABLISHMENT_REJECTED",
          "ESTABLISHMENT_WITHDRAWN",
        ],
      },
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
    orderBy: { createdAt: "desc" },
    take: 80,
  });
  return projects
    .map((project): ProjectEstablishmentView | null => {
      const scope = {
        team: project.team,
        techGroup: project.techGroup,
      };
      const canReview =
        project.status === "ESTABLISHING" &&
        canReviewProjectEstablishment(roles, scope);
      const isMine = project.requesterOpenId === userOpenId;
      const canRequestApprovalReminder =
        project.status === "ESTABLISHING" &&
        (isMine ||
          isAssignee(userOpenId, project.owners.map((owner) => owner.openId)) ||
          isAssignee(
            userOpenId,
            project.participants.map((participant) => participant.openId),
          ) ||
          isProgressSuperAdmin(roles) ||
          isProjectManager(roles) ||
          isTeamLead(roles, project.team) ||
          isTechGroupLead(roles, project.techGroup));
      const canDelete =
        (project.status === "ESTABLISHMENT_REJECTED" ||
          project.status === "ESTABLISHMENT_WITHDRAWN") &&
        (isMine || isProgressSuperAdmin(roles));
      if (!canReview && !isMine && !canDelete && !canRequestApprovalReminder) {
        return null;
      }

      return {
        id: project.id,
        status:
          project.status === "ESTABLISHMENT_REJECTED"
            ? "ESTABLISHMENT_REJECTED"
            : project.status === "ESTABLISHMENT_WITHDRAWN"
              ? "ESTABLISHMENT_WITHDRAWN"
              : "ESTABLISHING",
        requesterName: project.requesterName,
        projectName: project.name,
        team: scope.team,
        techGroup: scope.techGroup,
        ownerNames: project.owners.map((owner) => owner.name).join("、"),
        participantNames: project.participants
          .map((participant) => participant.name)
          .join("、"),
        stageCount: project.stages.length,
        stages: project.stages.map((stage, index) => {
          const previousDueAt = index > 0 ? project.stages[index - 1]?.dueAt : null;
          return {
            name: stage.name,
            goal: stage.goal,
            ownerNames: getProjectStageOwnerNames(stage),
            durationDays: getStageDurationDays(
              project.submittedAt ?? project.createdAt,
              previousDueAt,
              stage.dueAt,
            ),
            duePreview: stage.dueAt ? formatDateTime(stage.dueAt) : "未设置",
          };
        }),
        submittedAt: (project.submittedAt ?? project.createdAt).toISOString(),
        reviewerName: project.reviewerName,
        reviewComment: project.reviewComment,
        reviewedAt: project.reviewedAt?.toISOString() ?? null,
        canResubmit:
          (project.status === "ESTABLISHMENT_REJECTED" ||
            project.status === "ESTABLISHMENT_WITHDRAWN") &&
          isMine,
        canReview,
        canDelete,
        canRequestApprovalReminder,
        canWithdraw: project.status === "ESTABLISHING" && isMine,
      };
    })
    .filter((project): project is ProjectEstablishmentView => !!project)
    .slice(0, 20);
}

function getStageDurationDays(
  submittedAt: Date,
  previousDueAt: Date | null | undefined,
  dueAt: Date | null,
) {
  if (!dueAt) return 0;
  const base = previousDueAt ?? submittedAt;
  return Math.max(1, localDayNumber(dueAt) - localDayNumber(base));
}

function localDayNumber(date: Date): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() /
      86_400_000,
  );
}

function formatDateTime(date: Date): string {
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
