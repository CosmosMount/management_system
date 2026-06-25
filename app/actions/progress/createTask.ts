"use server";

import { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotification,
} from "@/lib/notification-outbox";
import { canManageProject } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { normalizeAcceptanceChecklistItems } from "@/lib/progress-acceptance-checklists";
import { revalidateProgress } from "@/lib/revalidate";
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
  const acceptanceChecklistItems = normalizeAcceptanceChecklistItems(
    parsed.acceptanceChecklistItems,
  );

  const task = await prisma.$transaction(async (tx) => {
    const activeProject = await tx.project.updateMany({
      where: { id: project.id, status: project.status },
      data: { status: project.status },
    });
    if (activeProject.count !== 1) {
      throw new Error("项目状态已更新，请刷新后重试");
    }

    return tx.task.create({
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
        acceptanceChecklistItems: {
          create: acceptanceChecklistItems.map((item, index) => ({
            content: item.content,
            sortOrder: index,
          })),
        },
      },
    });
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
      acceptanceChecklistCount: acceptanceChecklistItems.length,
    },
  });

  await enqueueProgressNotification(
    `progress:task_assigned:${task.id}`,
    {
      type: "task_assigned",
      taskId: task.id,
      taskTitle: task.title,
      projectName: project.name,
      team: task.team,
      techGroup: task.techGroup,
      assigneeOpenIds: orderedAssignees.map((assignee) => assignee.openId),
    },
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidateProgress(project.id, task.id);
  return task;
}
