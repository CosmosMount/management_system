"use server";

import { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canManageProject,
  canRequestTaskCreation,
} from "@/lib/permissions-progress";
import { getUserRoles } from "@/lib/permissions";
import { normalizeAcceptanceChecklistItems } from "@/lib/progress-acceptance-checklists";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { requireSessionUser } from "@/lib/progress-activity";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getProjectParticipantOpenIds } from "@/lib/progress-project-participants";
import {
  collectTaskManagementReviewRecipients,
  collectTaskNotificationRecipients,
} from "@/lib/progress-task-notifications";
import { normalizeTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { assertProjectActive } from "@/lib/progress-guards";
import {
  parseTaskCreationDraft,
  type TaskCreationDraft,
} from "@/lib/progress-task-creation-requests";
import { getNotificationContext } from "@/lib/request-origin";
import { prisma } from "@/lib/prisma";
import { revalidateProgress } from "@/lib/revalidate";
import { withActionLogging } from "@/lib/logger";
import {
  createTaskSchema,
  taskCreationReviewSchema,
  type CreateTaskInput,
} from "@/lib/validations/progress";

export async function requestTaskCreation(input: CreateTaskInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.task.creation.request",
      module: "progress",
      action: "requestTaskCreation",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Project",
      entityId: input.projectId,
      stageId: input.stageId,
    },
    async () => requestTaskCreationLogged(input, user),
  );
}

