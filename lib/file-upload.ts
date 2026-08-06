import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "fs/promises";
import path from "path";
import type { FileAssetKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  storagePathToAbsolute,
  uploadStorageRoot,
} from "@/lib/upload-paths";
import {
  FEEDBACK_IMAGE_SIZE_LABEL,
  FEEDBACK_IMAGE_ALLOWED_TYPES,
  MAX_FEEDBACK_IMAGE_SIZE,
} from "@/lib/feedback-upload-limits";
import { createRecoveryBackupPath } from "@/lib/upload-recovery-marker";

export { MAX_FEEDBACK_IMAGE_COUNT, MAX_FEEDBACK_IMAGE_SIZE } from "@/lib/feedback-upload-limits";
export {
  FEEDBACK_IMAGE_SIZE_LABEL,
  FEEDBACK_IMAGE_TOTAL_SIZE_LABEL,
  MAX_FEEDBACK_IMAGE_TOTAL_SIZE,
} from "@/lib/feedback-upload-limits";

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_INVOICE_COUNT = 20;
export const UPLOAD_PUBLIC_PREFIX = "/uploads/";

const INVOICE_TYPES = new Set(["application/pdf"]);

const IMAGE_UPLOAD_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
  "image/avif",
]);

const PHOTO_TYPES = IMAGE_UPLOAD_TYPES;

const LIST_DOC_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
]);

const SCREENSHOT_TYPES = new Set([
  "application/pdf",
  ...IMAGE_UPLOAD_TYPES,
]);

const SIGNATURE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);
const FEEDBACK_IMAGE_TYPES: ReadonlySet<string> = new Set(
  FEEDBACK_IMAGE_ALLOWED_TYPES,
);

export const MAX_SIGNATURE_SIZE = 2 * 1024 * 1024;
export const MAX_PROJECT_AVATAR_SIZE = 2 * 1024 * 1024;
const PROJECT_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export type SavedFeedbackImage = {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
};

type DetectedFeedbackImage = {
  ext: string;
  mimeType: string;
};

type SaveAssetOptions = {
  kind: FileAssetKind;
  orderId?: string | null;
  feedbackId?: string | null;
  signatureOwnerOpenId?: string | null;
  ownerOpenId?: string | null;
};

export { storagePathToAbsolute, uploadStorageRoot };

export function publicPathToStoragePath(publicPath: string): string | null {
  if (!publicPath.startsWith(UPLOAD_PUBLIC_PREFIX)) return null;
  const relative = publicPath.slice(UPLOAD_PUBLIC_PREFIX.length);
  const segments = relative.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments.join("/");
}

export function publicPathToAbsolute(publicPath: string): string {
  const storagePath = publicPathToStoragePath(publicPath);
  if (!storagePath) {
    throw new Error("上传文件路径无效");
  }
  return storagePathToAbsolute(storagePath);
}

