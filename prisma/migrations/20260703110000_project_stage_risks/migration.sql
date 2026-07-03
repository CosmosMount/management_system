ALTER TABLE "ProjectStage"
ADD COLUMN "riskNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN "riskUpdatedAt" TIMESTAMP(3);

CREATE TABLE "ProjectStageRiskRecord" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" "TaskRiskSource" NOT NULL DEFAULT 'MANUAL',
    "status" "TaskRiskStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByOpenId" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "resolvedByOpenId" TEXT NOT NULL DEFAULT '',
    "resolvedByName" TEXT NOT NULL DEFAULT '',
    "resolveNote" TEXT NOT NULL DEFAULT '',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectStageRiskRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectStageRiskRecord_stageId_status_idx"
ON "ProjectStageRiskRecord"("stageId", "status");

CREATE INDEX "ProjectStageRiskRecord_createdByOpenId_idx"
ON "ProjectStageRiskRecord"("createdByOpenId");

ALTER TABLE "ProjectStageRiskRecord"
ADD CONSTRAINT "ProjectStageRiskRecord_stageId_fkey"
FOREIGN KEY ("stageId") REFERENCES "ProjectStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
