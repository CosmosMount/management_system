import type { FileAssetKind } from "@prisma/client";

export function uploadCacheControl(kind: FileAssetKind): string {
  return kind === "MATERIAL_RETURN_PHOTO" || kind === "ORDER_ATTACHMENT"
    ? "private, no-store, max-age=0"
    : "private, max-age=3600";
}
