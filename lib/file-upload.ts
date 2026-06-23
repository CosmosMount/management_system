import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_INVOICE_COUNT = 20;
export const MAX_FEEDBACK_IMAGE_COUNT = 9;
export const MAX_FEEDBACK_IMAGE_SIZE = 10 * 1024 * 1024;

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
const FEEDBACK_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export const MAX_SIGNATURE_SIZE = 2 * 1024 * 1024;

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
): Promise<string> {
  if (!FEEDBACK_IMAGE_TYPES.has(file.type)) {
    throw new Error("反馈图片仅支持 PNG/JPG/WebP");
  }
  if (file.size > MAX_FEEDBACK_IMAGE_SIZE) {
    throw new Error("单张反馈图片不能超过 10MB");
  }

  const ext = path.extname(file.name) || ".png";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `image-${sortOrder}-${unique}${ext}`;
  const dir = path.join(process.cwd(), "public", "uploads", "feedback", feedbackId);
  await mkdir(dir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, filename), buffer);
  return `/uploads/feedback/${feedbackId}/${filename}`;
}

export const uploadTypeSets = {
  invoice: INVOICE_TYPES,
  itemPhoto: PHOTO_TYPES,
  listDoc: LIST_DOC_TYPES,
  screenshot: SCREENSHOT_TYPES,
  feedbackImage: FEEDBACK_IMAGE_TYPES,
};
