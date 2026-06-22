"use server";

import { revalidatePath } from "next/cache";
import type { ProjectStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { assertProjectTransition } from "@/lib/progress-flow";
import { canManageProject } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";

export async function updateProjectStatus(
  projectId: string,
  status: ProjectStatus,
) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("项目不存在");
  if (project.status === "ARCHIVED") throw new Error("项目已归档");

  if (
    !canManageProject(
      roles,
      { team: project.team, techGroup: project.techGroup },
      project.ownerOpenId,
      user.openId,
    )
  ) {
    throw new Error("无权限更新项目状态");
  }

  assertProjectTransition(project.status, status);

  if (status === "ARCHIVED") {
    const milestones = await prisma.projectMilestone.findMany({
      where: { projectId },
    });
    const allPassed =
      milestones.length > 0 &&
      milestones.every((m) => m.status === "PASSED");
    if (
      project.status !== "OUTCOME_GOOD" &&
      project.status !== "OUTCOME_POOR"
    ) {
      throw new Error("仅可在「结果理想」或「结果不理想」后归档项目");
    }
    if (!allPassed && milestones.length > 0) {
      throw new Error("请先完成全部里程碑验收后再归档");
    }
  }

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: {
      status,
      archivedAt: status === "ARCHIVED" ? new Date() : null,
    },
  });

  await logProgressActivity({
    projectId,
    action: "project.status_changed",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { from: project.status, to: status },
  });

  if (status === "ABNORMAL") {
    await sendProgressNotification({
      type: "project_abnormal",
      projectId: project.id,
      projectName: project.name,
      team: project.team,
      techGroup: project.techGroup,
      ownerName: project.ownerName,
    }).catch(console.error);
  }

  revalidatePath(`/progress/projects/${projectId}`);
  revalidatePath("/progress");
  return updated;
}
