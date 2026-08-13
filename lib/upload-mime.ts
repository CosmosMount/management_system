export type DetectedFeedbackImage = {
  ext: string;
  mimeType: string;
};

export function detectFeedbackImage(
  buffer: Buffer,
): DetectedFeedbackImage | null {
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
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
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

export function declaredTypeAllowed(
  mimeType: string,
  allowedTypes: Set<string> | ReadonlySet<string>,
): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (isIgnorableDeclaredMimeType(normalized)) return true;
  const allowed = new Set([...allowedTypes].map(normalizeMimeType));
  return allowed.has(normalized);
}

export function extensionForMime(mimeType: string): string {
  switch (normalizeMimeType(mimeType)) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "image/bmp": return ".bmp";
    case "image/tiff": return ".tiff";
    case "image/heic":
    case "image/heif": return ".heic";
    case "image/avif": return ".avif";
    case "application/pdf": return ".pdf";
    default: return "";
  }
}

export function assertDetectedMimeAllowed(
  buffer: Buffer,
  allowedTypes: Set<string> | ReadonlySet<string>,
  fallbackType: string,
) {
  const detected = detectUploadMime(buffer);
  if (!detected) throw new Error("文件内容与支持的文件类型不匹配");
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
