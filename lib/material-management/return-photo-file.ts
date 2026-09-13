import { readFile, stat } from "node:fs/promises";
import { storagePathToAbsolute } from "@/lib/upload-paths";
import { detectFeedbackImage } from "@/lib/upload-mime";

export const MAX_MATERIAL_RETURN_PHOTO_SIZE = 8 * 1024 * 1024;

const MATERIAL_RETURN_PHOTO_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/avif",
]);

function normalizeMaterialReturnPhotoMime(mimeType: string): string | null {
  const normalized = mimeType.trim().toLowerCase();
  const canonical =
    normalized === "image/jpg"
      ? "image/jpeg"
      : normalized === "image/heif"
        ? "image/heic"
        : normalized;
  return MATERIAL_RETURN_PHOTO_MIME_TYPES.has(canonical) ? canonical : null;
}

export function isMaterialReturnPhotoStoragePath(
  storagePath: string,
  loanId: string,
): boolean {
  if (storagePath.includes("\\")) return false;
  const segments = storagePath.split("/");
  return (
    segments.length === 3 &&
    segments[0] === "materials" &&
    segments[1] === loanId &&
    Boolean(segments[2]) &&
    segments[2] !== "." &&
    segments[2] !== ".."
  );
}

export function assertMaterialReturnPhotoContent(
  buffer: Buffer,
  declaredMimeType: string,
): string {
  const declared = normalizeMaterialReturnPhotoMime(declaredMimeType);
  if (!declared) {
    throw new Error("归还照片仅支持 PNG、JPG、WebP、HEIC 或 AVIF");
  }
  const detected = detectFeedbackImage(buffer);
  const detectedMime = detected
    ? normalizeMaterialReturnPhotoMime(detected.mimeType)
    : null;
  if (!detectedMime) {
    throw new Error("归还照片内容与支持的图片格式不匹配");
  }
  if (declared !== detectedMime) {
    throw new Error("归还照片内容与声明的图片格式不一致");
  }
  return detectedMime;
}

export async function validateStoredMaterialReturnPhoto(
  asset: {
    storagePath: string;
    mimeType: string;
    size: number;
    writeGeneration: string | null;
  },
  expectedWriteGeneration: string,
): Promise<boolean> {
  if (
    !asset.writeGeneration ||
    asset.writeGeneration !== expectedWriteGeneration ||
    asset.size <= 0 ||
    asset.size > MAX_MATERIAL_RETURN_PHOTO_SIZE
  ) {
    return false;
  }

  try {
    const absolutePath = storagePathToAbsolute(asset.storagePath);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile() || metadata.size !== asset.size) return false;

    const detected = detectFeedbackImage(await readFile(absolutePath));
    return (
      normalizeMaterialReturnPhotoMime(asset.mimeType) !== null &&
      normalizeMaterialReturnPhotoMime(asset.mimeType) ===
        normalizeMaterialReturnPhotoMime(detected?.mimeType ?? "")
    );
  } catch {
    return false;
  }
}
