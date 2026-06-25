import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import {
  ProjectDetailWorkspace,
  type ProjectDetailView,
} from "@/components/progress/project-detail-workspace";
import { PageShell } from "@/components/page-shell";
import { auth } from "@/lib/auth";
import { getUserRoles, isSuperAdmin } from "@/lib/permissions";
import {
  canManageProject,
  canRequestTaskCreation,
  canViewProject,
  canApproveStage as canApproveStagePermission,
  canSubmitStage as canSubmitStagePermission,
  canUpdateProjectLifecycle,
  progressProjectReadableWhere,
} from "@/lib/permissions-progress";
import {
  getTaskAssigneeNames,
  getTaskAssigneeOpenIds,
} from "@/lib/progress-assignees";
import {
  getProjectOwnerNames,
  getProjectOwnerOpenIds,
} from "@/lib/progress-project-owners";
import {
  getProjectParticipantNames,
  getProjectParticipantOpenIds,
} from "@/lib/progress-project-participants";
import {
  parseTaskCreationDraft,
  formatTaskCreationDraftSummary,
} from "@/lib/progress-task-creation-requests";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getRecentActivityCutoff } from "@/lib/progress-activity-window";
import { prisma } from "@/lib/prisma";

type Props = { params: Promise<{ id: string }> };

