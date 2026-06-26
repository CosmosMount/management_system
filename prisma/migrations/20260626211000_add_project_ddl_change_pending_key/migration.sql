-- AlterTable
ALTER TABLE "ProjectDdlChangeRequest" ADD COLUMN "pendingKey" TEXT NOT NULL DEFAULT '';

-- Backfill existing rows before adding the stage-level pending uniqueness guard.
UPDATE "ProjectDdlChangeRequest"
SET "pendingKey" = "status"::text || ':' || "id";

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDdlChangeRequest_stageId_pendingKey_key" ON "ProjectDdlChangeRequest"("stageId", "pendingKey");
