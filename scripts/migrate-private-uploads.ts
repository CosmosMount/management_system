import "dotenv/config";
import { mkdir, readdir, rename, stat } from "fs/promises";
import path from "path";
import type { FileAssetKind } from "@prisma/client";
import {
  publicPathToStoragePath,
  registerExistingFileAsset,
  storagePathToAbsolute,
  uploadStorageRoot,
} from "../lib/file-upload";
import { parseFilePaths } from "../lib/order-attachments";
import { prisma } from "../lib/prisma";

const PUBLIC_UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

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

type AssetHint = {
  kind: FileAssetKind;
  orderId?: string | null;
  feedbackId?: string | null;
  signatureOwnerOpenId?: string | null;
  ownerOpenId?: string | null;
};

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".gitkeep") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function publicPathFromPublicFile(filePath: string): string {
  const relative = path.relative(PUBLIC_UPLOADS_ROOT, filePath);
  return `/uploads/${relative.split(path.sep).join("/")}`;
}

function mimeFromPath(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function buildHints(): Promise<Map<string, AssetHint>> {
  const hints = new Map<string, AssetHint>();

  const orders = await prisma.purchaseOrder.findMany({
    include: {
      items: { select: { referenceImagePath: true, photoPath: true } },
      initiator: { select: { openId: true } },
    },
  });
  for (const order of orders) {
    for (const filePath of [
      ...parseFilePaths(order.invoicePaths),
      order.invoicePath,
      order.listDocPath,
      order.screenshotPath,
    ]) {
      if (filePath) {
        hints.set(filePath, {
          kind: "ORDER_ATTACHMENT",
          orderId: order.id,
          ownerOpenId: order.initiator.openId,
        });
      }
    }

    for (const item of order.items) {
      for (const filePath of [item.referenceImagePath, item.photoPath]) {
        if (filePath) {
          hints.set(filePath, {
            kind: "ORDER_ITEM_IMAGE",
            orderId: order.id,
            ownerOpenId: order.initiator.openId,
          });
        }
      }
    }
  }

  const feedbacks = await prisma.feedback.findMany({
    include: {
      messages: {
        include: { attachments: true },
      },
    },
  });
  for (const feedback of feedbacks) {
    for (const message of feedback.messages) {
      for (const attachment of message.attachments) {
        hints.set(attachment.path, {
          kind: "FEEDBACK_ATTACHMENT",
          feedbackId: feedback.id,
          ownerOpenId: feedback.submitterOpenId,
        });
      }
    }
  }

  const users = await prisma.user.findMany({
    where: { signaturePath: { not: null } },
    select: { openId: true, signaturePath: true },
  });
  for (const user of users) {
    if (user.signaturePath) {
      hints.set(user.signaturePath, {
        kind: "USER_SIGNATURE",
        signatureOwnerOpenId: user.openId,
        ownerOpenId: user.openId,
      });
    }
  }

  return hints;
}

async function main() {
  await mkdir(uploadStorageRoot(), { recursive: true });
  const files = await walk(PUBLIC_UPLOADS_ROOT);
  const hints = await buildHints();
  let moved = 0;
  let registered = 0;

  for (const publicFile of files) {
    const publicPath = publicPathFromPublicFile(publicFile);
    const storagePath = publicPathToStoragePath(publicPath);
    if (!storagePath) continue;

    const target = storagePathToAbsolute(storagePath);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await stat(target);
    } catch {
      await rename(publicFile, target);
      moved++;
    }

    const fileStat = await stat(target);
    const hint = hints.get(publicPath) ?? {
      kind: "TEMP_UPLOAD" as FileAssetKind,
    };
    await registerExistingFileAsset({
      publicPath,
      storagePath,
      mimeType: mimeFromPath(target),
      size: fileStat.size,
      ...hint,
    });
    registered++;
  }

  console.log(
    `[migrate-private-uploads] 移动 ${moved} 个文件，登记 ${registered} 个 FileAsset`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
