-- Add lifecycle idempotency and revision baseline fields for P2/P3 services.
ALTER TABLE "TaskPlanVersion"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "creationRequestHash" TEXT NOT NULL DEFAULT '';

ALTER TABLE "RevisionNode"
  ADD COLUMN "baseTaskLockVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "TaskPlanVersion_createdByAccountId_idempotencyKey_idx"
  ON "TaskPlanVersion"("createdByAccountId", "idempotencyKey");

CREATE UNIQUE INDEX "TaskPlanVersion_createdByAccountId_idempotencyKey_key"
  ON "TaskPlanVersion"("createdByAccountId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

ALTER TABLE "TaskPlanVersion"
  ADD CONSTRAINT "TaskPlanVersion_idempotency_not_blank_check"
    CHECK ("idempotencyKey" IS NULL OR length(btrim("idempotencyKey")) > 0);

ALTER TABLE "RevisionNode"
  ADD CONSTRAINT "RevisionNode_baseTaskLockVersion_non_negative_check"
    CHECK ("baseTaskLockVersion" >= 0);
