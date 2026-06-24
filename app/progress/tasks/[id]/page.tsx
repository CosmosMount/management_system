import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import {
  TaskDetailWorkspace,
  type TaskDetailView,
} from "@/components/progress/task-detail-workspace";
import { PageShell } from "@/components/page-shell";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  canApproveTask,
  canManageProject,
  canSubmitDelivery,
} from "@/lib/permissions-progress";
import {
  getTaskAssigneeNames,
  getTaskAssigneeOpenIds,
} from "@/lib/progress-assignees";
import { getRecentActivityCutoff } from "@/lib/progress-activity-window";
import { prisma } from "@/lib/prisma";

type Props = { params: Promise<{ id: string }> };

export default async function TaskDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];
  const recentActivityCutoff = getRecentActivityCutoff();

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      project: true,
      stage: true,
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      submissions: {
        orderBy: { submittedAt: "desc" },
        include: { approvals: { orderBy: { createdAt: "asc" } } },
      },
      weeklyReports: { orderBy: { submittedAt: "desc" }, take: 8 },
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

  const scope = { team: task.team, techGroup: task.techGroup };
  const isAssignee = canSubmitDelivery(
    userOpenId,
    getTaskAssigneeOpenIds(task),
  );
  const canApprove = canApproveTask(roles, scope);
  const canManage = canManageProject(
    roles,
    scope,
    task.project.ownerOpenId,
    userOpenId,
  );

  const taskView: TaskDetailView = {
    id: task.id,
    title: task.title,
    goal: task.goal,
    category: task.category,
    urgency: task.urgency,
    importance: task.importance,
    status: task.status,
    isOverdue: task.isOverdue,
    assigneeNames: getTaskAssigneeNames(task),
    assigneeOpenIds: getTaskAssigneeOpenIds(task),
    projectId: task.projectId,
    projectName: task.project.name,
    projectOwnerOpenId: task.project.ownerOpenId,
    stageId: task.stageId,
    stageName: task.stage?.name ?? null,
    team: task.team,
    techGroup: task.techGroup,
    metrics: task.metrics,
    dueAt: task.dueAt.toISOString(),
    needsOfflineConfirmation: task.needsOfflineConfirmation,
    needsWeeklyReport: task.needsWeeklyReport,
    riskNote: task.riskNote,
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
      })),
    })),
    weeklyReports: task.weeklyReports.map((report) => ({
      id: report.id,
      weekStart: report.weekStart.toISOString(),
      progress: report.progress,
      risks: report.risks,
      nextPlan: report.nextPlan,
      feishuDocUrl: report.feishuDocUrl,
      submitterName: report.submitterName,
      submittedAt: report.submittedAt.toISOString(),
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
      <PageShell>
        <TaskDetailWorkspace
          task={taskView}
          isAssignee={isAssignee}
          canApprove={canApprove}
          canManage={canManage}
        />
      </PageShell>
    </>
  );
}
