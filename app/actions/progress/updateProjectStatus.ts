"use server";

import type { ProjectStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotification,
} from "@/lib/notification-outbox";
import { assertProjectTransition } from "@/lib/progress-flow";
import { canUpdateProjectLifecycle } from "@/lib/permissions-progress";
import { getProjectOwnerOpenIds, getProjectOwnerNames } from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import { getUserRoles } from "@/lib/permissions";

export async function updateProjectStatus(
  projectId: string,
  status: ProjectStatus,
) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { orderBy: { sortOrder: "asc" } },
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

  if (status === "COMPLETED") {
    const allCompleted =
      project.stages.length > 0 &&
      project.stages.every((s) => s.status === "COMPLETED");
    if (!allCompleted) throw new Error("请先完成全部项目阶段后再完成项目");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.project.updateMany({
      where: { id: projectId, status: project.status },
      data: {
        status,
        completedAt: status === "COMPLETED" ? new Date() : null,
        canceledAt: status === "CANCELED" ? new Date() : null,
        archivedAt:
          status === "COMPLETED" || status === "CANCELED" ? new Date() : null,
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
    return record;
  });

  await logProgressActivity({
    projectId,
    action: "project.status_changed",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { from: project.status, to: status },
  });

  const type =
    status === "IN_PROGRESS"
      ? "project_started"
      : status === "COMPLETED"
        ? "project_completed"
        : "project_canceled";
  await enqueueProgressNotification(
    `progress:${type}:${project.id}:${updated.updatedAt.toISOString()}`,
    {
      type,
      projectId: project.id,
      projectName: project.name,
      team: project.team,
      techGroup: project.techGroup,
      ownerOpenIds: getProjectOwnerOpenIds(project),
      ownerNames: getProjectOwnerNames(project),
    },
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidateProgress(projectId);
  return updated;
}
