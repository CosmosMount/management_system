"use server";

import { SubmissionType, TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canSubmitDelivery,
  isProgressSuperAdmin,
} from "@/lib/permissions-progress";
import { assertProjectActive } from "@/lib/progress-guards";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { revalidateProgress } from "@/lib/revalidate";
import { submitDeliverySchema } from "@/lib/validations/progress";

export async function submitTaskDelivery(input: {
  taskId: string;
  feishuDocUrl: string;
  keyDataUrl: string;
  note?: string;
  failureReason?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = submitDeliverySchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      assignees: true,
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!task) throw new Error("任务不存在");
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (task.status !== "IN_PROGRESS") {
    throw new Error("仅进行中的任务可提交交付");
  }

  if (
    !canSubmitDelivery(user.openId, getTaskAssigneeOpenIds(task)) &&
    !isProgressSuperAdmin(roles)
  ) {
    throw new Error("仅任务负责人或超级管理员可提交交付");
  }

  const context = await getNotificationContext();
  const recipientOpenIds = await collectTaskNotificationRecipients(task);
  const submission = await prisma.$transaction(async (tx) => {
    const locked = await tx.task.updateMany({
      where: { id: task.id, status: TaskStatus.IN_PROGRESS, deletedAt: null },
      data: { status: TaskStatus.PENDING_ACCEPTANCE },
    });
    if (locked.count !== 1) {
      throw new Error("任务状态已更新，请刷新后重试");
    }

    const sub = await tx.taskSubmission.create({
      data: {
        taskId: task.id,
        projectId: task.projectId,
        type: SubmissionType.DELIVERY,
        feishuDocUrl: parsed.feishuDocUrl,
        keyDataUrl: parsed.keyDataUrl,
        note: parsed.note ?? "",
        failureReason: parsed.failureReason ?? "",
        submittedBy: user.openId,
        submitterName: user.name,
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action: "task.delivery_submitted",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({ submissionId: sub.id }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_pending_acceptance:${sub.id}`,
      {
        type: "task_pending_acceptance",
        taskId: task.id,
        taskTitle: task.title,
        projectName: task.project.name,
        team: task.team,
        techGroup: task.techGroup,
        feishuDocUrl: parsed.feishuDocUrl,
        keyDataUrl: parsed.keyDataUrl,
        recipientOpenIds,
      },
      context,
    );

    return sub;
  });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return submission;
}
