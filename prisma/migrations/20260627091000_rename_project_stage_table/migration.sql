ALTER TABLE IF EXISTS "ProjectMilestone" RENAME TO "ProjectStage";

ALTER TABLE "ProjectStage" RENAME COLUMN "feishuDocUrl" TO "evidenceUrl";

ALTER TABLE "ProjectStage" RENAME COLUMN "submissionId" TO "currentSubmissionId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProjectMilestone_pkey'
  ) THEN
    ALTER TABLE "ProjectStage" RENAME CONSTRAINT "ProjectMilestone_pkey" TO "ProjectStage_pkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProjectMilestone_projectId_fkey'
  ) THEN
    ALTER TABLE "ProjectStage" RENAME CONSTRAINT "ProjectMilestone_projectId_fkey" TO "ProjectStage_projectId_fkey";
  END IF;
END $$;
