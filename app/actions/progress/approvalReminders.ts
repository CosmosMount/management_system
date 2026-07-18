"use server";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withActionLogging } from "@/lib/logger";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import { getUserRoles } from "@/lib/permissions";
import {
  canRequestProgressApprovalReminder,
  getProgressApprovalCandidates,
  isProgressApprovalKind,
  progressApprovalKindLabels,
  resolveProgressApproval,
  type ProgressApprovalReference,
} from "@/lib/progress-approval-domain";
import { getProgressApprovalReminderSetting } from "@/lib/progress-approval-reminder-settings";
import { requireSessionUser } from "@/lib/progress-activity";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";

const referenceSchema = z.object({
  kind: z
    .string()
    .refine(isProgressApprovalKind, "未知审批类型"),
  id: z.string().trim().min(1, "审批记录不能为空"),
});

const requestSchema = z.object({
  reference: referenceSchema,
  recipientOpenIds: z
    .array(z.string().trim().min(1))
    .min(1, "请至少选择一位审批人")
    .max(50, "一次最多提醒 50 位审批人"),
});

export async function getProgressApprovalReminderCandidates(input: unknown) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.approval_reminder.candidates.read",
      module: "progress",
      action: "getProgressApprovalReminderCandidates",
      actorOpenId: user.openId,
      actorName: user.name,
    },
    async () => {
      const reference = referenceSchema.parse(input) as ProgressApprovalReference;
      const [approval, roles] = await Promise.all([
        resolveProgressApproval(reference),
        getUserRoles(user.openId),
      ]);
      if (!approval) throw new Error("审批事项不存在");
      if (approval.status !== "PENDING") throw new Error("该审批事项已不再待处理");
      if (!canRequestProgressApprovalReminder({ approval, roles, userOpenId: user.openId })) {
        throw new Error("你没有请求该审批的权限");
      }
      return getProgressApprovalCandidates(approval);
    },
  );
}

export async function requestProgressApprovalReminder(input: unknown) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.approval_reminder.request",
      module: "progress",
      action: "requestProgressApprovalReminder",
      actorOpenId: user.openId,
      actorName: user.name,
    },
    async () => requestProgressApprovalReminderLogged(input, user),
  );
}

