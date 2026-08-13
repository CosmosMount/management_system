import { randomUUID } from "node:crypto";
import { rm, stat } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import {
  storagePathToAbsolute,
  uploadStorageRoot,
} from "@/lib/upload-paths";
import {
  FEEDBACK_IMAGE_SIZE_LABEL,
  FEEDBACK_IMAGE_ALLOWED_TYPES,
  MAX_FEEDBACK_IMAGE_SIZE,
} from "@/lib/feedback-upload-limits";
import { writeAssetFile, type SaveAssetOptions } from "@/lib/upload-asset-writer";
import {
  assertDetectedMimeAllowed,
  declaredTypeAllowed,
  detectFeedbackImage,
  extensionForMime,
} from "@/lib/upload-mime";

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
