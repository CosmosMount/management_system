"use server";

import { revalidatePath } from "next/cache";
import { ProjectStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
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

  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        name: parsed.name,
        description: parsed.description ?? "",
        team: parsed.team,
        techGroup: parsed.techGroup,
        status: ProjectStatus.IN_PROGRESS,
        ownerOpenId: user.openId,
        ownerName: user.name,
        milestones: {
          create: parsed.milestones.map((m, i) => ({
            name: m.name,
            sortOrder: i,
          })),
        },
      },
      include: { milestones: true },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: created.id,
        action: "project.created",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({ name: created.name }),
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
    ownerName: project.ownerName,
  }).catch(console.error);

  revalidatePath("/progress");
  return project;
}
