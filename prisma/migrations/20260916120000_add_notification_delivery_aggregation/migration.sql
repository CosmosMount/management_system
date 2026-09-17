CREATE TYPE "NotificationDeliveryMode" AS ENUM ('DIRECT', 'AGGREGATED');

ALTER TABLE "NotificationOutbox"
ADD COLUMN "deliveryMode" "NotificationDeliveryMode" NOT NULL DEFAULT 'DIRECT';

CREATE TABLE "NotificationDeliveryBatch" (
    "id" TEXT NOT NULL,
    "openKey" TEXT,
    "channel" TEXT NOT NULL,
    "botKind" TEXT NOT NULL DEFAULT 'notification',
    "category" TEXT NOT NULL,
    "recipientOpenId" TEXT NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDeliveryBatch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "NotificationOutboxRecipient"
ADD COLUMN "deliveryBatchId" TEXT;

CREATE UNIQUE INDEX "NotificationDeliveryBatch_openKey_key"
ON "NotificationDeliveryBatch"("openKey");

CREATE INDEX "NotificationDeliveryBatch_status_nextRunAt_idx"
ON "NotificationDeliveryBatch"("status", "nextRunAt");

CREATE INDEX "NotificationDeliveryBatch_channel_status_updatedAt_idx"
ON "NotificationDeliveryBatch"("channel", "status", "updatedAt");

CREATE INDEX "NotificationOutboxRecipient_deliveryBatchId_status_idx"
ON "NotificationOutboxRecipient"("deliveryBatchId", "status");

ALTER TABLE "NotificationOutboxRecipient"
ADD CONSTRAINT "NotificationOutboxRecipient_deliveryBatchId_fkey"
FOREIGN KEY ("deliveryBatchId") REFERENCES "NotificationDeliveryBatch"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
