"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { canSubmitWeeklyReport } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { assertProjectActive } from "@/lib/progress-guards";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getNotificationContext } from "@/lib/request-origin";
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
  const parsed = submitWeeklyReportSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: { project: true, assignees: true },
  });
  if (!task) throw new Error("任务不存在");
  assertProjectActive(task.project.status);
  if (task.status === "ARCHIVED") throw new Error("任务已归档");

  if (!canSubmitWeeklyReport(user.openId, getTaskAssigneeOpenIds(task))) {
    throw new Error("仅任务负责人可提交周报");
  }

  const weekStart = getWeekStart();

  const existing = await prisma.weeklyReport.findFirst({
    where: { taskId: task.id, weekStart },
  });

  const report = existing
    ? await prisma.weeklyReport.update({
        where: { id: existing.id },
        data: {
          progress: parsed.progress,
          risks: parsed.risks ?? "",
          nextPlan: parsed.nextPlan ?? "",
          feishuDocUrl: parsed.feishuDocUrl ?? "",
          submittedAt: new Date(),
        },
      })
    : await prisma.weeklyReport.create({
        data: {
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

  await logProgressActivity({
    projectId: task.projectId,
    taskId: task.id,
    action: "task.weekly_report",
    actorOpenId: user.openId,
    actorName: user.name,
  });

  revalidatePath(`/progress/tasks/${task.id}`);
  return report;
}

export async function syncTaskRisk(input: { taskId: string; riskNote: string }) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = riskSyncSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: { project: true, assignees: true },
  });
  if (!task) throw new Error("任务不存在");
  assertProjectActive(task.project.status);
  if (task.status === "ARCHIVED" || task.status === "COMPLETED") {
    throw new Error("已结束任务不能同步风险");
  }
  if (!canSubmitWeeklyReport(user.openId, getTaskAssigneeOpenIds(task))) {
    throw new Error("仅任务负责人可同步风险");
  }

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { riskNote: parsed.riskNote, riskUpdatedAt: new Date() },
  });

  await logProgressActivity({
    projectId: task.projectId,
    taskId: task.id,
    action: "task.risk_synced",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { riskNote: parsed.riskNote },
  });

  await sendProgressNotification({
    type: "task_risk_synced",
    taskId: task.id,
    taskTitle: task.title,
    projectName: task.project.name,
    team: task.team,
    techGroup: task.techGroup,
    assigneeOpenIds: getTaskAssigneeOpenIds(task),
    projectOwnerOpenId: task.project.ownerOpenId,
    riskNote: parsed.riskNote,
  }, await getNotificationContext()).catch(console.error);

  revalidatePath(`/progress/tasks/${task.id}`);
  revalidatePath("/progress/kanban");
  return updated;
}
