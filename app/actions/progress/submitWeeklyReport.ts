"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { canSubmitWeeklyReport } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { submitWeeklyReportSchema } from "@/lib/validations/progress";

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
  });
  if (!task) throw new Error("任务不存在");
  if (task.status === "ARCHIVED") throw new Error("任务已归档");

  if (!canSubmitWeeklyReport(user.openId, task.assigneeOpenId)) {
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
