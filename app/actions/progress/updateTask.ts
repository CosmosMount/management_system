"use server";

import type { TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotification,
} from "@/lib/notification-outbox";
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
import {
  areAcceptanceChecklistsEqual,
  formatAcceptanceChecklistSummary,
  normalizeAcceptanceChecklistItems,
} from "@/lib/progress-acceptance-checklists";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";
import { revalidateProgress } from "@/lib/revalidate";
import {
  taskRestartSchema,
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
  if (task.deletedAt) throw new Error("任务已删除");
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

  const locked = await prisma.task.updateMany({
    where: { id: taskId, deletedAt: null },
    data: { status },
  });
  if (locked.count !== 1) {
    throw new Error("任务已被删除，请刷新后重试");
  }
  const updated = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });

  await logProgressActivity({
    projectId: task.projectId,
    taskId,
    action: "task.status_changed",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { from: task.status, to: status },
  });

  revalidateProgress(task.projectId, taskId);
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
  if (task.deletedAt) throw new Error("任务已删除");
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

  const locked = await prisma.task.updateMany({
    where: { id: taskId, deletedAt: null, status: "COMPLETED" },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
  if (locked.count !== 1) {
    throw new Error("任务已被删除，请刷新后重试");
  }
  const updated = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });

  await logProgressActivity({
    projectId: task.projectId,
    taskId,
    action: "task.archived",
    actorOpenId: user.openId,
    actorName: user.name,
  });

  revalidateProgress(task.projectId, taskId);
  return updated;
}