async function writeAssetFile({
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
  const tempPath = `${fullPath}.tmp-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
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
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) {
        throw err;
      }
    }
    await rename(tempPath, fullPath);
  } catch (err) {
    await rm(tempPath, { force: true });
    if (backupCreated) {
      await rename(backupPath, fullPath).catch((restoreErr: unknown) => {
        logger.error("upload.asset.backup_restore.failed", {
          module: "upload",
          action: "writeAssetFile",
          storagePath,
          error: restoreErr,
        });
      });
    }
    throw err;
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
      await rm(backupPath, { force: true }).catch((cleanupErr: unknown) => {
        logger.error("upload.asset.backup_cleanup.failed", {
          module: "upload",
          action: "writeAssetFile",
          storagePath,
          error: cleanupErr,
        });
      });
    }
  } catch (err) {
    if (backupCreated) {
      await recoverFailedAssetOverwrite({
        backupPath,
        fullPath,
        storagePath,
      });
      throw err;
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
    throw err;
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

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}

function detectFeedbackImage(buffer: Buffer): DetectedFeedbackImage | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { ext: ".png", mimeType: "image/png" };
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { ext: ".jpg", mimeType: "image/jpeg" };
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: ".webp", mimeType: "image/webp" };
  }

  if (buffer.length >= 6) {
    const gifHeader = buffer.subarray(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return { ext: ".gif", mimeType: "image/gif" };
    }
  }

  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") {
    return { ext: ".bmp", mimeType: "image/bmp" };
  }

  if (buffer.length >= 4) {
    const tiffHeader = buffer.subarray(0, 4).toString("ascii");
    if (tiffHeader === "II*\0" || tiffHeader === "MM\0*") {
      return { ext: ".tiff", mimeType: "image/tiff" };
    }
  }

  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { ext: ".heic", mimeType: "image/heic" };
    }
    if (brand === "avif") {
      return { ext: ".avif", mimeType: "image/avif" };
    }
  }

  return null;
}

function detectUploadMime(buffer: Buffer): string | null {
  const image = detectFeedbackImage(buffer);
  if (image) return image.mimeType;

  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return "application/msword";
  }

  return null;
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "image/jpg" || normalized === "image/pjpeg") {
    return "image/jpeg";
  }
  if (normalized === "image/x-png") return "image/png";
  return normalized;
}

function isImageMimeType(mimeType: string): boolean {
  return normalizeMimeType(mimeType).startsWith("image/");
}

function isIgnorableDeclaredMimeType(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return !normalized || normalized === "application/octet-stream";
}

function declaredTypeAllowed(
  mimeType: string,
  allowedTypes: Set<string> | ReadonlySet<string>,
): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (isIgnorableDeclaredMimeType(normalized)) return true;
  const allowed = new Set([...allowedTypes].map(normalizeMimeType));
  return allowed.has(normalized);
}

function extensionForMime(mimeType: string): string {
  switch (normalizeMimeType(mimeType)) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tiff";
    case "image/heic":
    case "image/heif":
      return ".heic";
    case "image/avif":
      return ".avif";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

function assertDetectedMimeAllowed(
  buffer: Buffer,
  allowedTypes: Set<string> | ReadonlySet<string>,
  fallbackType: string,
) {
  const detected = detectUploadMime(buffer);
  if (!detected) {
    throw new Error("文件内容与支持的文件类型不匹配");
  }
  const allowed = new Set([...allowedTypes].map(normalizeMimeType));
  const normalizedDetected = normalizeMimeType(detected);
  if (!allowed.has(normalizedDetected)) {
    throw new Error("文件内容与支持的文件类型不匹配");
  }

  const normalizedFallback = normalizeMimeType(fallbackType);
  if (
    normalizedFallback &&
    !isIgnorableDeclaredMimeType(normalizedFallback) &&
    normalizedFallback !== normalizedDetected &&
    !(isImageMimeType(normalizedFallback) && isImageMimeType(normalizedDetected))
  ) {
    throw new Error("文件内容与声明的文件类型不一致");
  }
  return detected;
}

export async function saveItemReferenceImage(
  orderId: string,
  index: number,
  file: File,
): Promise<string> {
  return saveUpload(orderId, file, `item-ref-${index}`, uploadTypeSets.itemPhoto, {
    kind: "ORDER_ITEM_IMAGE",
    orderId,
  });
}

export async function saveGeneratedOrderAttachment(
  orderId: string,
  buffer: Buffer,
  prefix: string,
  mimeType: string,
  extension: string,
): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${prefix}-${unique}${extension}`;
  const publicPath = `/uploads/${orderId}/${filename}`;
  await writeAssetFile({
    storagePath: `${orderId}/${filename}`,
    publicPath,
    buffer,
    mimeType,
    options: { kind: "ORDER_ATTACHMENT", orderId },
  });
  return publicPath;
}

export async function saveUpload(
  orderId: string,
  file: File,
  prefix: string,
  allowedTypes: Set<string>,
  options?: Partial<SaveAssetOptions>,
): Promise<string> {
  if (!declaredTypeAllowed(file.type, allowedTypes)) {
    throw new Error(`不支持的文件类型: ${file.type || "未知类型"}`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("文件大小不能超过 20MB");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detectedMimeType = assertDetectedMimeAllowed(
    buffer,
    allowedTypes,
    file.type,
  );
  const ext =
    extensionForMime(detectedMimeType) ||
    path.extname(file.name).toLowerCase() ||
    ".bin";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${prefix}-${unique}${ext}`;
  const publicPath = `/uploads/${orderId}/${filename}`;
  const storagePath = `${orderId}/${filename}`;

  await writeAssetFile({
    storagePath,
    publicPath,
    buffer,
    mimeType: detectedMimeType,
    options: {
      kind: options?.kind ?? "ORDER_ATTACHMENT",
      orderId: options?.orderId ?? orderId,
      feedbackId: options?.feedbackId,
      signatureOwnerOpenId: options?.signatureOwnerOpenId,
      ownerOpenId: options?.ownerOpenId,
    },
  });
  return publicPath;
}

/** 保存用户电子签名（覆盖旧文件） */
export async function saveUserSignature(
  openId: string,
  file: File,
): Promise<string> {
  if (!SIGNATURE_TYPES.has(file.type)) {
    throw new Error("电子签名仅支持 PNG/JPG 图片");
  }
  if (file.size > MAX_SIGNATURE_SIZE) {
    throw new Error("签名图片不能超过 2MB");
  }

  const ext = path.extname(file.name) || ".png";
  const filename = `signature${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const detectedMimeType = assertDetectedMimeAllowed(
    buffer,
    SIGNATURE_TYPES,
    file.type,
  );
  const publicPath = `/uploads/signatures/${openId}/${filename}`;
  await writeAssetFile({
    storagePath: `signatures/${openId}/${filename}`,
    publicPath,
    buffer,
    mimeType: detectedMimeType,
    options: {
      kind: "USER_SIGNATURE",
      signatureOwnerOpenId: openId,
      ownerOpenId: openId,
    },
  });
  return publicPath;
}

export async function saveFeedbackImage(
  feedbackId: string,
  file: File,
  sortOrder: number,
): Promise<SavedFeedbackImage> {
  if (!FEEDBACK_IMAGE_TYPES.has(file.type)) {
    throw new Error("反馈图片仅支持 PNG/JPG/WebP");
  }
  if (file.size > MAX_FEEDBACK_IMAGE_SIZE) {
    throw new Error(`单张反馈图片不能超过 ${FEEDBACK_IMAGE_SIZE_LABEL}`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = detectFeedbackImage(buffer);
  if (!detected) {
    throw new Error("反馈图片仅支持 PNG/JPG/WebP");
  }

  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `image-${sortOrder}-${unique}${detected.ext}`;
  const publicPath = `/uploads/feedback/${feedbackId}/${filename}`;
  await writeAssetFile({
    storagePath: `feedback/${feedbackId}/${filename}`,
    publicPath,
    buffer,
    mimeType: detected.mimeType,
    options: {
      kind: "FEEDBACK_ATTACHMENT",
      feedbackId,
    },
  });
  return {
    path: publicPath,
    fileName: file.name || filename,
    mimeType: detected.mimeType,
    size: file.size,
  };
}

export async function saveProjectAvatarDraft(
  ownerOpenId: string,
  file: File,
): Promise<string> {
  if (!PROJECT_AVATAR_TYPES.has(file.type)) {
    throw new Error("Project 头像仅支持 PNG/JPG/WebP");
  }
  if (file.size > MAX_PROJECT_AVATAR_SIZE) {
    throw new Error("Project 头像不能超过 2MB");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const detectedMimeType = assertDetectedMimeAllowed(buffer, PROJECT_AVATAR_TYPES, file.type);
  const extension = extensionForMime(detectedMimeType);
  if (!extension || ![".png", ".jpg", ".webp"].includes(extension)) {
    throw new Error("Project 头像仅支持 PNG/JPG/WebP");
  }
  const filename = `${randomUUID()}${extension}`;
  const storagePath = `projects/drafts/${filename}`;
  const publicPath = `/uploads/${storagePath}`;
  await writeAssetFile({
    storagePath,
    publicPath,
    buffer,
    mimeType: detectedMimeType,
    options: { kind: "PROJECT_AVATAR", ownerOpenId },
  });
  await prisma.fileAsset.update({
    where: { publicPath },
    data: {
      cleanupRequestedAt: new Date(),
      cleanupNextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      cleanupLastError: "未绑定的 Project 头像草稿将在 24 小时后清理",
    },
  });
  return publicPath;
}

export async function removeFeedbackUpload(publicPath: string): Promise<void> {
  if (!publicPath.startsWith("/uploads/feedback/")) return;
  const storagePath = publicPathToStoragePath(publicPath);
  if (!storagePath) return;
  const fullPath = storagePathToAbsolute(storagePath);
  await rm(fullPath, { force: true });
  await prisma.fileAsset.deleteMany({ where: { publicPath } });
}

export async function removeOrderUploads(orderId: string): Promise<void> {
  const dir = storagePathToAbsolute(orderId);
  await rm(dir, { recursive: true, force: true });
  await prisma.fileAsset.deleteMany({ where: { orderId } });
}

export async function removeUploadByPublicPath(publicPath: string): Promise<void> {
  await removeUploadFileByPublicPath(publicPath);
  await prisma.fileAsset.deleteMany({ where: { publicPath } });
}

export async function removeUploadFileByPublicPath(publicPath: string): Promise<void> {
  const storagePath = publicPathToStoragePath(publicPath);
  if (!storagePath) return;
  await rm(storagePathToAbsolute(storagePath), { force: true });
}

export async function fileAssetExists(publicPath: string): Promise<boolean> {
  const storagePath = publicPathToStoragePath(publicPath);
  if (!storagePath) return false;
  try {
    await stat(storagePathToAbsolute(storagePath));
    return true;
  } catch {
    return false;
  }
}

export const uploadTypeSets = {
  invoice: INVOICE_TYPES,
  itemPhoto: PHOTO_TYPES,
  listDoc: LIST_DOC_TYPES,
  screenshot: SCREENSHOT_TYPES,
  feedbackImage: FEEDBACK_IMAGE_TYPES,
};
