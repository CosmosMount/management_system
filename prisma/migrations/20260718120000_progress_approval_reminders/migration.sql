-- CreateEnum
CREATE TYPE "ProgressApprovalKind" AS ENUM (
  'PROJECT_ESTABLISHMENT',
  'STAGE_ACCEPTANCE',
  'PROJECT_BATCH_DDL',
  'PROJECT_STAGE_DDL',
  'TASK_CREATION',
  'TASK_DELETION',
  'TASK_DDL',
  'TASK_ACCEPTANCE'
);

-- CreateTable
CREATE TABLE "ProgressApprovalReminderSetting" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 10,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProgressApprovalReminderSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressApprovalReminderDelivery" (
  "id" TEXT NOT NULL,
  "approvalKind" "ProgressApprovalKind" NOT NULL,
  "approvalId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "projectId" TEXT,
  "taskId" TEXT,
  "remindedByOpenId" TEXT NOT NULL,
  "remindedByName" TEXT NOT NULL,
  "recipientOpenId" TEXT NOT NULL,
  "recipientName" TEXT NOT NULL,
  "outboxEventKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProgressApprovalReminderDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProgressApprovalReminderDelivery_batchId_recipientOpenId_key"
  ON "ProgressApprovalReminderDelivery"("batchId", "recipientOpenId");

CREATE INDEX "ProgressApprovalReminderDelivery_approvalKind_approvalId_recipientOpenId_createdAt_idx"
  ON "ProgressApprovalReminderDelivery"("approvalKind", "approvalId", "recipientOpenId", "createdAt");

CREATE INDEX "ProgressApprovalReminderDelivery_batchId_idx"
  ON "ProgressApprovalReminderDelivery"("batchId");

CREATE INDEX "ProgressApprovalReminderDelivery_projectId_createdAt_idx"
  ON "ProgressApprovalReminderDelivery"("projectId", "createdAt");

CREATE INDEX "ProgressApprovalReminderDelivery_taskId_createdAt_idx"
  ON "ProgressApprovalReminderDelivery"("taskId", "createdAt");

CREATE INDEX "ProgressApprovalReminderDelivery_outboxEventKey_idx"
  ON "ProgressApprovalReminderDelivery"("outboxEventKey");
