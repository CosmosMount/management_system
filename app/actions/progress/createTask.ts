"use server";

import { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import { canManageProject } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { normalizeAcceptanceChecklistItems } from "@/lib/progress-acceptance-checklists";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { normalizeTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { assertProjectActive } from "@/lib/progress-guards";
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
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: true,
    },
  });
  if (!project) throw new Error("项目不存在");
  assertProjectActive(project.status);

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
  const stageName = stageId
    ? project.stages.find((stage) => stage.id === stageId)?.name ?? "无阶段"
    : "无阶段";

  const dueAt = new Date(parsed.dueAt);
  const taskTechGroups = normalizeTaskTechGroups(parsed.taskTechGroups);
  if (taskTechGroups.length === 0) throw new Error("请选择任务技术组");
  const needsWeeklyReport =
    parsed.needsWeeklyReport ||
    dueAt.getTime() - Date.now() > 14 * 24 * 60 * 60 * 1000;
  const acceptanceChecklistItems = normalizeAcceptanceChecklistItems(
    parsed.acceptanceChecklistItems,
  );
  const context = await getNotificationContext();
  const recipientOpenIds = await collectTaskNotificationRecipients({
    team: project.team,
    techGroup: project.techGroup,
    assigneeOpenId: primaryAssignee.openId,
    assigneeName: primaryAssignee.name,
    assignees: orderedAssignees,
    techGroups: taskTechGroups.map((techGroup, index) => ({
      techGroup,
      sortOrder: index,
    })),
    project,
  });

  const task = await prisma.$transaction(async (tx) => {
    const activeProject = await tx.project.updateMany({
      where: { id: project.id, status: project.status },
      data: { status: project.status },
    });
    if (activeProject.count !== 1) {
      throw new Error("项目状态已更新，请刷新后重试");
    }

    const created = await tx.task.create({
      data: {
        projectId: project.id,
        stageId,
        title: parsed.title,
        goal: parsed.goal ?? "",
        urgency: parsed.urgency,
        importance: parsed.importance,
        assigneeOpenId: primaryAssignee.openId,
        assigneeName: primaryAssignee.name,
        team: project.team,
        techGroup: project.techGroup,
        metrics: parsed.metrics,
        dueAt,
        status: TaskStatus.TODO,
        needsOfflineConfirmation: parsed.needsOfflineConfirmation,
        needsWeeklyReport,
      },
    });

    await tx.taskAssignee.createMany({
      data: orderedAssignees.map((assignee, index) => ({
        taskId: created.id,
        openId: assignee.openId,
        name: assignee.name,
        sortOrder: index,
      })),
    });
    await tx.taskTechGroup.createMany({
      data: taskTechGroups.map((techGroup, index) => ({
        taskId: created.id,
        techGroup,
        sortOrder: index,
      })),
    });
    if (acceptanceChecklistItems.length > 0) {
      await tx.taskAcceptanceChecklistItem.createMany({
        data: acceptanceChecklistItems.map((item, index) => ({
          taskId: created.id,
          content: item.content,
          sortOrder: index,
        })),
      });
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        taskId: created.id,
        action: "task.created",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          title: created.title,
          assignees: orderedAssignees.map((assignee) => assignee.name),
          taskTechGroups,
          acceptanceChecklistCount: acceptanceChecklistItems.length,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_assigned:${created.id}`,
      {
        type: "task_assigned",
        taskId: created.id,
        taskTitle: created.title,
        projectId: project.id,
        projectName: project.name,
        actorName: user.name,
        stageName,
        assigneeNames: orderedAssignees.map((assignee) => assignee.name).join("、"),
        taskTechGroups,
        urgency: created.urgency,
        importance: created.importance,
        dueAt: created.dueAt.toISOString(),
        metrics: created.metrics,
        goal: created.goal,
        needsWeeklyReport: created.needsWeeklyReport,
        needsOfflineConfirmation: created.needsOfflineConfirmation,
        acceptanceChecklistItems: acceptanceChecklistItems.map((item) => item.content),
        team: created.team,
        techGroup: created.techGroup,
        assigneeOpenIds: orderedAssignees.map((assignee) => assignee.openId),
        recipientOpenIds,
      },
      context,
    );

    return created;
  });

  drainNotificationOutboxSoon();

  revalidateProgress(project.id, task.id);
  return task;
}
