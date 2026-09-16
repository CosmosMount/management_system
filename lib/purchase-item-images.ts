import { parseFilePaths, serializeFilePaths } from "@/lib/order-attachments";

export function resolveItemReferenceImagePaths(
  referenceImagePaths: string | null | undefined,
  legacyReferenceImagePath: string | null | undefined,
): string[] {
  const paths = parseFilePaths(referenceImagePaths);
  if (paths.length > 0) return paths;
  return legacyReferenceImagePath ? [legacyReferenceImagePath] : [];
}

export function serializeItemReferenceImagePaths(paths: string[]): string {
  return serializeFilePaths(paths);
}
