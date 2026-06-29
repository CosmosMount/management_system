"use server";

import { Prisma, type ProjectStage } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  canRequestProjectEstablishment,
  canReviewProjectEstablishment,
} from "@/lib/permissions-progress";
import {
  collectProjectEstablishmentReviewRecipients,
  collectProjectNotificationRecipients,
} from "@/lib/progress-project-notifications";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { revalidateProgress } from "@/lib/revalidate";
import {
  createProjectSchema,
  projectEstablishmentResubmitSchema,
  projectEstablishmentReviewSchema,
  type CreateProjectInput,
  type ParsedCreateProjectInput,
} from "@/lib/validations/progress";

type ProjectDraftResolution = {
  parsed: ParsedCreateProjectInput;
  ownerOpenIds: string[];
  participantOpenIds: string[];
  orderedOwners: Array<{ openId: string; name: string }>;
  orderedParticipants: Array<{ openId: string; name: string }>;
  primaryOwner: { openId: string; name: string };
  stageOwnerByOpenId: Map<string, string>;
};

export async function createProject(input: CreateProjectInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  if (!canRequestProjectEstablishment(user.openId)) {
    throw new Error("无项目立项权限");
  }

  const parsed = createProjectSchema.parse(input);
  const resolution = await resolveProjectDraft(parsed);
  const submittedAt = new Date();
  const stagesWithDueAt = buildStagesWithDueAt(parsed, submittedAt);
  const reviewerOpenIds = await collectProjectEstablishmentReviewRecipients({
    team: parsed.team ?? "",
    techGroup: parsed.techGroup ?? "",
  });
  const context = await getNotificationContext();

  const project = await prisma.$transaction(async (tx) => {
    const created = await createEstablishingProjectTx(tx, resolution, stagesWithDueAt, {
      requesterOpenId: user.openId,
      requesterName: user.name,
      submittedAt,
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: created.id,
        action: "project.establishment_requested",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          name: created.name,
          ownerOpenIds: resolution.orderedOwners.map((owner) => owner.openId),
          owners: resolution.orderedOwners.map((owner) => owner.name),
          participantOpenIds: resolution.orderedParticipants.map(
            (participant) => participant.openId,
          ),
          participants: resolution.orderedParticipants.map(
            (participant) => participant.name,
          ),
          stageCount: created.stages.length,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_establishment_requested:${created.id}:${submittedAt.toISOString()}`,
      {
        type: "project_establishment_requested",
        projectId: created.id,
        projectName: created.name,
        requesterName: user.name,
        requesterOpenId: user.openId,
        team: created.team,
        techGroup: created.techGroup,
        ownerNames: resolution.orderedOwners.map((owner) => owner.name).join("、"),
        participantNames: resolution.orderedParticipants
          .map((participant) => participant.name)
          .join("、"),
        stageCount: created.stages.length,
        recipientOpenIds: reviewerOpenIds,
      },
      context,
    );

    return created;
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return project;
}

export async function resubmitProjectEstablishment(input: {
  projectId: string;
  input: CreateProjectInput;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  if (!canRequestProjectEstablishment(user.openId)) {
    throw new Error("无项目立项权限");
  }

  const parsedResubmit = projectEstablishmentResubmitSchema.parse(input);
  const existingProject = await prisma.project.findFirst({
    where: {
      id: parsedResubmit.projectId,
      requesterOpenId: user.openId,
      status: "ESTABLISHMENT_REJECTED",
    },
    include: {
      tasks: { where: { deletedAt: null }, select: { id: true } },
    },
  });
  if (!existingProject) {
    throw new Error("只能修改并重提自己已驳回的立项");
  }
  if (existingProject.tasks.length > 0) {
    throw new Error("该项目已有任务，不能作为立项草案重提");
  }

  const resolution = await resolveProjectDraft(parsedResubmit.input);
  const submittedAt = new Date();
  const stagesWithDueAt = buildStagesWithDueAt(resolution.parsed, submittedAt);
  const reviewerOpenIds = await collectProjectEstablishmentReviewRecipients({
    team: resolution.parsed.team ?? "",
    techGroup: resolution.parsed.techGroup ?? "",
  });
  const context = await getNotificationContext();

  const project = await prisma.$transaction(async (tx) => {
    const locked = await tx.project.updateMany({
      where: {
        id: existingProject.id,
        requesterOpenId: user.openId,
        status: "ESTABLISHMENT_REJECTED",
      },
      data: {
        name: resolution.parsed.name,
        description: resolution.parsed.description ?? "",
        team: resolution.parsed.team ?? "",
        techGroup: resolution.parsed.techGroup ?? "",
        status: "ESTABLISHING",
        ownerOpenId: resolution.primaryOwner.openId,
        ownerName: resolution.primaryOwner.name,
        requesterOpenId: user.openId,
        requesterName: user.name,
        submittedAt,
        reviewerOpenId: "",
        reviewerName: "",
        reviewComment: "",
        reviewedAt: null,
        allowOwnerSelfApproval: resolution.parsed.allowOwnerSelfApproval,
        archivedAt: null,
        completedAt: null,
        canceledAt: null,
      },
    });
    if (locked.count !== 1) {
      throw new Error("立项状态已更新，请刷新后重试");
    }

    await tx.projectOwner.deleteMany({ where: { projectId: existingProject.id } });
    await tx.projectParticipant.deleteMany({
      where: { projectId: existingProject.id },
    });
    await tx.projectStage.deleteMany({ where: { projectId: existingProject.id } });

    await tx.projectOwner.createMany({
      data: resolution.orderedOwners.map((owner, index) => ({
        projectId: existingProject.id,
        openId: owner.openId,
        name: owner.name,
        sortOrder: index,
      })),
    });
    if (resolution.orderedParticipants.length > 0) {
      await tx.projectParticipant.createMany({
        data: resolution.orderedParticipants.map((participant, index) => ({
          projectId: existingProject.id,
          openId: participant.openId,
          name: participant.name,
          sortOrder: index,
        })),
      });
    }
    await tx.projectStage.createMany({
      data: stagesWithDueAt.map((stage, index) => ({
        projectId: existingProject.id,
        name: stage.name,
        goal: stage.goal,
        sortOrder: index,
        ownerOpenId: stage.ownerOpenId,
        ownerName: resolution.stageOwnerByOpenId.get(stage.ownerOpenId) ?? "",
        dueAt: stage.dueAt,
      })),
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: existingProject.id,
        action: "project.establishment_resubmitted",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          name: resolution.parsed.name,
          previousReviewComment: existingProject.reviewComment,
          stageCount: stagesWithDueAt.length,
        }),
      },
    });

    const updated = await tx.project.findUniqueOrThrow({
      where: { id: existingProject.id },
      include: { stages: true },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_establishment_requested:${updated.id}:${submittedAt.toISOString()}`,
      {
        type: "project_establishment_requested",
        projectId: updated.id,
        projectName: updated.name,
        requesterName: user.name,
        requesterOpenId: user.openId,
        team: updated.team,
        techGroup: updated.techGroup,
        ownerNames: resolution.orderedOwners.map((owner) => owner.name).join("、"),
        participantNames: resolution.orderedParticipants
          .map((participant) => participant.name)
          .join("、"),
        stageCount: updated.stages.length,
        recipientOpenIds: reviewerOpenIds,
      },
      context,
    );

    return updated;
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return project;
}

export async function reviewProjectEstablishment(input: {
  projectId: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsedReview = projectEstablishmentReviewSchema.parse(input);

  const project = await prisma.project.findUnique({
    where: { id: parsedReview.projectId },
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
  if (!project || project.status !== "ESTABLISHING") {
    throw new Error("立项不存在或已处理");
  }
  const scope = { team: project.team, techGroup: project.techGroup };
  if (!canReviewProjectEstablishment(roles, scope)) {
    throw new Error("无立项审批权限");
  }

  const context = await getNotificationContext();
  const reviewedAt = new Date();

  if (parsedReview.decision === "REJECTED") {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.project.updateMany({
        where: { id: project.id, status: "ESTABLISHING" },
        data: {
          status: "ESTABLISHMENT_REJECTED",
          reviewerOpenId: user.openId,
          reviewerName: user.name,
          reviewComment: parsedReview.comment ?? "",
          reviewedAt,
        },
      });
      if (locked.count !== 1) {
        throw new Error("立项已被处理，请刷新后重试");
      }

      await tx.progressActivityLog.create({
        data: {
          projectId: project.id,
          action: "project.establishment_rejected",
          actorOpenId: user.openId,
          actorName: user.name,
          payload: JSON.stringify({
            fromProjectStatus: project.status,
            toProjectStatus: "ESTABLISHMENT_REJECTED",
            reviewComment: parsedReview.comment ?? "",
          }),
        },
      });

      await enqueueProgressNotificationTx(
        tx,
        `progress:project_establishment_rejected:${project.id}:${reviewedAt.toISOString()}`,
        {
          type: "project_establishment_rejected",
          projectId: project.id,
          projectName: project.name,
          requesterOpenId: project.requesterOpenId,
          requesterName: project.requesterName,
          reviewerName: user.name,
          comment: parsedReview.comment ?? "",
          team: project.team,
          techGroup: project.techGroup,
          recipientOpenIds: [project.requesterOpenId],
        },
        context,
      );
    });

    drainNotificationOutboxSoon();
    revalidateProgress(project.id);
    return { success: true };
  }

  const stagesWithApprovedDueAt = buildApprovedStageDueAtUpdates(
    project.stages,
    project.submittedAt ?? project.createdAt,
    reviewedAt,
  );
  const recipientOpenIds = await collectProjectNotificationRecipients(project);
  const finalRecipientOpenIds = normalizeOpenIds([
    project.requesterOpenId,
    ...recipientOpenIds,
  ]);

  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.project.updateMany({
      where: { id: project.id, status: "ESTABLISHING" },
      data: {
        status: "NOT_STARTED",
        reviewerOpenId: user.openId,
        reviewerName: user.name,
        reviewComment: parsedReview.comment ?? "",
        reviewedAt,
      },
    });
    if (locked.count !== 1) {
      throw new Error("立项已被处理，请刷新后重试");
    }

    for (const stage of stagesWithApprovedDueAt) {
      await tx.projectStage.update({
        where: { id: stage.id },
        data: { dueAt: stage.dueAt },
      });
    }

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action: "project.establishment_approved",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          fromProjectStatus: project.status,
          toProjectStatus: "NOT_STARTED",
          reviewComment: parsedReview.comment ?? "",
          requesterName: project.requesterName,
          stageCount: project.stages.length,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_establishment_approved:${project.id}:${reviewedAt.toISOString()}`,
      {
        type: "project_establishment_approved",
        projectId: project.id,
        projectName: project.name,
        requesterOpenId: project.requesterOpenId,
        requesterName: project.requesterName,
        reviewerName: user.name,
        comment: parsedReview.comment ?? "",
        team: project.team,
        techGroup: project.techGroup,
        ownerOpenIds: project.owners.map((owner) => owner.openId),
        ownerNames: project.owners.map((owner) => owner.name).join("、"),
        participantOpenIds: project.participants.map(
          (participant) => participant.openId,
        ),
        participantNames: project.participants
          .map((participant) => participant.name)
          .join("、"),
        stageCount: project.stages.length,
        recipientOpenIds: finalRecipientOpenIds,
      },
      context,
    );

    return tx.project.findUniqueOrThrow({ where: { id: project.id } });
  });

  drainNotificationOutboxSoon();
  revalidateProgress(project.id);
  return { success: true, projectId: updated.id };
}

async function resolveProjectDraft(
  parsed: ParsedCreateProjectInput,
): Promise<ProjectDraftResolution> {
  const ownerOpenIds = normalizeOpenIds(
    parsed.ownerOpenIds?.filter(Boolean) ??
      (parsed.ownerOpenId ? [parsed.ownerOpenId] : []),
  );
  if (ownerOpenIds.length === 0) {
    throw new Error("请选择项目负责人");
  }
  const participantOpenIds = normalizeOpenIds(
    (parsed.participantOpenIds ?? []).filter(
      (openId) => !ownerOpenIds.includes(openId),
    ),
  );

  const [projectUsers, stageOwners] = await Promise.all([
    prisma.user.findMany({
      where: { openId: { in: [...ownerOpenIds, ...participantOpenIds] } },
      select: { openId: true, name: true },
    }),
    prisma.user.findMany({
      where: { openId: { in: parsed.stages.map((stage) => stage.ownerOpenId) } },
      select: { openId: true, name: true },
    }),
  ]);

  const projectUserByOpenId = new Map(
    projectUsers.map((projectUser) => [projectUser.openId, projectUser]),
  );
  const missingOwner = ownerOpenIds.find((openId) => !projectUserByOpenId.has(openId));
  if (missingOwner) throw new Error("项目负责人不存在，请先同步飞书通讯录");
  const orderedOwners = ownerOpenIds.map((openId) => {
    const owner = projectUserByOpenId.get(openId);
    if (!owner) throw new Error("项目负责人不存在，请先同步飞书通讯录");
    return owner;
  });
  const missingParticipant = participantOpenIds.find(
    (openId) => !projectUserByOpenId.has(openId),
  );
  if (missingParticipant) throw new Error("参与人员不存在，请先同步飞书通讯录");
  const orderedParticipants = participantOpenIds.map((openId) => {
    const participant = projectUserByOpenId.get(openId);
    if (!participant) throw new Error("参与人员不存在，请先同步飞书通讯录");
    return participant;
  });
  const primaryOwner = orderedOwners[0];
  if (!primaryOwner) throw new Error("请选择项目负责人");

  const stageOwnerByOpenId = new Map(
    stageOwners.map((stageOwner) => [stageOwner.openId, stageOwner.name]),
  );
  for (const stage of parsed.stages) {
    if (!stageOwnerByOpenId.has(stage.ownerOpenId)) {
      throw new Error(`阶段「${stage.name}」负责人不存在，请先同步飞书通讯录`);
    }
  }

  return {
    parsed,
    ownerOpenIds,
    participantOpenIds,
    orderedOwners,
    orderedParticipants,
    primaryOwner,
    stageOwnerByOpenId,
  };
}

async function createEstablishingProjectTx(
  tx: Prisma.TransactionClient,
  resolution: ProjectDraftResolution,
  stagesWithDueAt: Array<
    ParsedCreateProjectInput["stages"][number] & { dueAt: Date }
  >,
  requester: {
    requesterOpenId: string;
    requesterName: string;
    submittedAt: Date;
  },
) {
  const parsed = resolution.parsed;
  return tx.project.create({
    data: {
      name: parsed.name,
      description: parsed.description ?? "",
      team: parsed.team ?? "",
      techGroup: parsed.techGroup ?? "",
      status: "ESTABLISHING",
      ownerOpenId: resolution.primaryOwner.openId,
      ownerName: resolution.primaryOwner.name,
      requesterOpenId: requester.requesterOpenId,
      requesterName: requester.requesterName,
      submittedAt: requester.submittedAt,
      allowOwnerSelfApproval: parsed.allowOwnerSelfApproval,
      owners: {
        create: resolution.orderedOwners.map((owner, index) => ({
          openId: owner.openId,
          name: owner.name,
          sortOrder: index,
        })),
      },
      participants: {
        create: resolution.orderedParticipants.map((participant, index) => ({
          openId: participant.openId,
          name: participant.name,
          sortOrder: index,
        })),
      },
      stages: {
        create: stagesWithDueAt.map((stage, index) => ({
          name: stage.name,
          goal: stage.goal,
          sortOrder: index,
          ownerOpenId: stage.ownerOpenId,
          ownerName: resolution.stageOwnerByOpenId.get(stage.ownerOpenId) ?? "",
          dueAt: stage.dueAt,
        })),
      },
    },
    include: { stages: true },
  });
}

function buildStagesWithDueAt(parsed: ParsedCreateProjectInput, baseDate: Date) {
  let elapsedDurationDays = 0;
  return parsed.stages.map((stage) => {
    elapsedDurationDays += stage.durationDays;
    return {
      ...stage,
      dueAt: getStageDueAtFromDuration(elapsedDurationDays, baseDate),
    };
  });
}

function buildApprovedStageDueAtUpdates(
  stages: Pick<ProjectStage, "id" | "dueAt">[],
  submittedAt: Date,
  approvedAt: Date,
) {
  return stages.map((stage) => ({
    id: stage.id,
    dueAt: stage.dueAt
      ? getStageDueAtFromDuration(
          Math.max(1, localDayNumber(stage.dueAt) - localDayNumber(submittedAt)),
          approvedAt,
        )
      : null,
  }));
}

function getStageDueAtFromDuration(durationDays: number, baseDate: Date) {
  const dueAt = new Date(baseDate);
  dueAt.setDate(dueAt.getDate() + durationDays);
  dueAt.setHours(18, 0, 0, 0);
  return dueAt;
}

function localDayNumber(date: Date): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() /
      86_400_000,
  );
}

function normalizeOpenIds(openIds: string[]): string[] {
  return [...new Set(openIds.filter(Boolean))];
}
