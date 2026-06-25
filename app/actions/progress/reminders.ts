"use server";

import type { ProgressReminderKind } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  resetNotificationOutboxForRetry,
} from "@/lib/notification-outbox";
import { getUserRoles, requireSuperAdmin } from "@/lib/permissions";
import { canManageProject } from "@/lib/permissions-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import {
  isProgressReminderKind,
  runDueProgressReminderRules,
  saveProgressReminderRules,
  sendManualProjectReminder,
  sendManualTaskReminder,
} from "@/lib/progress-reminders";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateAdmin, revalidateProgress } from "@/lib/revalidate";

const reminderRuleUpdateSchema = z.object({
  rules: z.array(
    z.object({
      kind: z
        .string()
        .refine(isProgressReminderKind, "未知提醒规则")
        .transform((value) => value as ProgressReminderKind),
      enabled: z.boolean(),
      scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "请输入有效时间"),
      params: z.record(z.string(), z.coerce.number()),
    }),
  ),
});

const manualReminderSchema = z.object({
  targetType: z.enum(["PROJECT", "TASK"]),
  targetId: z.string().min(1),
  message: z.string().trim().max(500, "补充说明不能超过 500 个字符").optional(),
});

export async function updateProgressReminderRules(input: unknown) {
  await requireSuperAdmin();
  const parsed = reminderRuleUpdateSchema.parse(input);
  await saveProgressReminderRules(parsed.rules);
  revalidateAdmin();
}

export async function runProgressReminderScanNow() {
  await requireSuperAdmin();
  const result = await runDueProgressReminderRules({
    force: true,
    context: await getNotificationContext(),
  });
  if (result.skipped) {
    throw new Error("进度提醒扫描正在运行，请稍后再试");
  }
  drainNotificationOutboxSoon(10);
  revalidateAdmin();
  return result;
}

export async function retryProgressReminderOutbox(id: string) {
  await requireSuperAdmin();
  const updated = await resetNotificationOutboxForRetry({
    id,
    channel: "progress",
    type: "progress_reminder",
  });
  if (updated.count !== 1) {
    throw new Error("通知不存在或当前不可重试");
  }
  drainNotificationOutboxSoon(10);
  revalidateAdmin();
}

export async function sendManualProgressReminder(input: unknown) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = manualReminderSchema.parse(input);
  const message = parsed.message?.trim() || undefined;
  const context = await getNotificationContext();

  if (parsed.targetType === "PROJECT") {
    const project = await prisma.project.findUnique({
      where: { id: parsed.targetId },
      include: {
        owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
    });
    if (!project) throw new Error("项目不存在");
    if (project.status === "COMPLETED" || project.status === "CANCELED") {
      throw new Error("已结束项目不能催促");
    }
    if (
      !canManageProject(
        roles,
        { team: project.team, techGroup: project.techGroup },
        getProjectOwnerOpenIds(project),
        user.openId,
      )
    ) {
      throw new Error("无项目催促权限");
    }

    const queued = await sendManualProjectReminder({
      projectId: project.id,
      actorName: user.name,
      message,
      context,
    });
    if (queued) {
      await logProgressActivity({
        projectId: project.id,
        action: "project.reminded",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: { message: message ?? "" },
      });
    }
    drainNotificationOutboxSoon(10);
    revalidateProgress(project.id);
    return;
  }

  const task = await prisma.task.findUnique({
    where: { id: parsed.targetId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!task || task.deletedAt) throw new Error("任务不存在");
  if (task.project.status === "COMPLETED" || task.project.status === "CANCELED") {
    throw new Error("已结束项目下的任务不能催促");
  }
  if (task.status === "COMPLETED" || task.status === "ARCHIVED") {
    throw new Error("已结束任务不能催促");
  }
  if (
    !canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      getProjectOwnerOpenIds(task.project),
      user.openId,
    )
  ) {
    throw new Error("无任务催促权限");
  }

  const queued = await sendManualTaskReminder({
    taskId: task.id,
    actorName: user.name,
    message,
    context,
  });
  if (queued) {
    await logProgressActivity({
      projectId: task.projectId,
      taskId: task.id,
      action: "task.reminded",
      actorOpenId: user.openId,
      actorName: user.name,
      payload: { message: message ?? "" },
    });
  }
  drainNotificationOutboxSoon(10);
  revalidateProgress(task.projectId, task.id);
}