export default async function ProjectDetailPage({ params }: Props) {
  const { id } = await params;
  const liveVersion = await getCurrentUserLiveVersion("progress-project", id);
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];
  const recentActivityCutoff = getRecentActivityCutoff();

  const project = await prisma.project.findFirst({
    where: {
      id,
      AND: progressProjectReadableWhere(roles, userOpenId),
    },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
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
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: {
          stage: { select: { name: true } },
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          deletionRequests: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              status: true,
              requesterOpenId: true,
              requesterName: true,
              createdAt: true,
            },
          },
          creationRequests: {
            select: { requesterOpenId: true },
          },
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
  const projectOwnerOpenIds = getProjectOwnerOpenIds(project);
  const projectParticipantOpenIds = getProjectParticipantOpenIds(project);
  const stageOwnerOpenIds = project.stages
    .map((stage) => stage.ownerOpenId)
    .filter(Boolean);
  const taskAssigneeOpenIds = [
    ...new Set(project.tasks.flatMap((task) => getTaskAssigneeOpenIds(task))),
  ];
  if (
    !canViewProject(
      roles,
      scope,
      projectOwnerOpenIds,
      stageOwnerOpenIds,
      taskAssigneeOpenIds,
      userOpenId,
    )
  ) {
    notFound();
  }
  const canManage = canManageProject(
    roles,
    scope,
    projectOwnerOpenIds,
    userOpenId,
  );
  const canRequestTask =
    !canManage &&
    canRequestTaskCreation({
      roles,
      scope,
      ownerOpenIds: projectOwnerOpenIds,
      participantOpenIds: projectParticipantOpenIds,
      stageOwnerOpenIds,
      taskAssigneeOpenIds,
      userOpenId,
    });
  const canUpdateLifecycle = canUpdateProjectLifecycle(
    roles,
    scope,
    projectOwnerOpenIds,
    userOpenId,
  );
  const admin = userOpenId ? await isSuperAdmin(userOpenId) : false;

  const [
    users,
    acceptanceChecklistTemplates,
    activityLogCount,
    taskCreationRequests,
  ] =
    await Promise.all([
      canManage || canRequestTask
        ? prisma.user.findMany({
            orderBy: { name: "asc" },
            select: { openId: true, name: true, avatar: true },
          })
        : Promise.resolve([]),
      canManage || canRequestTask
        ? prisma.acceptanceChecklistTemplate.findMany({
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
            select: { id: true, content: true },
          })
        : Promise.resolve([]),
      prisma.progressActivityLog.count({
        where: { projectId: project.id },
      }),
      getRelevantTaskCreationRequests(project.id, canManage, userOpenId),
    ]);
  const visibleTaskIds = new Set(project.tasks.map((task) => task.id));

  const projectView: ProjectDetailView = {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    team: project.team,
    techGroup: project.techGroup,
    ownerOpenId: project.ownerOpenId,
    ownerName: project.ownerName,
    ownerOpenIds: projectOwnerOpenIds,
    ownerNames: getProjectOwnerNames(project),
    participantOpenIds: projectParticipantOpenIds,
    participantNames: getProjectParticipantNames(project),
    allowOwnerSelfApproval: project.allowOwnerSelfApproval,
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
          projectOwnerOpenIds,
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
    tasks: project.tasks.map((task) => {
      const assigneeOpenIds = getTaskAssigneeOpenIds(task);
      const pendingDeletionRequest = task.deletionRequests.find(
        (request) => request.status === "PENDING",
      );
      return {
        id: task.id,
        title: task.title,
        goal: task.goal,
        category: task.category,
        urgency: task.urgency,
        importance: task.importance,
        status: task.status,
        isOverdue: task.status === "PROJECT_CANCELED" ? false : task.isOverdue,
        assigneeNames: getTaskAssigneeNames(task),
        assigneeOpenIds,
        relatedOpenIds: [
          ...new Set([
            ...assigneeOpenIds,
            ...task.deletionRequests.map((request) => request.requesterOpenId),
            ...task.creationRequests.map((request) => request.requesterOpenId),
          ]),
        ],
        stageId: task.stageId,
        stageName: task.stage?.name ?? null,
        metrics: task.metrics,
        dueAt: task.dueAt.toISOString(),
        riskNote: task.riskNote,
        submissionsCount: task._count.submissions,
        pendingDeletionRequest: pendingDeletionRequest
          ? {
              id: pendingDeletionRequest.id,
              requesterName: pendingDeletionRequest.requesterName,
              createdAt: pendingDeletionRequest.createdAt.toISOString(),
            }
          : null,
      };
    }),
    activityLogs: project.activityLogs.map((log) => ({
      id: log.id,
      action: log.action,
      taskId: log.taskId,
      actorName: log.actorName,
      payload: log.payload,
      createdAt: log.createdAt.toISOString(),
    })),
    taskCreationRequests: taskCreationRequests.map((request) => {
      const draft = parseTaskCreationDraft(request.draftPayload);
      return {
        id: request.id,
        requesterOpenId: request.requesterOpenId,
        requesterName: request.requesterName,
        status: request.status,
        reviewerName: request.reviewerName,
        reviewComment: request.reviewComment,
        reviewedAt: request.reviewedAt?.toISOString() ?? null,
        createdTaskId:
          request.createdTaskId && visibleTaskIds.has(request.createdTaskId)
            ? request.createdTaskId
            : null,
        createdAt: request.createdAt.toISOString(),
        draft: draft
          ? {
              title: draft.title,
              goal: draft.goal,
              stageName: draft.stageName,
              category: draft.category,
              urgency: draft.urgency,
              importance: draft.importance,
              assigneeNames:
                draft.assigneeNames.length > 0
                  ? draft.assigneeNames.join("、")
                  : draft.assigneeOpenIds.join("、"),
              dueAt: draft.dueAt,
              metrics: draft.metrics,
              needsOfflineConfirmation: draft.needsOfflineConfirmation,
              needsWeeklyReport: draft.needsWeeklyReport,
              acceptanceChecklistItems: draft.acceptanceChecklistItems,
              summary: formatTaskCreationDraftSummary(draft),
            }
          : null,
      };
    }),
    hasMoreActivityLogs: activityLogCount > project.activityLogs.length,
  };

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress-project"
        resourceId={project.id}
        initialVersion={liveVersion}
        intervalMs={5000}
      />
      <PageShell>
        <ProjectDetailWorkspace
          project={projectView}
          users={users}
          acceptanceChecklistTemplates={acceptanceChecklistTemplates}
          canManage={canManage}
          canRequestTaskCreation={canRequestTask}
          canUpdateLifecycle={canUpdateLifecycle}
          isSuperAdmin={admin}
          userOpenId={userOpenId}
        />
      </PageShell>
    </>
  );
}

async function getRelevantTaskCreationRequests(
  projectId: string,
  canManage: boolean,
  userOpenId?: string,
) {
  if (canManage) {
    const [pending, recentReviewed] = await Promise.all([
      prisma.taskCreationRequest.findMany({
        where: { projectId, status: "PENDING" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      prisma.taskCreationRequest.findMany({
        where: { projectId, status: { not: "PENDING" } },
        orderBy: [{ reviewedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: 30,
      }),
    ]);
    return [...pending, ...recentReviewed];
  }

  if (!userOpenId) return [];
  return prisma.taskCreationRequest.findMany({
    where: { projectId, requesterOpenId: userOpenId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
