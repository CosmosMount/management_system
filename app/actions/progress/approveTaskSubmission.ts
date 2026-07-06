"use server";

import { ApprovalDecision, TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canApproveTask,
  getApproverRole,
} from "@/lib/permissions-progress";
import { assertProjectActive } from "@/lib/progress-guards";
import {
  getTaskAssigneeNames,
  getTaskAssigneeOpenIds,
} from "@/lib/progress-assignees";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import { getUserRoles } from "@/lib/permissions";
import { approvalSchema } from "@/lib/validations/progress";
import { withActionLogging } from "@/lib/logger";

export async function approveTaskSubmission(input: {
  submissionId: string;
  comment?: string;
  offlineConfirmed?: boolean;
  checkedChecklistItemIds?: string[];
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.task.submission.approve",
      module: "progress",
      action: "approveTaskSubmission",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "TaskSubmission",
      entityId: input.submissionId,
      decision: "APPROVED",
    },
    async () => approveTaskSubmissionLogged(input, user),
  );
}

async function approveTaskSubmissionLogged(
  input: {
    submissionId: string;
    comment?: string;
    offlineConfirmed?: boolean;
    checkedChecklistItemIds?: string[];
  },
  user: { openId: string; name: string },
) {
  const roles = await getUserRoles(user.openId);
  const parsed = approvalSchema.parse(input);

  const submission = await prisma.taskSubmission.findUnique({
    where: { id: parsed.submissionId },
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
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          acceptanceChecklistItems: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
        },
      },
      approvals: true,
    },
  });
  if (!submission) throw new Error("提交记录不存在");

  const task = submission.task;
  if (!task) throw new Error("关联任务不存在");
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (submission.type !== "DELIVERY") throw new Error("提交类型无效");
  if (task.status !== "PENDING_ACCEPTANCE") {
    throw new Error("任务不在待验收状态");
  }
  if (submission.approvals.length > 0) {
    throw new Error("该提交已审批");
  }
  const latestSubmission = await prisma.taskSubmission.findFirst({
    where: { taskId: task.id, type: "DELIVERY" },
    orderBy: { submittedAt: "desc" },
    select: { id: true },
  });
  if (latestSubmission?.id !== submission.id) {
    throw new Error("只能审批当前最新提交");
  }
  if (task.needsOfflineConfirmation && !parsed.offlineConfirmed) {
    throw new Error("该任务需要先完成线下确认");
  }
  const checklistItems = task.acceptanceChecklistItems;
  if (checklistItems.length > 0) {
    const checkedIds = new Set(parsed.checkedChecklistItemIds ?? []);
    const missingItem = checklistItems.find((item) => !checkedIds.has(item.id));
    if (missingItem) {
      throw new Error("请逐项确认全部验收清单后再通过");
    }
  }

  if (
    !canApproveTask(roles, {
      team: task.team,
      techGroup: task.techGroup,
    })
  ) {
    throw new Error("无验收权限");
  }

  const approverRole = getApproverRole(roles, {
    team: task.team,
    techGroup: task.techGroup,
  });
  if (!approverRole) throw new Error("无法确定审批角色");

  const context = await getNotificationContext();
  const recipientOpenIds = [
    ...new Set([
      submission.submittedBy,
      ...(await collectTaskNotificationRecipients(task)),
    ]),
  ];
  await prisma.$transaction(async (tx) => {
    const existingApproval = await tx.approvalRecord.findFirst({
      where: { submissionId: submission.id },
      select: { id: true },
    });
    if (existingApproval) throw new Error("该提交已审批");

    const statusUpdate = await tx.task.updateMany({
      where: {
        id: task.id,
        status: TaskStatus.PENDING_ACCEPTANCE,
        deletedAt: null,
      },
      data: { status: TaskStatus.COMPLETED },
    });
    if (statusUpdate.count !== 1) {
      throw new Error("该提交已审批");
    }

    const approval = await tx.approvalRecord.create({
      data: {
        submissionId: submission.id,
        approverOpenId: user.openId,
        approverName: user.name,
        approverRole,
        decision: ApprovalDecision.APPROVED,
        offlineConfirmed: parsed.offlineConfirmed,
        comment: parsed.comment ?? "",
      },
    });

    if (checklistItems.length > 0) {
      await tx.approvalChecklistConfirmation.createMany({
        data: checklistItems.map((item) => ({
          approvalId: approval.id,
          checklistItemId: item.id,
          content: item.content,
          sortOrder: item.sortOrder,
        })),
      });
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action: "task.approved",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          submissionId: submission.id,
          checklistConfirmationCount: checklistItems.length,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_approved:${submission.id}`,
      {
        type: "task_approved",
        taskId: task.id,
        taskTitle: task.title,
        projectName: task.project.name,
        assigneeOpenIds: getTaskAssigneeOpenIds(task),
        recipientOpenIds,
      },
      context,
    );
  });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return { success: true };
}

export async function rejectTaskSubmission(input: {
  submissionId: string;
  comment?: string;
  offlineConfirmed?: boolean;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.task.submission.reject",
      module: "progress",
      action: "rejectTaskSubmission",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "TaskSubmission",
      entityId: input.submissionId,
      decision: "REJECTED",
    },
    async () => rejectTaskSubmissionLogged(input, user),
  );
}

async function rejectTaskSubmissionLogged(
  input: {
    submissionId: string;
    comment?: string;
    offlineConfirmed?: boolean;
  },
  user: { openId: string; name: string },
) {
  const roles = await getUserRoles(user.openId);
  const parsed = approvalSchema.parse(input);

  const submission = await prisma.taskSubmission.findUnique({
    where: { id: parsed.submissionId },
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
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!submission?.task) throw new Error("提交记录不存在");

  const task = submission.task;
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (submission.type !== "DELIVERY") throw new Error("提交类型无效");
  if (task.status !== "PENDING_ACCEPTANCE") {
    throw new Error("任务不在待验收状态");
  }
  const existingApproval = await prisma.approvalRecord.findFirst({
    where: { submissionId: submission.id },
    select: { id: true },
  });
  if (existingApproval) throw new Error("该提交已审批");
  const latestSubmission = await prisma.taskSubmission.findFirst({
    where: { taskId: task.id, type: "DELIVERY" },
    orderBy: { submittedAt: "desc" },
    select: { id: true },
  });
  if (latestSubmission?.id !== submission.id) {
    throw new Error("只能审批当前最新提交");
  }

  if (
    !canApproveTask(roles, {
      team: task.team,
      techGroup: task.techGroup,
    })
  ) {
    throw new Error("无验收权限");
  }

  const approverRole = getApproverRole(roles, {
    team: task.team,
    techGroup: task.techGroup,
  });
  if (!approverRole) throw new Error("无法确定审批角色");

  const context = await getNotificationContext();
  const recipientOpenIds = [
    ...new Set([
      submission.submittedBy,
      ...(await collectTaskNotificationRecipients(task)),
    ]),
  ];
  await prisma.$transaction(async (tx) => {
    const existingApprovalInTx = await tx.approvalRecord.findFirst({
      where: { submissionId: submission.id },
      select: { id: true },
    });
    if (existingApprovalInTx) throw new Error("该提交已审批");

    const statusUpdate = await tx.task.updateMany({
      where: {
        id: task.id,
        status: TaskStatus.PENDING_ACCEPTANCE,
        deletedAt: null,
      },
      data: { status: TaskStatus.IN_PROGRESS },
    });
    if (statusUpdate.count !== 1) {
      throw new Error("该提交已审批");
    }

    await tx.approvalRecord.create({
      data: {
        submissionId: submission.id,
        approverOpenId: user.openId,
        approverName: user.name,
        approverRole,
        decision: ApprovalDecision.REJECTED,
        offlineConfirmed: parsed.offlineConfirmed,
        comment: parsed.comment ?? "",
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action: "task.rejected",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          submissionId: submission.id,
          comment: parsed.comment ?? "",
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_rejected:${submission.id}`,
      {
        type: "task_rejected",
        taskId: task.id,
        taskTitle: task.title,
        projectName: task.project.name,
        stageName: task.stage?.name ?? "无阶段",
        assigneeNames: getTaskAssigneeNames(task),
        taskTechGroups: getTaskTechGroups(task),
        reviewerName: user.name,
        submitterName: submission.submitterName,
        feishuDocUrl: submission.feishuDocUrl,
        keyDataUrl: submission.keyDataUrl,
        assigneeOpenIds: getTaskAssigneeOpenIds(task),
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
