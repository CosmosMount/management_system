DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RevisionNode" LIMIT 1) THEN
    RAISE EXCEPTION 'Revision time marker refactor requires an empty RevisionNode table';
  END IF;
END;
$$;

ALTER TABLE "RevisionNode"
  DROP CONSTRAINT "RevisionNode_revisedFromNodeId_fkey";

ALTER TABLE "RevisionNode"
  ADD COLUMN "revisionAt" TIMESTAMPTZ(6) NOT NULL,
  ADD COLUMN "reviewRound" INTEGER NOT NULL DEFAULT 1,
  DROP COLUMN "revisedFromNodeId",
  DROP COLUMN "submittedAt";

ALTER TABLE "RevisionNode"
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "RevisionStatus" RENAME TO "RevisionStatus_old";

CREATE TYPE "RevisionStatus" AS ENUM (
  'PENDING_APPROVAL',
  'EFFECTIVE',
  'REJECTED',
  'CANCELLED'
);

ALTER TABLE "RevisionNode"
  ALTER COLUMN "status" TYPE "RevisionStatus"
  USING ("status"::text::"RevisionStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';

DROP TYPE "RevisionStatus_old";

ALTER TABLE "RevisionNode"
  ADD CONSTRAINT "RevisionNode_reviewRound_positive_check"
    CHECK ("reviewRound" > 0);

CREATE INDEX "RevisionNode_revisionAt_idx"
  ON "RevisionNode"("revisionAt");

CREATE UNIQUE INDEX "TaskPlanVersion_one_revision_candidate_per_task_idx"
  ON "TaskPlanVersion"("taskId")
  WHERE "status" = 'DRAFT' AND "revisionNodeId" IS NOT NULL;