async function requestProgressApprovalReminderLogged(
  input: unknown,
  user: { openId: string; name: string },
) {
  const parsed = requestSchema.parse(input);
  const reference = parsed.reference as ProgressApprovalReference;
  const recipientOpenIds = [...new Set(parsed.recipientOpenIds)];
  const [approval, roles, setting, context] = await Promise.all([
    resolveProgressApproval(reference),
    getUserRoles(user.openId),
    getProgressApprovalReminderSetting(),
    getNotificationContext(),
  ]);
  if (!approval) throw new Error("审批事项不存在");
  if (approval.status !== "PENDING") throw new Error("该审批事项已不再待处理");
  if (!canRequestProgressApprovalReminder({ approval, roles, userOpenId: user.openId })) {
    throw new Error("你没有请求该审批的权限");
  }

  const candidates = await getProgressApprovalCandidates(approval);
  const initialCandidatesByOpenId = new Map(
    candidates.map((item) => [item.openId, item]),
  );
  const invalidRecipient = recipientOpenIds.find(
    (openId) => !initialCandidatesByOpenId.has(openId),
  );
  if (invalidRecipient) throw new Error("所选人员中包含无权处理该审批的人员");

  const now = new Date();
  const cooldownStart = new Date(
    now.getTime() - setting.cooldownMinutes * 60_000,
  );
  const batchId = randomUUID();
  const outboxEventKey = `progress:approval_reminder:${batchId}`;

  const result = await prisma.$transaction(async (tx) => {
    const lockKey = `approval-reminder:${reference.kind}:${reference.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    const approvalBeforeContextLock = await resolveProgressApproval(reference, tx);
    if (!approvalBeforeContextLock) {
      throw new Error("该审批事项已不再待处理");
    }
    await lockProgressApprovalForReminder(
      tx,
      reference,
      approvalBeforeContextLock,
    );
    const currentApproval = await resolveProgressApproval(reference, tx);
    if (!currentApproval || currentApproval.status !== "PENDING") {
      throw new Error("该审批事项已不再待处理");
    }
    const currentActorRoles = await tx.userRole.findMany({
      where: { openId: user.openId },
      select: { role: true, team: true, techGroup: true },
    });
    if (
      !canRequestProgressApprovalReminder({
        approval: currentApproval,
        roles: currentActorRoles,
        userOpenId: user.openId,
      })
    ) {
      throw new Error("你已没有请求该审批的权限");
    }
    const currentCandidates = await getProgressApprovalCandidates(
      currentApproval,
      tx,
    );
    const candidatesByOpenId = new Map(
      currentCandidates.map((item) => [item.openId, item]),
    );
    if (recipientOpenIds.some((openId) => !candidatesByOpenId.has(openId))) {
      throw new Error("所选审批人的权限已发生变化，请重新选择");
    }

    const recent = setting.cooldownMinutes > 0
      ? await tx.progressApprovalReminderDelivery.findMany({
          where: {
            approvalKind: reference.kind,
            approvalId: reference.id,
            recipientOpenId: { in: recipientOpenIds },
            createdAt: { gt: cooldownStart },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];
    const latestByRecipient = new Map<string, Date>();
    for (const delivery of recent) {
      if (!latestByRecipient.has(delivery.recipientOpenId)) {
        latestByRecipient.set(delivery.recipientOpenId, delivery.createdAt);
      }
    }

    const queuedOpenIds = recipientOpenIds.filter(
      (openId) => !latestByRecipient.has(openId),
    );
    if (queuedOpenIds.length === 0) {
      return {
        sentCount: 0,
        skippedCount: recipientOpenIds.length,
        nextAvailableAt: getNextAvailableAt(latestByRecipient, setting.cooldownMinutes),
      };
    }

    const recipientNames = queuedOpenIds.map(
      (openId) => candidatesByOpenId.get(openId)?.name ?? "未知审批人",
    );
    await tx.progressApprovalReminderDelivery.createMany({
      data: queuedOpenIds.map((openId) => ({
        approvalKind: reference.kind,
        approvalId: reference.id,
        batchId,
        projectId: currentApproval.project.id,
        taskId: currentApproval.task?.id ?? null,
        remindedByOpenId: user.openId,
        remindedByName: user.name,
        recipientOpenId: openId,
        recipientName: candidatesByOpenId.get(openId)?.name ?? "未知审批人",
        outboxEventKey,
      })),
    });
    await tx.progressActivityLog.create({
      data: {
        projectId: currentApproval.project.id,
        taskId: currentApproval.task?.id ?? null,
        action: "approval.reminder_requested",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          approvalKindLabel: progressApprovalKindLabels[reference.kind],
          approvalSubject: currentApproval.subject,
          recipientNames,
        }),
      },
    });
    await enqueueProgressNotificationTx(
      tx,
      outboxEventKey,
      {
        type: "approval_reminder_requested",
        approvalKindLabel: progressApprovalKindLabels[reference.kind],
        projectName: currentApproval.project.name,
        subject: currentApproval.subject,
        submitterName: currentApproval.submitterName || "未知提交人",
        reminderName: user.name,
        submittedAt: currentApproval.submittedAt.toISOString(),
        recipientOpenIds: queuedOpenIds,
        linkPath: currentApproval.href,
      },
      context,
    );

    return {
      sentCount: queuedOpenIds.length,
      skippedCount: recipientOpenIds.length - queuedOpenIds.length,
      nextAvailableAt: getNextAvailableAt(latestByRecipient, setting.cooldownMinutes),
    };
  });

  if (result.sentCount > 0) drainNotificationOutboxSoon(10);
  revalidateProgress(approval.project.id, approval.task?.id);
  return result;
}

async function lockProgressApprovalForReminder(
  tx: Prisma.TransactionClient,
  reference: ProgressApprovalReference,
  approval: NonNullable<Awaited<ReturnType<typeof resolveProgressApproval>>>,
): Promise<void> {
  // Match the lock order used by each approval action to avoid deadlock cycles.
  if (
    reference.kind === "STAGE_ACCEPTANCE" ||
    reference.kind === "TASK_ACCEPTANCE" ||
    reference.kind === "TASK_CREATION"
  ) {
    await lockProgressApprovalContextRows(tx, approval);
    await lockProgressApprovalRow(tx, reference);
    return;
  }
  await lockProgressApprovalRow(tx, reference);
  await lockProgressApprovalContextRows(tx, approval);
}

async function lockProgressApprovalContextRows(
  tx: Prisma.TransactionClient,
  approval: NonNullable<Awaited<ReturnType<typeof resolveProgressApproval>>>,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${approval.project.id} FOR UPDATE`;
  if (approval.stage) {
    await tx.$queryRaw`SELECT id FROM "ProjectStage" WHERE id = ${approval.stage.id} FOR UPDATE`;
  }
  if (approval.task) {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${approval.task.id} FOR UPDATE`;
  }
}

async function lockProgressApprovalRow(
  tx: Prisma.TransactionClient,
  reference: ProgressApprovalReference,
): Promise<void> {
  switch (reference.kind) {
    case "PROJECT_ESTABLISHMENT":
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "STAGE_ACCEPTANCE":
    case "TASK_ACCEPTANCE":
      await tx.$queryRaw`SELECT id FROM "TaskSubmission" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "PROJECT_BATCH_DDL":
    case "PROJECT_STAGE_DDL":
      await tx.$queryRaw`SELECT id FROM "ProjectDdlChangeRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "TASK_CREATION":
      await tx.$queryRaw`SELECT id FROM "TaskCreationRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "TASK_DELETION":
      await tx.$queryRaw`SELECT id FROM "TaskDeletionRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "TASK_DDL":
      await tx.$queryRaw`SELECT id FROM "TaskDdlChangeRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
  }
}

function getNextAvailableAt(
  latestByRecipient: Map<string, Date>,
  cooldownMinutes: number,
): string | null {
  if (latestByRecipient.size === 0 || cooldownMinutes === 0) return null;
  return new Date(
    Math.max(
      ...[...latestByRecipient.values()].map(
        (createdAt) => createdAt.getTime() + cooldownMinutes * 60_000,
      ),
    ),
  ).toISOString();
}
