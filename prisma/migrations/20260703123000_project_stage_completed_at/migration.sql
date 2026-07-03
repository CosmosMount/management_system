ALTER TABLE "ProjectStage" ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "ProjectStage" AS stage
SET "completedAt" = COALESCE(approval."approvedAt", stage."updatedAt")
FROM (
  SELECT submission."stageId", MAX(approval."createdAt") AS "approvedAt"
  FROM "TaskSubmission" AS submission
  INNER JOIN "ApprovalRecord" AS approval
    ON approval."submissionId" = submission."id"
  WHERE submission."type" = 'STAGE'
    AND approval."decision" = 'APPROVED'
    AND submission."stageId" IS NOT NULL
  GROUP BY submission."stageId"
) AS approval
WHERE stage."id" = approval."stageId"
  AND stage."status" = 'COMPLETED';

UPDATE "ProjectStage"
SET "completedAt" = "updatedAt"
WHERE "status" = 'COMPLETED'
  AND "completedAt" IS NULL;
