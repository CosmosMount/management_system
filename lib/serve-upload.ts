import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";

const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function isInsideUploadsRoot(filePath: string): boolean {
  const relative = path.relative(UPLOADS_ROOT, filePath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

export function resolveUploadFile(segments: string[]): string | null {
  if (segments.length === 0) return null;
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  const fullPath = path.resolve(UPLOADS_ROOT, ...segments);
  if (!isInsideUploadsRoot(fullPath)) {
    return null;
  }
  return fullPath;
}

function contentDisposition(filename: string, attachment: boolean): string {
  const encoded = encodeURIComponent(filename);
  const type = attachment ? "attachment" : "inline";
  return `${type}; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}

export async function serveUploadFile(
  segments: string[],
  options?: { download?: boolean },
): Promise<NextResponse> {
  const filePath = resolveUploadFile(segments);
  if (!filePath) {
    return new NextResponse("Bad Request", { status: 400 });
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }

  if (!fileStat.isFile()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const filename = path.basename(filePath);
  const forceDownload =
    options?.download || ext === ".doc" || ext === ".docx" || ext === ".pdf";

  const stream = createReadStream(filePath);
  const body = Readable.toWeb(stream) as ReadableStream;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(fileStat.size),
      "Content-Disposition": contentDisposition(filename, forceDownload),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
