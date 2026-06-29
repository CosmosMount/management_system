"use server";

import type { Prisma, ProjectDdlChangeRequestStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canRequestProjectStageBatchDdlChange,
  canRequestProjectStageDueDateChange,
  canReviewProjectStageBatchDdlChange,
  canReviewProjectStageDueDateChange,
} from "@/lib/permissions-progress";
import { getUserRoles } from "@/lib/permissions";
import { requireSessionUser } from "@/lib/progress-activity";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getProjectParticipantOpenIds } from "@/lib/progress-project-participants";
import { collectProjectNotificationRecipients } from "@/lib/progress-project-notifications";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import {
  projectStageBatchDdlChangeRequestSchema,
  projectStageBatchDdlChangeReviewSchema,
  projectStageDueDateChangeRequestSchema,
  projectStageDueDateChangeReviewSchema,
} from "@/lib/validations/progress";

const PENDING_DDL_CHANGE_KEY = "PENDING";

export async function requestProjectStageExtension(input: {
  projectId: string;
  stageId: string;
  reason: string;
  durationDays: number;
  isBenign: boolean;
}) {
  return requestProjectStageBatchDdlChange({ ...input, direction: "DELAY" });
}

export async function requestProjectStageBatchDdlChange(input: {
  projectId: string;
  stageId: string;
  direction: "DELAY" | "ADVANCE";
  reason: string;
  durationDays: number;
  isBenign: boolean;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = projectStageBatchDdlChangeRequestSchema.parse(input);
  const roles = await getUserRoles(user.openId);
  const signedDurationDays =
    parsed.direction === "DELAY" ? parsed.durationDays : -parsed.durationDays;

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
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!project) throw new Error("项目不存在");
  if (!isProjectDdlMutableStatus(project.status)) {
    throw new Error("已完成或已取消项目不可申请批量 DDL 调整");
  }

  const ownerOpenIds = getProjectOwnerOpenIds(project);
  const participantOpenIds = getProjectParticipantOpenIds(project);
  const stageOwnerOpenIds = uniqueOpenIds(
    project.stages.map((item) => item.ownerOpenId),
  );
  const taskAssigneeOpenIds = uniqueOpenIds(
    project.tasks.flatMap((task) => getTaskAssigneeOpenIds(task)),
  );
  if (
    !canRequestProjectStageBatchDdlChange({
      roles,
      scope: { team: project.team, techGroup: project.techGroup },
      ownerOpenIds,
      participantOpenIds,
      stageOwnerOpenIds,
      taskAssigneeOpenIds,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无批量 DDL 调整申请权限");
  }

  const stage = project.stages.find((item) => item.id === parsed.stageId);
  if (!stage) throw new Error("阶段不存在");
  if (stage.status === "COMPLETED") {
    throw new Error("已完成阶段不可申请批量 DDL 调整");
  }
  if (!stage.dueAt) {
    throw new Error("阶段未设置 DDL，无法申请批量 DDL 调整");
  }
  const affectedStages = project.stages.filter(
    (item) => item.sortOrder >= stage.sortOrder,
  );
  const completedAffectedStage = affectedStages.find(
    (item) => item.status === "COMPLETED",
  );
  if (completedAffectedStage) {
    throw new Error(
      `阶段「${completedAffectedStage.name}」已完成，不可申请批量 DDL 调整`,
    );
  }
  assertProjectStageDdlOrder(
    project.stages,
    new Map(
      affectedStages.map((item) => [
        item.id,
        item.dueAt ? addDays(item.dueAt, signedDurationDays) : null,
      ]),
    ),
  );

  const newDueAt = addDays(stage.dueAt, signedDurationDays);
  const context = await getNotificationContext();
  const recipientOpenIds = await collectProjectNotificationRecipients(project);
  const request = await prisma.$transaction(async (tx) => {
    await lockProjectDdlChanges(tx, project.id);
    const affectedStageIds = affectedStages.map((item) => item.id);
    const pendingCount = await tx.projectDdlChangeRequest.count({
      where: overlappingPendingDdlChangeWhere({
        projectId: project.id,
        affectedStageIds,
        overlappingBatchStartStageIds: project.stages.map((item) => item.id),
      }),
    });
    if (pendingCount > 0) {
      throw new Error("该项目受影响阶段已有待审批 DDL 变更申请");
    }

    const created = await tx.projectDdlChangeRequest.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        type: "CASCADE_EXTENSION",
        requesterOpenId: user.openId,
        requesterName: user.name,
        pendingKey: PENDING_DDL_CHANGE_KEY,
        reason: parsed.reason,
        oldDueAt: stage.dueAt,
        newDueAt,
        durationDays: signedDurationDays,
        requestedIsBenign:
          parsed.direction === "DELAY" ? parsed.isBenign : null,
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action: "project.stage_batch_due_change_requested",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          requestId: created.id,
          stageId: stage.id,
          stageName: stage.name,
          reason: parsed.reason,
          direction: parsed.direction,
          durationDays: signedDurationDays,
          requestedIsBenign:
            parsed.direction === "DELAY" ? parsed.isBenign : null,
          oldDueAt: stage.dueAt?.toISOString() ?? null,
          newDueAt: newDueAt.toISOString(),
          affectedStageIds: affectedStages.map((item) => item.id),
          affectedStageNames: affectedStages.map((item) => item.name),
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_stage_batch_due_change_requested:${created.id}`,
      {
        type: "project_stage_batch_due_change_requested",
        requestId: created.id,
        projectId: project.id,
        projectName: project.name,
        stageId: stage.id,
        stageName: stage.name,
        requesterName: user.name,
        requesterOpenId: user.openId,
        reason: parsed.reason,
        durationDays: signedDurationDays,
        requestedIsBenign:
          parsed.direction === "DELAY" ? parsed.isBenign : null,
        oldDueAt: stage.dueAt?.toISOString() ?? null,
        newDueAt: newDueAt.toISOString(),
        affectedStageNames: affectedStages.map((item) => item.name),
        team: project.team,
        techGroup: project.techGroup,
        recipientOpenIds,
      },
      context,
    );

    return created;
  }).catch((err) => {
    if (isUniqueConstraintError(err)) {
      throw new Error("该阶段已有待审批 DDL 变更申请");
    }
    throw err;
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return request;
}

export async function reviewProjectStageExtensionRequest(input: {
  requestId: string;
  decision: ProjectDdlChangeRequestStatus;
  comment: string;
  finalIsBenign?: boolean;
}) {
  return reviewProjectStageBatchDdlChangeRequest(input);
}

export async function reviewProjectStageBatchDdlChangeRequest(input: {
  requestId: string;
  decision: ProjectDdlChangeRequestStatus;
  comment: string;
  finalIsBenign?: boolean;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = projectStageBatchDdlChangeReviewSchema.parse(input);
  const roles = await getUserRoles(user.openId);

  const request = await prisma.projectDdlChangeRequest.findUnique({
    where: { id: parsed.requestId },
    include: {
      stage: true,
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
          stages: { orderBy: { sortOrder: "asc" } },
          tasks: {
            where: { deletedAt: null },
            include: {
              assignees: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
              techGroups: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
        },
      },
    },
  });
  if (!request || request.type !== "CASCADE_EXTENSION" || request.status !== "PENDING") {
    throw new Error("批量 DDL 调整申请不存在或已处理");
  }
  const project = request.project;
  if (!isProjectDdlMutableStatus(project.status)) {
    throw new Error("已完成或已取消项目不可审批批量 DDL 调整");
  }
  if (
    !canReviewProjectStageBatchDdlChange({
      roles,
      scope: { team: project.team, techGroup: project.techGroup },
      requesterOpenId: request.requesterOpenId,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无批量 DDL 调整审批权限");
  }

  const signedDurationDays = request.durationDays ?? 0;
  const isDelay = signedDurationDays > 0;
  const finalIsBenign =
    parsed.decision === "APPROVED" && isDelay
      ? (parsed.finalIsBenign ?? request.requestedIsBenign ?? false)
      : null;
  const affectedStages = project.stages.filter(
    (stage) => stage.sortOrder >= request.stage.sortOrder,
  );
  if (parsed.decision === "APPROVED") {
    if (!signedDurationDays) throw new Error("批量 DDL 调整申请缺少调整时长");
    const completedAffectedStage = affectedStages.find(
      (stage) => stage.status === "COMPLETED",
    );
    if (completedAffectedStage) {
      throw new Error(
        `阶段「${completedAffectedStage.name}」已完成，不可审批批量 DDL 调整`,
      );
    }
    if (!sameDueAt(request.stage.dueAt, request.oldDueAt)) {
      throw new Error("阶段 DDL 已变化，请驳回后重新申请");
    }
    const missingDueAt = affectedStages.find((stage) => !stage.dueAt);
    if (missingDueAt) {
      throw new Error(`阶段「${missingDueAt.name}」未设置 DDL，无法批量调整`);
    }
    assertProjectStageDdlOrder(
      project.stages,
      new Map(
        affectedStages.map((stage) => [
          stage.id,
          stage.dueAt ? addDays(stage.dueAt, signedDurationDays) : null,
        ]),
      ),
    );
  }

  const context = await getNotificationContext();
  const recipientOpenIds = await collectProjectNotificationRecipients(project);
  const reviewedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await lockProjectDdlChanges(tx, project.id);
    const affectedStageIds = affectedStages.map((stage) => stage.id);
    if (parsed.decision === "APPROVED") {
      const [completedStage, overlappingPendingCount] = await Promise.all([
        tx.projectStage.findFirst({
          where: { id: { in: affectedStageIds }, status: "COMPLETED" },
          select: { name: true },
        }),
        tx.projectDdlChangeRequest.count({
          where: overlappingPendingDdlChangeWhere({
            projectId: project.id,
            affectedStageIds,
            overlappingBatchStartStageIds: project.stages.map((stage) => stage.id),
            excludeRequestId: request.id,
          }),
        }),
      ]);
      if (completedStage) {
        throw new Error(
          `阶段「${completedStage.name}」已完成，不可审批批量 DDL 调整`,
        );
      }
      if (overlappingPendingCount > 0) {
        throw new Error("该项目受影响阶段存在其他待审批 DDL 变更申请");
      }
    }

    const locked = await tx.projectDdlChangeRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: parsed.decision,
        pendingKey: `${parsed.decision}:${request.id}`,
        reviewerOpenId: user.openId,
        reviewerName: user.name,
        reviewComment: parsed.comment,
        finalIsBenign,
        reviewedAt,
      },
    });
    if (locked.count !== 1) {
      throw new Error("延期申请已被处理，请刷新后重试");
    }

    if (parsed.decision === "APPROVED") {
      for (const stage of affectedStages) {
        if (!stage.dueAt || !signedDurationDays) continue;
        const updatedStage = await tx.projectStage.updateMany({
          where: { id: stage.id, dueAt: stage.dueAt },
          data: {
            dueAt: addDays(stage.dueAt, signedDurationDays),
            extensionCount: isDelay ? { increment: 1 } : undefined,
            benignExtensionCount:
              isDelay && finalIsBenign ? { increment: 1 } : undefined,
          },
        });
        if (updatedStage.count !== 1) {
          throw new Error("阶段 DDL 已变化，请驳回后重新申请");
        }
      }
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action:
          parsed.decision === "APPROVED"
            ? "project.stage_batch_due_change_approved"
            : "project.stage_batch_due_change_rejected",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          requestId: request.id,
          stageId: request.stageId,
          stageName: request.stage.name,
          reason: request.reason,
          reviewComment: parsed.comment,
          direction: signedDurationDays < 0 ? "ADVANCE" : "DELAY",
          durationDays: signedDurationDays,
          requestedIsBenign: request.requestedIsBenign,
          finalIsBenign,
          affectedStageIds: affectedStages.map((stage) => stage.id),
          affectedStageNames: affectedStages.map((stage) => stage.name),
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:${parsed.decision === "APPROVED" ? "project_stage_batch_due_change_approved" : "project_stage_batch_due_change_rejected"}:${request.id}`,
      {
        type:
          parsed.decision === "APPROVED"
            ? "project_stage_batch_due_change_approved"
            : "project_stage_batch_due_change_rejected",
        requestId: request.id,
        projectId: project.id,
        projectName: project.name,
        stageId: request.stageId,
        stageName: request.stage.name,
        reviewerName: user.name,
        requesterOpenId: request.requesterOpenId,
        reason: request.reason,
        comment: parsed.comment,
        durationDays: signedDurationDays,
        finalIsBenign: finalIsBenign ?? false,
        oldDueAt: request.oldDueAt?.toISOString() ?? null,
        newDueAt: request.newDueAt?.toISOString() ?? null,
        affectedStageNames: affectedStages.map((stage) => stage.name),
        team: project.team,
        techGroup: project.techGroup,
        ownerOpenIds: getProjectOwnerOpenIds(project),
        stageOwnerOpenIds: uniqueOpenIds(
          affectedStages.map((stage) => stage.ownerOpenId),
        ),
        recipientOpenIds,
      },
      context,
    );
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return { success: true };
}

export async function requestProjectStageDueDateChange(input: {
  projectId: string;
  stageId: string;
  proposedDueAt: string;
  reason: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = projectStageDueDateChangeRequestSchema.parse(input);
  const roles = await getUserRoles(user.openId);

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
          techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!project) throw new Error("项目不存在");
  if (!isProjectDdlMutableStatus(project.status)) {
    throw new Error("已完成或已取消项目不可申请修改 DDL");
  }

  const stage = project.stages.find((item) => item.id === parsed.stageId);
  if (!stage) throw new Error("阶段不存在");
  if (stage.status === "COMPLETED") {
    throw new Error("已完成阶段不可申请修改 DDL");
  }
  const ownerOpenIds = getProjectOwnerOpenIds(project);
  if (
    !canRequestProjectStageDueDateChange({
      roles,
      scope: { team: project.team, techGroup: project.techGroup },
      ownerOpenIds,
      participantOpenIds: getProjectParticipantOpenIds(project),
      stageOwnerOpenId: stage.ownerOpenId,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无阶段 DDL 修改申请权限");
  }

  const proposedDueAt = new Date(parsed.proposedDueAt);
  if (sameDueAt(stage.dueAt, proposedDueAt)) {
    throw new Error("新的阶段 DDL 与当前 DDL 一致");
  }
  assertProjectStageDdlOrder(
    project.stages,
    new Map([[stage.id, proposedDueAt]]),
  );

  const context = await getNotificationContext();
  const recipientOpenIds = await collectProjectNotificationRecipients(project);
  const request = await prisma.$transaction(async (tx) => {
    await lockProjectDdlChanges(tx, project.id);
    const pendingCount = await tx.projectDdlChangeRequest.count({
      where: overlappingPendingDdlChangeWhere({
        projectId: project.id,
        affectedStageIds: [stage.id],
        overlappingBatchStartStageIds: getBatchStartStageIdsAffectingStage(
          project.stages,
          stage.sortOrder,
        ),
      }),
    });
    if (pendingCount > 0) {
      throw new Error("该阶段已有待审批 DDL 变更申请");
    }

    const created = await tx.projectDdlChangeRequest.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        type: "SINGLE_STAGE_ADJUSTMENT",
        requesterOpenId: user.openId,
        requesterName: user.name,
        pendingKey: PENDING_DDL_CHANGE_KEY,
        reason: parsed.reason,
        oldDueAt: stage.dueAt,
        newDueAt: proposedDueAt,
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action: "project.stage_due_change_requested",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          requestId: created.id,
          stageId: stage.id,
          stageName: stage.name,
          reason: parsed.reason,
          oldDueAt: stage.dueAt?.toISOString() ?? null,
          newDueAt: proposedDueAt.toISOString(),
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_stage_due_change_requested:${created.id}`,
      {
        type: "project_stage_due_change_requested",
        requestId: created.id,
        projectId: project.id,
        projectName: project.name,
        stageId: stage.id,
        stageName: stage.name,
        requesterName: user.name,
        requesterOpenId: user.openId,
        reason: parsed.reason,
        oldDueAt: stage.dueAt?.toISOString() ?? null,
        newDueAt: proposedDueAt.toISOString(),
        team: project.team,
        techGroup: project.techGroup,
        ownerOpenIds,
        recipientOpenIds,
      },
      context,
    );

    return created;
  }).catch((err) => {
    if (isUniqueConstraintError(err)) {
      throw new Error("该阶段已有待审批 DDL 变更申请");
    }
    throw err;
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return request;
}

export async function reviewProjectStageDueDateChangeRequest(input: {
  requestId: string;
  decision: ProjectDdlChangeRequestStatus;
  comment: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = projectStageDueDateChangeReviewSchema.parse(input);
  const roles = await getUserRoles(user.openId);

  const request = await prisma.projectDdlChangeRequest.findUnique({
    where: { id: parsed.requestId },
    include: {
      stage: true,
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
          stages: { orderBy: { sortOrder: "asc" } },
          tasks: {
            where: { deletedAt: null },
            include: {
              assignees: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
              techGroups: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
        },
      },
    },
  });
  if (
    !request ||
    request.type !== "SINGLE_STAGE_ADJUSTMENT" ||
    request.status !== "PENDING"
  ) {
    throw new Error("DDL 修改申请不存在或已处理");
  }
  const project = request.project;
  if (!isProjectDdlMutableStatus(project.status)) {
    throw new Error("已完成或已取消项目不可审批 DDL 修改");
  }
  const ownerOpenIds = getProjectOwnerOpenIds(project);
  if (
    !canReviewProjectStageDueDateChange({
      roles,
      ownerOpenIds,
      requesterOpenId: request.requesterOpenId,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无阶段 DDL 修改审批权限");
  }

  if (parsed.decision === "APPROVED") {
    if (!request.newDueAt) throw new Error("DDL 修改申请缺少新 DDL");
    if (request.stage.status === "COMPLETED") {
      throw new Error("已完成阶段不可审批 DDL 修改");
    }
    if (!sameDueAt(request.stage.dueAt, request.oldDueAt)) {
      throw new Error("阶段 DDL 已变化，请驳回后重新申请");
    }
    assertProjectStageDdlOrder(
      project.stages,
      new Map([[request.stageId, request.newDueAt]]),
    );
  }

  const context = await getNotificationContext();
  const recipientOpenIds = await collectProjectNotificationRecipients(project);
  const reviewedAt = new Date();
  const shouldCountAsExtension =
    parsed.decision === "APPROVED" &&
    !!request.newDueAt &&
    (!request.oldDueAt || request.newDueAt.getTime() > request.oldDueAt.getTime());

  await prisma.$transaction(async (tx) => {
    await lockProjectDdlChanges(tx, project.id);
    if (parsed.decision === "APPROVED") {
      const [completedStage, overlappingPendingCount] = await Promise.all([
        tx.projectStage.findFirst({
          where: { id: request.stageId, status: "COMPLETED" },
          select: { name: true },
        }),
        tx.projectDdlChangeRequest.count({
          where: overlappingPendingDdlChangeWhere({
            projectId: project.id,
            affectedStageIds: [request.stageId],
            overlappingBatchStartStageIds: getBatchStartStageIdsAffectingStage(
              project.stages,
              request.stage.sortOrder,
            ),
            excludeRequestId: request.id,
          }),
        }),
      ]);
      if (completedStage) {
        throw new Error("已完成阶段不可审批 DDL 修改");
      }
      if (overlappingPendingCount > 0) {
        throw new Error("该阶段存在其他待审批 DDL 变更申请");
      }
    }

    const locked = await tx.projectDdlChangeRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: parsed.decision,
        pendingKey: `${parsed.decision}:${request.id}`,
        reviewerOpenId: user.openId,
        reviewerName: user.name,
        reviewComment: parsed.comment,
        reviewedAt,
      },
    });
    if (locked.count !== 1) {
      throw new Error("DDL 修改申请已被处理，请刷新后重试");
    }

    if (parsed.decision === "APPROVED" && request.newDueAt) {
      const updatedStage = await tx.projectStage.updateMany({
        where: { id: request.stageId, dueAt: request.oldDueAt },
        data: {
          dueAt: request.newDueAt,
          extensionCount: shouldCountAsExtension
            ? { increment: 1 }
            : undefined,
        },
      });
      if (updatedStage.count !== 1) {
        throw new Error("阶段 DDL 已变化，请驳回后重新申请");
      }
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action:
          parsed.decision === "APPROVED"
            ? "project.stage_due_change_approved"
            : "project.stage_due_change_rejected",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          requestId: request.id,
          stageId: request.stageId,
          stageName: request.stage.name,
          reason: request.reason,
          reviewComment: parsed.comment,
          oldDueAt: request.oldDueAt?.toISOString() ?? null,
          newDueAt: request.newDueAt?.toISOString() ?? null,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:${parsed.decision === "APPROVED" ? "project_stage_due_change_approved" : "project_stage_due_change_rejected"}:${request.id}`,
      {
        type:
          parsed.decision === "APPROVED"
            ? "project_stage_due_change_approved"
            : "project_stage_due_change_rejected",
        requestId: request.id,
        projectId: project.id,
        projectName: project.name,
        stageId: request.stageId,
        stageName: request.stage.name,
        reviewerName: user.name,
        requesterOpenId: request.requesterOpenId,
        reason: request.reason,
        comment: parsed.comment,
        oldDueAt: request.oldDueAt?.toISOString() ?? null,
        newDueAt: request.newDueAt?.toISOString() ?? null,
        stageOwnerOpenId: request.stage.ownerOpenId,
        recipientOpenIds,
      },
      context,
    );
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return { success: true };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function sameDueAt(left: Date | null, right: Date | null): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

function assertProjectStageDdlOrder(
  stages: Array<{
    id: string;
    name: string;
    sortOrder: number;
    dueAt: Date | null;
  }>,
  dueAtOverrides: Map<string, Date | null>,
) {
  const sortedStages = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
  let previous: { name: string; dueAt: Date } | null = null;

  for (const stage of sortedStages) {
    const dueAt = dueAtOverrides.has(stage.id)
      ? dueAtOverrides.get(stage.id) ?? null
      : stage.dueAt;
    if (!dueAt) {
      throw new Error(`阶段「${stage.name}」未设置 DDL，无法提交 DDL 变更申请`);
    }
    if (previous && previous.dueAt.getTime() > dueAt.getTime()) {
      throw new Error(
        `阶段 DDL 必须按流程非严格递增：「${previous.name}」不能晚于「${stage.name}」`,
      );
    }
    previous = { name: stage.name, dueAt };
  }
}

async function lockProjectDdlChanges(
  tx: Prisma.TransactionClient,
  projectId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId})::bigint)`;
}

function overlappingPendingDdlChangeWhere({
  projectId,
  affectedStageIds,
  overlappingBatchStartStageIds,
  excludeRequestId,
}: {
  projectId: string;
  affectedStageIds: string[];
  overlappingBatchStartStageIds: string[];
  excludeRequestId?: string;
}): Prisma.ProjectDdlChangeRequestWhereInput {
  return {
    projectId,
    status: "PENDING",
    id: excludeRequestId ? { not: excludeRequestId } : undefined,
    OR: [
      {
        type: "CASCADE_EXTENSION",
        stageId: { in: overlappingBatchStartStageIds },
      },
      {
        type: "SINGLE_STAGE_ADJUSTMENT",
        stageId: { in: affectedStageIds },
      },
    ],
  };
}

function getBatchStartStageIdsAffectingStage(
  stages: Array<{ id: string; sortOrder: number }>,
  stageSortOrder: number,
): string[] {
  return stages
    .filter((stage) => stage.sortOrder <= stageSortOrder)
    .map((stage) => stage.id);
}

function uniqueOpenIds(openIds: Array<string | null | undefined>): string[] {
  return [...new Set(openIds.filter((openId): openId is string => !!openId))];
}

function isProjectDdlMutableStatus(status: string): boolean {
  return status === "NOT_STARTED" || status === "IN_PROGRESS";
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}
