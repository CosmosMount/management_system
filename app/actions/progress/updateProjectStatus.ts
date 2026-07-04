"use server";

import type { ProjectStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import { assertProjectTransition } from "@/lib/progress-flow";
import { canUpdateProjectLifecycle } from "@/lib/permissions-progress";
import { getProjectOwnerOpenIds, getProjectOwnerNames } from "@/lib/progress-project-owners";
import { collectProjectNotificationRecipients } from "@/lib/progress-project-notifications";
import { getProjectParticipantNames, getProjectParticipantOpenIds } from "@/lib/progress-project-participants";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import { getUserRoles } from "@/lib/permissions";
import { withActionLogging } from "@/lib/logger";

const PROJECT_CANCELABLE_TASK_STATUSES = [
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
] as const;

const PROJECT_COMPLETION_TASK_STATUSES = ["COMPLETED", "ARCHIVED"] as const;

export async function updateProjectStatus(
  projectId: string,
  status: ProjectStatus,
  reason = "",
) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.project.status.update",
      module: "progress",
      action: "updateProjectStatus",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Project",
      entityId: projectId,
      targetStatus: status,
    },
    async () => updateProjectStatusLogged(projectId, status, reason, user),
  );
}

async function updateProjectStatusLogged(
  projectId: string,
  status: ProjectStatus,
  reason: string,
  user: { openId: string; name: string },
) {
  const roles = await getUserRoles(user.openId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { orderBy: { sortOrder: "asc" } },
      tasks: {
        where: { deletedAt: null },
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!project) throw new Error("项目不存在");
  if (project.status === "COMPLETED") throw new Error("项目已完成");
  if (project.status === "CANCELED") throw new Error("项目已取消");

  if (
    !canUpdateProjectLifecycle(
      roles,
      { team: project.team, techGroup: project.techGroup },
      getProjectOwnerOpenIds(project),
      user.openId,
    )
  ) {
    throw new Error("无权限更新项目状态");
  }

  assertProjectTransition(project.status, status);

  const context = await getNotificationContext();
  const recipientOpenIds = await collectProjectNotificationRecipients(project);
  const type =
    status === "IN_PROGRESS"
      ? "project_started"
      : status === "COMPLETED"
        ? "project_completed"
        : "project_canceled";
  const updated = await prisma.$transaction(async (tx) => {
    const lockedCurrentState = await tx.project.updateMany({
      where: { id: projectId, status: project.status },
      data: { status: project.status },
    });
    if (lockedCurrentState.count !== 1) {
      throw new Error("项目状态已更新，请刷新后重试");
    }

    if (status === "COMPLETED") {
      const [stageCount, incompleteStageCount, unfinishedTaskCount] =
        await Promise.all([
        tx.projectStage.count({ where: { projectId } }),
        tx.projectStage.count({
          where: { projectId, status: { not: "COMPLETED" } },
        }),
        tx.task.count({
          where: {
            projectId,
            deletedAt: null,
            status: { notIn: [...PROJECT_COMPLETION_TASK_STATUSES] },
          },
        }),
      ]);
      if (stageCount === 0 || incompleteStageCount > 0) {
        throw new Error("请先完成全部项目阶段后再完成项目");
      }
      if (unfinishedTaskCount > 0) {
        throw new Error(
          `请先完成全部任务后再完成项目：还有 ${unfinishedTaskCount} 个未完成任务`,
        );
      }
    }

    const canceledAt = status === "CANCELED" ? new Date() : null;
    let canceledTaskCount = 0;
    if (canceledAt) {
      const cancelableTasks = await tx.task.findMany({
        where: {
          projectId,
          deletedAt: null,
          status: { in: [...PROJECT_CANCELABLE_TASK_STATUSES] },
        },
        select: {
          id: true,
          title: true,
          status: true,
          stageId: true,
          stage: { select: { name: true } },
        },
      });

      if (cancelableTasks.length > 0) {
        const taskIds = cancelableTasks.map((task) => task.id);
        const canceledTasks = await tx.task.updateMany({
          where: {
            id: { in: taskIds },
            projectId,
            deletedAt: null,
            status: { in: [...PROJECT_CANCELABLE_TASK_STATUSES] },
          },
          data: {
            status: "PROJECT_CANCELED",
            isOverdue: false,
            archivedAt: canceledAt,
          },
        });
        canceledTaskCount = canceledTasks.count;

        await tx.progressActivityLog.createMany({
          data: cancelableTasks.map((task) => ({
            projectId,
            taskId: task.id,
            action: "task.project_canceled",
            actorOpenId: user.openId,
            actorName: user.name,
            payload: JSON.stringify({
              taskTitle: task.title,
              from: task.status,
              to: "PROJECT_CANCELED",
              stageId: task.stageId,
              stageName: task.stage?.name ?? "无阶段",
              reason,
            }),
          })),
        });
      }
    }

    const locked = await tx.project.updateMany({
      where: { id: projectId, status: project.status },
      data: {
        status,
        completedAt: status === "COMPLETED" ? new Date() : null,
        canceledAt,
        archivedAt:
          status === "COMPLETED" || status === "CANCELED"
            ? (canceledAt ?? new Date())
            : null,
      },
    });
    if (locked.count !== 1) {
      throw new Error("项目状态已更新，请刷新后重试");
    }

    if (status === "IN_PROGRESS") {
      const firstStage = project.stages.find(
        (s) => s.status === "NOT_STARTED",
      );
      if (firstStage) {
        await tx.projectStage.update({
          where: { id: firstStage.id },
          data: { status: "IN_PROGRESS" },
        });
      }
    }

    const record = await tx.project.findUnique({ where: { id: projectId } });
    if (!record) throw new Error("项目不存在");
    await tx.progressActivityLog.create({
      data: {
        projectId,
        action: "project.status_changed",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          from: project.status,
          to: status,
          reason,
          canceledTaskCount,
        }),
      },
    });
    await enqueueProgressNotificationTx(
      tx,
      `progress:${type}:${project.id}:${record.updatedAt.toISOString()}`,
      {
        type,
        projectId: project.id,
        projectName: project.name,
        team: project.team,
        techGroup: project.techGroup,
        ownerOpenIds: getProjectOwnerOpenIds(project),
        ownerNames: getProjectOwnerNames(project),
        participantOpenIds: getProjectParticipantOpenIds(project),
        participantNames: getProjectParticipantNames(project),
        recipientOpenIds,
        canceledTaskCount,
      },
      context,
    );
    return record;
  });
  drainNotificationOutboxSoon();

  revalidateProgress(projectId);
  return updated;
}
