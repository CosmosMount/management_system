"use server";

import { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotification,
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
  parseTaskCreationDraft,
  type TaskCreationDraft,
} from "@/lib/progress-task-creation-requests";
import { getNotificationContext } from "@/lib/request-origin";
import { prisma } from "@/lib/prisma";
import { revalidateProgress } from "@/lib/revalidate";
import {
  createTaskSchema,
  taskCreationReviewSchema,
  type CreateTaskInput,
} from "@/lib/validations/progress";

export async function requestTaskCreation(input: CreateTaskInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
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
  if (project.status === "COMPLETED") throw new Error("项目已完成");
  if (project.status === "CANCELED") throw new Error("项目已取消");

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
    category: parsed.category,
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
          requesterName: user.name,
        }),
      },
    });

    return created;
  });

  await enqueueProgressNotification(
    `progress:task_creation_requested:${request.id}`,
    {
      type: "task_creation_requested",
      requestId: request.id,
      projectId: project.id,
      projectName: project.name,
      taskTitle: draft.title,
      requesterName: user.name,
      team: project.team,
      techGroup: project.techGroup,
      projectOwnerOpenIds,
    },
    await getNotificationContext(),
  );
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
  if (project.status === "COMPLETED") throw new Error("项目已完成");
  if (project.status === "CANCELED") throw new Error("项目已取消");

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
    });

    await enqueueProgressNotification(
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
      },
      await getNotificationContext(),
    );
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
  const needsWeeklyReport =
    draft.needsWeeklyReport ||
    dueAt.getTime() - Date.now() > 14 * 24 * 60 * 60 * 1000;

  const task = await prisma.$transaction(async (tx) => {
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
        category: draft.category,
        urgency: draft.urgency,
        importance: draft.importance,
        assigneeOpenId: primaryAssignee.openId,
        assigneeName: primaryAssignee.name,
        assignees: {
          create: orderedAssignees.map((assignee, index) => ({
            openId: assignee.openId,
            name: assignee.name,
            sortOrder: index,
          })),
        },
        team: project.team,
        techGroup: project.techGroup,
        metrics: draft.metrics,
        dueAt,
        status: TaskStatus.TODO,
        needsOfflineConfirmation: draft.needsOfflineConfirmation,
        needsWeeklyReport,
        acceptanceChecklistItems: {
          create: draft.acceptanceChecklistItems.map((item, index) => ({
            content: item.content,
            sortOrder: index,
          })),
        },
      },
    });

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
          assignees: orderedAssignees.map((assignee) => assignee.name),
        }),
      },
    });

    return created;
  });

  await enqueueProgressNotification(
    `progress:task_creation_approved:${request.id}`,
    {
      type: "task_creation_approved",
      requestId: request.id,
      taskId: task.id,
      projectId: project.id,
      projectName: project.name,
      taskTitle: task.title,
      reviewerName: user.name,
      requesterOpenId: request.requesterOpenId,
      assigneeOpenIds: orderedAssignees.map((assignee) => assignee.openId),
      team: project.team,
      techGroup: project.techGroup,
      projectOwnerOpenIds,
    },
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidateProgress(project.id, task.id);
  return { success: true, taskId: task.id };
}

function normalizeOpenIds(openIds: string[]): string[] {
  return [...new Set(openIds.filter(Boolean))];
}
