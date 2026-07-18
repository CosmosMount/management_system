import type { Prisma } from "@prisma/client";
import type {
  ProgressApprovalReference,
  ResolvedProgressApproval,
} from "@/lib/progress-approval-domain";

export async function lockProgressApprovalForMutation(
  tx: Prisma.TransactionClient,
  reference: ProgressApprovalReference,
  approval: ResolvedProgressApproval,
): Promise<void> {
  // Match every approval action's row order to prevent reminder/withdrawal deadlocks.
  if (
    reference.kind === "STAGE_ACCEPTANCE" ||
    reference.kind === "TASK_ACCEPTANCE" ||
    reference.kind === "TASK_CREATION"
  ) {
    await lockContextRows(tx, approval);
    await lockApprovalRow(tx, reference);
    return;
  }
  await lockApprovalRow(tx, reference);
  await lockContextRows(tx, approval);
}

async function lockContextRows(
  tx: Prisma.TransactionClient,
  approval: ResolvedProgressApproval,
) {
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${approval.project.id} FOR UPDATE`;
  if (approval.stage) {
    await tx.$queryRaw`SELECT id FROM "ProjectStage" WHERE id = ${approval.stage.id} FOR UPDATE`;
  }
  if (approval.task) {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${approval.task.id} FOR UPDATE`;
  }
}

async function lockApprovalRow(
  tx: Prisma.TransactionClient,
  reference: ProgressApprovalReference,
) {
  switch (reference.kind) {
    case "PROJECT_ESTABLISHMENT":
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "STAGE_ACCEPTANCE":
    case "TASK_ACCEPTANCE":
      await tx.$queryRaw`SELECT id FROM "TaskSubmission" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "PROJECT_BATCH_DDL":
    case "PROJECT_STAGE_DDL":
      await tx.$queryRaw`SELECT id FROM "ProjectDdlChangeRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "TASK_CREATION":
      await tx.$queryRaw`SELECT id FROM "TaskCreationRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "TASK_DELETION":
      await tx.$queryRaw`SELECT id FROM "TaskDeletionRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
    case "TASK_DDL":
      await tx.$queryRaw`SELECT id FROM "TaskDdlChangeRequest" WHERE id = ${reference.id} FOR UPDATE`;
      return;
  }
}
