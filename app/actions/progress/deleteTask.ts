"use server";

import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canManageProject,
  canRequestTaskDeletion,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { getUserRoles } from "@/lib/permissions";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { requireSessionUser } from "@/lib/progress-activity";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getProjectParticipantOpenIds } from "@/lib/progress-project-participants";
import { getNotificationContext } from "@/lib/request-origin";
import { prisma } from "@/lib/prisma";
import { revalidateProgress } from "@/lib/revalidate";
import {
  taskDirectDeleteSchema,
  taskDeletionRequestSchema,
  taskDeletionReviewSchema,
} from "@/lib/validations/progress";

const PENDING_DELETE_REQUEST_KEY = "PENDING";

type DirectDeleteInput = { taskId: string; reason: string };

export async function deleteTaskDirectly(input: DirectDeleteInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = taskDirectDeleteSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
        },
      },
      stage: true,
      assignees: true,
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!task || task.deletedAt) throw new Error("任务不存在");
  if (task.status === "PROJECT_CANCELED") {
    throw new Error("项目已取消任务不能删除");
  }

  const projectOwnerOpenIds = getProjectOwnerOpenIds(task.project);
  if (
    !canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      projectOwnerOpenIds,
      user.openId,
    )
  ) {
    throw new Error("无任务删除权限");
  }

  const deletedAt = new Date();
  const context = await getNotificationContext();
  const taskRecipientOpenIds = await collectTaskNotificationRecipients(task);
  await prisma.$transaction(async (tx) => {
    const pendingRequests = await tx.taskDeletionRequest.findMany({
      where: { taskId: task.id, status: "PENDING" },
      select: { id: true, requesterOpenId: true },
    });
    const pendingRequesterOpenIds = pendingRequests.map(
      (request) => request.requesterOpenId,
    );

    const updated = await tx.task.updateMany({
      where: {
        id: task.id,
        deletedAt: null,
        status: { not: "PROJECT_CANCELED" },
        project: { status: "IN_PROGRESS" },
      },
      data: {
        deletedAt,
        deletedByOpenId: user.openId,
        deletedByName: user.name,
        deleteReason: parsed.reason,
      },
    });
    if (updated.count !== 1) {
      throw new Error("任务或项目状态已更新，请刷新后重试");
    }

    for (const request of pendingRequests) {
      await tx.taskDeletionRequest.update({
        where: { id: request.id },
        data: {
          status: "APPROVED",
          pendingKey: `APPROVED:${request.id}`,
          reviewerOpenId: user.openId,
          reviewerName: user.name,
          reviewComment: "管理员直接删除任务",
          reviewedAt: deletedAt,
        },
      });
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action: "task.deleted",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          taskTitle: task.title,
          stageId: task.stageId,
          stageName: task.stage?.name ?? "无阶段",
          reason: parsed.reason,
          direct: true,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_deleted:${task.id}:${deletedAt.toISOString()}`,
      {
        type: "task_deleted",
        taskId: task.id,
        taskTitle: task.title,
        projectId: task.projectId,
        projectName: task.project.name,
        stageId: task.stageId,
        stageName: task.stage?.name ?? "无阶段",
        actorName: user.name,
        reason: parsed.reason,
        team: task.team,
        techGroup: task.techGroup,
        assigneeOpenIds: [
          ...pendingRequesterOpenIds,
          ...getTaskAssigneeOpenIds(task),
        ],
        projectOwnerOpenIds,
        recipientOpenIds: [
          ...new Set([...pendingRequesterOpenIds, ...taskRecipientOpenIds]),
        ],
      },
      context,
    );
  });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
}

export async function requestTaskDeletion(input: { taskId: string; reason: string }) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = taskDeletionRequestSchema.parse(input);

  const task = await prisma.task.findFirst({
    where: {
      id: parsed.taskId,
      AND: progressTaskReadableWhere(roles, user.openId),
    },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
        },
      },
      stage: true,
      assignees: true,
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      deletionRequests: {
        where: { status: "PENDING" },
        take: 1,
      },
    },
  });
  if (!task) throw new Error("任务不存在或无权限查看");
  if (task.status === "PROJECT_CANCELED") {
    throw new Error("项目已取消任务不能申请删除");
  }

  const projectOwnerOpenIds = getProjectOwnerOpenIds(task.project);
  if (
    canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      projectOwnerOpenIds,
      user.openId,
    )
  ) {
    throw new Error("管理员可直接删除任务，无需提交申请");
  }
  if (
    !canRequestTaskDeletion({
      roles,
      scope: { team: task.team, techGroup: task.techGroup },
      ownerOpenIds: projectOwnerOpenIds,
      participantOpenIds: getProjectParticipantOpenIds(task.project),
      stageOwnerOpenId: task.stage?.ownerOpenId,
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无任务删除申请权限");
  }
  if (task.deletionRequests.length > 0) {
    throw new Error("该任务已有待审核的删除申请");
  }

  const context = await getNotificationContext();
  const recipientOpenIds = await collectTaskNotificationRecipients(task);
  const request = await prisma
    .$transaction(async (tx) => {
      const liveTask = await tx.task.findUnique({
        where: { id: task.id },
        select: {
          deletedAt: true,
          status: true,
          project: { select: { status: true } },
        },
      });
      if (!liveTask || liveTask.deletedAt) {
        throw new Error("任务已被删除，请刷新后重试");
      }
      if (liveTask.project.status !== "IN_PROGRESS") {
        throw new Error("已结束项目下的任务不能申请删除");
      }
      if (liveTask.status === "PROJECT_CANCELED") {
        throw new Error("项目已取消任务不能申请删除");
      }

      const created = await tx.taskDeletionRequest.create({
        data: {
          taskId: task.id,
          requesterOpenId: user.openId,
          requesterName: user.name,
          reason: parsed.reason,
          pendingKey: PENDING_DELETE_REQUEST_KEY,
        },
      });

      await tx.progressActivityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          action: "task.delete_requested",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            requestId: created.id,
            taskTitle: task.title,
            stageId: task.stageId,
            stageName: task.stage?.name ?? "无阶段",
            reason: parsed.reason,
          }),
        },
      });

      await enqueueProgressNotificationTx(
        tx,
        `progress:task_delete_requested:${created.id}`,
        {
          type: "task_delete_requested",
          taskId: task.id,
          taskTitle: task.title,
          projectName: task.project.name,
          requesterName: user.name,
          reason: parsed.reason,
          team: task.team,
          techGroup: task.techGroup,
          projectOwnerOpenIds,
          recipientOpenIds,
        },
        context,
      );

      return created;
    })
    .catch((err: unknown) => {
      if (isUniqueConstraintError(err)) {
        throw new Error("该任务已有待审核的删除申请");
      }
      throw err;
    });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return request;
}

export async function reviewTaskDeletionRequest(input: {
  requestId: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = taskDeletionReviewSchema.parse(input);

  const request = await prisma.taskDeletionRequest.findUnique({
    where: { id: parsed.requestId },
    include: {
      task: {
        include: {
          project: {
            include: {
              owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
              participants: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
          stage: true,
          assignees: true,
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (
    !request ||
    request.status !== "PENDING" ||
    request.task.deletedAt ||
    request.task.status === "PROJECT_CANCELED"
  ) {
    throw new Error("删除申请不存在或已处理");
  }

  const task = request.task;
  const projectOwnerOpenIds = getProjectOwnerOpenIds(task.project);
  if (
    !canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      projectOwnerOpenIds,
      user.openId,
    )
  ) {
    throw new Error("无删除申请审核权限");
  }

  const reviewedAt = new Date();
  const context = await getNotificationContext();
  const reviewRecipientOpenIds = [
    ...new Set([
      request.requesterOpenId,
      ...(await collectTaskNotificationRecipients(task)),
    ]),
  ];
  if (parsed.decision === "APPROVED") {
    await prisma.$transaction(async (tx) => {
      const lockedRequest = await tx.taskDeletionRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "APPROVED",
          pendingKey: `APPROVED:${request.id}`,
          reviewerOpenId: user.openId,
          reviewerName: user.name,
          reviewComment: parsed.comment ?? "",
          reviewedAt,
        },
      });
      if (lockedRequest.count !== 1) {
        throw new Error("删除申请已被处理，请刷新后重试");
      }

      const deletedTask = await tx.task.updateMany({
        where: {
          id: task.id,
          deletedAt: null,
          status: { not: "PROJECT_CANCELED" },
          project: { status: "IN_PROGRESS" },
        },
        data: {
          deletedAt: reviewedAt,
          deletedByOpenId: user.openId,
          deletedByName: user.name,
          deleteReason: request.reason,
        },
      });
      if (deletedTask.count !== 1) {
        throw new Error("任务或项目状态已更新，请刷新后重试");
      }

      await tx.progressActivityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          action: "task.deleted",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            requestId: request.id,
            taskTitle: task.title,
            stageId: task.stageId,
            stageName: task.stage?.name ?? "无阶段",
            reason: request.reason,
            reviewComment: parsed.comment ?? "",
            requesterName: request.requesterName,
          }),
        },
      });

      await enqueueProgressNotificationTx(
        tx,
        `progress:task_deleted:${task.id}:${reviewedAt.toISOString()}`,
        {
          type: "task_deleted",
          taskId: task.id,
          taskTitle: task.title,
          projectId: task.projectId,
          projectName: task.project.name,
          stageId: task.stageId,
          stageName: task.stage?.name ?? "无阶段",
          actorName: user.name,
          reason: request.reason,
          team: task.team,
          techGroup: task.techGroup,
          assigneeOpenIds: [
            request.requesterOpenId,
            ...getTaskAssigneeOpenIds(task),
          ],
          projectOwnerOpenIds,
          recipientOpenIds: reviewRecipientOpenIds,
        },
        context,
      );
    });
  } else {
    await prisma.$transaction(async (tx) => {
      const lockedRequest = await tx.taskDeletionRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "REJECTED",
          pendingKey: `REJECTED:${request.id}`,
          reviewerOpenId: user.openId,
          reviewerName: user.name,
          reviewComment: parsed.comment ?? "",
          reviewedAt,
        },
      });
      if (lockedRequest.count !== 1) {
        throw new Error("删除申请已被处理，请刷新后重试");
      }

      await tx.progressActivityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          action: "task.delete_rejected",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            requestId: request.id,
            taskTitle: task.title,
            stageId: task.stageId,
            stageName: task.stage?.name ?? "无阶段",
            reason: request.reason,
            reviewComment: parsed.comment ?? "",
            requesterName: request.requesterName,
          }),
        },
      });

      await enqueueProgressNotificationTx(
        tx,
        `progress:task_delete_rejected:${request.id}`,
        {
          type: "task_delete_rejected",
          taskId: task.id,
          taskTitle: task.title,
          projectName: task.project.name,
          reviewerName: user.name,
          reason: request.reason,
          comment: parsed.comment ?? "",
          requesterOpenId: request.requesterOpenId,
          assigneeOpenIds: getTaskAssigneeOpenIds(task),
          recipientOpenIds: reviewRecipientOpenIds,
        },
        context,
      );
    });
  }

  drainNotificationOutboxSoon();
  revalidateProgress(task.projectId, task.id);
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}
