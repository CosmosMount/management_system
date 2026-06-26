-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'MANAGEMENT_REVIEW', 'TEACHER_REVIEW', 'PENDING_APPLICANT_DOCS', 'PENDING_FINANCE_REVIEW', 'PENDING_APPLICANT_CONFIRM', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "UserRoleType" AS ENUM ('SUPER_ADMIN', 'TEAM_ADMIN', 'TECH_GROUP_ADMIN', 'TEACHER', 'FINANCE', 'PROJECT_MANAGER');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'PENDING_ACCEPTANCE', 'COMPLETED', 'ARCHIVED', 'PROJECT_CANCELED');

-- CreateEnum
CREATE TYPE "TaskDeletionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskCreationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskCategory" AS ENUM ('TEST', 'ASSEMBLY', 'RND', 'DEBUG', 'REVIEW_DRAWING', 'ITERATION');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "Importance" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "SubmissionType" AS ENUM ('DELIVERY', 'STAGE');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'PENDING_ACCEPTANCE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSED');

-- CreateEnum
CREATE TYPE "FileAssetKind" AS ENUM ('ORDER_ATTACHMENT', 'ORDER_ITEM_IMAGE', 'FEEDBACK_ATTACHMENT', 'USER_SIGNATURE', 'TEMP_UPLOAD');

-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ProgressReminderKind" AS ENUM ('TASK_OVERDUE', 'TASK_DUE_SOON', 'TASK_PENDING_ACCEPTANCE_STALE', 'WEEKLY_REPORT_MISSING', 'TASK_STALE_ACTIVITY', 'STAGE_STALE_OR_DUE_SOON');

