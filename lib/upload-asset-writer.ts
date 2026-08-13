import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileAssetKind } from "@prisma/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { storagePathToAbsolute } from "@/lib/upload-paths";
import { createRecoveryBackupPath } from "@/lib/upload-recovery-marker";

export type SaveAssetOptions = {
  kind: FileAssetKind;
  orderId?: string | null;
  feedbackId?: string | null;
  signatureOwnerOpenId?: string | null;
  ownerOpenId?: string | null;
};

export async function writeAssetFile({
  storagePath,
  publicPath,
  buffer,
  mimeType,
  options,
}: {
  storagePath: string;
  publicPath: string;
  buffer: Buffer;
  mimeType: string;
  options: SaveAssetOptions;
}) {
  const fullPath = storagePathToAbsolute(storagePath);
  const previousAssetVersion = await prisma.fileAsset.findUnique({
    where: { publicPath },
    select: { id: true, writeGeneration: true },
  });
  const writeGeneration = randomUUID();
  await mkdir(path.dirname(fullPath), { recursive: true });
  const tempPath = `${fullPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupPath = createRecoveryBackupPath(
    fullPath,
    previousAssetVersion,
    backupSuffix,
  );
  let backupCreated = false;
  try {
    await writeFile(tempPath, buffer);
    try {
      await rename(fullPath, backupPath);
      backupCreated = true;
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
    await rename(tempPath, fullPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    if (backupCreated) {
      await rename(backupPath, fullPath).catch((restoreError: unknown) => {
        logger.error("upload.asset.backup_restore.failed", {
          module: "upload",
          action: "writeAssetFile",
          storagePath,
          error: restoreError,
        });
      });
    }
    throw error;
  }
  try {
    await prisma.fileAsset.upsert({
      where: { publicPath },
      update: {
        storagePath,
        kind: options.kind,
        mimeType,
        size: buffer.length,
        orderId: options.orderId ?? null,
        feedbackId: options.feedbackId ?? null,
        signatureOwnerOpenId: options.signatureOwnerOpenId ?? null,
        ownerOpenId: options.ownerOpenId ?? null,
        writeGeneration,
        cleanupRequestedAt: null,
        cleanupAttempts: 0,
        cleanupLastError: "",
        cleanupNextRunAt: null,
      },
      create: {
        publicPath,
        storagePath,
        kind: options.kind,
        mimeType,
        size: buffer.length,
        orderId: options.orderId ?? null,
        feedbackId: options.feedbackId ?? null,
        signatureOwnerOpenId: options.signatureOwnerOpenId ?? null,
        ownerOpenId: options.ownerOpenId ?? null,
        writeGeneration,
      },
    });
    if (backupCreated) {
      await rm(backupPath, { force: true }).catch((cleanupError: unknown) => {
        logger.error("upload.asset.backup_cleanup.failed", {
          module: "upload",
          action: "writeAssetFile",
          storagePath,
          error: cleanupError,
        });
      });
    }
  } catch (error) {
    if (backupCreated) {
      await recoverFailedAssetOverwrite({ backupPath, fullPath, storagePath });
      throw error;
    }
    try {
      await rm(fullPath, { force: true });
    } catch (cleanupError) {
      logger.error("upload.asset.registration_cleanup.failed", {
        module: "upload",
        action: "writeAssetFile",
        storagePath,
        error: cleanupError,
      });
      const scheduled = await persistFailedRegistrationCleanup({
        publicPath,
        storagePath,
        mimeType,
        size: buffer.length,
        options,
        error: cleanupError,
      });
      if (!scheduled) {
        const recoveryPath = `${fullPath}.tmp-cleanup-${Date.now()}`;
        await rename(fullPath, recoveryPath).catch((renameError: unknown) => {
          logger.error("upload.asset.registration_cleanup.fallback_failed", {
            module: "upload",
            action: "writeAssetFile",
            storagePath,
            error: renameError,
          });
        });
      }
    }
    throw error;
  }
}

async function recoverFailedAssetOverwrite({
  backupPath,
  fullPath,
  storagePath,
}: {
  backupPath: string;
  fullPath: string;
  storagePath: string;
}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const failedReplacementPath = `${fullPath}.tmp-cleanup-${suffix}`;
  try {
    await rename(fullPath, failedReplacementPath);
  } catch (error) {
    logger.error("upload.asset.overwrite_recovery.quarantine.failed", {
      module: "upload",
      action: "recoverFailedAssetOverwrite",
      storagePath,
      error,
    });
    return;
  }
  try {
    await rename(backupPath, fullPath);
  } catch (error) {
    logger.error("upload.asset.overwrite_recovery.restore.failed", {
      module: "upload",
      action: "recoverFailedAssetOverwrite",
      storagePath,
      error,
    });
  }
}

async function persistFailedRegistrationCleanup({
  publicPath,
  storagePath,
  mimeType,
  size,
  options,
  error,
}: {
  publicPath: string;
  storagePath: string;
  mimeType: string;
  size: number;
  options: SaveAssetOptions;
  error: unknown;
}) {
  try {
    await prisma.fileAsset.upsert({
      where: { publicPath },
      update: {
        cleanupRequestedAt: new Date(),
        cleanupAttempts: { increment: 1 },
        cleanupLastError: cleanupFailureMessage(error),
        cleanupNextRunAt: new Date(),
      },
      create: {
        publicPath,
        storagePath,
        kind: options.kind,
        mimeType,
        size,
        orderId: options.orderId ?? null,
        feedbackId: options.feedbackId ?? null,
        signatureOwnerOpenId: options.signatureOwnerOpenId ?? null,
        ownerOpenId: options.ownerOpenId ?? null,
        cleanupRequestedAt: new Date(),
        cleanupAttempts: 1,
        cleanupLastError: cleanupFailureMessage(error),
        cleanupNextRunAt: new Date(),
      },
    });
    return true;
  } catch (scheduleError) {
    logger.error("upload.asset.registration_cleanup.schedule_failed", {
      module: "upload",
      action: "writeAssetFile",
      storagePath,
      error: scheduleError,
    });
    return false;
  }
}

function cleanupFailureMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
