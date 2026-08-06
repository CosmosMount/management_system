ALTER TABLE "FileAsset"
ADD COLUMN "cleanupRequestedAt" TIMESTAMP(3),
ADD COLUMN "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cleanupLastError" TEXT NOT NULL DEFAULT '',
ADD COLUMN "cleanupNextRunAt" TIMESTAMP(3);

CREATE INDEX "FileAsset_cleanupRequestedAt_cleanupNextRunAt_idx"
ON "FileAsset"("cleanupRequestedAt", "cleanupNextRunAt");
