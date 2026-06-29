"use server";

import type { ProjectStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotification,
} from "@/lib/notification-outbox";
import { canUpdateProjectLifecycle } from "@/lib/permissions-progress";
import {
  getProjectOwnerNames,
  getProjectOwnerOpenIds,
} from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import { getUserRoles } from "@/lib/permissions";
import { projectStageRollbackSchema } from "@/lib/validations/progress";

type RollbackStage = {
  id: string;
  name: string;
  sortOrder: number;
  status: "NOT_STARTED" | "IN_PROGRESS" | "PENDING_ACCEPTANCE" | "COMPLETED";
  ownerOpenId: string;
  currentSubmissionId: string | null;
};

type ProjectForRollback = {
  id: string;
  name: string;
  status: ProjectStatus;
  team: string;
  techGroup: string;
  stages: RollbackStage[];
};

type RollbackPlan = {
  targetStage: RollbackStage;
  fromStage: RollbackStage | null;
  fromProjectStatus: ProjectForRollback["status"];
  mode: "pending" | "previous" | "completed";
};

export async function rollbackProjectStage(input: {
  projectId: string;
  reason: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = projectStageRollbackSchema.parse(input);

  const result = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: parsed.projectId },
      include: {
        owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        stages: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!project) throw new Error("项目不存在");
    if (project.status === "ESTABLISHING") {
      throw new Error("项目正在立项审批，无法回退");
    }
    if (project.status === "ESTABLISHMENT_REJECTED") {
      throw new Error("项目立项已驳回，无法回退");
    }
    if (project.status === "NOT_STARTED") {
      throw new Error("项目尚未启动，无法回退");
    }
    if (project.status === "CANCELED") throw new Error("已取消项目不可回退");

    const ownerOpenIds = getProjectOwnerOpenIds(project);
    if (
      !canUpdateProjectLifecycle(
        roles,
        { team: project.team, techGroup: project.techGroup },
        ownerOpenIds,
        user.openId,
      )
    ) {
      throw new Error("无权限回退项目流程");
    }

    const plan = buildRollbackPlan(project);
    const affectedStages = project.stages.filter(
      (stage) => stage.sortOrder > plan.targetStage.sortOrder,
    );

    if (project.status === "COMPLETED") {
      const lockedProject = await tx.project.updateMany({
        where: { id: project.id, status: "COMPLETED" },
        data: {
          status: "IN_PROGRESS",
          completedAt: null,
          archivedAt: null,
          canceledAt: null,
        },
      });
      if (lockedProject.count !== 1) {
        throw new Error("项目状态已更新，请刷新后重试");
      }
    } else if (project.status === "IN_PROGRESS") {
      const lockedProject = await tx.project.updateMany({
        where: { id: project.id, status: "IN_PROGRESS" },
        data: { status: "IN_PROGRESS" },
      });
      if (lockedProject.count !== 1) {
        throw new Error("项目状态已更新，请刷新后重试");
      }
    }

    if (plan.mode === "pending") {
      const lockedStage = await tx.projectStage.updateMany({
        where: {
          id: plan.targetStage.id,
          projectId: project.id,
          status: "PENDING_ACCEPTANCE",
          currentSubmissionId: plan.targetStage.currentSubmissionId,
        },
        data: {
          status: "IN_PROGRESS",
          currentSubmissionId: null,
          evidenceUrl: "",
        },
      });
      if (lockedStage.count !== 1) {
        throw new Error("阶段状态已更新，请刷新后重试");
      }
    } else {
      const lockedTarget = await tx.projectStage.updateMany({
        where: {
          id: plan.targetStage.id,
          projectId: project.id,
          status: "COMPLETED",
          currentSubmissionId: plan.targetStage.currentSubmissionId,
        },
        data: {
          status: "IN_PROGRESS",
          currentSubmissionId: null,
          evidenceUrl: "",
        },
      });
      if (lockedTarget.count !== 1) {
        throw new Error("阶段状态已更新，请刷新后重试");
      }
    }

    for (const stage of affectedStages) {
      const lockedAffectedStage = await tx.projectStage.updateMany({
        where: {
          id: stage.id,
          projectId: project.id,
          status: stage.status,
          currentSubmissionId: stage.currentSubmissionId,
        },
        data: {
          status: "NOT_STARTED",
          currentSubmissionId: null,
          evidenceUrl: "",
        },
      });
      if (lockedAffectedStage.count !== 1) {
        throw new Error("阶段状态已更新，请刷新后重试");
      }
    }

    const record = await tx.projectStage.findUnique({
      where: { id: plan.targetStage.id },
      select: { updatedAt: true },
    });
    if (!record) throw new Error("阶段不存在");
    return {
      project,
      ownerOpenIds,
      plan,
      targetStageUpdatedAt: record.updatedAt,
    };
  });

  await logProgressActivity({
    projectId: result.project.id,
    action: "project.stage_rollback",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: {
      stageId: result.plan.targetStage.id,
      stageName: result.plan.targetStage.name,
      fromStageId: result.plan.fromStage?.id ?? null,
      fromStageName: result.plan.fromStage?.name ?? null,
      fromProjectStatus: result.plan.fromProjectStatus,
      toProjectStatus: "IN_PROGRESS",
      reason: parsed.reason,
    },
  });

  await enqueueProgressNotification(
    `progress:project_stage_rollback:${result.project.id}:${result.targetStageUpdatedAt.toISOString()}`,
    {
      type: "project_stage_rollback",
      projectId: result.project.id,
      projectName: result.project.name,
      stageId: result.plan.targetStage.id,
      stageName: result.plan.targetStage.name,
      actorName: user.name,
      reason: parsed.reason,
      team: result.project.team,
      techGroup: result.project.techGroup,
      ownerOpenIds: result.ownerOpenIds,
      ownerNames: getProjectOwnerNames(result.project),
      stageOwnerOpenIds: [
        ...new Set(
          [
            result.plan.targetStage.ownerOpenId,
            result.plan.fromStage?.ownerOpenId,
          ].filter(
            (openId): openId is string => !!openId,
          ),
        ),
      ],
    },
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidateProgress(result.project.id);
  return {
    success: true,
    targetStageId: result.plan.targetStage.id,
    targetStageName: result.plan.targetStage.name,
  };
}

