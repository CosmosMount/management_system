"use server";

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withActionLogging } from "@/lib/logger";
import {
  cancelRetryableNotificationOutboxesTx,
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  getProgressApprovalCandidates,
  isProgressApprovalKind,
  progressApprovalKindLabels,
  resolveProgressApproval,
  type ProgressApprovalReference,
} from "@/lib/progress-approval-domain";
import { lockProgressApprovalForMutation } from "@/lib/progress-approval-locks";
import { requireSessionUser } from "@/lib/progress-activity";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";

const referenceSchema = z.object({
  kind: z.string().refine(isProgressApprovalKind, "未知审批类型"),
  id: z.string().trim().min(1, "审批记录不能为空"),
});

export async function withdrawProgressApproval(input: unknown) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.approval.withdraw",
      module: "progress",
      action: "withdrawProgressApproval",
      actorOpenId: user.openId,
      actorName: user.name,
    },
    async () => withdrawProgressApprovalLogged(input, user),
  );
}

async function withdrawProgressApprovalLogged(
  input: unknown,
  user: { openId: string; name: string },
) {
  const reference = referenceSchema.parse(input) as ProgressApprovalReference;
  const [approval, context] = await Promise.all([
    resolveProgressApproval(reference),
    getNotificationContext(),
  ]);
  assertWithdrawable(approval, user.openId);

  const withdrawnAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await lockProgressApprovalForMutation(tx, reference, approval);
    const current = await resolveProgressApproval(reference, tx);
    assertWithdrawable(current, user.openId);

    const candidates = await getProgressApprovalCandidates(current, tx);
    await applyWithdrawal(tx, reference, user, withdrawnAt);
    await cancelPendingApprovalReminders(tx, reference);

    await tx.progressActivityLog.create({
      data: {
        projectId: current.project.id,
        taskId: current.task?.id,
        action: "approval.withdrawn",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          approvalKindLabel: progressApprovalKindLabels[reference.kind],
          approvalSubject: current.subject,
          submittedAt: current.submittedAt.toISOString(),
          withdrawnAt: withdrawnAt.toISOString(),
        }),
      },
    });

    const recipientOpenIds = candidates
      .map((candidate) => candidate.openId)
      .filter((openId) => openId !== user.openId);
    if (recipientOpenIds.length > 0) {
      await enqueueProgressNotificationTx(
        tx,
        `progress:approval_withdrawn:${reference.kind}:${reference.id}:${withdrawnAt.toISOString()}`,
        {
          type: "approval_withdrawn",
          approvalKindLabel: progressApprovalKindLabels[reference.kind],
          projectName: current.project.name,
          subject: current.subject,
          submitterName: current.submitterName || "未知提交人",
          withdrawnAt: withdrawnAt.toISOString(),
          recipientOpenIds,
          linkPath: current.href,
        },
        context,
      );
    }

    return {
      projectId: current.project.id,
      taskId: current.task?.id,
      notificationQueued: recipientOpenIds.length > 0,
    };
  });

  if (result.notificationQueued) drainNotificationOutboxSoon(10);
  revalidateProgress(result.projectId, result.taskId);
  return { success: true };
}

function assertWithdrawable(
  approval: Awaited<ReturnType<typeof resolveProgressApproval>>,
  userOpenId: string,
): asserts approval is NonNullable<Awaited<ReturnType<typeof resolveProgressApproval>>> {
  if (!approval) throw new Error("审批事项不存在");
  if (approval.status !== "PENDING") throw new Error("该审批事项已不再待处理");
  if (approval.submitterOpenId !== userOpenId) throw new Error("仅原提交人可以撤回审批");
}

