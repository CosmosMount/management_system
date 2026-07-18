ALTER TYPE "ProjectStatus" ADD VALUE 'ESTABLISHMENT_WITHDRAWN' AFTER 'ESTABLISHING';
ALTER TYPE "TaskDeletionRequestStatus" ADD VALUE 'WITHDRAWN';
ALTER TYPE "TaskCreationRequestStatus" ADD VALUE 'WITHDRAWN';
ALTER TYPE "ProjectDdlChangeRequestStatus" ADD VALUE 'WITHDRAWN';
ALTER TYPE "TaskDdlChangeRequestStatus" ADD VALUE 'WITHDRAWN';

ALTER TABLE "Project"
  ADD COLUMN "establishmentWithdrawnAt" TIMESTAMP(3),
  ADD COLUMN "establishmentWithdrawnByOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "establishmentWithdrawnByName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ProjectDdlChangeRequest"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnByOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "withdrawnByName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "TaskDeletionRequest"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnByOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "withdrawnByName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "TaskDdlChangeRequest"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnByOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "withdrawnByName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "TaskCreationRequest"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnByOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "withdrawnByName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "TaskSubmission"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawnByOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "withdrawnByName" TEXT NOT NULL DEFAULT '';
