-- Add project establishment lifecycle states.
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'ESTABLISHING' BEFORE 'NOT_STARTED';
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'ESTABLISHMENT_REJECTED' AFTER 'ESTABLISHING';

-- Store establishment request/review information on the real project record.
ALTER TABLE "Project"
  ALTER COLUMN "status" SET DEFAULT 'ESTABLISHING',
  ADD COLUMN "requesterOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "requesterName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "reviewerOpenId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewerName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewComment" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

CREATE INDEX "Project_status_idx" ON "Project"("status");
CREATE INDEX "Project_requesterOpenId_idx" ON "Project"("requesterOpenId");
CREATE INDEX "Project_team_techGroup_status_idx" ON "Project"("team", "techGroup", "status");
