"use server";

import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import { canCreateProject, canCreateProjectInScope } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { revalidateProgress } from "@/lib/revalidate";
import { createProjectSchema, type CreateProjectInput } from "@/lib/validations/progress";

export async function createProject(input: CreateProjectInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  if (!canCreateProject(roles)) {
    throw new Error("无创建项目权限");
  }

  const parsed = createProjectSchema.parse(input);
  const projectScope = { team: parsed.team ?? "", techGroup: parsed.techGroup ?? "" };
  if (!canCreateProjectInScope(roles, projectScope)) {
    throw new Error("无权限在该车组/技术组下创建项目");
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

  const [projectUsers, stageOwners] = await Promise.all([
    prisma.user.findMany({
      where: { openId: { in: [...ownerOpenIds, ...participantOpenIds] } },
      select: { openId: true, name: true },
    }),
    prisma.user.findMany({
      where: { openId: { in: parsed.stages.map((s) => s.ownerOpenId) } },
      select: { openId: true, name: true },
    }),
  ]);
  const ownerByOpenId = new Map(projectUsers.map((owner) => [owner.openId, owner]));
  const missingOwner = ownerOpenIds.find((openId) => !ownerByOpenId.has(openId));
  if (missingOwner) throw new Error("项目负责人不存在，请先同步飞书通讯录");
  const orderedOwners = ownerOpenIds.map((openId) => {
    const owner = ownerByOpenId.get(openId);
    if (!owner) throw new Error("项目负责人不存在，请先同步飞书通讯录");
    return owner;
  });
  const missingParticipant = participantOpenIds.find(
    (openId) => !ownerByOpenId.has(openId),
  );
  if (missingParticipant) throw new Error("参与人员不存在，请先同步飞书通讯录");
  const orderedParticipants = participantOpenIds.map((openId) => {
    const participant = ownerByOpenId.get(openId);
    if (!participant) throw new Error("参与人员不存在，请先同步飞书通讯录");
    return participant;
  });
  const primaryOwner = orderedOwners[0];
  if (!primaryOwner) throw new Error("请选择项目负责人");

  const stageOwnerByOpenId = new Map(
    stageOwners.map((u) => [u.openId, u.name]),
  );
  for (const stage of parsed.stages) {
    if (!stageOwnerByOpenId.has(stage.ownerOpenId)) {
      throw new Error(`阶段「${stage.name}」负责人不存在，请先同步飞书通讯录`);
    }
  }

  const context = await getNotificationContext();
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        name: parsed.name,
        description: parsed.description ?? "",
        team: parsed.team ?? "",
        techGroup: parsed.techGroup ?? "",
        ownerOpenId: primaryOwner.openId,
        ownerName: primaryOwner.name,
        allowOwnerSelfApproval: parsed.allowOwnerSelfApproval,
        owners: {
          create: orderedOwners.map((owner, index) => ({
            openId: owner.openId,
            name: owner.name,
            sortOrder: index,
          })),
        },
        participants: {
          create: orderedParticipants.map((participant, index) => ({
            openId: participant.openId,
            name: participant.name,
            sortOrder: index,
          })),
        },
        stages: {
          create: parsed.stages.map((s, i) => ({
            name: s.name,
            goal: s.goal,
            sortOrder: i,
            ownerOpenId: s.ownerOpenId,
            ownerName: stageOwnerByOpenId.get(s.ownerOpenId) ?? "",
            dueAt: new Date(s.dueAt),
          })),
        },
      },
      include: { stages: true },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: created.id,
        action: "project.created",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          name: created.name,
          ownerOpenIds: orderedOwners.map((owner) => owner.openId),
          owners: orderedOwners.map((owner) => owner.name),
          participantOpenIds: orderedParticipants.map(
            (participant) => participant.openId,
          ),
          participants: orderedParticipants.map(
            (participant) => participant.name,
          ),
          stageCount: created.stages.length,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_created:${created.id}`,
      {
        type: "project_created",
        projectId: created.id,
        projectName: created.name,
        team: created.team,
        techGroup: created.techGroup,
        ownerOpenIds: orderedOwners.map((owner) => owner.openId),
        ownerNames: orderedOwners.map((owner) => owner.name).join("、"),
        participantOpenIds: orderedParticipants.map(
          (participant) => participant.openId,
        ),
        participantNames: orderedParticipants
          .map((participant) => participant.name)
          .join("、"),
      },
      context,
    );

    return created;
  });
  drainNotificationOutboxSoon();

  revalidateProgress(project.id);
  return project;
}
