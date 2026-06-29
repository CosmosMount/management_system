"use server";

import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canRequestTaskDdlChange,
  canReviewTaskDdlChange,
} from "@/lib/permissions-progress";
import { getUserRoles } from "@/lib/permissions";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { requireSessionUser } from "@/lib/progress-activity";
import { assertProjectActive } from "@/lib/progress-guards";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import {
  taskDdlChangeRequestSchema,
  taskDdlChangeReviewSchema,
} from "@/lib/validations/progress";

const PENDING_DDL_CHANGE_KEY = "PENDING";

export async function requestTaskDdlChange(input: {
  taskId: string;
  newDueAt: string;
  reason: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = taskDdlChangeRequestSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!task) throw new Error("任务不存在");
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (
    task.status === "ARCHIVED" ||
    task.status === "COMPLETED" ||
    task.status === "PROJECT_CANCELED"
  ) {
    throw new Error("已结束任务不能申请修改 DDL");
  }

  const projectOwnerOpenIds = getProjectOwnerOpenIds(task.project);
  if (
    !canRequestTaskDdlChange({
      projectOwnerOpenIds,
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      userOpenId: user.openId,
    })
  ) {
    throw new Error("仅项目负责人或任务负责人可申请修改 DDL");
  }

  const newDueAt = new Date(parsed.newDueAt);
  if (newDueAt.getTime() === task.dueAt.getTime()) {
    throw new Error("新的最晚完成时间与当前时间一致");
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
          dueAt: true,
          project: { select: { status: true } },
        },
      });
      if (!liveTask || liveTask.deletedAt) {
        throw new Error("任务已被删除，请刷新后重试");
      }
      if (liveTask.project.status !== "IN_PROGRESS") {
        throw new Error("已结束项目下的任务不能申请修改 DDL");
      }
      if (
        liveTask.status === "COMPLETED" ||
        liveTask.status === "ARCHIVED" ||
        liveTask.status === "PROJECT_CANCELED"
      ) {
        throw new Error("已结束任务不能申请修改 DDL");
      }
      if (liveTask.dueAt.getTime() !== task.dueAt.getTime()) {
        throw new Error("任务 DDL 已变化，请刷新后重试");
      }

      const created = await tx.taskDdlChangeRequest.create({
        data: {
          taskId: task.id,
          requesterOpenId: user.openId,
          requesterName: user.name,
          oldDueAt: task.dueAt,
          newDueAt,
          reason: parsed.reason,
          pendingKey: PENDING_DDL_CHANGE_KEY,
        },
      });

      await tx.progressActivityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          action: "task.ddl_change_requested",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            requestId: created.id,
            oldDueAt: task.dueAt.toISOString(),
            newDueAt: newDueAt.toISOString(),
            reason: parsed.reason,
          }),
        },
      });

      await enqueueProgressNotificationTx(
        tx,
        `progress:task_ddl_change_requested:${created.id}`,
        {
          type: "task_ddl_change_requested",
          requestId: created.id,
          taskId: task.id,
          taskTitle: task.title,
          projectName: task.project.name,
          requesterName: user.name,
          oldDueAt: task.dueAt.toISOString(),
          newDueAt: newDueAt.toISOString(),
          reason: parsed.reason,
          recipientOpenIds,
        },
        context,
      );

      return created;
    })
    .catch((err: unknown) => {
      if (isUniqueConstraintError(err)) {
        throw new Error("该任务已有待审批 DDL 修改申请");
      }
      throw err;
    });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return request;
}

export async function reviewTaskDdlChange(input: {
  requestId: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = taskDdlChangeReviewSchema.parse(input);

  const request = await prisma.taskDdlChangeRequest.findUnique({
    where: { id: parsed.requestId },
    include: {
      task: {
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          project: {
            include: {
              owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
              participants: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
        },
      },
    },
  });
  if (!request || request.status !== "PENDING") {
    throw new Error("DDL 修改申请不存在或已处理");
  }

  const task = request.task;
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (
    !canReviewTaskDdlChange({
      roles,
      scope: { team: task.team, techGroup: task.techGroup },
      projectOwnerOpenIds: getProjectOwnerOpenIds(task.project),
      taskTechGroups: getTaskTechGroups(task),
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无 DDL 修改审批权限");
  }

  const reviewedAt = new Date();
  const context = await getNotificationContext();
  const approved = parsed.decision === "APPROVED";
  const recipientOpenIds = [
    ...new Set([
      request.requesterOpenId,
      ...(await collectTaskNotificationRecipients(task)),
    ]),
  ];
  await prisma.$transaction(async (tx) => {
    const locked = await tx.taskDdlChangeRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: parsed.decision,
        pendingKey: `${parsed.decision}:${request.id}`,
        reviewerOpenId: user.openId,
        reviewerName: user.name,
        reviewComment: parsed.comment ?? "",
        reviewedAt,
      },
    });
    if (locked.count !== 1) {
      throw new Error("DDL 修改申请已被处理，请刷新后重试");
    }

    if (parsed.decision === "APPROVED") {
      const updatedTask = await tx.task.updateMany({
        where: {
          id: task.id,
          dueAt: request.oldDueAt,
          deletedAt: null,
          status: { notIn: ["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"] },
          project: {
            status: {
              notIn: [
                "ESTABLISHING",
                "ESTABLISHMENT_REJECTED",
                "COMPLETED",
                "CANCELED",
              ],
            },
          },
        },
        data: {
          dueAt: request.newDueAt,
          isOverdue: request.newDueAt.getTime() < reviewedAt.getTime(),
        },
      });
      if (updatedTask.count !== 1) {
        throw new Error("任务 DDL 已变化，请刷新后重试");
      }
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action:
          parsed.decision === "APPROVED"
            ? "task.ddl_change_approved"
            : "task.ddl_change_rejected",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          requestId: request.id,
          oldDueAt: request.oldDueAt.toISOString(),
          newDueAt: request.newDueAt.toISOString(),
          reason: request.reason,
          comment: parsed.comment ?? "",
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_ddl_change_${approved ? "approved" : "rejected"}:${request.id}`,
      {
        type: approved
          ? "task_ddl_change_approved"
          : "task_ddl_change_rejected",
        requestId: request.id,
        taskId: task.id,
        taskTitle: task.title,
        projectName: task.project.name,
        reviewerName: user.name,
        requesterOpenId: request.requesterOpenId,
        oldDueAt: request.oldDueAt.toISOString(),
        newDueAt: request.newDueAt.toISOString(),
        reason: request.reason,
        comment: parsed.comment ?? "",
        recipientOpenIds,
      },
      context,
    );
  });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return { success: true };
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}
