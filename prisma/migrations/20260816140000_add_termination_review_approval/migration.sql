-- Terminal completion now follows the same submit/review workflow as a
-- Milestone. Existing completed TerminationNode rows remain unchanged; the
-- new table records only requests submitted after this migration.

CREATE TYPE "TerminationReviewResult" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REVISION_REQUIRED'
);

CREATE TABLE "TerminationReview" (
  "id" TEXT NOT NULL,
  "terminationNodeId" TEXT NOT NULL,
  "outcome" "TerminationOutcome" NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "summary" TEXT NOT NULL DEFAULT '',
  "result" "TerminationReviewResult" NOT NULL DEFAULT 'PENDING',
  "submittedByAccountId" TEXT,
  "reviewerAccountId" TEXT,
  "reviewedAt" TIMESTAMPTZ(6),
  "comment" TEXT NOT NULL DEFAULT '',
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TerminationReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TerminationReview_idempotency_not_blank_check"
    CHECK (length(btrim("idempotencyKey")) > 0),
  CONSTRAINT "TerminationReview_non_success_reason_required_check"
    CHECK ("outcome" = 'SUCCESS' OR length(btrim("reason")) > 0),
  CONSTRAINT "TerminationReview_rejection_comment_required_check"
    CHECK (
      "result" NOT IN ('REJECTED', 'REVISION_REQUIRED')
      OR length(btrim("comment")) > 0
    ),
  CONSTRAINT "TerminationReview_review_state_check"
    CHECK (
      (
        "result" = 'PENDING'
        AND "reviewerAccountId" IS NULL
        AND "reviewedAt" IS NULL
      )
      OR (
        "result" <> 'PENDING'
        AND "reviewedAt" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "TerminationReview_terminationNodeId_idempotencyKey_key"
  ON "TerminationReview"("terminationNodeId", "idempotencyKey");
CREATE INDEX "TerminationReview_terminationNodeId_createdAt_idx"
  ON "TerminationReview"("terminationNodeId", "createdAt");
CREATE INDEX "TerminationReview_submittedByAccountId_idx"
  ON "TerminationReview"("submittedByAccountId");
CREATE INDEX "TerminationReview_reviewerAccountId_idx"
  ON "TerminationReview"("reviewerAccountId");
CREATE INDEX "TerminationReview_result_idx"
  ON "TerminationReview"("result");
CREATE UNIQUE INDEX "TerminationReview_pending_terminationNode_key"
  ON "TerminationReview"("terminationNodeId")
  WHERE "result" = 'PENDING';

ALTER TABLE "TerminationReview"
  ADD CONSTRAINT "TerminationReview_terminationNodeId_fkey"
  FOREIGN KEY ("terminationNodeId") REFERENCES "TerminationNode"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TerminationReview"
  ADD CONSTRAINT "TerminationReview_submittedByAccountId_fkey"
  FOREIGN KEY ("submittedByAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TerminationReview"
  ADD CONSTRAINT "TerminationReview_reviewerAccountId_fkey"
  FOREIGN KEY ("reviewerAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
