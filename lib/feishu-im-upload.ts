import { readFile } from "fs/promises";
import path from "path";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { getFeishuTenantAccessTokenByBotKind } from "@/lib/feishu-auth";
import {
  publicPathToStoragePath,
  storagePathToAbsolute,
} from "@/lib/file-upload";
import { isImagePath } from "@/lib/image-path";
import { logger } from "@/lib/logger";

async function readLocalUpload(
  publicPath: string,
): Promise<{ buffer: Buffer; fileName: string } | null> {
  const storagePath = publicPathToStoragePath(publicPath);
  if (!storagePath) {
    logger.warn("feishu.im_upload.invalid_path", {
      module: "feishu",
      action: "readLocalUpload",
      publicPath,
    });
    return null;
  }

  try {
    const absolutePath = storagePathToAbsolute(storagePath);
    const buffer = await readFile(absolutePath);
    return { buffer, fileName: path.basename(absolutePath) };
  } catch (error) {
    logger.warn("feishu.im_upload.read_failed", {
      module: "feishu",
      action: "readLocalUpload",
      publicPath,
      error,
    });
    return null;
  }
}

function mimeTypeForImagePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

function feishuFileTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc") return "doc";
  if (ext === ".docx") return "stream";
  if (ext === ".xls") return "xls";
  if (ext === ".xlsx") return "stream";
  if (ext === ".ppt") return "ppt";
  if (ext === ".pptx") return "stream";
  return "stream";
}

/** 将本地图片上传到飞书，返回卡片 img 组件所需的 image_key。 */
export async function uploadFeishuMessageImage(
  publicPath: string,
  botKind: FeishuBotKind,
): Promise<string | null> {
  if (!isImagePath(publicPath)) return null;

  const local = await readLocalUpload(publicPath);
  if (!local) return null;

  const form = new FormData();
  form.append("image_type", "message");
  form.append(
    "image",
    new Blob([Uint8Array.from(local.buffer)], {
      type: mimeTypeForImagePath(publicPath),
    }),
    local.fileName,
  );

  const token = await getFeishuTenantAccessTokenByBotKind(botKind);
  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const data = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: { image_key?: string };
  };

  if (data.code !== 0 || !data.data?.image_key) {
    logger.warn("feishu.im_upload.image_failed", {
      module: "feishu",
      action: "uploadFeishuMessageImage",
      publicPath,
      botKind,
      feishuCode: data.code,
      feishuMessage: data.msg,
      status: res.status,
    });
    return null;
  }

  return data.data.image_key;
}

/** 将本地文件上传到飞书，返回文件消息的 file_key。 */
export async function uploadFeishuMessageFile(
  publicPath: string,
  botKind: FeishuBotKind,
): Promise<string | null> {
  if (isImagePath(publicPath)) return null;

  const local = await readLocalUpload(publicPath);
  if (!local) return null;

  const form = new FormData();
  form.append("file_type", feishuFileTypeForPath(publicPath));
  form.append("file_name", local.fileName);
  form.append(
    "file",
    new Blob([Uint8Array.from(local.buffer)]),
    local.fileName,
  );

  const token = await getFeishuTenantAccessTokenByBotKind(botKind);
  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const data = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: { file_key?: string };
  };

  if (data.code !== 0 || !data.data?.file_key) {
    logger.warn("feishu.im_upload.file_failed", {
      module: "feishu",
      action: "uploadFeishuMessageFile",
      publicPath,
      botKind,
      feishuCode: data.code,
      feishuMessage: data.msg,
      status: res.status,
    });
    return null;
  }

  return data.data.file_key;
}
