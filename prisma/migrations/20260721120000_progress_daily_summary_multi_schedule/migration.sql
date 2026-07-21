-- CreateTable
CREATE TABLE "ProgressDailySummarySchedule" (
    "id" TEXT NOT NULL,
    "settingId" TEXT NOT NULL,
    "scheduleTime" TEXT NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastProcessedSlotAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressDailySummarySchedule_pkey" PRIMARY KEY ("id")
);

-- Preserve every deployment's existing daily-card time and run history.
INSERT INTO "ProgressDailySummarySchedule" (
    "id",
    "settingId",
    "scheduleTime",
    "activeFrom",
    "lastProcessedSlotAt",
    "lastRunAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "id" || ':' || "scheduleTime",
    "id",
    "scheduleTime",
    "createdAt",
    "lastRunAt",
    "lastRunAt",
    "createdAt",
    "updatedAt"
FROM "ProgressDailySummarySetting";

-- CreateIndex
CREATE UNIQUE INDEX "ProgressDailySummarySchedule_settingId_scheduleTime_key"
ON "ProgressDailySummarySchedule"("settingId", "scheduleTime");

-- CreateIndex
CREATE INDEX "ProgressDailySummarySchedule_settingId_idx"
ON "ProgressDailySummarySchedule"("settingId");

-- AddForeignKey
ALTER TABLE "ProgressDailySummarySchedule"
ADD CONSTRAINT "ProgressDailySummarySchedule_settingId_fkey"
FOREIGN KEY ("settingId") REFERENCES "ProgressDailySummarySetting"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- The values now live on individual schedule rows.
ALTER TABLE "ProgressDailySummarySetting"
DROP COLUMN "scheduleTime",
DROP COLUMN "lastRunAt";
