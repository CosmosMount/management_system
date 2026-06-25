"use server";

import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotification,
} from "@/lib/notification-outbox";
import {
  canChangeProjectScope,
  canManageProject,
} from "@/lib/permissions-progress";
import { getProjectOwnerOpenIds, getProjectOwnerNames } from "@/lib/progress-project-owners";
import {
  getProjectParticipantNames,
  getProjectParticipantOpenIds,
} from "@/lib/progress-project-participants";
import { requireSessionUser } from "@/lib/progress-activity";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import {
  updateProjectSchema,
  type UpdateProjectInput,
} from "@/lib/validations/progress";

export async function updateProject(input: UpdateProjectInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = updateProjectSchema.parse(input);

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!project) throw new Error("项目不存在");
  if (project.updatedAt.toISOString() !== parsed.expectedUpdatedAt) {
    throw new Error("数据已被更新，请刷新后重试");
  }
  if (project.status === "COMPLETED") throw new Error("已完成项目不可编辑");
  if (project.status === "CANCELED") throw new Error("已取消项目不可编辑");

  const oldOwnerOpenIds = getProjectOwnerOpenIds(project);
  const oldOwnerNames = getProjectOwnerNames(project);
  const oldParticipantOpenIds = getProjectParticipantOpenIds(project);
  const oldParticipantNames = getProjectParticipantNames(project);
  if (
    !canManageProject(
      roles,
      { team: project.team, techGroup: project.techGroup },
      oldOwnerOpenIds,
      user.openId,
    )
  ) {
    throw new Error("无项目编辑权限");
  }

  const ownerOpenIds = [
    ...new Set(
      parsed.ownerOpenIds?.filter(Boolean) ??
        (parsed.ownerOpenId ? [parsed.ownerOpenId] : []),
    ),
  ];
  if (ownerOpenIds.length === 0) {
    throw new Error("请选择项目负责人");
  }
  const participantOpenIds = [
    ...new Set((parsed.participantOpenIds ?? []).filter(Boolean)),
  ].filter((openId) => !ownerOpenIds.includes(openId));

  const owners = await prisma.user.findMany({
    where: { openId: { in: [...ownerOpenIds, ...participantOpenIds] } },
    select: { openId: true, name: true },
  });
  const ownerByOpenId = new Map(owners.map((owner) => [owner.openId, owner]));
  const missingOwner = ownerOpenIds.find((openId) => !ownerByOpenId.has(openId));
  if (missingOwner) throw new Error("项目负责人不存在，请先同步飞书通讯录");
  const orderedOwners = ownerOpenIds.map((openId) => {
    const owner = ownerByOpenId.get(openId);
    if (!owner) throw new Error("项目负责人不存在，请先同步飞书通讯录");
    return owner;
  });
  const primaryOwner = orderedOwners[0];
  if (!primaryOwner) throw new Error("请选择项目负责人");
  const missingParticipant = participantOpenIds.find(
    (openId) => !ownerByOpenId.has(openId),
  );
  if (missingParticipant) throw new Error("参与人员不存在，请先同步飞书通讯录");
  const orderedParticipants = participantOpenIds.map((openId) => {
    const participant = ownerByOpenId.get(openId);
    if (!participant) throw new Error("参与人员不存在，请先同步飞书通讯录");
    return participant;
  });

  const nextTeam = parsed.team ?? "";
  const nextTechGroup = parsed.techGroup ?? "";
  const scopeChanged =
    project.team !== nextTeam || project.techGroup !== nextTechGroup;
  if (
    scopeChanged &&
    !canChangeProjectScope(roles, {
      team: nextTeam,
      techGroup: nextTechGroup,
    })
  ) {
    throw new Error("无权限将项目切换到该车组/技术组");
  }
  const ownerNames = orderedOwners.map((owner) => owner.name).join("、");
  const participantNames = orderedParticipants
    .map((participant) => participant.name)
    .join("、");
  const changes = buildProjectChangeSummary({
    before: {
      name: project.name,
      description: project.description,
      team: project.team,
      techGroup: project.techGroup,
      ownerNames: oldOwnerNames,
      participantNames: oldParticipantNames,
      allowOwnerSelfApproval: project.allowOwnerSelfApproval,
    },
    after: {
      name: parsed.name,
      description: parsed.description ?? "",
      team: nextTeam,
      techGroup: nextTechGroup,
      ownerNames,
      participantNames,
      allowOwnerSelfApproval: parsed.allowOwnerSelfApproval,
    },
  });

  if (changes.length === 0) {
    return project;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.project.updateMany({
      where: { id: project.id, updatedAt: new Date(parsed.expectedUpdatedAt) },
      data: {
        name: parsed.name,
        description: parsed.description ?? "",
        team: nextTeam,
        techGroup: nextTechGroup,
        ownerOpenId: primaryOwner.openId,
        ownerName: primaryOwner.name,
        allowOwnerSelfApproval: parsed.allowOwnerSelfApproval,
      },
    });
    if (locked.count !== 1) {
      throw new Error("数据已被更新，请刷新后重试");
    }

    await tx.projectOwner.deleteMany({ where: { projectId: project.id } });
    await tx.projectOwner.createMany({
      data: orderedOwners.map((owner, index) => ({
        projectId: project.id,
        openId: owner.openId,
        name: owner.name,
        sortOrder: index,
      })),
    });
    await tx.projectParticipant.deleteMany({ where: { projectId: project.id } });
    if (orderedParticipants.length > 0) {
      await tx.projectParticipant.createMany({
        data: orderedParticipants.map((participant, index) => ({
          projectId: project.id,
          openId: participant.openId,
          name: participant.name,
          sortOrder: index,
        })),
      });
    }

    if (scopeChanged) {
      await tx.task.updateMany({
        where: { projectId: project.id },
        data: { team: nextTeam, techGroup: nextTechGroup },
      });
    }

    const record = await tx.project.findUnique({ where: { id: project.id } });
    if (!record) throw new Error("项目不存在");

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action: "project.updated",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          changes,
          oldOwnerOpenIds,
          ownerOpenIds: orderedOwners.map((owner) => owner.openId),
          oldParticipantOpenIds,
          participantOpenIds: orderedParticipants.map(
            (participant) => participant.openId,
          ),
        }),
      },
    });

    return record;
  });

  await enqueueProgressNotification(
    `progress:project_updated:${project.id}:${updated.updatedAt.toISOString()}`,
    {
      type: "project_updated",
      projectId: project.id,
      projectName: parsed.name,
      actorName: user.name,
      changes,
      team: nextTeam,
      techGroup: nextTechGroup,
      oldTeam: project.team,
      oldTechGroup: project.techGroup,
      ownerOpenIds: orderedOwners.map((owner) => owner.openId),
      oldOwnerOpenIds,
      participantOpenIds: orderedParticipants.map(
        (participant) => participant.openId,
      ),
      oldParticipantOpenIds,
    },
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidateProgress(project.id);
  return updated;
}

function buildProjectChangeSummary({
  before,
  after,
}: {
  before: ProjectChangeComparable;
  after: ProjectChangeComparable;
}): string[] {
  const labels: Array<[keyof ProjectChangeComparable, string, (value: unknown) => string]> = [
    ["name", "项目名称", String],
    ["description", "描述", formatOptional],
    ["team", "车组", formatOptional],
    ["techGroup", "技术组", formatOptional],
    ["ownerNames", "项目负责人", String],
    ["participantNames", "参与人员", formatOptional],
    ["allowOwnerSelfApproval", "负责人自审", formatBoolean],
  ];
  return labels.flatMap(([key, label, format]) => {
    if (before[key] === after[key]) return [];
    return `${label}：${format(before[key])} -> ${format(after[key])}`;
  });
}

type ProjectChangeComparable = {
  name: string;
  description: string;
  team: string;
  techGroup: string;
  ownerNames: string;
  participantNames: string;
  allowOwnerSelfApproval: boolean;
};

function formatOptional(value: unknown): string {
  return typeof value === "string" && value ? value : "未指定";
}

function formatBoolean(value: unknown): string {
  return value ? "允许" : "不允许";
}
