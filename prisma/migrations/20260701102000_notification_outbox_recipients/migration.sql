ALTER TABLE "Project"
  ADD COLUMN "establishmentSubmitVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "NotificationOutboxRecipient" (
  "id" TEXT NOT NULL,
  "outboxId" TEXT NOT NULL,
  "openId" TEXT NOT NULL,
  "receiveId" TEXT NOT NULL DEFAULT '',
  "receiveIdType" TEXT NOT NULL DEFAULT '',
  "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT NOT NULL DEFAULT '',
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedUntil" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NotificationOutboxRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationOutboxRecipient_outboxId_openId_key"
  ON "NotificationOutboxRecipient"("outboxId", "openId");

CREATE INDEX "NotificationOutboxRecipient_outboxId_status_idx"
  ON "NotificationOutboxRecipient"("outboxId", "status");

CREATE INDEX "NotificationOutboxRecipient_status_nextRunAt_idx"
  ON "NotificationOutboxRecipient"("status", "nextRunAt");

ALTER TABLE "NotificationOutboxRecipient"
  ADD CONSTRAINT "NotificationOutboxRecipient_outboxId_fkey"
  FOREIGN KEY ("outboxId") REFERENCES "NotificationOutbox"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
