-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "signaturePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "openId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "team" TEXT NOT NULL DEFAULT '',
    "techGroup" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNo" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "initiatorName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "techGroup" TEXT NOT NULL,
    "totalPrice" REAL NOT NULL DEFAULT 0,
    "teamApproved" BOOLEAN NOT NULL DEFAULT false,
    "techGroupApproved" BOOLEAN NOT NULL DEFAULT false,
    "invoicePaths" TEXT NOT NULL DEFAULT '[]',
    "invoicePath" TEXT,
    "listDocPath" TEXT,
    "screenshotPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isWorkshopFee" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "rejectedAt" DATETIME,
    "rejectedByName" TEXT,
    "lastReminderAt" DATETIME,
    "statusEnteredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseOrder_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL DEFAULT 'COMPONENT',
    "purchaseLink" TEXT NOT NULL DEFAULT '',
    "referenceImagePath" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "photoPath" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL,
    "techGroup" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "ownerOpenId" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "allowOwnerSelfApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "completedAt" DATETIME,
    "canceledAt" DATETIME
);

-- CreateTable
CREATE TABLE "ProjectOwner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectOwner_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectParticipant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectParticipant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectMilestone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "feishuDocUrl" TEXT NOT NULL DEFAULT '',
    "ownerOpenId" TEXT NOT NULL DEFAULT '',
    "ownerName" TEXT NOT NULL DEFAULT '',
    "dueAt" DATETIME,
    "submissionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "stageId" TEXT,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'RND',
    "urgency" TEXT NOT NULL DEFAULT 'MEDIUM',
    "importance" TEXT NOT NULL DEFAULT 'MEDIUM',
    "assigneeOpenId" TEXT NOT NULL,
    "assigneeName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "techGroup" TEXT NOT NULL,
    "metrics" TEXT NOT NULL DEFAULT '',
    "dueAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'TODO',
    "isOverdue" BOOLEAN NOT NULL DEFAULT false,
    "needsOfflineConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "needsWeeklyReport" BOOLEAN NOT NULL DEFAULT false,
    "riskNote" TEXT NOT NULL DEFAULT '',
    "riskUpdatedAt" DATETIME,
    "failureReason" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "deletedAt" DATETIME,
    "deletedByOpenId" TEXT NOT NULL DEFAULT '',
    "deletedByName" TEXT NOT NULL DEFAULT '',
    "deleteReason" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ProjectMilestone" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskDeletionRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "requesterOpenId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pendingKey" TEXT NOT NULL DEFAULT '',
    "reviewerOpenId" TEXT NOT NULL DEFAULT '',
    "reviewerName" TEXT NOT NULL DEFAULT '',
    "reviewComment" TEXT NOT NULL DEFAULT '',
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskDeletionRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskCreationRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "requesterOpenId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "draftPayload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewerOpenId" TEXT NOT NULL DEFAULT '',
    "reviewerName" TEXT NOT NULL DEFAULT '',
    "reviewComment" TEXT NOT NULL DEFAULT '',
    "reviewedAt" DATETIME,
    "createdTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskCreationRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskCreationRequest_createdTaskId_fkey" FOREIGN KEY ("createdTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskAssignee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "projectId" TEXT,
    "stageId" TEXT,
    "type" TEXT NOT NULL,
    "feishuDocUrl" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "failureReason" TEXT NOT NULL DEFAULT '',
    "submittedBy" TEXT NOT NULL,
    "submitterName" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskSubmission_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ProjectMilestone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AcceptanceChecklistTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TaskAcceptanceChecklistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskAcceptanceChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WeeklyReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "weekStart" DATETIME NOT NULL,
    "progress" TEXT NOT NULL,
    "risks" TEXT NOT NULL DEFAULT '',
    "nextPlan" TEXT NOT NULL DEFAULT '',
    "feishuDocUrl" TEXT NOT NULL DEFAULT '',
    "submittedBy" TEXT NOT NULL,
    "submitterName" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WeeklyReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApprovalRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "approverOpenId" TEXT NOT NULL,
    "approverName" TEXT NOT NULL,
    "approverRole" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "docViewVerified" BOOLEAN NOT NULL DEFAULT false,
    "offlineConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalRecord_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TaskSubmission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApprovalChecklistConfirmation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "approvalId" TEXT NOT NULL,
    "checklistItemId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalChecklistConfirmation_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "ApprovalRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProgressActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "taskId" TEXT,
    "action" TEXT NOT NULL,
    "actorOpenId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProgressActivityLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressActivityLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submitterOpenId" TEXT NOT NULL,
    "submitterName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FeedbackMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedbackId" TEXT NOT NULL,
    "authorOpenId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackMessage_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FeedbackAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "FeedbackMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicPath" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "orderId" TEXT,
    "feedbackId" TEXT,
    "signatureOwnerOpenId" TEXT,
    "ownerOpenId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" DATETIME,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProgressReminderRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleTime" TEXT NOT NULL DEFAULT '09:00',
    "paramsJson" TEXT NOT NULL DEFAULT '{}',
    "recipientConfigJson" TEXT NOT NULL DEFAULT '{}',
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_openId_key" ON "User"("openId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_openId_role_team_techGroup_key" ON "UserRole"("openId", "role", "team", "techGroup");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orderNo_key" ON "PurchaseOrder"("orderNo");

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
