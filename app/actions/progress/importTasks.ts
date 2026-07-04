"use server";

import { randomUUID } from "node:crypto";
import { Prisma, TaskStatus, type ProjectStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canManageProject,
  canRequestTaskCreation,
} from "@/lib/permissions-progress";
import { getUserRoles } from "@/lib/permissions";
import { normalizeAcceptanceChecklistItems } from "@/lib/progress-acceptance-checklists";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { requireSessionUser } from "@/lib/progress-activity";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getProjectParticipantOpenIds } from "@/lib/progress-project-participants";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { normalizeTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { assertProjectActive } from "@/lib/progress-guards";
import type { TaskCreationDraft } from "@/lib/progress-task-creation-requests";
import { getNotificationContext } from "@/lib/request-origin";
import { prisma } from "@/lib/prisma";
import { revalidateProgress } from "@/lib/revalidate";
import { withActionLogging } from "@/lib/logger";
import {
  batchTaskImportSchema,
  createTaskSchema,
  type BatchTaskImportInput,
} from "@/lib/validations/progress";

type PreparedImportTask = {
  title: string;
  goal: string;
  stageId: string;
  stageName: string;
  taskTechGroups: string[];
  urgency: "HIGH" | "MEDIUM" | "LOW";
  importance: "HIGH" | "MEDIUM" | "LOW";
  assignees: Array<{ openId: string; name: string }>;
  metrics: string;
  dueAt: Date;
  dueAtIso: string;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
  acceptanceChecklistItems: Array<{ content: string }>;
};

export async function importProgressTasks(input: BatchTaskImportInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.task.import",
      module: "progress",
      action: "importProgressTasks",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Project",
      entityId: input.projectId,
      mode: input.mode,
      taskCount: input.tasks.length,
    },
    async () => importProgressTasksLogged(input, user),
  );
}