async function requestTaskCreationLogged(
  input: CreateTaskInput,
  user: { openId: string; name: string },
) {
  const roles = await getUserRoles(user.openId);
  const parsed = createTaskSchema.parse(input);

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: true,
      tasks: {
        where: { deletedAt: null },
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!project) throw new Error("项目不存在");
  assertProjectActive(project.status);

  const projectOwnerOpenIds = getProjectOwnerOpenIds(project);
  const participantOpenIds = getProjectParticipantOpenIds(project);
  const scope = { team: project.team, techGroup: project.techGroup };
  if (canManageProject(roles, scope, projectOwnerOpenIds, user.openId)) {
    throw new Error("项目管理者可直接创建任务，无需提交申请");
  }

  const stageId = parsed.stageId || null;
  const selectedStage = stageId
    ? project.stages.find((stage) => stage.id === stageId)
    : null;
  if (stageId && !selectedStage) {
    throw new Error("任务阶段不属于当前项目");
  }
  if (selectedStage?.status === "COMPLETED") {
    throw new Error("已完成阶段不可申请新任务");
  }
  const stageOwnerOpenIds = selectedStage?.ownerOpenId
    ? [selectedStage.ownerOpenId]
    : [];
  const taskAssigneeOpenIds = [
    ...new Set(project.tasks.flatMap((task) => getTaskAssigneeOpenIds(task))),
  ];
  if (
    !canRequestTaskCreation({
      roles,
      scope,
      ownerOpenIds: projectOwnerOpenIds,
      participantOpenIds,
      stageOwnerOpenIds,
      taskAssigneeOpenIds,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无任务申请权限");
  }

  const assigneeOpenIds = normalizeOpenIds(
    parsed.assigneeOpenIds?.filter(Boolean) ??
      (parsed.assigneeOpenId ? [parsed.assigneeOpenId] : []),
  );
  if (assigneeOpenIds.length === 0) throw new Error("请选择负责人");

  const assignees = await prisma.user.findMany({
    where: { openId: { in: assigneeOpenIds } },
    select: { openId: true, name: true },
  });
  const assigneeByOpenId = new Map(
    assignees.map((assignee) => [assignee.openId, assignee]),
  );
  const orderedAssignees = assigneeOpenIds.map((openId) => {
    const assignee = assigneeByOpenId.get(openId);
    if (!assignee) throw new Error("负责人不存在，请先同步飞书通讯录");
    return assignee;
  });

  const dueAt = new Date(parsed.dueAt);
  const taskTechGroups = normalizeTaskTechGroups(parsed.taskTechGroups);
  if (taskTechGroups.length === 0) throw new Error("请选择任务技术组");
  const acceptanceChecklistItems = normalizeAcceptanceChecklistItems(
    parsed.acceptanceChecklistItems,
  );
  const stageName = stageId
    ? selectedStage?.name ?? "无阶段"
    : "无阶段";
  const draft: TaskCreationDraft = {
    title: parsed.title,
    goal: parsed.goal ?? "",
    stageId,
    stageName,
    taskTechGroups,
    urgency: parsed.urgency,
    importance: parsed.importance,
    assigneeOpenIds,
    assigneeNames: orderedAssignees.map((assignee) => assignee.name),
    metrics: parsed.metrics,
    dueAt: dueAt.toISOString(),
    needsOfflineConfirmation: parsed.needsOfflineConfirmation,
    needsWeeklyReport: parsed.needsWeeklyReport,
    acceptanceChecklistItems,
  };
  const baseRecipientOpenIds = await collectTaskManagementReviewRecipients({
    team: project.team,
    techGroup: project.techGroup,
    assigneeOpenId: orderedAssignees[0]?.openId ?? "",
    assigneeName: orderedAssignees[0]?.name ?? "",
    assignees: orderedAssignees,
    techGroups: taskTechGroups.map((techGroup, index) => ({
      techGroup,
      sortOrder: index,
    })),
    project,
  });
  const recipientOpenIds = normalizeOpenIds(baseRecipientOpenIds);

  const context = await getNotificationContext();
  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.taskCreationRequest.create({
      data: {
        projectId: project.id,
        requesterOpenId: user.openId,
        requesterName: user.name,
        draftPayload: JSON.stringify(draft),
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action: "task.creation_requested",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          requestId: created.id,
        taskTitle: draft.title,
        stageId: draft.stageId,
        stageName: draft.stageName,
        taskTechGroups,
        requesterName: user.name,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_creation_requested:${created.id}`,
      {
        type: "task_creation_requested",
        requestId: created.id,
        projectId: project.id,
        projectName: project.name,
        taskTitle: draft.title,
        requesterName: user.name,
        team: project.team,
        techGroup: project.techGroup,
        projectOwnerOpenIds,
        stageName: draft.stageName,
        assigneeNames: draft.assigneeNames.join("、"),
        taskTechGroups,
        dueAt: draft.dueAt,
        recipientOpenIds,
      },
      context,
    );

    return created;
  });

  drainNotificationOutboxSoon();

  revalidateProgress(project.id);
  return request;
}

export async function reviewTaskCreationRequest(input: {
  requestId: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.task.creation.review",
      module: "progress",
      action: "reviewTaskCreationRequest",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "TaskCreationRequest",
      entityId: input.requestId,
      decision: input.decision,
    },
    async () => reviewTaskCreationRequestLogged(input, user),
  );
}

async function reviewTaskCreationRequestLogged(
  input: {
    requestId: string;
    decision: "APPROVED" | "REJECTED";
    comment?: string;
  },
  user: { openId: string; name: string },
) {
  const roles = await getUserRoles(user.openId);
  const parsed = taskCreationReviewSchema.parse(input);

  const request = await prisma.taskCreationRequest.findUnique({
    where: { id: parsed.requestId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
          stages: true,
        },
      },
    },
  });
  if (!request || request.status !== "PENDING") {
    throw new Error("任务申请不存在或已处理");
  }
  const project = request.project;
  assertProjectActive(project.status);

  const projectOwnerOpenIds = getProjectOwnerOpenIds(project);
  if (
    !canManageProject(
      roles,
      { team: project.team, techGroup: project.techGroup },
      projectOwnerOpenIds,
      user.openId,
    )
  ) {
    throw new Error("无任务申请审核权限");
  }

  const draft = parseTaskCreationDraft(request.draftPayload);
  if (!draft) throw new Error("任务申请内容无法解析");
  const selectedStage = draft.stageId
    ? project.stages.find((stage) => stage.id === draft.stageId)
    : null;
  if (draft.stageId && !selectedStage) {
    throw new Error("任务阶段不属于当前项目");
  }
  if (selectedStage?.status === "COMPLETED") {
    throw new Error("已完成阶段不可创建新任务");
  }

  const reviewedAt = new Date();
  const context = await getNotificationContext();
  if (parsed.decision === "REJECTED") {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.taskCreationRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "REJECTED",
          reviewerOpenId: user.openId,
          reviewerName: user.name,
          reviewComment: parsed.comment ?? "",
          reviewedAt,
        },
      });
      if (locked.count !== 1) {
        throw new Error("任务申请已被处理，请刷新后重试");
      }
      await tx.progressActivityLog.create({
        data: {
          projectId: project.id,
          action: "task.creation_rejected",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            requestId: request.id,
            taskTitle: draft.title,
            requesterName: request.requesterName,
            comment: parsed.comment ?? "",
          }),
        },
      });

      await enqueueProgressNotificationTx(
        tx,
        `progress:task_creation_rejected:${request.id}`,
        {
          type: "task_creation_rejected",
          requestId: request.id,
          projectId: project.id,
          projectName: project.name,
          taskTitle: draft.title,
          reviewerName: user.name,
          requesterOpenId: request.requesterOpenId,
          comment: parsed.comment ?? "",
          recipientOpenIds: [request.requesterOpenId],
        },
        context,
      );
    });

    drainNotificationOutboxSoon();
    revalidateProgress(project.id);
    return { success: true };
  }

  const assignees = await prisma.user.findMany({
    where: { openId: { in: draft.assigneeOpenIds } },
    select: { openId: true, name: true },
  });
  const assigneeByOpenId = new Map(
    assignees.map((assignee) => [assignee.openId, assignee]),
  );
  const orderedAssignees = draft.assigneeOpenIds.map((openId) => {
    const assignee = assigneeByOpenId.get(openId);
    if (!assignee) throw new Error("负责人不存在，请先同步飞书通讯录");
    return assignee;
  });
  const primaryAssignee = orderedAssignees[0];
  if (!primaryAssignee) throw new Error("请选择负责人");

  const dueAt = new Date(draft.dueAt);
  const taskTechGroups =
    draft.taskTechGroups.length > 0
      ? normalizeTaskTechGroups(draft.taskTechGroups)
      : normalizeTaskTechGroups([project.techGroup || "通用"]);
  const needsWeeklyReport =
    draft.needsWeeklyReport ||
    dueAt.getTime() - Date.now() > 14 * 24 * 60 * 60 * 1000;
  const baseRecipientOpenIds = await collectTaskNotificationRecipients({
    team: project.team,
    techGroup: project.techGroup,
    assigneeOpenId: primaryAssignee.openId,
    assigneeName: primaryAssignee.name,
    assignees: orderedAssignees,
    techGroups: taskTechGroups.map((techGroup, index) => ({
      techGroup,
      sortOrder: index,
    })),
    project,
  });
  const recipientOpenIds = normalizeOpenIds([
    ...baseRecipientOpenIds,
    request.requesterOpenId,
    ...(selectedStage?.ownerOpenId ? [selectedStage.ownerOpenId] : []),
  ]);

  const task = await prisma.$transaction(async (tx) => {
    const activeProject = await tx.project.updateMany({
      where: { id: project.id, status: project.status },
      data: { status: project.status },
    });
    if (activeProject.count !== 1) {
      throw new Error("项目状态已更新，请刷新后重试");
    }

    const locked = await tx.taskCreationRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        reviewerOpenId: user.openId,
        reviewerName: user.name,
        reviewComment: parsed.comment ?? "",
        reviewedAt,
      },
    });
    if (locked.count !== 1) {
      throw new Error("任务申请已被处理，请刷新后重试");
    }

    const created = await tx.task.create({
      data: {
        projectId: project.id,
        stageId: draft.stageId,
        title: draft.title,
        goal: draft.goal,
        urgency: draft.urgency,
        importance: draft.importance,
        assigneeOpenId: primaryAssignee.openId,
        assigneeName: primaryAssignee.name,
        team: project.team,
        techGroup: project.techGroup,
        metrics: draft.metrics,
        dueAt,
        status: TaskStatus.TODO,
        needsOfflineConfirmation: draft.needsOfflineConfirmation,
        needsWeeklyReport,
      },
    });

    await tx.taskTechGroup.createMany({
      data: taskTechGroups.map((techGroup, index) => ({
        taskId: created.id,
        techGroup,
        sortOrder: index,
      })),
    });
    await tx.taskAssignee.createMany({
      data: orderedAssignees.map((assignee, index) => ({
        taskId: created.id,
        openId: assignee.openId,
        name: assignee.name,
        sortOrder: index,
      })),
    });
    if (draft.acceptanceChecklistItems.length > 0) {
      await tx.taskAcceptanceChecklistItem.createMany({
        data: draft.acceptanceChecklistItems.map((item, index) => ({
          taskId: created.id,
          content: item.content,
          sortOrder: index,
        })),
      });
    }

    await tx.taskCreationRequest.update({
      where: { id: request.id },
      data: { createdTaskId: created.id },
    });
    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        taskId: created.id,
        action: "task.creation_approved",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          requestId: request.id,
          taskTitle: draft.title,
          requesterName: request.requesterName,
          taskTechGroups,
          assignees: orderedAssignees.map((assignee) => assignee.name),
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_creation_approved:${request.id}`,
      {
        type: "task_creation_approved",
        requestId: request.id,
        taskId: created.id,
        projectId: project.id,
        projectName: project.name,
        taskTitle: created.title,
        reviewerName: user.name,
        requesterOpenId: request.requesterOpenId,
        stageName: selectedStage?.name ?? draft.stageName ?? "无阶段",
        assigneeNames: orderedAssignees.map((assignee) => assignee.name).join("、"),
        taskTechGroups,
        urgency: created.urgency,
        importance: created.importance,
        dueAt: created.dueAt.toISOString(),
        metrics: created.metrics,
        goal: created.goal,
        needsWeeklyReport: created.needsWeeklyReport,
        needsOfflineConfirmation: created.needsOfflineConfirmation,
        acceptanceChecklistItems: draft.acceptanceChecklistItems.map(
          (item) => item.content,
        ),
        assigneeOpenIds: orderedAssignees.map((assignee) => assignee.openId),
        team: project.team,
        techGroup: project.techGroup,
        projectOwnerOpenIds,
        recipientOpenIds,
      },
      context,
    );

    return created;
  });

  drainNotificationOutboxSoon();

  revalidateProgress(project.id, task.id);
  return { success: true, taskId: task.id };
}

function normalizeOpenIds(openIds: string[]): string[] {
  return [...new Set(openIds.filter(Boolean))];
}
