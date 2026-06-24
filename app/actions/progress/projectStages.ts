"use server";

import { revalidatePath } from "next/cache";
import { ApprovalDecision, SubmissionType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import {
  canApproveStage,
  canSubmitStage,
  getApproverRole,
} from "@/lib/permissions-progress";
import { assertProjectActive } from "@/lib/progress-guards";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { getUserRoles } from "@/lib/permissions";
import { approvalSchema, stageSubmitSchema } from "@/lib/validations/progress";

export async function submitStageEvidence(input: {
  projectId: string;
  stageId: string;
  evidenceUrl: string;
  note?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = stageSubmitSchema.parse(input);
  const roles = await getUserRoles(user.openId);

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!project) throw new Error("项目不存在");
  assertProjectActive(project.status);
  if (project.status !== "IN_PROGRESS") {
    throw new Error("仅进行中的项目可提交阶段证据");
  }

  const stage = project.stages.find((s) => s.id === parsed.stageId);
  if (!stage) throw new Error("阶段不存在");
  if (stage.status !== "IN_PROGRESS") {
    throw new Error("仅进行中的阶段可提交证据");
  }

  const priorIncomplete = project.stages
    .filter((s) => s.sortOrder < stage.sortOrder)
    .some((s) => s.status !== "COMPLETED");
  if (priorIncomplete) throw new Error("请先完成前一阶段");

  if (!canSubmitStage(roles, stage.ownerOpenId, user.openId)) {
    throw new Error("仅阶段负责人可提交阶段证据");
  }

  const submission = await prisma.$transaction(async (tx) => {
    const sub = await tx.taskSubmission.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        type: SubmissionType.STAGE,
        feishuDocUrl: parsed.evidenceUrl,
        note: parsed.note ?? "",
        submittedBy: user.openId,
        submitterName: user.name,
      },
    });

    await tx.projectStage.update({
      where: { id: stage.id },
      data: {
        evidenceUrl: parsed.evidenceUrl,
        currentSubmissionId: sub.id,
        status: "PENDING_ACCEPTANCE",
      },
    });

    return sub;
  });

  await logProgressActivity({
    projectId: project.id,
    action: "stage.evidence_submitted",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { stageId: stage.id, submissionId: submission.id },
  });

  await sendProgressNotification({
    type: "stage_pending_acceptance",
    projectId: project.id,
    projectName: project.name,
    stageName: stage.name,
    team: project.team,
    techGroup: project.techGroup,
    ownerOpenIds: getProjectOwnerOpenIds(project),
    submitterOpenId: user.openId,
    evidenceUrl: parsed.evidenceUrl,
  }, await getNotificationContext()).catch(console.error);

  revalidatePath(`/progress/projects/${project.id}`);
  return submission;
}

export async function approveStageSubmission(input: {
  submissionId: string;
  comment?: string;
  offlineConfirmed?: boolean;
}) {
  return reviewStageSubmission(input, true);
}

export async function rejectStageSubmission(input: {
  submissionId: string;
  comment?: string;
  offlineConfirmed?: boolean;
}) {
  return reviewStageSubmission(input, false);
}

async function reviewStageSubmission(
  input: { submissionId: string; comment?: string; offlineConfirmed?: boolean },
  pass: boolean,
) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const roles = await getUserRoles(user.openId);
  const parsed = approvalSchema.parse(input);

  const submission = await prisma.taskSubmission.findUnique({
    where: { id: parsed.submissionId },
    include: {
      stage: {
        include: {
          project: {
            include: {
              owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
              stages: true,
            },
          },
        },
      },
    },
  });
  if (!submission?.stage) throw new Error("阶段提交记录不存在");

  const stage = submission.stage;
  const project = stage.project;
  assertProjectActive(project.status);
  if (submission.type !== "STAGE") throw new Error("提交类型无效");
  if (stage.currentSubmissionId !== submission.id) {
    throw new Error("只能审批当前阶段最新提交");
  }
  const existingApproval = await prisma.approvalRecord.findFirst({
    where: { submissionId: submission.id },
    select: { id: true },
  });
  if (existingApproval) throw new Error("该提交已审批");
  if (stage.status !== "PENDING_ACCEPTANCE") {
    throw new Error("当前阶段不在待审批状态");
  }

  if (
    !canApproveStage(
      roles,
      { team: project.team, techGroup: project.techGroup },
      getProjectOwnerOpenIds(project),
      submission.submittedBy,
      project.allowOwnerSelfApproval,
      user.openId,
    )
  ) {
    throw new Error("无阶段审批权限");
  }

  const approverRole = getApproverRole(roles, {
    team: project.team,
    techGroup: project.techGroup,
  }) ?? (getProjectOwnerOpenIds(project).includes(user.openId) ? "PROJECT_MANAGER" : null);
  if (!approverRole) throw new Error("无法确定审批角色");

  await prisma.$transaction(async (tx) => {
    await tx.approvalRecord.create({
      data: {
        submissionId: submission.id,
        approverOpenId: user.openId,
        approverName: user.name,
        approverRole,
        decision: pass ? ApprovalDecision.APPROVED : ApprovalDecision.REJECTED,
        offlineConfirmed: parsed.offlineConfirmed,
        comment: parsed.comment ?? "",
      },
    });

    await tx.projectStage.update({
      where: { id: stage.id },
      data: { status: pass ? "COMPLETED" : "IN_PROGRESS" },
    });

    if (pass) {
      const next = project.stages
        .filter((s) => s.sortOrder > stage.sortOrder)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .find((s) => s.status === "NOT_STARTED");
      if (next) {
        await tx.projectStage.update({
          where: { id: next.id },
          data: { status: "IN_PROGRESS" },
        });
      }
    }
  });

  await logProgressActivity({
    projectId: project.id,
    action: pass ? "stage.approved" : "stage.rejected",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { stageId: stage.id, submissionId: submission.id },
  });

  await sendProgressNotification({
    type: pass ? "stage_approved" : "stage_rejected",
    projectId: project.id,
    projectName: project.name,
    stageName: stage.name,
    stageOwnerOpenId: stage.ownerOpenId,
  }, await getNotificationContext()).catch(console.error);

  revalidatePath(`/progress/projects/${project.id}`);
  return { success: true };
}
