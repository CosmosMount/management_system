"use server";

import { revalidatePath } from "next/cache";
import { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { canManageProject } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { createTaskSchema, type CreateTaskInput } from "@/lib/validations/progress";

export async function createTask(input: CreateTaskInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const parsed = createTaskSchema.parse(input);
  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: true,
    },
  });
  if (!project) throw new Error("项目不存在");
  if (project.status === "COMPLETED") throw new Error("项目已完成");
  if (project.status === "CANCELED") throw new Error("项目已取消");

  if (
    !canManageProject(
      roles,
      { team: project.team, techGroup: project.techGroup },
      getProjectOwnerOpenIds(project),
      user.openId,
    )
  ) {
    throw new Error("无创建任务权限");
  }

  const assigneeOpenIds = [
    ...new Set(
      (
        parsed.assigneeOpenIds?.filter(Boolean) ??
        (parsed.assigneeOpenId ? [parsed.assigneeOpenId] : [])
      ),
    ),
  ];
  if (assigneeOpenIds.length === 0) {
    throw new Error("请选择负责人");
  }

  const assignees = await prisma.user.findMany({
    where: { openId: { in: assigneeOpenIds } },
    select: { openId: true, name: true },
  });
  const assigneeByOpenId = new Map(
    assignees.map((assignee) => [assignee.openId, assignee]),
  );
  const missingAssignee = assigneeOpenIds.find(
    (openId) => !assigneeByOpenId.has(openId),
  );
  if (missingAssignee) {
    throw new Error("负责人不存在，请先同步飞书通讯录");
  }

  const orderedAssignees = assigneeOpenIds.map((openId) => {
    const assignee = assigneeByOpenId.get(openId);
    if (!assignee) throw new Error("负责人不存在，请先同步飞书通讯录");
    return assignee;
  });
  const primaryAssignee = orderedAssignees[0];

  const stageId = parsed.stageId || null;
  if (stageId && !project.stages.some((s) => s.id === stageId)) {
    throw new Error("任务阶段不属于当前项目");
  }

  const dueAt = new Date(parsed.dueAt);
  const needsWeeklyReport =
    parsed.needsWeeklyReport ||
    dueAt.getTime() - Date.now() > 14 * 24 * 60 * 60 * 1000;

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      stageId,
      title: parsed.title,
      goal: parsed.goal ?? "",
      category: parsed.category,
      urgency: parsed.urgency,
      importance: parsed.importance,
      assigneeOpenId: primaryAssignee.openId,
      assigneeName: primaryAssignee.name,
      assignees: {
        create: orderedAssignees.map((assignee, index) => ({
          openId: assignee.openId,
          name: assignee.name,
          sortOrder: index,
        })),
      },
      team: project.team,
      techGroup: project.techGroup,
      metrics: parsed.metrics,
      dueAt,
      status: TaskStatus.TODO,
      needsOfflineConfirmation: parsed.needsOfflineConfirmation,
      needsWeeklyReport,
    },
  });

  await logProgressActivity({
    projectId: project.id,
    taskId: task.id,
    action: "task.created",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: {
      title: task.title,
      assignees: orderedAssignees.map((assignee) => assignee.name),
    },
  });

  await sendProgressNotification({
    type: "task_assigned",
    taskId: task.id,
    taskTitle: task.title,
    projectName: project.name,
    team: task.team,
    techGroup: task.techGroup,
    assigneeOpenIds: orderedAssignees.map((assignee) => assignee.openId),
  }, await getNotificationContext()).catch(console.error);

  revalidatePath(`/progress/projects/${project.id}`);
  revalidatePath("/progress/kanban");
  return task;
}
