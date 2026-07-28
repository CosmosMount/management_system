-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('FEISHU');

-- CreateEnum
CREATE TYPE "PersonStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProjectManagementSystemRole" AS ENUM ('SYSTEM_ADMINISTRATOR', 'TEAM_ADMINISTRATOR', 'RESOURCE_MANAGER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "TaskMemberRole" AS ENUM ('OWNER', 'LEAD', 'MEMBER', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "RevisionApprovalMode" AS ENUM ('DIRECT_BY_OWNER', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "PlanVersionStatus" AS ENUM ('DRAFT', 'CURRENT', 'HISTORICAL', 'ABANDONED');

-- CreateEnum
CREATE TYPE "TaskNodeType" AS ENUM ('MILESTONE', 'REVISION', 'TERMINATION');

-- CreateEnum
CREATE TYPE "TaskNodeStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'REVISED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RevisionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'EFFECTIVE', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MilestoneReviewResult" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUIRED');

-- CreateEnum
CREATE TYPE "ReviewEvidenceKind" AS ENUM ('FILE', 'LINK', 'TEXT');

-- CreateEnum
CREATE TYPE "TerminationOutcome" AS ENUM ('SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "WorkSegmentType" AS ENUM ('PLANNED', 'ACTUAL');

-- CreateEnum
CREATE TYPE "WorkSegmentStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkSegmentRole" AS ENUM ('OWNER', 'LEAD', 'DEVELOPER', 'DESIGNER', 'REVIEWER', 'SUPPORT', 'OBSERVER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "WorkSegmentChangeAction" AS ENUM ('CREATE', 'UPDATE', 'SPLIT', 'MERGE', 'CONFIRM', 'CANCEL', 'DELETE', 'RELINK');

-- CreateEnum
CREATE TYPE "ResourceConflictKind" AS ENUM ('ALLOCATION_OVER_LIMIT', 'MISSING_ALLOCATION', 'HIGH_PRIORITY_OVERLAP', 'LEAD_ROLE_OVERLAP', 'UNAVAILABLE_TIME', 'REVISION_OVERLAP', 'ACTUAL_OVERLOAD');

-- CreateEnum
CREATE TYPE "ResourceConflictSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ResourceConflictStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ProjectManagementNotificationCategory" AS ENUM ('TASK', 'MILESTONE', 'REVIEW', 'REVISION', 'WORK_SEGMENT', 'RESOURCE_CONFLICT', 'ACCOUNT_SECURITY');

-- CreateEnum
CREATE TYPE "ProjectManagementNotificationChannel" AS ENUM ('IN_APP', 'FEISHU');

-- CreateEnum
CREATE TYPE "AuditSource" AS ENUM ('WEB', 'CRON', 'MIGRATION', 'SYSTEM');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountIdentity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "openId" TEXT,
    "unionId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AccountIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "displayName" TEXT NOT NULL,
    "avatar" TEXT,
    "status" "PersonStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "createdByAccountId" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL DEFAULT '',
    "techGroup" TEXT NOT NULL DEFAULT '',
    "status" "TaskStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "currentPlanVersionId" TEXT NOT NULL,
    "activeMilestoneNodeId" TEXT,
    "revisionApprovalMode" "RevisionApprovalMode" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "allowSelfReview" BOOLEAN NOT NULL DEFAULT false,
    "lockVersion" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),
    "relatedTaskId" TEXT,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTag" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskMember" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "TaskMemberRole" NOT NULL,
    "createdByAccountId" TEXT,
    "removedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskPlanVersion" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "PlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "baseVersionId" TEXT,
    "revisionNodeId" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdByAccountId" TEXT NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "snapshotHash" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TaskPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskNode" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "type" "TaskNodeType" NOT NULL,
    "status" "TaskNodeStatus" NOT NULL DEFAULT 'PENDING',
    "businessDescription" TEXT NOT NULL DEFAULT '',
    "createdByAccountId" TEXT NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TaskNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanVersionNode" (
    "id" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "isCarryForward" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanVersionNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneNode" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "completionCriteria" TEXT NOT NULL,
    "expectedCompletedAt" TIMESTAMPTZ(6) NOT NULL,
    "reviewRequirements" TEXT NOT NULL,
    "submittedForReviewAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MilestoneNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevisionNode" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "revisedFromNodeId" TEXT,
    "basePlanVersionId" TEXT NOT NULL,
    "status" "RevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMPTZ(6),
    "reviewedAt" TIMESTAMPTZ(6),
    "effectiveAt" TIMESTAMPTZ(6),
    "reviewedByAccountId" TEXT,
    "reviewComment" TEXT NOT NULL DEFAULT '',
    "affectedSummary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "RevisionNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminationNode" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "plannedOutcomeCriteria" TEXT NOT NULL,
    "plannedAt" TIMESTAMPTZ(6) NOT NULL,
    "outcome" "TerminationOutcome",
    "reason" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "confirmedByAccountId" TEXT,
    "confirmedAt" TIMESTAMPTZ(6),

    CONSTRAINT "TerminationNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneReview" (
    "id" TEXT NOT NULL,
    "milestoneNodeId" TEXT NOT NULL,
    "result" "MilestoneReviewResult" NOT NULL DEFAULT 'PENDING',
    "submittedByAccountId" TEXT,
    "reviewerAccountId" TEXT,
    "reviewedAt" TIMESTAMPTZ(6),
    "comment" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedByAccountId" TEXT,
    "revokeReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewEvidence" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "kind" "ReviewEvidenceKind" NOT NULL,
    "fileAssetId" TEXT,
    "externalUrl" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSegment" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "type" "WorkSegmentType" NOT NULL,
    "status" "WorkSegmentStatus" NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6) NOT NULL,
    "content" TEXT NOT NULL,
    "allocation" DECIMAL(5,2),
    "role" "WorkSegmentRole" NOT NULL DEFAULT 'DEVELOPER',
    "customRole" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "expectedOutput" TEXT NOT NULL DEFAULT '',
    "actualOutput" TEXT NOT NULL DEFAULT '',
    "completionPercent" DECIMAL(5,2),
    "taskId" TEXT,
    "nodeId" TEXT,
    "associationNeedsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdByAccountId" TEXT NOT NULL,
    "updatedByAccountId" TEXT,
    "sourceSplitFromId" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentTag" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSegmentSource" (
    "id" TEXT NOT NULL,
    "plannedSegmentId" TEXT NOT NULL,
    "actualSegmentId" TEXT NOT NULL,
    "coveredStartAt" TIMESTAMPTZ(6) NOT NULL,
    "coveredEndAt" TIMESTAMPTZ(6) NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSegmentSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSegmentChange" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "action" "WorkSegmentChangeAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT NOT NULL DEFAULT '',
    "actorAccountId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSegmentChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceConflict" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "ResourceConflictKind" NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6) NOT NULL,
    "severity" "ResourceConflictSeverity" NOT NULL,
    "status" "ResourceConflictStatus" NOT NULL DEFAULT 'OPEN',
    "fingerprint" TEXT NOT NULL,
    "explanation" JSONB NOT NULL DEFAULT '{}',
    "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "ignoredUntil" TIMESTAMPTZ(6),
    "resolvedByAccountId" TEXT,
    "resolutionNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ResourceConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConflictSegment" (
    "id" TEXT NOT NULL,
    "conflictId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConflictSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemRoleAssignment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" "ProjectManagementSystemRole" NOT NULL,
    "team" TEXT NOT NULL DEFAULT '',
    "techGroup" TEXT NOT NULL DEFAULT '',
    "grantedByAccountId" TEXT,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "category" "ProjectManagementNotificationCategory" NOT NULL,
    "channel" "ProjectManagementNotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InAppNotification" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT,
    "recipientAccountId" TEXT NOT NULL,
    "category" "ProjectManagementNotificationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taskId" TEXT,
    "linkPath" TEXT NOT NULL DEFAULT '',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InAppNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainAuditEvent" (
    "id" TEXT NOT NULL,
    "actorAccountId" TEXT,
    "actorPersonId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taskId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT NOT NULL DEFAULT '',
    "requestId" TEXT NOT NULL DEFAULT '',
    "source" "AuditSource" NOT NULL DEFAULT 'WEB',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountIdentity_accountId_idx" ON "AccountIdentity"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_provider_tenantId_providerSubject_key" ON "AccountIdentity"("provider", "tenantId", "providerSubject");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_provider_tenantId_openId_key" ON "AccountIdentity"("provider", "tenantId", "openId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_provider_tenantId_unionId_key" ON "AccountIdentity"("provider", "tenantId", "unionId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_accountId_key" ON "Person"("accountId");

-- CreateIndex
CREATE INDEX "Person_displayName_idx" ON "Person"("displayName");

-- CreateIndex
CREATE INDEX "Person_status_idx" ON "Person"("status");

-- CreateIndex
CREATE INDEX "Tag_name_idx" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "Tag_archivedAt_idx" ON "Tag"("archivedAt");

-- CreateIndex
CREATE INDEX "Tag_createdByAccountId_idx" ON "Tag"("createdByAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_currentPlanVersionId_key" ON "Task"("currentPlanVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_activeMilestoneNodeId_key" ON "Task"("activeMilestoneNodeId");

-- CreateIndex
CREATE INDEX "Task_status_team_techGroup_idx" ON "Task"("status", "team", "techGroup");

-- CreateIndex
CREATE INDEX "Task_createdByAccountId_idx" ON "Task"("createdByAccountId");

-- CreateIndex
CREATE INDEX "Task_deletedAt_idx" ON "Task"("deletedAt");

-- CreateIndex
CREATE INDEX "Task_relatedTaskId_idx" ON "Task"("relatedTaskId");

-- CreateIndex
CREATE INDEX "TaskTag_tagId_idx" ON "TaskTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTag_taskId_tagId_key" ON "TaskTag"("taskId", "tagId");

-- CreateIndex
CREATE INDEX "TaskMember_taskId_personId_idx" ON "TaskMember"("taskId", "personId");

-- CreateIndex
CREATE INDEX "TaskMember_personId_role_idx" ON "TaskMember"("personId", "role");

-- CreateIndex
CREATE INDEX "TaskMember_createdByAccountId_idx" ON "TaskMember"("createdByAccountId");

-- CreateIndex
CREATE INDEX "TaskMember_removedAt_idx" ON "TaskMember"("removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPlanVersion_revisionNodeId_key" ON "TaskPlanVersion"("revisionNodeId");

-- CreateIndex
CREATE INDEX "TaskPlanVersion_taskId_status_idx" ON "TaskPlanVersion"("taskId", "status");

-- CreateIndex
CREATE INDEX "TaskPlanVersion_baseVersionId_idx" ON "TaskPlanVersion"("baseVersionId");

-- CreateIndex
CREATE INDEX "TaskPlanVersion_createdByAccountId_idx" ON "TaskPlanVersion"("createdByAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPlanVersion_taskId_versionNo_key" ON "TaskPlanVersion"("taskId", "versionNo");

-- CreateIndex
CREATE INDEX "TaskNode_taskId_type_status_idx" ON "TaskNode"("taskId", "type", "status");

-- CreateIndex
CREATE INDEX "TaskNode_createdByAccountId_idx" ON "TaskNode"("createdByAccountId");

-- CreateIndex
CREATE INDEX "TaskNode_deletedAt_idx" ON "TaskNode"("deletedAt");

-- CreateIndex
CREATE INDEX "PlanVersionNode_nodeId_idx" ON "PlanVersionNode"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersionNode_planVersionId_sequence_key" ON "PlanVersionNode"("planVersionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersionNode_planVersionId_nodeId_key" ON "PlanVersionNode"("planVersionId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneNode_nodeId_key" ON "MilestoneNode"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionNode_nodeId_key" ON "RevisionNode"("nodeId");

-- CreateIndex
CREATE INDEX "RevisionNode_basePlanVersionId_idx" ON "RevisionNode"("basePlanVersionId");

-- CreateIndex
CREATE INDEX "RevisionNode_revisedFromNodeId_idx" ON "RevisionNode"("revisedFromNodeId");

-- CreateIndex
CREATE INDEX "RevisionNode_reviewedByAccountId_idx" ON "RevisionNode"("reviewedByAccountId");

-- CreateIndex
CREATE INDEX "RevisionNode_status_idx" ON "RevisionNode"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TerminationNode_nodeId_key" ON "TerminationNode"("nodeId");

-- CreateIndex
CREATE INDEX "TerminationNode_confirmedByAccountId_idx" ON "TerminationNode"("confirmedByAccountId");

-- CreateIndex
CREATE INDEX "TerminationNode_outcome_idx" ON "TerminationNode"("outcome");

-- CreateIndex
CREATE INDEX "MilestoneReview_milestoneNodeId_createdAt_idx" ON "MilestoneReview"("milestoneNodeId", "createdAt");

-- CreateIndex
CREATE INDEX "MilestoneReview_submittedByAccountId_idx" ON "MilestoneReview"("submittedByAccountId");

-- CreateIndex
CREATE INDEX "MilestoneReview_reviewerAccountId_idx" ON "MilestoneReview"("reviewerAccountId");

-- CreateIndex
CREATE INDEX "MilestoneReview_revokedByAccountId_idx" ON "MilestoneReview"("revokedByAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneReview_milestoneNodeId_idempotencyKey_key" ON "MilestoneReview"("milestoneNodeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ReviewEvidence_reviewId_sortOrder_idx" ON "ReviewEvidence"("reviewId", "sortOrder");

-- CreateIndex
CREATE INDEX "ReviewEvidence_fileAssetId_idx" ON "ReviewEvidence"("fileAssetId");

-- CreateIndex
CREATE INDEX "WorkSegment_personId_type_startAt_endAt_idx" ON "WorkSegment"("personId", "type", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "WorkSegment_taskId_startAt_idx" ON "WorkSegment"("taskId", "startAt");

-- CreateIndex
CREATE INDEX "WorkSegment_nodeId_type_idx" ON "WorkSegment"("nodeId", "type");

-- CreateIndex
CREATE INDEX "WorkSegment_associationNeedsReview_personId_idx" ON "WorkSegment"("associationNeedsReview", "personId");

-- CreateIndex
CREATE INDEX "WorkSegment_createdByAccountId_idx" ON "WorkSegment"("createdByAccountId");

-- CreateIndex
CREATE INDEX "WorkSegment_updatedByAccountId_idx" ON "WorkSegment"("updatedByAccountId");

-- CreateIndex
CREATE INDEX "WorkSegment_sourceSplitFromId_idx" ON "WorkSegment"("sourceSplitFromId");

-- CreateIndex
CREATE INDEX "WorkSegment_deletedAt_idx" ON "WorkSegment"("deletedAt");

-- CreateIndex
CREATE INDEX "SegmentTag_tagId_idx" ON "SegmentTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "SegmentTag_segmentId_tagId_key" ON "SegmentTag"("segmentId", "tagId");

-- CreateIndex
CREATE INDEX "WorkSegmentSource_actualSegmentId_idx" ON "WorkSegmentSource"("actualSegmentId");

-- CreateIndex
CREATE INDEX "WorkSegmentSource_createdByAccountId_idx" ON "WorkSegmentSource"("createdByAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSegmentSource_plannedSegmentId_actualSegmentId_coveredS_key" ON "WorkSegmentSource"("plannedSegmentId", "actualSegmentId", "coveredStartAt", "coveredEndAt");

-- CreateIndex
CREATE INDEX "WorkSegmentChange_segmentId_createdAt_idx" ON "WorkSegmentChange"("segmentId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkSegmentChange_actorAccountId_idx" ON "WorkSegmentChange"("actorAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceConflict_fingerprint_key" ON "ResourceConflict"("fingerprint");

-- CreateIndex
CREATE INDEX "ResourceConflict_personId_status_startAt_endAt_idx" ON "ResourceConflict"("personId", "status", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "ResourceConflict_status_severity_idx" ON "ResourceConflict"("status", "severity");

-- CreateIndex
CREATE INDEX "ResourceConflict_resolvedByAccountId_idx" ON "ResourceConflict"("resolvedByAccountId");

-- CreateIndex
CREATE INDEX "ConflictSegment_segmentId_idx" ON "ConflictSegment"("segmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ConflictSegment_conflictId_segmentId_key" ON "ConflictSegment"("conflictId", "segmentId");

-- CreateIndex
CREATE INDEX "SystemRoleAssignment_accountId_role_idx" ON "SystemRoleAssignment"("accountId", "role");

-- CreateIndex
CREATE INDEX "SystemRoleAssignment_role_team_techGroup_idx" ON "SystemRoleAssignment"("role", "team", "techGroup");

-- CreateIndex
CREATE INDEX "SystemRoleAssignment_grantedByAccountId_idx" ON "SystemRoleAssignment"("grantedByAccountId");

-- CreateIndex
CREATE INDEX "SystemRoleAssignment_revokedAt_idx" ON "SystemRoleAssignment"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_accountId_category_channel_key" ON "NotificationPreference"("accountId", "category", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "InAppNotification_eventKey_key" ON "InAppNotification"("eventKey");

-- CreateIndex
CREATE INDEX "InAppNotification_recipientAccountId_readAt_createdAt_idx" ON "InAppNotification"("recipientAccountId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "InAppNotification_category_createdAt_idx" ON "InAppNotification"("category", "createdAt");

-- CreateIndex
CREATE INDEX "InAppNotification_taskId_idx" ON "InAppNotification"("taskId");

-- CreateIndex
CREATE INDEX "DomainAuditEvent_entityType_entityId_createdAt_idx" ON "DomainAuditEvent"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "DomainAuditEvent_taskId_createdAt_idx" ON "DomainAuditEvent"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "DomainAuditEvent_actorAccountId_createdAt_idx" ON "DomainAuditEvent"("actorAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "DomainAuditEvent_actorPersonId_createdAt_idx" ON "DomainAuditEvent"("actorPersonId", "createdAt");

-- CreateIndex
CREATE INDEX "DomainAuditEvent_source_createdAt_idx" ON "DomainAuditEvent"("source", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountIdentity" ADD CONSTRAINT "AccountIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_currentPlanVersionId_fkey" FOREIGN KEY ("currentPlanVersionId") REFERENCES "TaskPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_activeMilestoneNodeId_fkey" FOREIGN KEY ("activeMilestoneNodeId") REFERENCES "TaskNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_relatedTaskId_fkey" FOREIGN KEY ("relatedTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTag" ADD CONSTRAINT "TaskTag_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTag" ADD CONSTRAINT "TaskTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMember" ADD CONSTRAINT "TaskMember_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMember" ADD CONSTRAINT "TaskMember_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMember" ADD CONSTRAINT "TaskMember_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPlanVersion" ADD CONSTRAINT "TaskPlanVersion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPlanVersion" ADD CONSTRAINT "TaskPlanVersion_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "TaskPlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPlanVersion" ADD CONSTRAINT "TaskPlanVersion_revisionNodeId_fkey" FOREIGN KEY ("revisionNodeId") REFERENCES "RevisionNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPlanVersion" ADD CONSTRAINT "TaskPlanVersion_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskNode" ADD CONSTRAINT "TaskNode_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskNode" ADD CONSTRAINT "TaskNode_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVersionNode" ADD CONSTRAINT "PlanVersionNode_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "TaskPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVersionNode" ADD CONSTRAINT "PlanVersionNode_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TaskNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneNode" ADD CONSTRAINT "MilestoneNode_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TaskNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionNode" ADD CONSTRAINT "RevisionNode_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TaskNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionNode" ADD CONSTRAINT "RevisionNode_revisedFromNodeId_fkey" FOREIGN KEY ("revisedFromNodeId") REFERENCES "TaskNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionNode" ADD CONSTRAINT "RevisionNode_basePlanVersionId_fkey" FOREIGN KEY ("basePlanVersionId") REFERENCES "TaskPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionNode" ADD CONSTRAINT "RevisionNode_reviewedByAccountId_fkey" FOREIGN KEY ("reviewedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminationNode" ADD CONSTRAINT "TerminationNode_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TaskNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminationNode" ADD CONSTRAINT "TerminationNode_confirmedByAccountId_fkey" FOREIGN KEY ("confirmedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneReview" ADD CONSTRAINT "MilestoneReview_milestoneNodeId_fkey" FOREIGN KEY ("milestoneNodeId") REFERENCES "MilestoneNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneReview" ADD CONSTRAINT "MilestoneReview_submittedByAccountId_fkey" FOREIGN KEY ("submittedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneReview" ADD CONSTRAINT "MilestoneReview_reviewerAccountId_fkey" FOREIGN KEY ("reviewerAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneReview" ADD CONSTRAINT "MilestoneReview_revokedByAccountId_fkey" FOREIGN KEY ("revokedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewEvidence" ADD CONSTRAINT "ReviewEvidence_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "MilestoneReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewEvidence" ADD CONSTRAINT "ReviewEvidence_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TaskNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_updatedByAccountId_fkey" FOREIGN KEY ("updatedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_sourceSplitFromId_fkey" FOREIGN KEY ("sourceSplitFromId") REFERENCES "WorkSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentTag" ADD CONSTRAINT "SegmentTag_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "WorkSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentTag" ADD CONSTRAINT "SegmentTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegmentSource" ADD CONSTRAINT "WorkSegmentSource_plannedSegmentId_fkey" FOREIGN KEY ("plannedSegmentId") REFERENCES "WorkSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegmentSource" ADD CONSTRAINT "WorkSegmentSource_actualSegmentId_fkey" FOREIGN KEY ("actualSegmentId") REFERENCES "WorkSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegmentSource" ADD CONSTRAINT "WorkSegmentSource_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegmentChange" ADD CONSTRAINT "WorkSegmentChange_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "WorkSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegmentChange" ADD CONSTRAINT "WorkSegmentChange_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceConflict" ADD CONSTRAINT "ResourceConflict_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceConflict" ADD CONSTRAINT "ResourceConflict_resolvedByAccountId_fkey" FOREIGN KEY ("resolvedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConflictSegment" ADD CONSTRAINT "ConflictSegment_conflictId_fkey" FOREIGN KEY ("conflictId") REFERENCES "ResourceConflict"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConflictSegment" ADD CONSTRAINT "ConflictSegment_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "WorkSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemRoleAssignment" ADD CONSTRAINT "SystemRoleAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemRoleAssignment" ADD CONSTRAINT "SystemRoleAssignment_grantedByAccountId_fkey" FOREIGN KEY ("grantedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InAppNotification" ADD CONSTRAINT "InAppNotification_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InAppNotification" ADD CONSTRAINT "InAppNotification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainAuditEvent" ADD CONSTRAINT "DomainAuditEvent_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainAuditEvent" ADD CONSTRAINT "DomainAuditEvent_actorPersonId_fkey" FOREIGN KEY ("actorPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainAuditEvent" ADD CONSTRAINT "DomainAuditEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Project management P1 invariants that Prisma cannot express.
ALTER TABLE "Task"
  ALTER CONSTRAINT "Task_currentPlanVersionId_fkey" DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "TaskPlanVersion"
  ALTER CONSTRAINT "TaskPlanVersion_taskId_fkey" DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX "TaskPlanVersion_one_current_per_task_idx"
  ON "TaskPlanVersion"("taskId")
  WHERE "status" = 'CURRENT';

CREATE UNIQUE INDEX "Tag_active_name_key"
  ON "Tag"("name")
  WHERE "archivedAt" IS NULL;

CREATE UNIQUE INDEX "TaskMember_active_task_person_role_key"
  ON "TaskMember"("taskId", "personId", "role")
  WHERE "removedAt" IS NULL;

CREATE UNIQUE INDEX "SystemRoleAssignment_active_account_role_scope_key"
  ON "SystemRoleAssignment"("accountId", "role", "team", "techGroup")
  WHERE "revokedAt" IS NULL;

ALTER TABLE "AccountIdentity"
  ADD CONSTRAINT "AccountIdentity_providerSubject_not_blank_check"
    CHECK (length(btrim("providerSubject")) > 0),
  ADD CONSTRAINT "AccountIdentity_open_or_union_check"
    CHECK ("openId" IS NOT NULL OR "unionId" IS NOT NULL);

ALTER TABLE "Tag"
  ADD CONSTRAINT "Tag_name_not_blank_check"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_title_not_blank_check"
    CHECK (length(btrim("title")) > 0),
  ADD CONSTRAINT "Task_lockVersion_non_negative_check"
    CHECK ("lockVersion" >= 0);

ALTER TABLE "PlanVersionNode"
  ADD CONSTRAINT "PlanVersionNode_sequence_positive_check"
    CHECK ("sequence" > 0);

ALTER TABLE "MilestoneNode"
  ADD CONSTRAINT "MilestoneNode_goal_not_blank_check"
    CHECK (length(btrim("goal")) > 0),
  ADD CONSTRAINT "MilestoneNode_criteria_not_blank_check"
    CHECK (length(btrim("completionCriteria")) > 0),
  ADD CONSTRAINT "MilestoneNode_review_requirements_not_blank_check"
    CHECK (length(btrim("reviewRequirements")) > 0);

ALTER TABLE "MilestoneReview"
  ADD CONSTRAINT "MilestoneReview_idempotency_not_blank_check"
    CHECK (length(btrim("idempotencyKey")) > 0),
  ADD CONSTRAINT "MilestoneReview_rejection_comment_required_check"
    CHECK (
      "result" NOT IN ('REJECTED', 'REVISION_REQUIRED')
      OR length(btrim("comment")) > 0
    );

ALTER TABLE "ReviewEvidence"
  ADD CONSTRAINT "ReviewEvidence_file_shape_check"
    CHECK ("kind" <> 'FILE' OR "fileAssetId" IS NOT NULL),
  ADD CONSTRAINT "ReviewEvidence_link_shape_check"
    CHECK ("kind" <> 'LINK' OR length(btrim(coalesce("externalUrl", ''))) > 0),
  ADD CONSTRAINT "ReviewEvidence_text_shape_check"
    CHECK ("kind" <> 'TEXT' OR length(btrim("note")) > 0);

ALTER TABLE "WorkSegment"
  ADD CONSTRAINT "WorkSegment_time_order_check"
    CHECK ("endAt" > "startAt"),
  ADD CONSTRAINT "WorkSegment_allocation_range_check"
    CHECK ("allocation" IS NULL OR ("allocation" > 0 AND "allocation" <= 100)),
  ADD CONSTRAINT "WorkSegment_completion_range_check"
    CHECK ("completionPercent" IS NULL OR ("completionPercent" >= 0 AND "completionPercent" <= 100)),
  ADD CONSTRAINT "WorkSegment_content_not_blank_check"
    CHECK (length(btrim("content")) > 0),
  ADD CONSTRAINT "WorkSegment_custom_role_check"
    CHECK ("role" <> 'CUSTOM' OR length(btrim(coalesce("customRole", ''))) > 0),
  ADD CONSTRAINT "WorkSegment_node_requires_task_check"
    CHECK ("nodeId" IS NULL OR "taskId" IS NOT NULL),
  ADD CONSTRAINT "WorkSegment_type_status_check"
    CHECK (
      ("type" = 'PLANNED' AND "status" IN ('PLANNED', 'IN_PROGRESS', 'PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED'))
      OR ("type" = 'ACTUAL' AND "status" IN ('CONFIRMED', 'CANCELLED'))
    );

ALTER TABLE "WorkSegmentSource"
  ADD CONSTRAINT "WorkSegmentSource_covered_time_order_check"
    CHECK ("coveredEndAt" > "coveredStartAt");

ALTER TABLE "ResourceConflict"
  ADD CONSTRAINT "ResourceConflict_time_order_check"
    CHECK ("endAt" > "startAt"),
  ADD CONSTRAINT "ResourceConflict_fingerprint_not_blank_check"
    CHECK (length(btrim("fingerprint")) > 0);

ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_account_category_channel_check"
    CHECK ("accountId" <> '');

ALTER TABLE "InAppNotification"
  ADD CONSTRAINT "InAppNotification_title_not_blank_check"
    CHECK (length(btrim("title")) > 0),
  ADD CONSTRAINT "InAppNotification_entity_not_blank_check"
    CHECK (length(btrim("entityType")) > 0 AND length(btrim("entityId")) > 0),
  ADD CONSTRAINT "InAppNotification_payloadVersion_positive_check"
    CHECK ("payloadVersion" > 0);

ALTER TABLE "DomainAuditEvent"
  ADD CONSTRAINT "DomainAuditEvent_action_not_blank_check"
    CHECK (length(btrim("action")) > 0),
  ADD CONSTRAINT "DomainAuditEvent_entity_not_blank_check"
    CHECK (length(btrim("entityType")) > 0 AND length(btrim("entityId")) > 0),
  ADD CONSTRAINT "DomainAuditEvent_schemaVersion_positive_check"
    CHECK ("schemaVersion" > 0);
