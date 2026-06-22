"use server";

import { revalidatePath } from "next/cache";
import { SubmissionType, TaskStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { sendProgressNotification } from "@/lib/feishu-progress";
import { logProgressActivity, requireSessionUser } from "@/lib/progress-activity";
import { canSubmitDelivery } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { submitDeliverySchema } from "@/lib/validations/progress";

export async function submitTaskDelivery(input: {
  taskId: string;
  feishuDocUrl: string;
  videoUrl?: string;
  note?: string;
  failureReason?: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  const parsed = submitDeliverySchema.parse(input);

  const task = await prisma.task.findUnique({
    where: { id: parsed.taskId },
    include: { project: true },
  });
  if (!task) throw new Error("任务不存在");

  if (!canSubmitDelivery(user.openId, task.assigneeOpenId)) {
    throw new Error("仅任务负责人可提交交付");
  }

  const submission = await prisma.$transaction(async (tx) => {
    const sub = await tx.taskSubmission.create({
      data: {
        taskId: task.id,
        projectId: task.projectId,
        type: SubmissionType.DELIVERY,
        feishuDocUrl: parsed.feishuDocUrl,
        videoUrl: parsed.videoUrl ?? "",
        note: parsed.note ?? "",
        failureReason: parsed.failureReason ?? "",
        submittedBy: user.openId,
        submitterName: user.name,
      },
    });

    await tx.task.update({
      where: { id: task.id },
      data: { status: TaskStatus.PENDING_ACCEPTANCE },
    });

    return sub;
  });

  await logProgressActivity({
    projectId: task.projectId,
    taskId: task.id,
    action: "task.delivery_submitted",
    actorOpenId: user.openId,
    actorName: user.name,
    payload: { submissionId: submission.id },
  });

  await sendProgressNotification({
    type: "task_pending_acceptance",
    taskId: task.id,
    taskTitle: task.title,
    projectName: task.project.name,
    team: task.team,
    techGroup: task.techGroup,
    feishuDocUrl: parsed.feishuDocUrl,
  }).catch(console.error);

  revalidatePath(`/progress/tasks/${task.id}`);
  revalidatePath("/progress/kanban");
  return submission;
}
