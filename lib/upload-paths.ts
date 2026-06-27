import path from "path";

const DEFAULT_UPLOAD_STORAGE_DIR = path.join(process.cwd(), "storage", "uploads");
const RELATIVE_UPLOAD_ROOT = path.join("storage", "uploads");

function assertWithinRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("上传文件路径无效");
  }
}

export function uploadStorageRoot(): string {
  const configured = process.env.UPLOAD_STORAGE_DIR;
  if (!configured) return DEFAULT_UPLOAD_STORAGE_DIR;
  if (path.isAbsolute(configured)) return path.resolve(configured);

  const normalized = path.normalize(configured);
  const relativeToUploads = path.relative(RELATIVE_UPLOAD_ROOT, normalized);
  if (
    relativeToUploads === ".." ||
    relativeToUploads.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToUploads)
  ) {
    throw new Error("UPLOAD_STORAGE_DIR 相对路径必须位于 storage/uploads 下");
  }

  return path.join(DEFAULT_UPLOAD_STORAGE_DIR, relativeToUploads);
}

export function storagePathToAbsolute(storagePath: string): string {
  const root = uploadStorageRoot();
  const fullPath = path.resolve(root, storagePath);
  assertWithinRoot(root, fullPath);
  return fullPath;
}
