-- CreateTable
CREATE TABLE "ProjectStageOwner" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectStageOwner_pkey" PRIMARY KEY ("id")
);

-- Backfill the existing primary owner for every configured stage.
INSERT INTO "ProjectStageOwner" ("id", "stageId", "openId", "name", "sortOrder")
SELECT "id", "id", "ownerOpenId", "ownerName", 0
FROM "ProjectStage"
WHERE "ownerOpenId" <> '';

-- CreateIndex
CREATE UNIQUE INDEX "ProjectStageOwner_stageId_openId_key" ON "ProjectStageOwner"("stageId", "openId");
CREATE INDEX "ProjectStageOwner_openId_idx" ON "ProjectStageOwner"("openId");
CREATE INDEX "ProjectStageOwner_stageId_sortOrder_idx" ON "ProjectStageOwner"("stageId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ProjectStageOwner" ADD CONSTRAINT "ProjectStageOwner_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ProjectStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
