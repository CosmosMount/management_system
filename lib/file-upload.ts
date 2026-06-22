import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_INVOICE_COUNT = 20;

const INVOICE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

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

export const uploadTypeSets = {
  invoice: INVOICE_TYPES,
  listDoc: LIST_DOC_TYPES,
  screenshot: SCREENSHOT_TYPES,
};
