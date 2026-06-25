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
            where: { status: "PENDING" },
            orderBy: { createdAt: "desc" },
            take: 1,
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
  const canUpdateLifecycle = canUpdateProjectLifecycle(
    roles,
    scope,
    projectOwnerOpenIds,
    userOpenId,
  );
  const admin = userOpenId ? await isSuperAdmin(userOpenId) : false;

  const ownedStageIds = new Set(
    project.stages
      .filter((stage) => stage.ownerOpenId === userOpenId)
      .map((stage) => stage.id),
  );
  const visibleTasks = canManage
    ? project.tasks
    : project.tasks.filter(
        (task) =>
          getTaskAssigneeOpenIds(task).includes(userOpenId ?? "") ||
          (!!task.stageId && ownedStageIds.has(task.stageId)),
      );
  const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
  const visibleStageIds = new Set([
    ...ownedStageIds,
    ...visibleTasks
      .map((task) => task.stageId)
      .filter((stageId): stageId is string => !!stageId),
  ]);
  const visibleStages = canManage
    ? project.stages
    : project.stages
        .filter((stage) => visibleStageIds.has(stage.id))
        .map((stage) =>
          ownedStageIds.has(stage.id)
            ? stage
            : {
                ...stage,
                evidenceUrl: "",
                currentSubmissionId: null,
                submissions: [],
              },
        );
  const visibleActivityLogs = project.activityLogs.filter((log) => {
    if (canManage) return true;
    if (log.taskId && visibleTaskIds.has(log.taskId)) return true;
    const payload = parseActivityPayload(log.payload);
    const stageId = getPayloadString(payload.stageId);
    const fromStageId = getPayloadString(payload.fromStageId);
    return (
      (!!stageId && ownedStageIds.has(stageId)) ||
      (!!fromStageId && ownedStageIds.has(fromStageId))
    );
  });
  const limitedActivityFilters = [
    ...(visibleTaskIds.size > 0
      ? [{ taskId: { in: [...visibleTaskIds] } }]
      : []),
    ...[...ownedStageIds].flatMap((stageId) => [
      {
        projectId: project.id,
        payload: { contains: `"stageId":"${stageId}"` },
      },
      {
        projectId: project.id,
        payload: { contains: `"fromStageId":"${stageId}"` },
      },
    ]),
  ];
  const activityLogWhere = canManage
    ? { projectId: project.id }
    : limitedActivityFilters.length > 0
      ? { OR: limitedActivityFilters }
      : { id: "__none__" };

  const [users, acceptanceChecklistTemplates, activityLogCount] =
    await Promise.all([
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
      prisma.progressActivityLog.count({
        where: activityLogWhere,
      }),
    ]);

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
    allowOwnerSelfApproval: project.allowOwnerSelfApproval,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    completedAt: project.completedAt?.toISOString() ?? null,
    canceledAt: project.canceledAt?.toISOString() ?? null,
    stages: visibleStages.map((stage) => ({
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
    tasks: visibleTasks.map((task) => ({
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
      pendingDeletionRequest: task.deletionRequests[0]
        ? {
            id: task.deletionRequests[0].id,
            requesterName: task.deletionRequests[0].requesterName,
            createdAt: task.deletionRequests[0].createdAt.toISOString(),
          }
        : null,
    })),
    activityLogs: visibleActivityLogs.map((log) => ({
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
          canUpdateLifecycle={canUpdateLifecycle}
          isSuperAdmin={admin}
          userOpenId={userOpenId}
        />
      </PageShell>
    </>
  );
}

function parseActivityPayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getPayloadString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
