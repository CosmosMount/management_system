"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { requireSessionUser } from "@/lib/progress-activity";
import { canCreateProject } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";
import { createProjectSchema, type CreateProjectInput } from "@/lib/validations/progress";

export async function createProject(input: CreateProjectInput) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  if (!canCreateProject(roles)) {
    throw new Error("无创建项目权限");
  }

  const parsed = createProjectSchema.parse(input);
  const [owner, stageOwners] = await Promise.all([
    prisma.user.findUnique({ where: { openId: parsed.ownerOpenId } }),
    prisma.user.findMany({
      where: { openId: { in: parsed.stages.map((s) => s.ownerOpenId) } },
      select: { openId: true, name: true },
    }),
  ]);
  if (!owner) throw new Error("项目负责人不存在，请先同步飞书通讯录");

  const stageOwnerByOpenId = new Map(
    stageOwners.map((u) => [u.openId, u.name]),
  );
  for (const stage of parsed.stages) {
    if (!stageOwnerByOpenId.has(stage.ownerOpenId)) {
      throw new Error(`阶段「${stage.name}」负责人不存在，请先同步飞书通讯录`);
    }
  }

  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        name: parsed.name,
        description: parsed.description ?? "",
        team: parsed.team,
        techGroup: parsed.techGroup,
        ownerOpenId: owner.openId,
        ownerName: owner.name,
        allowOwnerSelfApproval: parsed.allowOwnerSelfApproval,
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
          ownerOpenId: owner.openId,
          stageCount: created.stages.length,
        }),
      },
    });

    return created;
  });

  await sendProgressNotification({
    type: "project_created",
    projectId: project.id,
    projectName: project.name,
    team: project.team,
    techGroup: project.techGroup,
    ownerOpenId: project.ownerOpenId,
    ownerName: project.ownerName,
  }).catch(console.error);

  revalidatePath("/progress");
  return project;
}
