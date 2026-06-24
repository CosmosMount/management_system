import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import {
  ProjectDetailWorkspace,
  type ProjectDetailView,
} from "@/components/progress/project-detail-workspace";
import { PageShell } from "@/components/page-shell";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  canManageProject,
  canApproveStage as canApproveStagePermission,
  canSubmitStage as canSubmitStagePermission,
  canUpdateProjectLifecycle,
} from "@/lib/permissions-progress";
import {
  getTaskAssigneeNames,
  getTaskAssigneeOpenIds,
} from "@/lib/progress-assignees";
import { getRecentActivityCutoff } from "@/lib/progress-activity-window";
import { prisma } from "@/lib/prisma";

type Props = { params: Promise<{ id: string }> };

export default async function ProjectDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];
  const recentActivityCutoff = getRecentActivityCutoff();

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      stages: {
        orderBy: { sortOrder: "asc" },
        include: {
          submissions: {
            orderBy: { submittedAt: "desc" },
            include: { approvals: { orderBy: { createdAt: "asc" } } },
          },
        },
      },
      tasks: {
        orderBy: { createdAt: "desc" },
        include: {
          stage: { select: { name: true } },
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          _count: { select: { submissions: true } },
        },
      },
      activityLogs: {
        where: { createdAt: { gte: recentActivityCutoff } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      },
    },
  });

  if (!project) notFound();

  const scope = { team: project.team, techGroup: project.techGroup };
  const canManage = canManageProject(
    roles,
    scope,
    project.ownerOpenId,
    userOpenId,
  );
  const canUpdateLifecycle = canUpdateProjectLifecycle(
    roles,
    project.ownerOpenId,
    userOpenId,
  );

  const users = await prisma.user.findMany({
    orderBy: { name: "asc" },
    select: { openId: true, name: true, avatar: true },
  });
  const activityLogCount = await prisma.progressActivityLog.count({
    where: { projectId: project.id },
  });

  const projectView: ProjectDetailView = {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    team: project.team,
    techGroup: project.techGroup,
    ownerOpenId: project.ownerOpenId,
    ownerName: project.ownerName,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    completedAt: project.completedAt?.toISOString() ?? null,
    canceledAt: project.canceledAt?.toISOString() ?? null,
    stages: project.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      goal: stage.goal,
      sortOrder: stage.sortOrder,
      status: stage.status,
      evidenceUrl: stage.evidenceUrl,
      ownerOpenId: stage.ownerOpenId,
      ownerName: stage.ownerName,
      dueAt: stage.dueAt?.toISOString() ?? null,
      currentSubmissionId: stage.currentSubmissionId,
      canSubmit: canSubmitStagePermission(roles, stage.ownerOpenId, userOpenId),
      submissions: stage.submissions.map((submission) => ({
        id: submission.id,
        feishuDocUrl: submission.feishuDocUrl,
        note: submission.note,
        submittedBy: submission.submittedBy,
        submitterName: submission.submitterName,
        submittedAt: submission.submittedAt.toISOString(),
        canApprove: canApproveStagePermission(
          roles,
          scope,
          project.ownerOpenId,
          submission.submittedBy,
          project.allowOwnerSelfApproval,
          userOpenId,
        ),
        approvals: submission.approvals.map((approval) => ({
          id: approval.id,
          decision: approval.decision,
          approverName: approval.approverName,
          comment: approval.comment,
          createdAt: approval.createdAt.toISOString(),
        })),
      })),
    })),
    tasks: project.tasks.map((task) => ({
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
      stageId: task.stageId,
      stageName: task.stage?.name ?? null,
      metrics: task.metrics,
      dueAt: task.dueAt.toISOString(),
      riskNote: task.riskNote,
      submissionsCount: task._count.submissions,
    })),
    activityLogs: project.activityLogs.map((log) => ({
      id: log.id,
      action: log.action,
      taskId: log.taskId,
      actorName: log.actorName,
      payload: log.payload,
      createdAt: log.createdAt.toISOString(),
    })),
    hasMoreActivityLogs: activityLogCount > project.activityLogs.length,
  };

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProjectDetailWorkspace
          project={projectView}
          users={users}
          canManage={canManage}
          canUpdateLifecycle={canUpdateLifecycle}
          userOpenId={userOpenId}
        />
      </PageShell>
    </>
  );
}
