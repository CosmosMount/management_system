import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canViewFileAsset } from "@/lib/file-asset-permissions";
import { getUserRoles } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  publicPathToStoragePath,
} from "@/lib/file-upload";
import { storagePathToAbsolute } from "@/lib/upload-paths";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function resolveUploadPublicPath(segments: string[]): string | null {
  if (segments.length === 0) return null;
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return `/uploads/${segments.join("/")}`;
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
  const session = await auth();
  const userOpenId = session?.user?.openId;
  if (!userOpenId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const publicPath = resolveUploadPublicPath(segments);
  if (!publicPath) {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const asset = await prisma.fileAsset.findUnique({
    where: { publicPath },
  });
  if (!asset) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const roles = await getUserRoles(userOpenId);
  if (!(await canViewFileAsset({ asset, userOpenId, roles }))) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const storagePath =
    asset.storagePath || publicPathToStoragePath(asset.publicPath);
  if (!storagePath) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const filePath = storagePathToAbsolute(storagePath);

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
  const contentType = asset.mimeType || MIME_TYPES[ext] || "application/octet-stream";
  const filename = path.basename(filePath);
  const forceDownload =
    options?.download || ext === ".doc" || ext === ".docx" || ext === ".pdf";

  const body = Readable.toWeb(createReadStream(filePath));

  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(fileStat.size),
      "Content-Disposition": contentDisposition(filename, forceDownload),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
