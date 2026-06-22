"use server";

import { revalidatePath } from "next/cache";
import { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { canManageProject } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";
import { createTaskSchema, type CreateTaskInput } from "@/lib/validations/progress";

export async function createTask(input: CreateTaskInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const parsed = createTaskSchema.parse(input);
  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
  });
  if (!project) throw new Error("项目不存在");
  if (project.status === "ARCHIVED") throw new Error("项目已归档");

  if (
    !canManageProject(
      roles,
      { team: project.team, techGroup: project.techGroup },
      project.ownerOpenId,
      user.openId,
    )
  ) {
    throw new Error("无创建任务权限");
  }

  const assignee = await prisma.user.findUnique({
    where: { openId: parsed.assigneeOpenId },
  });
  if (!assignee) throw new Error("负责人不存在，请先同步飞书通讯录");

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      title: parsed.title,
      goal: parsed.goal ?? "",
      category: parsed.category,
      urgency: parsed.urgency,
      importance: parsed.importance,
      assigneeOpenId: assignee.openId,
      assigneeName: assignee.name,
      team: project.team,
      techGroup: project.techGroup,
      metrics: parsed.metrics,
      dueAt: new Date(parsed.dueAt),
      status: TaskStatus.TODO,
    },
  });

  await logProgressActivity({
    projectId: project.id,
    taskId: task.id,
    action: "task.created",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { title: task.title, assignee: assignee.name },
  });

  await sendProgressNotification({
    type: "task_assigned",
    taskId: task.id,
    taskTitle: task.title,
    projectName: project.name,
    team: task.team,
    techGroup: task.techGroup,
    assigneeOpenId: assignee.openId,
  }).catch(console.error);

  revalidatePath(`/progress/projects/${project.id}`);
  revalidatePath("/progress/kanban");
  return task;
}
