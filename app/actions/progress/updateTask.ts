"use server";

import { revalidatePath } from "next/cache";
import type { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { assertTaskTransition } from "@/lib/progress-flow";
import {
  canManageProject,
  canSubmitDelivery,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";

export async function updateTaskStatus(taskId: string, status: TaskStatus) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: true },
  });
  if (!task) throw new Error("任务不存在");
  if (task.status === "ARCHIVED") throw new Error("任务已归档");

  const canManage = canManageProject(
    roles,
    { team: task.team, techGroup: task.techGroup },
    task.project.ownerOpenId,
    user.openId,
  );
  const canAssignee = canSubmitDelivery(user.openId, task.assigneeOpenId);

  if (!canManage && !canAssignee) {
    throw new Error("无权限更新任务状态");
  }

  if (canAssignee && !canManage) {
    if (status !== "IN_PROGRESS" || task.status !== "TODO") {
      throw new Error("执行人仅可从「待办」开始任务");
    }
  } else {
    assertTaskTransition(task.status, status);
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { status },
  });

  await logProgressActivity({
    projectId: task.projectId,
    taskId,
    action: "task.status_changed",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { from: task.status, to: status },
  });

  revalidatePath(`/progress/tasks/${taskId}`);
  revalidatePath(`/progress/projects/${task.projectId}`);
  revalidatePath("/progress/kanban");
  return updated;
}

export async function archiveTask(taskId: string) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { project: true },
  });
  if (!task) throw new Error("任务不存在");
  if (task.status !== "COMPLETED") {
    throw new Error("仅「已完成」的任务可归档");
  }

  if (
    !canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      task.project.ownerOpenId,
      user.openId,
    )
  ) {
    throw new Error("无归档权限");
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });

  await logProgressActivity({
    projectId: task.projectId,
    taskId,
    action: "task.archived",
    actorOpenId: user.openId,
    actorName: user.name,
  });

  revalidatePath(`/progress/tasks/${taskId}`);
  revalidatePath("/progress/archive");
  revalidatePath("/progress/kanban");
  return updated;
}
