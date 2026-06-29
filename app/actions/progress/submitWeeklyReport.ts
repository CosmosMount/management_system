"use server";

import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  canSyncTaskRisk,
  canSubmitTaskWeeklyReport,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import { assertProjectActive } from "@/lib/progress-guards";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { getWeekStart } from "@/lib/progress-weekly";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import { getUserRoles } from "@/lib/permissions";
import {
  riskSyncSchema,
  submitWeeklyReportSchema,
  taskRiskResolveSchema,
} from "@/lib/validations/progress";

export async function submitWeeklyReport(input: {
  taskId: string;
  progress: string;
  nextPlan?: string;
  feishuDocUrl?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = submitWeeklyReportSchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
        },
      },
      assignees: true,
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!task) throw new Error("任务不存在");
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (
    task.status === "ARCHIVED" ||
    task.status === "COMPLETED" ||
    task.status === "PROJECT_CANCELED"
  ) {
    throw new Error("已结束任务不能提交周报");
  }
  if (!task.needsWeeklyReport) throw new Error("该任务当前未要求提交周报");

  if (
    !canSubmitTaskWeeklyReport({
      roles,
      scope: { team: task.team, techGroup: task.techGroup },
      projectOwnerOpenIds: getProjectOwnerOpenIds(task.project),
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      taskTechGroups: getTaskTechGroups(task),
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无周报提交权限");
  }

  const weekStart = getWeekStart();

  const report = await prisma.$transaction(async (tx) => {
    const liveTask = await tx.task.updateMany({
      where: {
        id: task.id,
        deletedAt: null,
        needsWeeklyReport: true,
        status: { notIn: ["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"] },
        project: {
          status: {
            notIn: [
              "ESTABLISHING",
              "ESTABLISHMENT_REJECTED",
              "COMPLETED",
              "CANCELED",
            ],
          },
        },
      },
      data: { status: task.status },
    });
    if (liveTask.count !== 1) {
      throw new Error("任务状态已更新，请刷新后重试");
    }

    const savedReport = await tx.weeklyReport.upsert({
      where: { taskId_weekStart: { taskId: task.id, weekStart } },
      update: {
        progress: parsed.progress,
        nextPlan: parsed.nextPlan ?? "",
        feishuDocUrl: parsed.feishuDocUrl ?? "",
        submittedAt: new Date(),
        submittedBy: user.openId,
        submitterName: user.name,
      },
      create: {
        taskId: task.id,
        weekStart,
        progress: parsed.progress,
        nextPlan: parsed.nextPlan ?? "",
        feishuDocUrl: parsed.feishuDocUrl ?? "",
        submittedBy: user.openId,
        submitterName: user.name,
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action: "task.weekly_report",
        actorOpenId: user.openId,
        actorName: user.name,
      },
    });

    return savedReport;
  });

  revalidateProgress(task.projectId, task.id);
  return report;
}

export async function syncTaskRisk(input: {
  taskId: string;
  content?: string;
  riskNote?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = riskSyncSchema.parse({
    taskId: input.taskId,
    content: "content" in input ? input.content : input.riskNote,
  });

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
        },
      },
      assignees: true,
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!task) throw new Error("任务不存在");
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (
    task.status === "ARCHIVED" ||
    task.status === "COMPLETED" ||
    task.status === "PROJECT_CANCELED"
  ) {
    throw new Error("已结束任务不能同步风险");
  }
  const roles = await getUserRoles(user.openId);
  if (
    !canSyncTaskRisk({
      roles,
      scope: { team: task.team, techGroup: task.techGroup },
      projectOwnerOpenIds: getProjectOwnerOpenIds(task.project),
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      taskTechGroups: getTaskTechGroups(task),
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无风险同步权限");
  }

  const riskUpdatedAt = new Date();
  const context = await getNotificationContext();
  const recipientOpenIds = await collectTaskNotificationRecipients(task);
  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.task.updateMany({
      where: {
        id: task.id,
        deletedAt: null,
        status: { notIn: ["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"] },
        project: {
          status: {
            notIn: [
              "ESTABLISHING",
              "ESTABLISHMENT_REJECTED",
              "COMPLETED",
              "CANCELED",
            ],
          },
        },
      },
      data: { riskNote: parsed.content, riskUpdatedAt },
    });
    if (locked.count !== 1) {
      throw new Error("任务状态已更新，请刷新后重试");
    }
    await tx.taskRiskRecord.create({
      data: {
        taskId: task.id,
        content: parsed.content,
        source: "MANUAL",
        status: "ACTIVE",
        createdByOpenId: user.openId,
        createdByName: user.name,
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action: "task.risk_synced",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({ riskNote: parsed.content }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_risk_synced:${task.id}:${riskUpdatedAt.toISOString()}`,
      {
        type: "task_risk_synced",
        taskId: task.id,
        taskTitle: task.title,
        projectName: task.project.name,
        team: task.team,
        techGroup: task.techGroup,
        assigneeOpenIds: getTaskAssigneeOpenIds(task),
        projectOwnerOpenIds: getProjectOwnerOpenIds(task.project),
        riskNote: parsed.content,
        recipientOpenIds,
      },
      context,
    );

    return tx.task.findUniqueOrThrow({ where: { id: task.id } });
  });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return updated;
}

export async function resolveTaskRisk(input: {
  riskId: string;
  resolveNote: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = taskRiskResolveSchema.parse(input);

  const risk = await prisma.taskRiskRecord.findUnique({
    where: { id: parsed.riskId },
    include: {
      task: {
        include: {
          project: {
            include: {
              owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
              participants: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
          assignees: true,
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!risk) throw new Error("风险记录不存在");
  if (risk.status !== "ACTIVE") throw new Error("该风险已解除");
  const task = risk.task;
  if (task.deletedAt) throw new Error("任务已删除");
  assertProjectActive(task.project.status);
  if (
    task.status === "ARCHIVED" ||
    task.status === "COMPLETED" ||
    task.status === "PROJECT_CANCELED"
  ) {
    throw new Error("已结束任务不能解除风险");
  }
  if (
    !canSyncTaskRisk({
      roles,
      scope: { team: task.team, techGroup: task.techGroup },
      projectOwnerOpenIds: getProjectOwnerOpenIds(task.project),
      taskAssigneeOpenIds: getTaskAssigneeOpenIds(task),
      taskTechGroups: getTaskTechGroups(task),
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无风险解除权限");
  }

  const resolvedAt = new Date();
  const context = await getNotificationContext();
  const recipientOpenIds = await collectTaskNotificationRecipients(task);
  await prisma.$transaction(async (tx) => {
    const locked = await tx.taskRiskRecord.updateMany({
      where: { id: risk.id, status: "ACTIVE" },
      data: {
        status: "RESOLVED",
        resolvedByOpenId: user.openId,
        resolvedByName: user.name,
        resolveNote: parsed.resolveNote,
        resolvedAt,
      },
    });
    if (locked.count !== 1) throw new Error("风险状态已更新，请刷新后重试");

    const latestActive = await tx.taskRiskRecord.findFirst({
      where: { taskId: task.id, status: "ACTIVE" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { content: true },
    });
    const updatedTask = await tx.task.updateMany({
      where: {
        id: task.id,
        deletedAt: null,
        status: { notIn: ["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"] },
        project: {
          status: {
            notIn: [
              "ESTABLISHING",
              "ESTABLISHMENT_REJECTED",
              "COMPLETED",
              "CANCELED",
            ],
          },
        },
      },
      data: {
        riskNote: latestActive?.content ?? "",
        riskUpdatedAt: resolvedAt,
      },
    });
    if (updatedTask.count !== 1) {
      throw new Error("任务状态已更新，请刷新后重试");
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        action: "task.risk_resolved",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          riskId: risk.id,
          riskNote: risk.content,
          resolveNote: parsed.resolveNote,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_risk_resolved:${risk.id}:${resolvedAt.toISOString()}`,
      {
        type: "task_risk_resolved",
        taskId: task.id,
        taskTitle: task.title,
        projectName: task.project.name,
        riskNote: risk.content,
        resolveNote: parsed.resolveNote,
        resolverName: user.name,
        recipientOpenIds,
      },
      context,
    );
  });

  drainNotificationOutboxSoon();

  revalidateProgress(task.projectId, task.id);
  return { success: true };
}
