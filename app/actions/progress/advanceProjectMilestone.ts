"use server";

import { revalidatePath } from "next/cache";
import { MilestoneStatus, SubmissionType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  canApproveTask,
  canManageProject,
  getApproverRole,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";
import { milestoneSubmitSchema } from "@/lib/validations/progress";

/** 提交里程碑飞书文档（项目推进验收） */
export async function submitMilestoneDoc(input: {
  projectId: string;
  milestoneId: string;
  feishuDocUrl: string;
  note?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = milestoneSubmitSchema.parse(input);

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    include: { milestones: { orderBy: { sortOrder: "asc" } } },
  });
  if (!project) throw new Error("项目不存在");

  const milestone = project.milestones.find((m) => m.id === parsed.milestoneId);
  if (!milestone) throw new Error("里程碑不存在");

  const milestoneIndex = project.milestones.findIndex(
    (m) => m.id === milestone.id,
  );
  const priorPending = project.milestones
    .slice(0, milestoneIndex)
    .some((m) => m.status !== "PASSED");
  if (priorPending) {
    throw new Error("请先完成前一里程碑验收");
  }

  const roles = await getUserRoles(user.openId);
  if (
    !canManageProject(
      roles,
      { team: project.team, techGroup: project.techGroup },
      project.ownerOpenId,
      user.openId,
    )
  ) {
    throw new Error("无提交里程碑权限");
  }

  const submission = await prisma.taskSubmission.create({
    data: {
      projectId: project.id,
      type: SubmissionType.MILESTONE,
      feishuDocUrl: parsed.feishuDocUrl,
      note: parsed.note ?? "",
      submittedBy: user.openId,
      submitterName: user.name,
    },
  });

  await prisma.projectMilestone.update({
    where: { id: milestone.id },
    data: {
      feishuDocUrl: parsed.feishuDocUrl,
      submissionId: submission.id,
    },
  });

  await logProgressActivity({
    projectId: project.id,
    action: "milestone.doc_submitted",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { milestoneId: milestone.id, submissionId: submission.id },
  });

  revalidatePath(`/progress/projects/${project.id}`);
  return submission;
}

/** 审批通过里程碑，推进项目状态 */
export async function advanceProjectMilestone(input: {
  projectId: string;
  milestoneId: string;
  pass: boolean;
  comment?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    include: { milestones: { orderBy: { sortOrder: "asc" } } },
  });
  if (!project) throw new Error("项目不存在");

  if (
    !canApproveTask(roles, {
      team: project.team,
      techGroup: project.techGroup,
    })
  ) {
    throw new Error("无里程碑验收权限");
  }

  const milestone = project.milestones.find((m) => m.id === input.milestoneId);
  if (!milestone) throw new Error("里程碑不存在");
  if (!milestone.submissionId) throw new Error("请先提交里程碑飞书文档");

  const submission = await prisma.taskSubmission.findUnique({
    where: { id: milestone.submissionId },
  });
  if (!submission) throw new Error("提交记录不存在");

  const approverRole = getApproverRole(roles, {
    team: project.team,
    techGroup: project.techGroup,
  });
  if (!approverRole) throw new Error("无法确定审批角色");

  const milestoneIndex = project.milestones.findIndex(
    (m) => m.id === milestone.id,
  );
  const priorPending = project.milestones
    .slice(0, milestoneIndex)
    .some((m) => m.status !== "PASSED");
  if (priorPending) {
    throw new Error("请先完成前一里程碑验收");
  }

  await prisma.$transaction(async (tx) => {
    await tx.approvalRecord.create({
      data: {
        submissionId: submission.id,
        approverOpenId: user.openId,
        approverName: user.name,
        approverRole,
        decision: input.pass ? "APPROVED" : "REJECTED",
        docViewVerified: false,
        comment: input.comment ?? "",
      },
    });

    await tx.projectMilestone.update({
      where: { id: milestone.id },
      data: {
        status: input.pass ? MilestoneStatus.PASSED : MilestoneStatus.FAILED,
      },
    });

    if (input.pass) {
      const idx = project.milestones.findIndex((m) => m.id === milestone.id);
      const isLast = idx === project.milestones.length - 1;
      await tx.project.update({
        where: { id: project.id },
        data: {
          status: isLast ? "OUTCOME_GOOD" : project.status,
        },
      });
    }
  });

  await logProgressActivity({
    projectId: project.id,
    action: input.pass ? "milestone.passed" : "milestone.failed",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { milestoneId: milestone.id },
  });

  revalidatePath(`/progress/projects/${project.id}`);
  return { success: true };
}