async function applyWithdrawal(
  tx: Prisma.TransactionClient,
  reference: ProgressApprovalReference,
  user: { openId: string; name: string },
  withdrawnAt: Date,
) {
  const withdrawnBy = {
    withdrawnAt,
    withdrawnByOpenId: user.openId,
    withdrawnByName: user.name,
  };
  switch (reference.kind) {
    case "PROJECT_ESTABLISHMENT": {
      const updated = await tx.project.updateMany({
        where: {
          id: reference.id,
          status: "ESTABLISHING",
          requesterOpenId: user.openId,
        },
        data: {
          status: "ESTABLISHMENT_WITHDRAWN",
          establishmentWithdrawnAt: withdrawnAt,
          establishmentWithdrawnByOpenId: user.openId,
          establishmentWithdrawnByName: user.name,
        },
      });
      assertUpdated(updated.count);
      return;
    }
    case "STAGE_ACCEPTANCE": {
      const submission = await tx.taskSubmission.findUnique({
        where: { id: reference.id },
        select: { stageId: true },
      });
      if (!submission?.stageId) throw new Error("阶段验收提交不存在");
      const stage = await tx.projectStage.updateMany({
        where: {
          id: submission.stageId,
          status: "PENDING_ACCEPTANCE",
          currentSubmissionId: reference.id,
        },
        data: { status: "IN_PROGRESS", currentSubmissionId: null },
      });
      assertUpdated(stage.count);
      const record = await tx.taskSubmission.updateMany({
        where: { id: reference.id, submittedBy: user.openId, withdrawnAt: null },
        data: withdrawnBy,
      });
      assertUpdated(record.count);
      return;
    }
    case "TASK_ACCEPTANCE": {
      const submission = await tx.taskSubmission.findUnique({
        where: { id: reference.id },
        select: { taskId: true },
      });
      if (!submission?.taskId) throw new Error("任务验收提交不存在");
      const task = await tx.task.updateMany({
        where: {
          id: submission.taskId,
          status: "PENDING_ACCEPTANCE",
          deletedAt: null,
        },
        data: { status: "IN_PROGRESS" },
      });
      assertUpdated(task.count);
      const record = await tx.taskSubmission.updateMany({
        where: { id: reference.id, submittedBy: user.openId, withdrawnAt: null },
        data: withdrawnBy,
      });
      assertUpdated(record.count);
      return;
    }
    case "PROJECT_BATCH_DDL":
    case "PROJECT_STAGE_DDL": {
      const updated = await tx.projectDdlChangeRequest.updateMany({
        where: { id: reference.id, status: "PENDING", requesterOpenId: user.openId },
        data: {
          status: "WITHDRAWN",
          pendingKey: `WITHDRAWN:${reference.id}`,
          ...withdrawnBy,
        },
      });
      assertUpdated(updated.count);
      return;
    }
    case "TASK_CREATION": {
      const updated = await tx.taskCreationRequest.updateMany({
        where: { id: reference.id, status: "PENDING", requesterOpenId: user.openId },
        data: { status: "WITHDRAWN", ...withdrawnBy },
      });
      assertUpdated(updated.count);
      return;
    }
    case "TASK_DELETION": {
      const updated = await tx.taskDeletionRequest.updateMany({
        where: { id: reference.id, status: "PENDING", requesterOpenId: user.openId },
        data: {
          status: "WITHDRAWN",
          pendingKey: `WITHDRAWN:${reference.id}`,
          ...withdrawnBy,
        },
      });
      assertUpdated(updated.count);
      return;
    }
    case "TASK_DDL": {
      const updated = await tx.taskDdlChangeRequest.updateMany({
        where: { id: reference.id, status: "PENDING", requesterOpenId: user.openId },
        data: {
          status: "WITHDRAWN",
          pendingKey: `WITHDRAWN:${reference.id}`,
          ...withdrawnBy,
        },
      });
      assertUpdated(updated.count);
      return;
    }
  }
}

function assertUpdated(count: number) {
  if (count !== 1) throw new Error("审批状态已更新，请刷新后重试");
}

async function cancelPendingApprovalReminders(
  tx: Prisma.TransactionClient,
  reference: ProgressApprovalReference,
) {
  const deliveries = await tx.progressApprovalReminderDelivery.findMany({
    where: { approvalKind: reference.kind, approvalId: reference.id },
    select: { outboxEventKey: true },
    distinct: ["outboxEventKey"],
  });
  const eventKeys = deliveries.map((item) => item.outboxEventKey);
  if (eventKeys.length === 0) return;
  const cancellationMessage = "审批已由提交人撤回，提醒不再发送";
  await cancelRetryableNotificationOutboxesTx(tx, eventKeys, cancellationMessage);
}
