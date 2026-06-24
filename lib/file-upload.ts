import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import {
  FEEDBACK_IMAGE_ALLOWED_TYPES,
  MAX_FEEDBACK_IMAGE_SIZE,
} from "@/lib/feedback-upload-limits";

export { MAX_FEEDBACK_IMAGE_COUNT, MAX_FEEDBACK_IMAGE_SIZE } from "@/lib/feedback-upload-limits";

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_INVOICE_COUNT = 20;

const INVOICE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

const PHOTO_TYPES = INVOICE_TYPES;

const LIST_DOC_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ...INVOICE_TYPES,
]);

const SCREENSHOT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

const SIGNATURE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);
const FEEDBACK_IMAGE_TYPES: ReadonlySet<string> = new Set(
  FEEDBACK_IMAGE_ALLOWED_TYPES,
);

export const MAX_SIGNATURE_SIZE = 2 * 1024 * 1024;

export type SavedFeedbackImage = {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
};

type DetectedFeedbackImage = {
  ext: ".png" | ".jpg" | ".webp";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

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

  return null;
}

export async function saveItemReferenceImage(
  orderId: string,
  index: number,
  file: File,
): Promise<string> {
  return saveUpload(orderId, file, `item-ref-${index}`, uploadTypeSets.itemPhoto);
}

export async function saveUpload(
  orderId: string,
  file: File,
  prefix: string,
  allowedTypes: Set<string>,
): Promise<string> {
  if (!allowedTypes.has(file.type)) {
    throw new Error(`不支持的文件类型: ${file.type}`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("文件大小不能超过 20MB");
  }

  const ext = path.extname(file.name) || ".bin";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${prefix}-${unique}${ext}`;
  const dir = path.join(process.cwd(), "public", "uploads", orderId);
  await mkdir(dir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, filename), buffer);
  return `/uploads/${orderId}/${filename}`;
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
  const dir = path.join(process.cwd(), "public", "uploads", "signatures", openId);
  await mkdir(dir, { recursive: true });

  const filename = `signature${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, filename), buffer);
  return `/uploads/signatures/${openId}/${filename}`;
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
    throw new Error("单张反馈图片不能超过 100MB");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = detectFeedbackImage(buffer);
  if (!detected) {
    throw new Error("反馈图片仅支持 PNG/JPG/WebP");
  }

  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `image-${sortOrder}-${unique}${detected.ext}`;
  const dir = path.join(process.cwd(), "public", "uploads", "feedback", feedbackId);
  await mkdir(dir, { recursive: true });

  await writeFile(path.join(dir, filename), buffer);
  return {
    path: `/uploads/feedback/${feedbackId}/${filename}`,
    fileName: file.name || filename,
    mimeType: detected.mimeType,
    size: file.size,
  };
}

export async function removeFeedbackUpload(publicPath: string): Promise<void> {
  if (!publicPath.startsWith("/uploads/feedback/")) return;
  const fullPath = path.join(
    process.cwd(),
    "public",
    publicPath.replace(/^\/+/, ""),
  );
  await rm(fullPath, { force: true });
}

export async function removeOrderUploads(orderId: string): Promise<void> {
  const dir = path.join(process.cwd(), "public", "uploads", orderId);
  await rm(dir, { recursive: true, force: true });
}

export const uploadTypeSets = {
  invoice: INVOICE_TYPES,
  itemPhoto: PHOTO_TYPES,
  listDoc: LIST_DOC_TYPES,
  screenshot: SCREENSHOT_TYPES,
  feedbackImage: FEEDBACK_IMAGE_TYPES,
};
