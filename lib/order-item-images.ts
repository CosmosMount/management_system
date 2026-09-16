import { FileAssetKind, type PurchaseItemKind } from "@prisma/client";
import { saveItemReferenceImage } from "@/lib/file-upload";
import { itemKindNeedsImage } from "@/lib/purchase-item-kind";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";
import { prisma } from "@/lib/prisma";
import { MAX_ITEM_REFERENCE_IMAGE_COUNT } from "@/lib/upload-accept";

export type PreparedItemReferenceImages = {
  referenceImagePaths: string[][];
  stagedUploadPaths: string[];
};

/**
 * Writes all new item images before the business transaction. If any write
 * fails, every image already staged by this invocation is compensated.
 */
export async function prepareItemReferenceImages({
  orderId,
  itemKinds,
  itemImages,
  existingPaths,
}: {
  orderId: string;
  itemKinds: PurchaseItemKind[];
  itemImages: Map<number, File[]>;
  existingPaths?: string[][];
}): Promise<PreparedItemReferenceImages> {
  const referenceImagePaths: string[][] = [];
  const stagedUploadPaths: string[] = [];
  try {
    for (const [index, itemKind] of itemKinds.entries()) {
      if (!itemKindNeedsImage(itemKind)) {
        referenceImagePaths.push([]);
        continue;
      }
      const retainedPaths = existingPaths?.[index] ?? [];
      const uploadedFiles = itemImages.get(index) ?? [];
      if (retainedPaths.length + uploadedFiles.length > MAX_ITEM_REFERENCE_IMAGE_COUNT) {
        throw new Error(`加工费参考图片最多 ${MAX_ITEM_REFERENCE_IMAGE_COUNT} 张`);
      }
      const itemPaths = [...retainedPaths];
      for (const [uploadIndex, uploadedFile] of uploadedFiles.entries()) {
        const referenceImagePath = await saveItemReferenceImage(
          orderId,
          index,
          retainedPaths.length + uploadIndex,
          uploadedFile,
        );
        stagedUploadPaths.push(referenceImagePath);
        itemPaths.push(referenceImagePath);
      }
      if (itemPaths.length === 0) {
        throw new Error("加工费须上传对应图片");
      }
      referenceImagePaths.push(itemPaths);
    }
    return { referenceImagePaths, stagedUploadPaths };
  } catch (error) {
    await cleanupUploadPaths(
      stagedUploadPaths,
      "item_reference_image_staging_compensation",
    );
    throw error;
  }
}

export async function assertExistingItemImagesBelongToOrder(
  orderId: string,
  currentPaths: Array<string | null>,
  submittedPaths: Array<string | null | undefined>,
) {
  const requested = [
    ...new Set(submittedPaths.filter((value): value is string => !!value)),
  ];
  if (requested.length === 0) return;
  const current = new Set(
    currentPaths.filter((value): value is string => !!value),
  );
  if (requested.some((value) => !current.has(value))) {
    throw new Error("明细图片不属于当前订单，请刷新后重试");
  }
  const assets = await prisma.fileAsset.findMany({
    where: {
      publicPath: { in: requested },
      orderId,
      kind: FileAssetKind.ORDER_ITEM_IMAGE,
    },
    select: { publicPath: true },
  });
  if (new Set(assets.map((asset) => asset.publicPath)).size !== requested.length) {
    throw new Error("明细图片不属于当前订单，请重新上传");
  }
}
