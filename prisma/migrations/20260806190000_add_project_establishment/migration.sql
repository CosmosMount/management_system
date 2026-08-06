BEGIN;

ALTER TYPE "FileAssetKind" ADD VALUE IF NOT EXISTS 'PROJECT_AVATAR';
ALTER TYPE "ProjectManagementNotificationCategory" ADD VALUE IF NOT EXISTS 'PROJECT';

CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'COMPLETED');
CREATE TYPE "ProjectMemberRole" AS ENUM ('OWNER', 'PARTICIPANT');
CREATE TYPE "ProjectEstablishmentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "description" VARCHAR(8000) NOT NULL,
  "avatarPath" TEXT,
  "status" "ProjectStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "requesterAccountId" TEXT NOT NULL,
  "establishmentRound" INTEGER NOT NULL DEFAULT 1,
  "lockVersion" INTEGER NOT NULL DEFAULT 0,
  "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "reviewedAt" TIMESTAMPTZ(6),
  "reviewedByAccountId" TEXT,
  "reviewComment" VARCHAR(2000) NOT NULL DEFAULT '',
  "deletedAt" TIMESTAMPTZ(6),
  "deletedByAccountId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Project_establishment_round_check" CHECK ("establishmentRound" >= 1),
  CONSTRAINT "Project_lock_version_check" CHECK ("lockVersion" >= 0)
);

CREATE TABLE "ProjectMember" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "role" "ProjectMemberRole" NOT NULL,
  "createdByAccountId" TEXT NOT NULL,
  "removedByAccountId" TEXT,
  "removedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectEstablishmentRequest" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "round" INTEGER NOT NULL,
  "status" "ProjectEstablishmentRequestStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "submittedByAccountId" TEXT NOT NULL,
  "reviewerAccountId" TEXT,
  "reviewComment" VARCHAR(2000) NOT NULL DEFAULT '',
  "snapshot" JSONB NOT NULL,
  "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMPTZ(6),
  CONSTRAINT "ProjectEstablishmentRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectEstablishmentRequest_round_check" CHECK ("round" >= 1)
);

CREATE TABLE "ProjectEstablishmentRequestedTask" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "lockVersion" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectEstablishmentRequestedTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectEstablishmentRequestedTask_lock_version_check" CHECK ("lockVersion" >= 0)
);

ALTER TABLE "Task" ADD COLUMN "projectId" TEXT;
ALTER TABLE "FileAsset" ADD COLUMN "projectId" TEXT;
ALTER TABLE "InAppNotification" ADD COLUMN "projectId" TEXT;
ALTER TABLE "DomainAuditEvent" ADD COLUMN "projectId" TEXT;

CREATE INDEX "Project_status_updatedAt_id_idx" ON "Project"("status", "updatedAt", "id");
CREATE INDEX "Project_requesterAccountId_idx" ON "Project"("requesterAccountId");
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");
CREATE INDEX "ProjectMember_projectId_role_idx" ON "ProjectMember"("projectId", "role");
CREATE INDEX "ProjectMember_personId_role_idx" ON "ProjectMember"("personId", "role");
CREATE INDEX "ProjectMember_removedAt_idx" ON "ProjectMember"("removedAt");
CREATE UNIQUE INDEX "ProjectMember_active_project_person_key" ON "ProjectMember"("projectId", "personId") WHERE "removedAt" IS NULL;
CREATE UNIQUE INDEX "ProjectEstablishmentRequest_projectId_round_key" ON "ProjectEstablishmentRequest"("projectId", "round");
CREATE UNIQUE INDEX "ProjectEstablishmentRequest_submittedByAccountId_idempotencyKey_key" ON "ProjectEstablishmentRequest"("submittedByAccountId", "idempotencyKey");
CREATE INDEX "ProjectEstablishmentRequest_status_submittedAt_idx" ON "ProjectEstablishmentRequest"("status", "submittedAt");
CREATE UNIQUE INDEX "ProjectEstablishmentRequest_pending_project_key" ON "ProjectEstablishmentRequest"("projectId") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "ProjectEstablishmentRequestedTask_requestId_taskId_key" ON "ProjectEstablishmentRequestedTask"("requestId", "taskId");
CREATE INDEX "ProjectEstablishmentRequestedTask_taskId_idx" ON "ProjectEstablishmentRequestedTask"("taskId");
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");
CREATE UNIQUE INDEX "FileAsset_projectId_key" ON "FileAsset"("projectId");
CREATE INDEX "FileAsset_projectId_idx" ON "FileAsset"("projectId");
CREATE INDEX "InAppNotification_projectId_idx" ON "InAppNotification"("projectId");
CREATE INDEX "DomainAuditEvent_projectId_createdAt_idx" ON "DomainAuditEvent"("projectId", "createdAt");

ALTER TABLE "Project" ADD CONSTRAINT "Project_requesterAccountId_fkey" FOREIGN KEY ("requesterAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_reviewedByAccountId_fkey" FOREIGN KEY ("reviewedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_deletedByAccountId_fkey" FOREIGN KEY ("deletedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_removedByAccountId_fkey" FOREIGN KEY ("removedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectEstablishmentRequest" ADD CONSTRAINT "ProjectEstablishmentRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectEstablishmentRequest" ADD CONSTRAINT "ProjectEstablishmentRequest_submittedByAccountId_fkey" FOREIGN KEY ("submittedByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectEstablishmentRequest" ADD CONSTRAINT "ProjectEstablishmentRequest_reviewerAccountId_fkey" FOREIGN KEY ("reviewerAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectEstablishmentRequestedTask" ADD CONSTRAINT "ProjectEstablishmentRequestedTask_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProjectEstablishmentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectEstablishmentRequestedTask" ADD CONSTRAINT "ProjectEstablishmentRequestedTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InAppNotification" ADD CONSTRAINT "InAppNotification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DomainAuditEvent" ADD CONSTRAINT "DomainAuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