export async function restartTask(input: { taskId: string; reason: string }) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = taskRestartSchema.parse(input);

  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id: parsed.taskId },
      include: {
        project: {
          include: {
            owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          },
        },
        stage: true,
        assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
    });
    if (!task) throw new Error("任务不存在");
    if (task.deletedAt) throw new Error("任务已删除");
    if (task.project.status !== "IN_PROGRESS") {
      throw new Error("仅进行中的项目可重启任务；已完成项目请先回退项目流程");
    }
    if (task.status !== "PENDING_ACCEPTANCE" && task.status !== "COMPLETED") {
      if (task.status === "ARCHIVED") {
        throw new Error("已归档任务不可重启");
      }
      throw new Error("仅待验收或已完成任务可重启");
    }

    const projectOwnerOpenIds = getProjectOwnerOpenIds(task.project);
    if (
      !canManageProject(
        roles,
        { team: task.team, techGroup: task.techGroup },
        projectOwnerOpenIds,
        user.openId,
      )
    ) {
      throw new Error("无任务重启权限");
    }

    const locked = await tx.task.updateMany({
      where: {
        id: task.id,
        status: task.status,
        deletedAt: null,
        project: { status: "IN_PROGRESS" },
      },
      data: {
        status: "IN_PROGRESS",
        archivedAt: null,
      },
    });
    if (locked.count !== 1) {
      throw new Error("任务状态已更新，请刷新后重试");
    }

    const record = await tx.task.findUnique({
      where: { id: task.id },
      select: { updatedAt: true },
    });
    if (!record) throw new Error("任务不存在");
    return { task, projectOwnerOpenIds, updatedAt: record.updatedAt };
  });

  await logProgressActivity({
    projectId: result.task.projectId,
    taskId: result.task.id,
    action: "task.restarted",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: {
      from: result.task.status,
      to: "IN_PROGRESS",
      reason: parsed.reason,
      stageId: result.task.stageId,
      stageName: result.task.stage?.name ?? null,
    },
  });

  await enqueueProgressNotification(
    `progress:task_restarted:${result.task.id}:${result.updatedAt.toISOString()}`,
    {
      type: "task_restarted",
      taskId: result.task.id,
      taskTitle: result.task.title,
      projectId: result.task.projectId,
      projectName: result.task.project.name,
      stageId: result.task.stageId,
      stageName: result.task.stage?.name ?? "无阶段",
      actorName: user.name,
      reason: parsed.reason,
      fromStatus: result.task.status,
      team: result.task.team,
      techGroup: result.task.techGroup,
      assigneeOpenIds: getTaskAssigneeOpenIds(result.task),
      projectOwnerOpenIds: result.projectOwnerOpenIds,
    },
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidateProgress(result.task.projectId, result.task.id);
  return { success: true };
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
      acceptanceChecklistItems: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
      submissions: { select: { id: true }, take: 1 },
    },
  });
  if (!task) throw new Error("任务不存在");
  if (task.deletedAt) throw new Error("任务已删除");
  if (task.updatedAt.toISOString() !== parsed.expectedUpdatedAt) {
    throw new Error("数据已被更新，请刷新后重试");
  }
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
  const nextAcceptanceChecklistItems =
    parsed.acceptanceChecklistItems === undefined
      ? task.acceptanceChecklistItems.map((item) => ({ content: item.content }))
      : normalizeAcceptanceChecklistItems(parsed.acceptanceChecklistItems);
  const checklistLocked =
    task.submissions.length > 0 ||
    task.status === "PENDING_ACCEPTANCE" ||
    task.status === "COMPLETED";
  const checklistChanged = !areAcceptanceChecklistsEqual(
    task.acceptanceChecklistItems,
    nextAcceptanceChecklistItems,
  );
  if (checklistLocked && checklistChanged) {
    throw new Error("任务已有交付记录，验收清单不可修改");
  }
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
      acceptanceChecklistSummary: formatAcceptanceChecklistSummary(
        task.acceptanceChecklistItems,
      ),
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
      acceptanceChecklistSummary: formatAcceptanceChecklistSummary(
        nextAcceptanceChecklistItems,
      ),
    },
  });

  const updated = await prisma.$transaction(async (tx) => {
    if (checklistChanged) {
      const latestLockState = await tx.task.findUnique({
        where: { id: task.id },
        select: {
          status: true,
          _count: { select: { submissions: true } },
        },
      });
      if (!latestLockState) throw new Error("任务不存在");
      const latestLocked =
        latestLockState._count.submissions > 0 ||
        latestLockState.status === "PENDING_ACCEPTANCE" ||
        latestLockState.status === "COMPLETED" ||
        latestLockState.status === "ARCHIVED";
      if (latestLocked) {
        throw new Error("任务已有交付记录，验收清单不可修改");
      }
    }

    const locked = await tx.task.updateMany({
      where: {
        id: task.id,
        updatedAt: new Date(parsed.expectedUpdatedAt),
        deletedAt: null,
      },
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
    if (locked.count !== 1) {
      throw new Error("数据已被更新，请刷新后重试");
    }

    await tx.taskAssignee.deleteMany({ where: { taskId: task.id } });
    await tx.taskAssignee.createMany({
      data: orderedAssignees.map((assignee, index) => ({
        taskId: task.id,
        openId: assignee.openId,
        name: assignee.name,
        sortOrder: index,
      })),
    });

    if (!checklistLocked && checklistChanged) {
      await tx.taskAcceptanceChecklistItem.deleteMany({
        where: { taskId: task.id },
      });
      if (nextAcceptanceChecklistItems.length > 0) {
        await tx.taskAcceptanceChecklistItem.createMany({
          data: nextAcceptanceChecklistItems.map((item, index) => ({
            taskId: task.id,
            content: item.content,
            sortOrder: index,
          })),
        });
      }
    }

    const record = await tx.task.findUnique({ where: { id: task.id } });
    if (!record) throw new Error("任务不存在");

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
    await enqueueProgressNotification(
      `progress:task_updated:${task.id}:${updated.updatedAt.toISOString()}`,
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
    );
    drainNotificationOutboxSoon();
  }

  revalidateProgress(task.projectId, task.id);
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
    ["acceptanceChecklistSummary", "验收清单", String],
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
  acceptanceChecklistSummary: string;
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
