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
  canRequestProjectStageBatchDdlChange,
  canRequestProjectStageDueDateChange,
  canSyncProjectStageRisk,
  canRequestTaskCreation,
  canReviewProjectStageBatchDdlChange,
  canReviewProjectStageDueDateChange,
  canReviewProjectEstablishment,
  canViewProject,
  canApproveStage as canApproveStagePermission,
  canSubmitStage as canSubmitStagePermission,
  canUpdateProjectLifecycle,
  isAssignee,
  isProjectManager,
  isProgressSuperAdmin,
  isTeamLead,
  isTechGroupLead,
  progressProjectReadableWhere,
} from "@/lib/permissions-progress";
import {
  getTaskAssigneeNames,
  getTaskAssigneeOpenIds,
} from "@/lib/progress-assignees";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import {
  getProjectOwnerNames,
  getProjectOwnerOpenIds,
} from "@/lib/progress-project-owners";
import {
  getProjectParticipantNames,
  getProjectParticipantOpenIds,
} from "@/lib/progress-project-participants";
import {
  getProjectStageOwnerNames,
  getProjectStageOwnerOpenIds,
} from "@/lib/progress-stage-owners";
import {
  parseTaskCreationDraft,
  formatTaskCreationDraftSummary,
} from "@/lib/progress-task-creation-requests";
import { getProjectFollowPolicy } from "@/lib/progress-following";
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
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          submissions: {
            orderBy: { submittedAt: "desc" },
            include: { approvals: { orderBy: { createdAt: "asc" } } },
          },
          riskRecords: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          },
        },
      },
      ddlChangeRequests: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          stage: { select: { id: true, name: true, sortOrder: true } },
        },
      },
      tasks: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: {
          stage: { select: { name: true } },
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
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
          ddlChangeRequests: {
            select: { requesterOpenId: true },
          },
          riskRecords: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          },
          _count: { select: { submissions: true } },
        },
      },
      activityLogs: {
        where: { createdAt: { gte: recentActivityCutoff } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      },
      comments: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      },
      followPreferences: true,
    },
  });

  if (!project) notFound();

  const scope = { team: project.team, techGroup: project.techGroup };
  const projectOwnerOpenIds = getProjectOwnerOpenIds(project);
  const projectParticipantOpenIds = getProjectParticipantOpenIds(project);
  const stageOwnerOpenIds = [
    ...new Set(project.stages.flatMap((stage) => getProjectStageOwnerOpenIds(stage))),
  ];
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
  const canReviewEstablishment =
    project.status === "ESTABLISHING" &&
    canReviewProjectEstablishment(roles, scope);
  const canRequestApprovalReminder =
    !!userOpenId &&
    (isAssignee(userOpenId, projectOwnerOpenIds) ||
      isAssignee(userOpenId, projectParticipantOpenIds) ||
      isProgressSuperAdmin(roles) ||
      isProjectManager(roles) ||
      isTeamLead(roles, project.team) ||
      isTechGroupLead(roles, project.techGroup));
  const projectAllowsDdlChange =
    project.status === "NOT_STARTED" || project.status === "IN_PROGRESS";
  const admin = userOpenId ? await isSuperAdmin(userOpenId) : false;
  const stageAdvanceCounts = getStageAdvanceCounts(
    project.stages,
    project.ddlChangeRequests,
  );
  const projectFollowPolicy = await getProjectFollowPolicy({
    project,
    userOpenId,
    roles,
  });

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
    requesterOpenId: project.requesterOpenId,
    requesterName: project.requesterName,
    submittedAt: project.submittedAt?.toISOString() ?? null,
    reviewerOpenId: project.reviewerOpenId,
    reviewerName: project.reviewerName,
    reviewComment: project.reviewComment,
    reviewedAt: project.reviewedAt?.toISOString() ?? null,
    allowOwnerSelfApproval: project.allowOwnerSelfApproval,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    completedAt: project.completedAt?.toISOString() ?? null,
    canceledAt: project.canceledAt?.toISOString() ?? null,
    follow: projectFollowPolicy,
    stages: project.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      goal: stage.goal,
      sortOrder: stage.sortOrder,
      status: stage.status,
      evidenceUrl: stage.evidenceUrl,
      ownerOpenId: stage.ownerOpenId,
      ownerName: stage.ownerName,
      ownerOpenIds: getProjectStageOwnerOpenIds(stage),
      ownerNames: getProjectStageOwnerNames(stage),
      updatedAt: stage.updatedAt.toISOString(),
      dueAt: stage.dueAt?.toISOString() ?? null,
      completedAt: stage.completedAt?.toISOString() ?? null,
      extensionCount: stage.extensionCount,
      advanceCount: stageAdvanceCounts.get(stage.id) ?? 0,
      benignExtensionCount: stage.benignExtensionCount,
      currentSubmissionId: stage.currentSubmissionId,
      canSubmit: canSubmitStagePermission({
        roles,
        stageOwnerOpenIds: getProjectStageOwnerOpenIds(stage),
        projectOwnerOpenIds,
        projectParticipantOpenIds,
        userOpenId,
      }),
      canRequestExtension:
        projectAllowsDdlChange &&
        stage.status !== "COMPLETED" &&
        canRequestProjectStageBatchDdlChange({
          roles,
          scope,
          ownerOpenIds: projectOwnerOpenIds,
          participantOpenIds: projectParticipantOpenIds,
          stageOwnerOpenIds,
          taskAssigneeOpenIds,
          userOpenId,
        }),
      canRequestDueDateChange:
        projectAllowsDdlChange &&
        stage.status !== "COMPLETED" &&
        canRequestProjectStageDueDateChange({
          roles,
          scope,
          ownerOpenIds: projectOwnerOpenIds,
          participantOpenIds: projectParticipantOpenIds,
          stageOwnerOpenId: getProjectStageOwnerOpenIds(stage),
          userOpenId,
        }),
      canSyncRisk: canSyncProjectStageRisk({
        roles,
        scope,
        projectOwnerOpenIds,
        projectParticipantOpenIds,
        stageOwnerOpenId: getProjectStageOwnerOpenIds(stage),
        userOpenId,
      }),
      riskNote: stage.riskNote,
      riskUpdatedAt: stage.riskUpdatedAt?.toISOString() ?? null,
      riskRecords: stage.riskRecords.map((risk) => ({
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
        taskTechGroups: getTaskTechGroups(task),
        urgency: task.urgency,
        importance: task.importance,
        status: task.status,
        isOverdue: task.status === "PROJECT_CANCELED" ? false : task.isOverdue,
        assigneeNames: getTaskAssigneeNames(task),
        assigneeOpenIds,
        relatedOpenIds: [
          ...new Set([
            ...projectOwnerOpenIds,
            ...projectParticipantOpenIds,
            ...(task.stageId
              ? project.stages
                  .filter((stage) => stage.id === task.stageId)
                  .flatMap((stage) => getProjectStageOwnerOpenIds(stage))
              : []),
            ...assigneeOpenIds,
            ...task.deletionRequests.map((request) => request.requesterOpenId),
            ...task.creationRequests.map((request) => request.requesterOpenId),
            ...task.ddlChangeRequests.map((request) => request.requesterOpenId),
          ].filter(Boolean)),
        ],
        stageId: task.stageId,
        stageName: task.stage?.name ?? null,
        metrics: task.metrics,
        dueAt: task.dueAt.toISOString(),
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
    ddlChangeRequests: project.ddlChangeRequests.map((request) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      stageId: request.stageId,
      stageName: request.stage.name,
      requesterOpenId: request.requesterOpenId,
      requesterName: request.requesterName,
      reason: request.reason,
      oldDueAt: request.oldDueAt?.toISOString() ?? null,
      newDueAt: request.newDueAt?.toISOString() ?? null,
      durationDays: request.durationDays,
      requestedIsBenign: request.requestedIsBenign,
      finalIsBenign: request.finalIsBenign,
      reviewerName: request.reviewerName,
      reviewComment: request.reviewComment,
      reviewedAt: request.reviewedAt?.toISOString() ?? null,
      createdAt: request.createdAt.toISOString(),
      canReview:
        request.type === "CASCADE_EXTENSION"
          ? canReviewProjectStageBatchDdlChange({
              roles,
              scope,
              requesterOpenId: request.requesterOpenId,
              userOpenId,
            })
          : canReviewProjectStageDueDateChange({
              roles,
              ownerOpenIds: projectOwnerOpenIds,
              requesterOpenId: request.requesterOpenId,
              userOpenId,
            }),
    })),
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
              taskTechGroups: draft.taskTechGroups,
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
    comments: project.comments.map((comment) => ({
      id: comment.id,
      authorOpenId: comment.authorOpenId,
      authorName: comment.authorName,
      authorAvatar: comment.authorAvatar,
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      canDelete:
        !!userOpenId && (comment.authorOpenId === userOpenId || canManage),
    })),
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
          canReviewEstablishment={canReviewEstablishment}
          isSuperAdmin={admin}
          userOpenId={userOpenId}
          canRequestApprovalReminder={canRequestApprovalReminder}
        />
      </PageShell>
    </>
  );
}

function getStageAdvanceCounts(
  stages: Array<{ id: string; sortOrder: number }>,
  requests: Array<{
    type: "CASCADE_EXTENSION" | "SINGLE_STAGE_ADJUSTMENT";
    status: string;
    stageId: string;
    durationDays: number | null;
    oldDueAt: Date | null;
    newDueAt: Date | null;
    stage: { sortOrder: number };
  }>,
): Map<string, number> {
  const counts = new Map(stages.map((stage) => [stage.id, 0]));
  for (const request of requests) {
    if (request.status !== "APPROVED") continue;

    if (request.type === "CASCADE_EXTENSION") {
      if ((request.durationDays ?? 0) >= 0) continue;
      for (const stage of stages) {
        if (stage.sortOrder >= request.stage.sortOrder) {
          counts.set(stage.id, (counts.get(stage.id) ?? 0) + 1);
        }
      }
      continue;
    }

    if (
      request.type === "SINGLE_STAGE_ADJUSTMENT" &&
      request.oldDueAt &&
      request.newDueAt &&
      request.newDueAt.getTime() < request.oldDueAt.getTime()
    ) {
      counts.set(request.stageId, (counts.get(request.stageId) ?? 0) + 1);
    }
  }
  return counts;
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
