import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import {
  TaskDetailWorkspace,
  type TaskDetailView,
} from "@/components/progress/task-detail-workspace";
import { PageShell } from "@/components/page-shell";
import { auth } from "@/lib/auth";
import { getUserRoles, isSuperAdmin } from "@/lib/permissions";
import {
  canApproveTask,
  canManageProject,
  canRequestTaskDdlChange,
  canRequestTaskDeletion,
  canReviewTaskDdlChange,
  canSyncTaskRisk,
  canSubmitDelivery,
  canSubmitTaskWeeklyReport,
  canViewTask,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import {
  getTaskAssigneeNames,
  getTaskAssigneeOpenIds,
} from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getProjectParticipantOpenIds } from "@/lib/progress-project-participants";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import {
  getWeekStart,
  getWeeklyReportDueState,
} from "@/lib/progress-weekly";
import { getProgressReminderRuleViews } from "@/lib/progress-reminders";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getRecentActivityCutoff } from "@/lib/progress-activity-window";
import { prisma } from "@/lib/prisma";

type Props = { params: Promise<{ id: string }> };

export default async function TaskDetailPage({ params }: Props) {
  const { id } = await params;
  const liveVersion = await getCurrentUserLiveVersion("progress-task", id);
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];
  const recentActivityCutoff = getRecentActivityCutoff();

  const task = await prisma.task.findFirst({
    where: {
      id,
      AND: progressTaskReadableWhere(roles, userOpenId),
    },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
          stages: { orderBy: { sortOrder: "asc" } },
        },
      },
      stage: true,
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      acceptanceChecklistItems: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
      submissions: {
        orderBy: { submittedAt: "desc" },
        include: {
          approvals: {
            orderBy: { createdAt: "asc" },
            include: {
              checklistConfirmations: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
        },
      },
      weeklyReports: { orderBy: { submittedAt: "desc" }, take: 8 },
      ddlChangeRequests: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 8,
      },
      riskRecords: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
      },
      deletionRequests: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
      },
      activityLogs: {
        where: { createdAt: { gte: recentActivityCutoff } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      },
    },
  });

  if (!task) notFound();
  const activityLogCount = await prisma.progressActivityLog.count({
    where: { taskId: task.id },
  });

  const projectOwnerOpenIds = getProjectOwnerOpenIds(task.project);

  const scope = { team: task.team, techGroup: task.techGroup };
  if (
    !canViewTask(
      roles,
      scope,
      projectOwnerOpenIds,
      getTaskAssigneeOpenIds(task),
      userOpenId,
      task.stage?.ownerOpenId,
    )
  ) {
    notFound();
  }
  const isAssignee = canSubmitDelivery(
    userOpenId,
    getTaskAssigneeOpenIds(task),
  );
  const canApprove = canApproveTask(roles, scope);
  const canManage = canManageProject(
    roles,
    scope,
    projectOwnerOpenIds,
    userOpenId,
  );
  const taskTechGroups = getTaskTechGroups(task);
  const canSubmitTaskWeekly =
    task.project.status !== "COMPLETED" &&
    task.project.status !== "CANCELED" &&
    task.needsWeeklyReport &&
    (task.status === "IN_PROGRESS" || task.status === "PENDING_ACCEPTANCE") &&
    canSubmitTaskWeeklyReport({
      roles,
      scope,
      projectOwnerOpenIds,
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      taskTechGroups,
      userOpenId,
    });
  const canSyncRisk =
    task.project.status !== "COMPLETED" &&
    task.project.status !== "CANCELED" &&
    task.status !== "COMPLETED" &&
    task.status !== "ARCHIVED" &&
    task.status !== "PROJECT_CANCELED" &&
    canSyncTaskRisk({
      roles,
      scope,
      projectOwnerOpenIds,
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      taskTechGroups,
      userOpenId,
    });
  const canRequestDdlChange =
    task.project.status !== "COMPLETED" &&
    task.project.status !== "CANCELED" &&
    task.status !== "COMPLETED" &&
    task.status !== "ARCHIVED" &&
    task.status !== "PROJECT_CANCELED" &&
    canRequestTaskDdlChange({
      projectOwnerOpenIds,
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      userOpenId,
    });
  const canReviewDdlChange = canReviewTaskDdlChange({
    roles,
    scope,
    projectOwnerOpenIds,
    taskTechGroups,
    userOpenId,
  });
  const canRequestDeletion =
    task.status !== "PROJECT_CANCELED" &&
    !canManage &&
    canRequestTaskDeletion({
      roles,
      scope,
      ownerOpenIds: projectOwnerOpenIds,
      participantOpenIds: getProjectParticipantOpenIds(task.project),
      stageOwnerOpenId: task.stage?.ownerOpenId,
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      userOpenId,
    });
  const admin = userOpenId ? await isSuperAdmin(userOpenId) : false;
  const [users, acceptanceChecklistTemplates, reminderRules] = await Promise.all([
    canManage
      ? prisma.user.findMany({
          orderBy: { name: "asc" },
          select: { openId: true, name: true, avatar: true },
        })
      : Promise.resolve([]),
    canManage
      ? prisma.acceptanceChecklistTemplate.findMany({
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true, content: true },
        })
      : Promise.resolve([]),
    getProgressReminderRuleViews(),
  ]);
  const weeklyReminderWeekday =
    reminderRules.find((rule) => rule.kind === "WEEKLY_REPORT_MISSING")?.params
      .weekday ?? 5;
  const currentWeekStart = getWeekStart();
  const hasCurrentWeekReport = task.weeklyReports.some(
    (report) => report.weekStart.getTime() === currentWeekStart.getTime(),
  );
  const weeklyReportDueState = getWeeklyReportDueState({
    weekday: weeklyReminderWeekday,
    submitted: hasCurrentWeekReport,
  });

  const taskView: TaskDetailView = {
    id: task.id,
    title: task.title,
    goal: task.goal,
    taskTechGroups,
    urgency: task.urgency,
    importance: task.importance,
    status: task.status,
    isOverdue: task.status === "PROJECT_CANCELED" ? false : task.isOverdue,
    assigneeNames: getTaskAssigneeNames(task),
    assigneeOpenIds: getTaskAssigneeOpenIds(task),
    projectId: task.projectId,
    projectName: task.project.name,
    projectStatus: task.project.status,
    projectOwnerOpenIds,
    updatedAt: task.updatedAt.toISOString(),
    stageId: task.stageId,
    stageName: task.stage?.name ?? null,
    team: task.team,
    techGroup: task.techGroup,
    metrics: task.metrics,
    dueAt: task.dueAt.toISOString(),
    needsOfflineConfirmation: task.needsOfflineConfirmation,
    needsWeeklyReport: task.needsWeeklyReport,
    weeklyReportDueLabel:
      task.needsWeeklyReport &&
      (task.status === "IN_PROGRESS" || task.status === "PENDING_ACCEPTANCE")
      ? weeklyReportDueState.label
      : "",
    acceptanceChecklistItems: task.acceptanceChecklistItems.map((item) => ({
      id: item.id,
      content: item.content,
      sortOrder: item.sortOrder,
    })),
    acceptanceChecklistLocked:
      task.submissions.length > 0 ||
      task.status === "PENDING_ACCEPTANCE" ||
      task.status === "COMPLETED" ||
      task.status === "ARCHIVED" ||
      task.status === "PROJECT_CANCELED",
    riskNote: task.riskNote,
    riskRecords: task.riskRecords.map((risk) => ({
      id: risk.id,
      content: risk.content,
      source: risk.source,
      status: risk.status,
      createdByName: risk.createdByName,
      resolvedByName: risk.resolvedByName,
      resolveNote: risk.resolveNote,
      createdAt: risk.createdAt.toISOString(),
      resolvedAt: risk.resolvedAt?.toISOString() ?? null,
    })),
    submissions: task.submissions.map((submission) => ({
      id: submission.id,
      feishuDocUrl: submission.feishuDocUrl,
      keyDataUrl: submission.keyDataUrl,
      note: submission.note,
      failureReason: submission.failureReason,
      submittedAt: submission.submittedAt.toISOString(),
      submitterName: submission.submitterName,
        approvals: submission.approvals.map((approval) => ({
          id: approval.id,
          approverName: approval.approverName,
          decision: approval.decision,
          comment: approval.comment,
          createdAt: approval.createdAt.toISOString(),
          checklistConfirmations: approval.checklistConfirmations.map(
            (item) => ({
              id: item.id,
              content: item.content,
              sortOrder: item.sortOrder,
            }),
          ),
        })),
      })),
    weeklyReports: task.weeklyReports.map((report) => ({
      id: report.id,
      weekStart: report.weekStart.toISOString(),
      progress: report.progress,
      nextPlan: report.nextPlan,
      feishuDocUrl: report.feishuDocUrl,
      submitterName: report.submitterName,
      submittedAt: report.submittedAt.toISOString(),
    })),
    deletionRequests: task.deletionRequests.map((request) => ({
      id: request.id,
      requesterName: request.requesterName,
      reason: request.reason,
      status: request.status,
      reviewerName: request.reviewerName,
      reviewComment: request.reviewComment,
      createdAt: request.createdAt.toISOString(),
      reviewedAt: request.reviewedAt?.toISOString() ?? null,
    })),
    ddlChangeRequests: task.ddlChangeRequests.map((request) => ({
      id: request.id,
      requesterOpenId: request.requesterOpenId,
      requesterName: request.requesterName,
      oldDueAt: request.oldDueAt.toISOString(),
      newDueAt: request.newDueAt.toISOString(),
      reason: request.reason,
      status: request.status,
      reviewerName: request.reviewerName,
      reviewComment: request.reviewComment,
      createdAt: request.createdAt.toISOString(),
      reviewedAt: request.reviewedAt?.toISOString() ?? null,
    })),
    activityLogs: task.activityLogs.map((log) => ({
      id: log.id,
      action: log.action,
      actorName: log.actorName,
      payload: log.payload,
      createdAt: log.createdAt.toISOString(),
    })),
    hasMoreActivityLogs: activityLogCount > task.activityLogs.length,
  };

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress-task"
        resourceId={task.id}
        initialVersion={liveVersion}
        intervalMs={5000}
      />
      <PageShell>
        <TaskDetailWorkspace
          task={taskView}
          users={users}
          stages={task.project.stages.map((stage) => ({
            id: stage.id,
            name: stage.name,
          }))}
          acceptanceChecklistTemplates={acceptanceChecklistTemplates}
          isAssignee={isAssignee}
          canApprove={canApprove}
          canManage={canManage}
          canRequestDeletion={canRequestDeletion}
          canSubmitWeeklyReport={canSubmitTaskWeekly}
          canSyncRisk={canSyncRisk}
          canRequestDdlChange={canRequestDdlChange}
          canReviewDdlChange={canReviewDdlChange}
          isSuperAdmin={admin}
        />
      </PageShell>
    </>
  );
}
