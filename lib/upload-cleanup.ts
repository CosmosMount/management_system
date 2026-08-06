import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { removeUploadByPublicPath } from "@/lib/file-upload";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { uploadStorageRoot } from "@/lib/upload-paths";
import {
  isSameFileAssetWriteVersion,
  parseRecoveryBackupPath,
} from "@/lib/upload-recovery-marker";

const IMMEDIATE_CLEANUP_ATTEMPTS = 2;
const MAX_PERSISTED_ERROR_LENGTH = 1000;

export async function cleanupUploadPaths(
  publicPaths: string[],
  reason: string,
): Promise<{ cleaned: number; scheduled: number }> {
  const uniquePaths = [...new Set(publicPaths.filter(Boolean))];
  let cleaned = 0;
  let scheduled = 0;

  await Promise.all(
    uniquePaths.map(async (publicPath) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= IMMEDIATE_CLEANUP_ATTEMPTS; attempt++) {
        try {
          await removeUploadByPublicPath(publicPath);
          cleaned += 1;
          return;
        } catch (error) {
          lastError = error;
          logger.warn("upload.cleanup.retry", {
            module: "upload",
            action: "cleanupUploadPaths",
            publicPath,
            reason,
            attempt,
            error,
          });
        }
      }

      const message = cleanupErrorMessage(lastError);
      try {
        const marked = await prisma.fileAsset.updateMany({
          where: { publicPath },
          data: {
            cleanupRequestedAt: new Date(),
            cleanupAttempts: { increment: IMMEDIATE_CLEANUP_ATTEMPTS },
            cleanupLastError: message,
            cleanupNextRunAt: new Date(),
          },
        });
        scheduled += marked.count;
      } catch (scheduleError) {
        logger.error("upload.cleanup.schedule.failed", {
          module: "upload",
          action: "cleanupUploadPaths",
          publicPath,
          reason,
          error: scheduleError,
        });
      }
      logger.error("upload.cleanup.deferred", {
        module: "upload",
        action: "cleanupUploadPaths",
        publicPath,
        reason,
        error: lastError,
      });
    }),
  );

  return { cleaned, scheduled };
}

export async function drainUploadCleanupTasks(limit = 50): Promise<{
  cleaned: number;
  failed: number;
}> {
  const assets = await prisma.fileAsset.findMany({
    where: {
      cleanupRequestedAt: { not: null },
      OR: [{ cleanupNextRunAt: null }, { cleanupNextRunAt: { lte: new Date() } }],
    },
    select: {
      id: true,
      publicPath: true,
      cleanupAttempts: true,
    },
    orderBy: [{ cleanupNextRunAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
  let cleaned = 0;
  let failed = 0;

  for (const asset of assets) {
    try {
      await removeUploadByPublicPath(asset.publicPath);
      cleaned += 1;
    } catch (error) {
      failed += 1;
      const attempts = asset.cleanupAttempts + 1;
      await prisma.fileAsset.updateMany({
        where: { id: asset.id, cleanupRequestedAt: { not: null } },
        data: {
          cleanupAttempts: attempts,
          cleanupLastError: cleanupErrorMessage(error),
          cleanupNextRunAt: new Date(
            Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7)),
          ),
        },
      });
      logger.error("upload.cleanup.task.failed", {
        module: "upload",
        action: "drainUploadCleanupTasks",
        publicPath: asset.publicPath,
        attempts,
        error,
      });
    }
  }
  return { cleaned, failed };
}

export async function reconcileStaleUploadArtifacts(options?: {
  limit?: number;
  olderThanMs?: number;
}): Promise<{ removed: number; restored: number; failed: number }> {
  const root = uploadStorageRoot();
  const limit = options?.limit ?? 100;
  const cutoff = Date.now() - (options?.olderThanMs ?? 60 * 60_000);
  const candidates = await collectUploadArtifacts(root, limit);
  let removed = 0;
  let restored = 0;
  let failed = 0;

  for (const artifactPath of candidates) {
    try {
      const metadata = await stat(artifactPath);
      if (metadata.mtimeMs > cutoff) continue;
      const recovery = parseRecoveryBackupPath(artifactPath);
      const backupMarker = artifactPath.lastIndexOf(".bak-");
      if (recovery) {
        const relativeStoragePath = path.relative(root, recovery.originalPath);
        if (
          relativeStoragePath.startsWith("..") ||
          path.isAbsolute(relativeStoragePath)
        ) {
          throw new Error("上传覆盖恢复路径越出存储目录");
        }
        const publicPath = `/uploads/${relativeStoragePath
          .split(path.sep)
          .join("/")}`;
        const currentVersion = await prisma.fileAsset.findUnique({
          where: { publicPath },
          select: { id: true, writeGeneration: true },
        });
        if (
          !isSameFileAssetWriteVersion(
            currentVersion,
            recovery.expectedVersion,
          )
        ) {
          await rm(artifactPath, { force: true });
          removed += 1;
          continue;
        }
        const originalPath = recovery.originalPath;
        const failedReplacementPath = `${originalPath}.tmp-cleanup-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        try {
          await rename(originalPath, failedReplacementPath);
        } catch (error) {
          if (!isErrnoCode(error, "ENOENT")) throw error;
        }
        await rename(artifactPath, originalPath);
        restored += 1;
      } else if (backupMarker >= 0) {
        const originalPath = artifactPath.slice(0, backupMarker);
        try {
          await stat(originalPath);
          await rm(artifactPath, { force: true });
          removed += 1;
        } catch (error) {
          if (!isErrnoCode(error, "ENOENT")) throw error;
          await rename(artifactPath, originalPath);
          restored += 1;
        }
      } else {
        await rm(artifactPath, { force: true });
        removed += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error("upload.artifact.reconcile.failed", {
        module: "upload",
        action: "reconcileStaleUploadArtifacts",
        artifactPath: path.relative(root, artifactPath),
        error,
      });
    }
  }
  return { removed, restored, failed };
}

async function collectUploadArtifacts(
  directory: string,
  limit: number,
): Promise<string[]> {
  if (limit <= 0) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
  const artifacts: string[] = [];
  for (const entry of entries) {
    if (artifacts.length >= limit) break;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(
        ...(await collectUploadArtifacts(entryPath, limit - artifacts.length)),
      );
    } else if (
      entry.name.includes(".tmp-") ||
      entry.name.includes(".bak-") ||
      entry.name.includes(".restore-bak-")
    ) {
      artifacts.push(entryPath);
    }
  }
  return artifacts;
}

function cleanupErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_PERSISTED_ERROR_LENGTH,
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
