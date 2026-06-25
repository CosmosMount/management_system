"use server";

import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  canManageProject,
  canSubmitWeeklyReport,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotification,
} from "@/lib/notification-outbox";
import { assertProjectActive } from "@/lib/progress-guards";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import { getUserRoles } from "@/lib/permissions";
import { riskSyncSchema, submitWeeklyReportSchema } from "@/lib/validations/progress";

function getWeekStart(date = new Date()): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function submitWeeklyReport(input: {
  taskId: string;
  progress: string;
  risks?: string;
  nextPlan?: string;
  feishuDocUrl?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = submitWeeklyReportSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      assignees: true,
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
    throw new Error("已结束任务不能提交周报");
  }
  if (!task.needsWeeklyReport) throw new Error("该任务当前未要求提交周报");

  const canSubmitAsAssignee = canSubmitWeeklyReport(
    user.openId,
    getTaskAssigneeOpenIds(task),
  );
  const canSubmitAsManager =
    canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      getProjectOwnerOpenIds(task.project),
      user.openId,
    );
  if (!canSubmitAsAssignee && !canSubmitAsManager) {
    throw new Error("仅任务负责人或任务管理者可提交必填周报");
  }

  const weekStart = getWeekStart();

  const report = await prisma.$transaction(async (tx) => {
    const liveTask = await tx.task.updateMany({
      where: {
        id: task.id,
        deletedAt: null,
        needsWeeklyReport: true,
        status: { notIn: ["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"] },
        project: { status: { notIn: ["COMPLETED", "CANCELED"] } },
      },
      data: { status: task.status },
    });
    if (liveTask.count !== 1) {
      throw new Error("任务状态已更新，请刷新后重试");
    }

    return tx.weeklyReport.upsert({
      where: { taskId_weekStart: { taskId: task.id, weekStart } },
      update: {
        progress: parsed.progress,
        risks: parsed.risks ?? "",
        nextPlan: parsed.nextPlan ?? "",
        feishuDocUrl: parsed.feishuDocUrl ?? "",
        submittedAt: new Date(),
        submittedBy: user.openId,
        submitterName: user.name,
      },
      create: {
        taskId: task.id,
        weekStart,
        progress: parsed.progress,
        risks: parsed.risks ?? "",
        nextPlan: parsed.nextPlan ?? "",
        feishuDocUrl: parsed.feishuDocUrl ?? "",
        submittedBy: user.openId,
        submitterName: user.name,
      },
    });
  });

  await logProgressActivity({
    projectId: task.projectId,
    taskId: task.id,
    action: "task.weekly_report",
    actorOpenId: user.openId,
    actorName: user.name,
  });

  revalidateProgress(task.projectId, task.id);
  return report;
}

export async function syncTaskRisk(input: { taskId: string; riskNote: string }) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = riskSyncSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      assignees: true,
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
    throw new Error("已结束任务不能同步风险");
  }
  if (!canSubmitWeeklyReport(user.openId, getTaskAssigneeOpenIds(task))) {
    throw new Error("仅任务负责人可同步风险");
  }

  const riskUpdatedAt = new Date();
  const locked = await prisma.task.updateMany({
    where: {
      id: task.id,
      deletedAt: null,
      status: { notIn: ["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"] },
      project: { status: { notIn: ["COMPLETED", "CANCELED"] } },
    },
    data: { riskNote: parsed.riskNote, riskUpdatedAt },
  });
  if (locked.count !== 1) {
    throw new Error("任务状态已更新，请刷新后重试");
  }
  const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });

  await logProgressActivity({
    projectId: task.projectId,
    taskId: task.id,
    action: "task.risk_synced",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { riskNote: parsed.riskNote },
  });

  await enqueueProgressNotification(
    `progress:task_risk_synced:${task.id}:${updated.riskUpdatedAt?.toISOString() ?? updated.updatedAt.toISOString()}`,
    {
      type: "task_risk_synced",
      taskId: task.id,
      taskTitle: task.title,
      projectName: task.project.name,
      team: task.team,
      techGroup: task.techGroup,
      assigneeOpenIds: getTaskAssigneeOpenIds(task),
      projectOwnerOpenIds: getProjectOwnerOpenIds(task.project),
      riskNote: parsed.riskNote,
    },
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return updated;
}
