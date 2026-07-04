"use server";

import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import { canSyncProjectStageRisk } from "@/lib/permissions-progress";
import { getUserRoles } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import { assertProjectActive } from "@/lib/progress-guards";
import {
  getProjectOwnerNames,
  getProjectOwnerOpenIds,
} from "@/lib/progress-project-owners";
import { getProjectParticipantOpenIds } from "@/lib/progress-project-participants";
import { collectProjectStageRiskNotificationRecipients } from "@/lib/progress-project-notifications";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import {
  projectStageRiskResolveSchema,
  projectStageRiskSyncSchema,
} from "@/lib/validations/progress";
import { withActionLogging } from "@/lib/logger";

const inactiveProjectStatuses = [
  "ESTABLISHING",
  "ESTABLISHMENT_REJECTED",
  "COMPLETED",
  "CANCELED",
] as const;

export async function syncProjectStageRisk(input: {
  stageId: string;
  content: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.stage.risk.sync",
      module: "progress",
      action: "syncProjectStageRisk",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "ProjectStage",
      entityId: input.stageId,
    },
    async () => syncProjectStageRiskLogged(input, user),
  );
}

async function syncProjectStageRiskLogged(
  input: {
    stageId: string;
    content: string;
  },
  user: { openId: string; name: string },
) {
  const parsed = projectStageRiskSyncSchema.parse(input);

  const stage = await prisma.projectStage.findUnique({
    where: { id: parsed.stageId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });
  if (!stage) throw new Error("阶段不存在");
  assertProjectActive(stage.project.status);
  if (stage.status === "COMPLETED") {
    throw new Error("已完成阶段不能新增风险");
  }

  const roles = await getUserRoles(user.openId);
  const projectOwnerOpenIds = getProjectOwnerOpenIds(stage.project);
  const projectParticipantOpenIds = getProjectParticipantOpenIds(stage.project);
  if (
    !canSyncProjectStageRisk({
      roles,
      scope: { team: stage.project.team, techGroup: stage.project.techGroup },
      projectOwnerOpenIds,
      projectParticipantOpenIds,
      stageOwnerOpenId: stage.ownerOpenId,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无阶段风险同步权限");
  }

  const riskUpdatedAt = new Date();
  const context = await getNotificationContext();
  const recipientOpenIds = await collectProjectStageRiskNotificationRecipients(
    stage.project,
    stage,
  );

  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.projectStage.updateMany({
      where: {
        id: stage.id,
        status: { not: "COMPLETED" },
        project: { status: { notIn: [...inactiveProjectStatuses] } },
      },
      data: {
        riskNote: parsed.content,
        riskUpdatedAt,
      },
    });
    if (locked.count !== 1) {
      throw new Error("阶段状态已更新，请刷新后重试");
    }

    const risk = await tx.projectStageRiskRecord.create({
      data: {
        stageId: stage.id,
        content: parsed.content,
        source: "MANUAL",
        status: "ACTIVE",
        createdByOpenId: user.openId,
        createdByName: user.name,
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: stage.projectId,
        action: "stage.risk_synced",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          stageId: stage.id,
          stageName: stage.name,
          riskId: risk.id,
          riskNote: parsed.content,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_stage_risk_synced:${risk.id}`,
      {
        type: "project_stage_risk_synced",
        projectId: stage.projectId,
        projectName: stage.project.name,
        stageId: stage.id,
        stageName: stage.name,
        team: stage.project.team,
        techGroup: stage.project.techGroup,
        ownerNames: getProjectOwnerNames(stage.project),
        stageOwnerName: stage.ownerName,
        actorName: user.name,
        riskNote: parsed.content,
        recipientOpenIds,
      },
      context,
    );

    return tx.projectStage.findUniqueOrThrow({ where: { id: stage.id } });
  });

  drainNotificationOutboxSoon();
  revalidateProgress(stage.projectId);
  return updated;
}

export async function resolveProjectStageRisk(input: {
  riskId: string;
  resolveNote: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.stage.risk.resolve",
      module: "progress",
      action: "resolveProjectStageRisk",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "ProjectStageRiskRecord",
      entityId: input.riskId,
    },
    async () => resolveProjectStageRiskLogged(input, user),
  );
}

async function resolveProjectStageRiskLogged(
  input: {
    riskId: string;
    resolveNote: string;
  },
  user: { openId: string; name: string },
) {
  const parsed = projectStageRiskResolveSchema.parse(input);

  const risk = await prisma.projectStageRiskRecord.findUnique({
    where: { id: parsed.riskId },
    include: {
      stage: {
        include: {
          project: {
            include: {
              owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
              participants: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
        },
      },
    },
  });
  if (!risk) throw new Error("风险记录不存在");
  if (risk.status !== "ACTIVE") throw new Error("该风险已取消");

  const stage = risk.stage;
  assertProjectActive(stage.project.status);

  const roles = await getUserRoles(user.openId);
  const projectOwnerOpenIds = getProjectOwnerOpenIds(stage.project);
  const projectParticipantOpenIds = getProjectParticipantOpenIds(stage.project);
  if (
    !canSyncProjectStageRisk({
      roles,
      scope: { team: stage.project.team, techGroup: stage.project.techGroup },
      projectOwnerOpenIds,
      projectParticipantOpenIds,
      stageOwnerOpenId: stage.ownerOpenId,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无阶段风险取消权限");
  }

  const resolvedAt = new Date();
  const context = await getNotificationContext();
  const recipientOpenIds = await collectProjectStageRiskNotificationRecipients(
    stage.project,
    stage,
  );

  await prisma.$transaction(async (tx) => {
    const stageLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ProjectStage" WHERE "id" = ${stage.id} FOR UPDATE
    `;
    if (stageLock.length !== 1) {
      throw new Error("阶段不存在");
    }

    const locked = await tx.projectStageRiskRecord.updateMany({
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

    const latestActive = await tx.projectStageRiskRecord.findFirst({
      where: { stageId: stage.id, status: "ACTIVE" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { content: true },
    });
    const updatedStage = await tx.projectStage.updateMany({
      where: {
        id: stage.id,
        project: { status: { notIn: [...inactiveProjectStatuses] } },
      },
      data: {
        riskNote: latestActive?.content ?? "",
        riskUpdatedAt: resolvedAt,
      },
    });
    if (updatedStage.count !== 1) {
      throw new Error("阶段状态已更新，请刷新后重试");
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: stage.projectId,
        action: "stage.risk_resolved",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          stageId: stage.id,
          stageName: stage.name,
          riskId: risk.id,
          riskNote: risk.content,
          resolveNote: parsed.resolveNote,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_stage_risk_resolved:${risk.id}`,
      {
        type: "project_stage_risk_resolved",
        projectId: stage.projectId,
        projectName: stage.project.name,
        stageId: stage.id,
        stageName: stage.name,
        riskNote: risk.content,
        resolveNote: parsed.resolveNote,
        resolverName: user.name,
        recipientOpenIds,
      },
      context,
    );
  });

  drainNotificationOutboxSoon();
  revalidateProgress(stage.projectId);
  return { success: true };
}