function buildRollbackPlan(project: ProjectForRollback): RollbackPlan {
  if (project.stages.length === 0) {
    throw new Error("项目未配置阶段，无法回退");
  }

  if (project.status === "COMPLETED") {
    const targetStage = [...project.stages]
      .reverse()
      .find((stage) => stage.status === "COMPLETED");
    if (!targetStage) throw new Error("没有可回退的已完成阶段");
    return {
      targetStage,
      fromStage: null,
      fromProjectStatus: project.status,
      mode: "completed",
    };
  }

  if (project.status !== "IN_PROGRESS") {
    throw new Error("仅进行中或已完成项目可回退");
  }

  const pendingStage = project.stages.find(
    (stage) => stage.status === "PENDING_ACCEPTANCE",
  );
  if (pendingStage) {
    return {
      targetStage: pendingStage,
      fromStage: pendingStage,
      fromProjectStatus: project.status,
      mode: "pending",
    };
  }

  const activeStage = project.stages.find(
    (stage) => stage.status === "IN_PROGRESS",
  );
  if (activeStage) {
    const previousCompletedStage = [...project.stages]
      .filter(
        (stage) =>
          stage.sortOrder < activeStage.sortOrder &&
          stage.status === "COMPLETED",
      )
      .at(-1);
    if (!previousCompletedStage) {
      throw new Error("当前阶段已是第一阶段，无法继续回退");
    }
    return {
      targetStage: previousCompletedStage,
      fromStage: activeStage,
      fromProjectStatus: project.status,
      mode: "previous",
    };
  }

  const lastCompletedStage = [...project.stages]
    .reverse()
    .find((stage) => stage.status === "COMPLETED");
  if (lastCompletedStage) {
    return {
      targetStage: lastCompletedStage,
      fromStage: null,
      fromProjectStatus: project.status,
      mode: "previous",
    };
  }

  throw new Error("当前项目没有可回退的阶段");
}