-- CreateEnum
CREATE TYPE "PurchaseItemKind" AS ENUM ('COMPONENT', 'STANDARD_PART', 'PROCESSING_FEE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "signaturePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "role" "UserRoleType" NOT NULL,
    "team" TEXT NOT NULL DEFAULT '',
    "techGroup" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "initiatorName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "techGroup" TEXT NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "teamApproved" BOOLEAN NOT NULL DEFAULT false,
    "techGroupApproved" BOOLEAN NOT NULL DEFAULT false,
    "invoicePaths" TEXT NOT NULL DEFAULT '[]',
    "invoicePath" TEXT,
    "listDocPath" TEXT,
    "screenshotPath" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "isWorkshopFee" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedByName" TEXT,
    "lastReminderAt" TIMESTAMP(3),
    "statusEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingVendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "itemKind" "PurchaseItemKind" NOT NULL DEFAULT 'COMPONENT',
    "purchaseLink" TEXT NOT NULL DEFAULT '',
    "referenceImagePath" TEXT,
    "processingVendor" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "photoPath" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL,
    "techGroup" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "ownerOpenId" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "allowOwnerSelfApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectOwner" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectParticipant" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMilestone" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "feishuDocUrl" TEXT NOT NULL DEFAULT '',
    "ownerOpenId" TEXT NOT NULL DEFAULT '',
    "ownerName" TEXT NOT NULL DEFAULT '',
    "dueAt" TIMESTAMP(3),
    "submissionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stageId" TEXT,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "category" "TaskCategory" NOT NULL DEFAULT 'RND',
    "urgency" "Urgency" NOT NULL DEFAULT 'MEDIUM',
    "importance" "Importance" NOT NULL DEFAULT 'MEDIUM',
    "assigneeOpenId" TEXT NOT NULL,
    "assigneeName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "techGroup" TEXT NOT NULL,
    "metrics" TEXT NOT NULL DEFAULT '',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "isOverdue" BOOLEAN NOT NULL DEFAULT false,
    "needsOfflineConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "needsWeeklyReport" BOOLEAN NOT NULL DEFAULT false,
    "riskNote" TEXT NOT NULL DEFAULT '',
    "riskUpdatedAt" TIMESTAMP(3),
    "failureReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedByOpenId" TEXT NOT NULL DEFAULT '',
    "deletedByName" TEXT NOT NULL DEFAULT '',
    "deleteReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDeletionRequest" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "requesterOpenId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TaskDeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "pendingKey" TEXT NOT NULL DEFAULT '',
    "reviewerOpenId" TEXT NOT NULL DEFAULT '',
    "reviewerName" TEXT NOT NULL DEFAULT '',
    "reviewComment" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCreationRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requesterOpenId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "draftPayload" TEXT NOT NULL,
    "status" "TaskCreationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerOpenId" TEXT NOT NULL DEFAULT '',
    "reviewerName" TEXT NOT NULL DEFAULT '',
    "reviewComment" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TIMESTAMP(3),
    "createdTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskCreationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignee" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSubmission" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "projectId" TEXT,
    "stageId" TEXT,
    "type" "SubmissionType" NOT NULL,
    "feishuDocUrl" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "failureReason" TEXT NOT NULL DEFAULT '',
    "submittedBy" TEXT NOT NULL,
    "submitterName" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcceptanceChecklistTemplate" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcceptanceChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAcceptanceChecklistItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAcceptanceChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyReport" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "progress" TEXT NOT NULL,
    "risks" TEXT NOT NULL DEFAULT '',
    "nextPlan" TEXT NOT NULL DEFAULT '',
    "feishuDocUrl" TEXT NOT NULL DEFAULT '',
    "submittedBy" TEXT NOT NULL,
    "submitterName" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRecord" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "approverOpenId" TEXT NOT NULL,
    "approverName" TEXT NOT NULL,
    "approverRole" "UserRoleType" NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "docViewVerified" BOOLEAN NOT NULL DEFAULT false,
    "offlineConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalChecklistConfirmation" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "checklistItemId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalChecklistConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressActivityLog" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "action" TEXT NOT NULL,
    "actorOpenId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgressActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "submitterOpenId" TEXT NOT NULL,
    "submitterName" TEXT NOT NULL,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackMessage" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "authorOpenId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL,
    "publicPath" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "kind" "FileAssetKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "orderId" TEXT,
    "feedbackId" TEXT,
    "signatureOwnerOpenId" TEXT,
    "ownerOpenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgressReminderRule" (
    "id" TEXT NOT NULL,
    "kind" "ProgressReminderKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleTime" TEXT NOT NULL DEFAULT '09:00',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "recipientConfigJson" TEXT NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressReminderRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_openId_key" ON "User"("openId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_openId_role_team_techGroup_key" ON "UserRole"("openId", "role", "team", "techGroup");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orderNo_key" ON "PurchaseOrder"("orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingVendor_name_key" ON "ProcessingVendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectOwner_projectId_openId_key" ON "ProjectOwner"("projectId", "openId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectParticipant_projectId_openId_key" ON "ProjectParticipant"("projectId", "openId");

-- CreateIndex
CREATE INDEX "TaskDeletionRequest_taskId_status_idx" ON "TaskDeletionRequest"("taskId", "status");

-- CreateIndex
CREATE INDEX "TaskDeletionRequest_requesterOpenId_idx" ON "TaskDeletionRequest"("requesterOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDeletionRequest_taskId_pendingKey_key" ON "TaskDeletionRequest"("taskId", "pendingKey");

-- CreateIndex
CREATE INDEX "TaskCreationRequest_projectId_status_idx" ON "TaskCreationRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "TaskCreationRequest_requesterOpenId_idx" ON "TaskCreationRequest"("requesterOpenId");

-- CreateIndex
CREATE INDEX "TaskCreationRequest_createdTaskId_idx" ON "TaskCreationRequest"("createdTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskAssignee_taskId_openId_key" ON "TaskAssignee"("taskId", "openId");

-- CreateIndex
CREATE UNIQUE INDEX "AcceptanceChecklistTemplate_content_key" ON "AcceptanceChecklistTemplate"("content");

-- CreateIndex
CREATE INDEX "TaskAcceptanceChecklistItem_taskId_sortOrder_idx" ON "TaskAcceptanceChecklistItem"("taskId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyReport_taskId_weekStart_key" ON "WeeklyReport"("taskId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRecord_submissionId_key" ON "ApprovalRecord"("submissionId");

-- CreateIndex
CREATE INDEX "ApprovalChecklistConfirmation_approvalId_sortOrder_idx" ON "ApprovalChecklistConfirmation"("approvalId", "sortOrder");

-- CreateIndex
CREATE INDEX "Feedback_submitterOpenId_idx" ON "Feedback"("submitterOpenId");

-- CreateIndex
CREATE INDEX "Feedback_status_lastMessageAt_idx" ON "Feedback"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "FeedbackMessage_feedbackId_createdAt_idx" ON "FeedbackMessage"("feedbackId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileAsset_publicPath_key" ON "FileAsset"("publicPath");

-- CreateIndex
CREATE INDEX "FileAsset_orderId_idx" ON "FileAsset"("orderId");

-- CreateIndex
CREATE INDEX "FileAsset_feedbackId_idx" ON "FileAsset"("feedbackId");

-- CreateIndex
CREATE INDEX "FileAsset_signatureOwnerOpenId_idx" ON "FileAsset"("signatureOwnerOpenId");

-- CreateIndex
CREATE INDEX "FileAsset_ownerOpenId_idx" ON "FileAsset"("ownerOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_eventKey_key" ON "NotificationOutbox"("eventKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_nextRunAt_idx" ON "NotificationOutbox"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProgressReminderRule_kind_key" ON "ProgressReminderRule"("kind");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectOwner" ADD CONSTRAINT "ProjectOwner_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectParticipant" ADD CONSTRAINT "ProjectParticipant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMilestone" ADD CONSTRAINT "ProjectMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ProjectMilestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDeletionRequest" ADD CONSTRAINT "TaskDeletionRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCreationRequest" ADD CONSTRAINT "TaskCreationRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCreationRequest" ADD CONSTRAINT "TaskCreationRequest_createdTaskId_fkey" FOREIGN KEY ("createdTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ProjectMilestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAcceptanceChecklistItem" ADD CONSTRAINT "TaskAcceptanceChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyReport" ADD CONSTRAINT "WeeklyReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRecord" ADD CONSTRAINT "ApprovalRecord_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TaskSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalChecklistConfirmation" ADD CONSTRAINT "ApprovalChecklistConfirmation_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "ApprovalRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressActivityLog" ADD CONSTRAINT "ProgressActivityLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgressActivityLog" ADD CONSTRAINT "ProgressActivityLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackMessage" ADD CONSTRAINT "FeedbackMessage_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackAttachment" ADD CONSTRAINT "FeedbackAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "FeedbackMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

