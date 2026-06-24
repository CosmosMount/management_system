"use server";

import { revalidatePath } from "next/cache";
import { ApprovalDecision, TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  canApproveTask,
  getApproverRole,
} from "@/lib/permissions-progress";
import { assertProjectActive } from "@/lib/progress-guards";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { approvalSchema } from "@/lib/validations/progress";

export async function approveTaskSubmission(input: {
  submissionId: string;
  comment?: string;
  offlineConfirmed?: boolean;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = approvalSchema.parse(input);

  const submission = await prisma.taskSubmission.findUnique({
    where: { id: parsed.submissionId },
    include: {
      task: { include: { project: true, assignees: true } },
      approvals: true,
    },
  });
  if (!submission) throw new Error("提交记录不存在");

  const task = submission.task;
  if (!task) throw new Error("关联任务不存在");
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

  await prisma.$transaction(async (tx) => {
    await tx.approvalRecord.create({
      data: {
        submissionId: submission.id,
        approverOpenId: user.openId,
        approverName: user.name,
        approverRole,
        decision: ApprovalDecision.APPROVED,
        docViewVerified: false,
        offlineConfirmed: parsed.offlineConfirmed,
        comment: parsed.comment ?? "",
      },
    });

    if (submission.type === "DELIVERY" && task.status === "PENDING_ACCEPTANCE") {
      await tx.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.COMPLETED },
      });
    }
  });

  await logProgressActivity({
    projectId: task.projectId,
    taskId: task.id,
    action: "task.approved",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { submissionId: submission.id },
  });

  await sendProgressNotification({
    type: "task_approved",
    taskId: task.id,
    taskTitle: task.title,
    projectName: task.project.name,
    assigneeOpenIds: getTaskAssigneeOpenIds(task),
  }, await getNotificationContext()).catch(console.error);

  revalidatePath(`/progress/tasks/${task.id}`);
  revalidatePath("/progress/kanban");
  return { success: true };
}

export async function rejectTaskSubmission(input: {
  submissionId: string;
  comment?: string;
  offlineConfirmed?: boolean;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = approvalSchema.parse(input);

  const submission = await prisma.taskSubmission.findUnique({
    where: { id: parsed.submissionId },
    include: { task: { include: { project: true, assignees: true } } },
  });
  if (!submission?.task) throw new Error("提交记录不存在");

  const task = submission.task;
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

  await prisma.$transaction(async (tx) => {
    await tx.approvalRecord.create({
      data: {
        submissionId: submission.id,
        approverOpenId: user.openId,
        approverName: user.name,
        approverRole,
        decision: ApprovalDecision.REJECTED,
        docViewVerified: false,
        offlineConfirmed: parsed.offlineConfirmed,
        comment: parsed.comment ?? "",
      },
    });

    await tx.task.update({
      where: { id: task.id },
      data: { status: TaskStatus.IN_PROGRESS },
    });
  });

  await logProgressActivity({
    projectId: task.projectId,
    taskId: task.id,
    action: "task.rejected",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { submissionId: submission.id, comment: parsed.comment ?? "" },
  });

  await sendProgressNotification({
    type: "task_rejected",
    taskId: task.id,
    taskTitle: task.title,
    projectName: task.project.name,
    assigneeOpenIds: getTaskAssigneeOpenIds(task),
    comment: parsed.comment ?? "",
  }, await getNotificationContext()).catch(console.error);

  revalidatePath(`/progress/tasks/${task.id}`);
  revalidatePath("/progress/kanban");
  return { success: true };
}
