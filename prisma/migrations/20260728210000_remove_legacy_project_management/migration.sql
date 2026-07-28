BEGIN;

-- Remove queued legacy project-management notifications before their payload
-- contracts and recipient resolution rules disappear. Recipient rows are
-- deleted by NotificationOutboxRecipient_outboxId_fkey ON DELETE CASCADE.
DELETE FROM "NotificationOutbox"
WHERE "channel" = 'progress';

-- Remove the obsolete role before rebuilding UserRoleType without the value.
DELETE FROM "UserRole"
WHERE "role" = 'PROJECT_MANAGER';

-- Drop every legacy implementation in one statement so PostgreSQL can resolve
-- circular foreign keys inside the removal set. IF EXISTS also makes recovery
-- safe when a previous non-transactional deploy stopped after partial drops.
-- Pm* objects were created by an abandoned development-only implementation;
-- some development databases contain them even though those migrations are no
-- longer part of this repository's canonical migration chain.
DROP TABLE IF EXISTS
  "ApprovalChecklistConfirmation",
  "ApprovalRecord",
  "TaskSubmission",
  "TaskAcceptanceChecklistItem",
  "WeeklyReport",
  "TaskTechGroup",
  "TaskDeletionRequest",
  "TaskDdlChangeRequest",
  "TaskRiskRecord",
  "TaskAssignee",
  "TaskFollowPreference",
  "TaskCreationRequest",
  "ProjectCreationRequest",
  "ProgressActivityLog",
  "ProjectStageOwner",
  "ProjectStageRiskRecord",
  "ProjectDdlChangeRequest",
  "ProjectFollowPreference",
  "ProjectComment",
  "Task",
  "ProjectStage",
  "ProjectOwner",
  "ProjectParticipant",
  "ProjectTemplateStage",
  "ProjectTemplate",
  "Project",
  "AcceptanceChecklistTemplate",
  "ProgressReminderRule",
  "ProgressDailySummarySchedule",
  "ProgressDailySummarySetting",
  "ProgressApprovalReminderDelivery",
  "ProgressApprovalReminderSetting",
  "PmConflictSegment",
  "PmDomainAuditEvent",
  "PmInAppNotification",
  "PmMilestoneMember",
  "PmReviewEvidence",
  "PmMilestoneReview",
  "PmMilestoneNode",
  "PmNotificationPreference",
  "PmPlanVersionNode",
  "PmRevisionNode",
  "PmSegmentTag",
  "PmTaskTag",
  "PmTaskMember",
  "PmTerminationNode",
  "PmWorkSegmentChange",
  "PmWorkSegmentSource",
  "PmResourceConflict",
  "PmWorkSegment",
  "PmTaskNode",
  "PmTaskPlanVersion",
  "PmV2MigrationMap",
  "PmV2MigrationRun",
  "PmTask",
  "PmTag",
  "PmSystemRoleAssignment",
  "PmPerson",
  "PmAccountIdentity",
  "PmAccount";

-- PostgreSQL enum values cannot be removed in place. At this point UserRole is
-- the only remaining table that uses UserRoleType, so replace the type safely.
ALTER TYPE "UserRoleType" RENAME TO "UserRoleType_old";
CREATE TYPE "UserRoleType" AS ENUM (
  'SUPER_ADMIN',
  'TEAM_ADMIN',
  'TECH_GROUP_ADMIN',
  'TEACHER',
  'FINANCE'
);
ALTER TABLE "UserRole"
  ALTER COLUMN "role" TYPE "UserRoleType"
  USING ("role"::text::"UserRoleType");
DROP TYPE "UserRoleType_old";

DROP TYPE IF EXISTS
  "ProjectStatus",
  "TaskStatus",
  "TaskDeletionRequestStatus",
  "TaskCreationRequestStatus",
  "ProjectCreationRequestStatus",
  "ProjectDdlChangeRequestType",
  "ProjectDdlChangeRequestStatus",
  "TaskDdlChangeRequestStatus",
  "TaskRiskStatus",
  "TaskRiskSource",
  "Urgency",
  "Importance",
  "SubmissionType",
  "StageStatus",
  "ApprovalDecision",
  "ProgressReminderKind",
  "ProgressApprovalKind",
  "ProgressFollowPreferenceState",
  "PmAccountStatus",
  "PmAuditSource",
  "PmIdentityProvider",
  "PmLegacySourceType",
  "PmMilestoneMemberRole",
  "PmMilestoneReviewResult",
  "PmNotificationCategory",
  "PmPersonStatus",
  "PmPlanVersionStatus",
  "PmResourceConflictKind",
  "PmResourceConflictSeverity",
  "PmResourceConflictStatus",
  "PmReviewEvidenceKind",
  "PmReviewRevocationKind",
  "PmRevisionApprovalMode",
  "PmRevisionStatus",
  "PmSystemRole",
  "PmTaskMemberRole",
  "PmTaskNodeStatus",
  "PmTaskNodeType",
  "PmTaskPriority",
  "PmTaskStatus",
  "PmTerminationOutcome",
  "PmV2MigrationRunStatus",
  "PmWorkSegmentChangeAction",
  "PmWorkSegmentRole",
  "PmWorkSegmentStatus",
  "PmWorkSegmentType";

COMMIT;
