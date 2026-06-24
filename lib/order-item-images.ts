import { saveItemReferenceImage } from "@/lib/file-upload";
import {
  itemKindNeedsImage,
  type PurchaseItemKind,
} from "@/lib/purchase-item-kind";
import { prisma } from "@/lib/prisma";

export async function attachItemReferenceImages(
  orderId: string,
  items: { id: string; itemKind: PurchaseItemKind }[],
  itemImages: Map<number, File>,
  existingPaths: (string | null | undefined)[],
): Promise<void> {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!itemKindNeedsImage(item.itemKind)) continue;

    const uploaded = itemImages.get(index);
    let referenceImagePath = existingPaths[index] ?? null;
    if (uploaded) {
      referenceImagePath = await saveItemReferenceImage(orderId, index, uploaded);
    }

    if (!referenceImagePath) {
      throw new Error("标准件与加工费须上传对应图片");
    }

    await prisma.purchaseItem.update({
      where: { id: item.id },
      data: { referenceImagePath },
    });
  }
}
