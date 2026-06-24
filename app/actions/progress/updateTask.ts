"use server";

import { revalidatePath } from "next/cache";
import type { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { assertTaskTransition } from "@/lib/progress-flow";
import {
  canManageProject,
  canSubmitDelivery,
} from "@/lib/permissions-progress";
import { assertProjectActive } from "@/lib/progress-guards";
import { getNotificationContext } from "@/lib/request-origin";
import {
  getTaskAssigneeNames,
  getTaskAssigneeOpenIds,
} from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";
import {
  updateTaskSchema,
  type UpdateTaskInput,
} from "@/lib/validations/progress";

export async function updateTaskStatus(taskId: string, status: TaskStatus) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const task = await prisma.task.findUnique({
    where: { id: taskId },
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
  if (task.status === "ARCHIVED") throw new Error("任务已归档");
  assertProjectActive(task.project.status);

  const canManage = canManageProject(
    roles,
    { team: task.team, techGroup: task.techGroup },
    getProjectOwnerOpenIds(task.project),
    user.openId,
  );
  const canAssignee = canSubmitDelivery(
    user.openId,
    getTaskAssigneeOpenIds(task),
  );

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
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!task) throw new Error("任务不存在");
  assertProjectActive(task.project.status);
  if (task.status !== "COMPLETED") {
    throw new Error("仅「已完成」的任务可归档");
  }

  if (
    !canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      getProjectOwnerOpenIds(task.project),
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

export async function updateTask(input: UpdateTaskInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = updateTaskSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          stages: true,
        },
      },
      stage: true,
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!task) throw new Error("任务不存在");
  if (task.status === "ARCHIVED") throw new Error("已归档任务不可编辑");
  assertProjectActive(task.project.status);

  if (
    !canManageProject(
      roles,
      { team: task.team, techGroup: task.techGroup },
      getProjectOwnerOpenIds(task.project),
      user.openId,
    )
  ) {
    throw new Error("无任务编辑权限");
  }

  const assigneeOpenIds = [
    ...new Set(
      parsed.assigneeOpenIds?.filter(Boolean) ??
        (parsed.assigneeOpenId ? [parsed.assigneeOpenId] : []),
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
  if (!primaryAssignee) throw new Error("请选择负责人");

  const stageId = parsed.stageId || null;
  if (stageId && !task.project.stages.some((stage) => stage.id === stageId)) {
    throw new Error("任务阶段不属于当前项目");
  }

  const dueAt = new Date(parsed.dueAt);
  const nextStageName =
    stageId
      ? task.project.stages.find((stage) => stage.id === stageId)?.name ?? "无阶段"
      : "无阶段";
  const nextAssigneeNames = orderedAssignees
    .map((assignee) => assignee.name)
    .join("、");
  const oldAssigneeOpenIds = getTaskAssigneeOpenIds(task);
  const changes = buildTaskChangeSummary({
    before: {
      title: task.title,
      goal: task.goal,
      stageName: task.stage?.name ?? "无阶段",
      category: task.category,
      urgency: task.urgency,
      importance: task.importance,
      assigneeNames: getTaskAssigneeNames(task),
      metrics: task.metrics,
      dueAt: task.dueAt.toISOString(),
      needsOfflineConfirmation: task.needsOfflineConfirmation,
      needsWeeklyReport: task.needsWeeklyReport,
    },
    after: {
      title: parsed.title,
      goal: parsed.goal ?? "",
      stageName: nextStageName,
      category: parsed.category,
      urgency: parsed.urgency,
      importance: parsed.importance,
      assigneeNames: nextAssigneeNames,
      metrics: parsed.metrics,
      dueAt: dueAt.toISOString(),
      needsOfflineConfirmation: parsed.needsOfflineConfirmation,
      needsWeeklyReport: parsed.needsWeeklyReport,
    },
  });

  const updated = await prisma.$transaction(async (tx) => {
    const record = await tx.task.update({
      where: { id: task.id },
      data: {
        stageId,
        title: parsed.title,
        goal: parsed.goal ?? "",
        category: parsed.category,
        urgency: parsed.urgency,
        importance: parsed.importance,
        assigneeOpenId: primaryAssignee.openId,
        assigneeName: primaryAssignee.name,
        metrics: parsed.metrics,
        dueAt,
        needsOfflineConfirmation: parsed.needsOfflineConfirmation,
        needsWeeklyReport: parsed.needsWeeklyReport,
      },
    });

    await tx.taskAssignee.deleteMany({ where: { taskId: task.id } });
    await tx.taskAssignee.createMany({
      data: orderedAssignees.map((assignee, index) => ({
        taskId: task.id,
        openId: assignee.openId,
        name: assignee.name,
        sortOrder: index,
      })),
    });

    if (changes.length > 0) {
      await tx.progressActivityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          action: "task.updated",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            changes,
            oldAssigneeOpenIds,
            assigneeOpenIds: orderedAssignees.map((assignee) => assignee.openId),
          }),
        },
      });
    }

    return record;
  });

  if (changes.length > 0) {
    await sendProgressNotification(
      {
        type: "task_updated",
        taskId: task.id,
        taskTitle: parsed.title,
        projectName: task.project.name,
        actorName: user.name,
        changes,
        team: task.team,
        techGroup: task.techGroup,
        oldTeam: task.team,
        oldTechGroup: task.techGroup,
        assigneeOpenIds: orderedAssignees.map((assignee) => assignee.openId),
        oldAssigneeOpenIds,
        projectOwnerOpenIds: getProjectOwnerOpenIds(task.project),
      },
      await getNotificationContext(),
    ).catch(console.error);
  }

  revalidatePath(`/progress/tasks/${task.id}`);
  revalidatePath(`/progress/projects/${task.projectId}`);
  revalidatePath("/progress/kanban");
  return updated;
}

function buildTaskChangeSummary({
  before,
  after,
}: {
  before: TaskChangeComparable;
  after: TaskChangeComparable;
}): string[] {
  const labels: Array<[keyof TaskChangeComparable, string, (value: unknown) => string]> = [
    ["title", "任务名称", String],
    ["goal", "详细说明", formatOptional],
    ["stageName", "所属阶段", String],
    ["category", "类别", String],
    ["urgency", "紧急程度", String],
    ["importance", "重要程度", String],
    ["assigneeNames", "负责人", String],
    ["metrics", "指标", String],
    ["dueAt", "截止时间", formatDateTime],
    ["needsOfflineConfirmation", "线下确认", formatBoolean],
    ["needsWeeklyReport", "定期周报", formatBoolean],
  ];
  return labels.flatMap(([key, label, format]) => {
    if (before[key] === after[key]) return [];
    return `${label}：${format(before[key])} -> ${format(after[key])}`;
  });
}

type TaskChangeComparable = {
  title: string;
  goal: string;
  stageName: string;
  category: string;
  urgency: string;
  importance: string;
  assigneeNames: string;
  metrics: string;
  dueAt: string;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
};

function formatOptional(value: unknown): string {
  return typeof value === "string" && value ? value : "未填写";
}

function formatDateTime(value: unknown): string {
  return typeof value === "string"
    ? new Date(value).toLocaleString("zh-CN")
    : "未设置";
}

function formatBoolean(value: unknown): string {
  return value ? "需要" : "不需要";
}