async function importProgressTasksLogged(
  input: BatchTaskImportInput,
  user: { openId: string; name: string },
) {
  const roles = await getUserRoles(user.openId);
  const parsed = batchTaskImportSchema.parse(input);
  const rawTasks = parsed.tasks.filter((task) => !task.ignored);
  if (rawTasks.length === 0) throw new Error("没有可导入的任务");

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { orderBy: { sortOrder: "asc" } },
      tasks: {
        where: { deletedAt: null },
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!project) throw new Error("项目不存在");
  assertProjectActive(project.status);

  const projectOwnerOpenIds = getProjectOwnerOpenIds(project);
  const participantOpenIds = getProjectParticipantOpenIds(project);
  const scope = { team: project.team, techGroup: project.techGroup };
  const canManage = canManageProject(roles, scope, projectOwnerOpenIds, user.openId);
  const stageOwnerOpenIds = project.stages
    .map((stage) => stage.ownerOpenId)
    .filter(Boolean);
  const taskAssigneeOpenIds = [
    ...new Set(project.tasks.flatMap((task) => getTaskAssigneeOpenIds(task))),
  ];
  const canRequest = canRequestTaskCreation({
    roles,
    scope,
    ownerOpenIds: projectOwnerOpenIds,
    participantOpenIds,
    stageOwnerOpenIds,
    taskAssigneeOpenIds,
    userOpenId: user.openId,
  });

  if (parsed.mode === "create" && !canManage) {
    throw new Error("无批量创建任务权限");
  }
  if (parsed.mode === "request") {
    if (canManage) throw new Error("项目管理者请直接创建任务");
    if (!canRequest) throw new Error("无任务申请权限");
  }

  const stageById = new Map(project.stages.map((stage) => [stage.id, stage]));
  const allAssigneeOpenIds = [
    ...new Set(
      rawTasks.flatMap((task) =>
        (task.assigneeOpenIds ?? (task.assigneeOpenId ? [task.assigneeOpenId] : []))
          .filter(Boolean),
      ),
    ),
  ];
  const users = await prisma.user.findMany({
    where: { openId: { in: allAssigneeOpenIds } },
    select: { openId: true, name: true },
  });
  const userByOpenId = new Map(users.map((assignee) => [assignee.openId, assignee]));

  const preparedTasks = rawTasks.map((task, index): PreparedImportTask => {
    const stageId = task.stageId || parsed.defaultStageId;
    const stage = stageById.get(stageId);
    if (!stage) throw new Error(`第 ${index + 1} 条任务的阶段不属于当前项目`);
    if (stage.status === "COMPLETED") {
      throw new Error(`第 ${index + 1} 条任务所属阶段已完成，不能导入`);
    }
    if (
      parsed.mode === "request" &&
      !canRequestTaskCreation({
        roles,
        scope,
        ownerOpenIds: projectOwnerOpenIds,
        participantOpenIds,
        stageOwnerOpenIds: stage.ownerOpenId ? [stage.ownerOpenId] : [],
        taskAssigneeOpenIds,
        userOpenId: user.openId,
      })
    ) {
      throw new Error(`无权限为阶段“${stage.name}”提交任务申请`);
    }

    const normalized = createTaskSchema.parse({
      ...task,
      projectId: project.id,
      stageId,
    });
    const assigneeOpenIds = [
      ...new Set(
        (
          normalized.assigneeOpenIds?.filter(Boolean) ??
          (normalized.assigneeOpenId ? [normalized.assigneeOpenId] : [])
        ),
      ),
    ];
    const assignees = assigneeOpenIds.map((openId) => {
      const assignee = userByOpenId.get(openId);
      if (!assignee) {
        throw new Error(`任务“${normalized.title}”的负责人不存在，请重新选择`);
      }
      return assignee;
    });
    const taskTechGroups = normalizeTaskTechGroups(normalized.taskTechGroups);
    if (taskTechGroups.length === 0) {
      throw new Error(`任务“${normalized.title}”未选择任务技术组`);
    }
    const dueAt = new Date(normalized.dueAt);
    const needsWeeklyReport =
      normalized.needsWeeklyReport ||
      (parsed.mode === "create" &&
        dueAt.getTime() - Date.now() > 14 * 24 * 60 * 60 * 1000);

    return {
      title: normalized.title,
      goal: normalized.goal ?? "",
      stageId,
      stageName: stage.name,
      taskTechGroups,
      urgency: normalized.urgency,
      importance: normalized.importance,
      assignees,
      metrics: normalized.metrics,
      dueAt,
      dueAtIso: dueAt.toISOString(),
      needsOfflineConfirmation: normalized.needsOfflineConfirmation,
      needsWeeklyReport,
      acceptanceChecklistItems: normalizeAcceptanceChecklistItems(
        normalized.acceptanceChecklistItems,
      ),
    };
  });

  const recipientOpenIds = await collectBatchRecipients(preparedTasks, project, user.openId);
  const context = await getNotificationContext();
  const batchId = randomUUID();

  if (parsed.mode === "request") {
    const requestIds = await prisma.$transaction(async (tx) => {
      await assertProjectAndStagesStillWritable(tx, {
        projectId: project.id,
        expectedProjectStatus: project.status,
        stageIds: preparedTasks.map((task) => task.stageId),
      });
      const createdRequests: string[] = [];
      for (const task of preparedTasks) {
        const draft: TaskCreationDraft = {
          title: task.title,
          goal: task.goal,
          stageId: task.stageId,
          stageName: task.stageName,
          taskTechGroups: task.taskTechGroups,
          urgency: task.urgency,
          importance: task.importance,
          assigneeOpenIds: task.assignees.map((assignee) => assignee.openId),
          assigneeNames: task.assignees.map((assignee) => assignee.name),
          metrics: task.metrics,
          dueAt: task.dueAtIso,
          needsOfflineConfirmation: task.needsOfflineConfirmation,
          needsWeeklyReport: task.needsWeeklyReport,
          acceptanceChecklistItems: task.acceptanceChecklistItems,
        };
        const request = await tx.taskCreationRequest.create({
          data: {
            projectId: project.id,
            requesterOpenId: user.openId,
            requesterName: user.name,
            draftPayload: JSON.stringify(draft),
          },
        });
        createdRequests.push(request.id);
      }

      await tx.progressActivityLog.create({
        data: {
          projectId: project.id,
          action: "task.bulk_creation_requested",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            batchId,
            count: preparedTasks.length,
            titles: preparedTasks.map((task) => task.title),
          }),
        },
      });

      await enqueueProgressNotificationTx(
        tx,
        `progress:task_bulk_creation_requested:${batchId}`,
        {
          type: "task_bulk_creation_requested",
          batchId,
          projectId: project.id,
          projectName: project.name,
          actorName: user.name,
          taskCount: preparedTasks.length,
          tasks: summarizeTasks(preparedTasks),
          team: project.team,
          techGroup: project.techGroup,
          recipientOpenIds,
        },
        context,
      );

      return createdRequests;
    });

    drainNotificationOutboxSoon();
    revalidateProgress(project.id);
    return { mode: "request" as const, count: requestIds.length, requestIds };
  }

  const taskIds = await prisma.$transaction(async (tx) => {
    await assertProjectAndStagesStillWritable(tx, {
      projectId: project.id,
      expectedProjectStatus: project.status,
      stageIds: preparedTasks.map((task) => task.stageId),
    });

    const createdTaskIds: string[] = [];
    for (const task of preparedTasks) {
      const primaryAssignee = task.assignees[0];
      if (!primaryAssignee) throw new Error(`任务“${task.title}”未选择负责人`);
      const created = await tx.task.create({
        data: {
          projectId: project.id,
          stageId: task.stageId,
          title: task.title,
          goal: task.goal,
          urgency: task.urgency,
          importance: task.importance,
          assigneeOpenId: primaryAssignee.openId,
          assigneeName: primaryAssignee.name,
          team: project.team,
          techGroup: project.techGroup,
          metrics: task.metrics,
          dueAt: task.dueAt,
          status: TaskStatus.TODO,
          needsOfflineConfirmation: task.needsOfflineConfirmation,
          needsWeeklyReport: task.needsWeeklyReport,
        },
      });
      createdTaskIds.push(created.id);

      await tx.taskAssignee.createMany({
        data: task.assignees.map((assignee, sortOrder) => ({
          taskId: created.id,
          openId: assignee.openId,
          name: assignee.name,
          sortOrder,
        })),
      });
      await tx.taskTechGroup.createMany({
        data: task.taskTechGroups.map((techGroup, sortOrder) => ({
          taskId: created.id,
          techGroup,
          sortOrder,
        })),
      });
      if (task.acceptanceChecklistItems.length > 0) {
        await tx.taskAcceptanceChecklistItem.createMany({
          data: task.acceptanceChecklistItems.map((item, sortOrder) => ({
            taskId: created.id,
            content: item.content,
            sortOrder,
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
            source: "import",
            batchId,
            stageName: task.stageName,
            assignees: task.assignees.map((assignee) => assignee.name),
            taskTechGroups: task.taskTechGroups,
          }),
        },
      });
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action: "task.bulk_imported",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          batchId,
          count: preparedTasks.length,
          titles: preparedTasks.map((task) => task.title),
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_bulk_imported:${batchId}`,
      {
        type: "task_bulk_imported",
        batchId,
        projectId: project.id,
        projectName: project.name,
        actorName: user.name,
        taskCount: preparedTasks.length,
        tasks: summarizeTasks(preparedTasks),
        team: project.team,
        techGroup: project.techGroup,
        recipientOpenIds,
      },
      context,
    );

    return createdTaskIds;
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return { mode: "create" as const, count: taskIds.length, taskIds };
}

async function assertProjectAndStagesStillWritable(
  tx: Prisma.TransactionClient,
  {
    projectId,
    expectedProjectStatus,
    stageIds,
  }: {
    projectId: string;
    expectedProjectStatus: ProjectStatus;
    stageIds: string[];
  },
) {
  const activeProject = await tx.project.updateMany({
    where: { id: projectId, status: expectedProjectStatus },
    data: { status: expectedProjectStatus },
  });
  if (activeProject.count !== 1) {
    throw new Error("项目状态已更新，请刷新后重试");
  }

  const uniqueStageIds = [...new Set(stageIds)];
  const writableStageCount = await tx.projectStage.count({
    where: {
      id: { in: uniqueStageIds },
      projectId,
      status: { not: "COMPLETED" },
    },
  });
  if (writableStageCount !== uniqueStageIds.length) {
    throw new Error("阶段状态已更新，请刷新后重试");
  }
}

async function collectBatchRecipients(
  tasks: PreparedImportTask[],
  project: Parameters<typeof collectTaskNotificationRecipients>[0]["project"] & {
    team: string;
    techGroup: string;
    stages?: Array<{ id: string; ownerOpenId: string }>;
  },
  actorOpenId: string,
) {
  const openIds = new Set<string>([actorOpenId]);
  const stageOwnerById = new Map((project.stages ?? []).map((stage) => [stage.id, stage.ownerOpenId]));
  for (const task of tasks) {
    const recipients = await collectTaskNotificationRecipients({
      team: project.team,
      techGroup: project.techGroup,
      assigneeOpenId: task.assignees[0]?.openId ?? "",
      assigneeName: task.assignees[0]?.name ?? "",
      assignees: task.assignees,
      techGroups: task.taskTechGroups.map((techGroup, sortOrder) => ({
        techGroup,
        sortOrder,
      })),
      project,
    });
    recipients.forEach((openId) => openIds.add(openId));
    const stageOwnerOpenId = stageOwnerById.get(task.stageId);
    if (stageOwnerOpenId) openIds.add(stageOwnerOpenId);
  }
  return [...openIds];
}

function summarizeTasks(tasks: PreparedImportTask[]) {
  return tasks.map((task) => ({
    title: task.title,
    stageName: task.stageName,
    assigneeNames: task.assignees.map((assignee) => assignee.name).join("、"),
    taskTechGroups: task.taskTechGroups,
    dueAt: task.dueAtIso,
  }));
}
