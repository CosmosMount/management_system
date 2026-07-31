CREATE TABLE "ProjectManagementScanCheckpoint" (
  "key" TEXT NOT NULL,
  "cursor" JSONB NOT NULL DEFAULT '{}',
  "lastStartedAt" TIMESTAMPTZ(6),
  "lastCompletedAt" TIMESTAMPTZ(6),
  "lastFullScanAt" TIMESTAMPTZ(6),
  "lastError" TEXT NOT NULL DEFAULT '',
  "lockVersion" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectManagementScanCheckpoint_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "ProjectManagementScanCheckpoint_lockVersion_non_negative_check"
    CHECK ("lockVersion" >= 0)
);

CREATE INDEX "ProjectManagementScanCheckpoint_lastCompletedAt_idx"
  ON "ProjectManagementScanCheckpoint"("lastCompletedAt");

CREATE INDEX "ProjectManagementScanCheckpoint_lastFullScanAt_idx"
  ON "ProjectManagementScanCheckpoint"("lastFullScanAt");

-- Query-path indexes validated by the S9 10k Task / 100k Segment / 100k notification fixture.
CREATE INDEX "Task_updatedAt_id_idx" ON "Task"("updatedAt", "id");
CREATE INDEX "WorkSegment_updatedAt_id_idx" ON "WorkSegment"("updatedAt", "id");
CREATE INDEX "InAppNotification_readAt_createdAt_idx"
  ON "InAppNotification"("readAt", "createdAt");
CREATE INDEX "NotificationOutbox_channel_status_updatedAt_idx"
  ON "NotificationOutbox"("channel", "status", "updatedAt");
