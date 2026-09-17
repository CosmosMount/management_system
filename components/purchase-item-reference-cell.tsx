import { AttachmentFileLink } from "@/components/attachment-file-link";
import type { PurchaseItemKind } from "@/lib/purchase-item-kind";
import { resolveItemReferenceImagePaths } from "@/lib/purchase-item-images";

type Props = {
  itemKind: PurchaseItemKind;
  purchaseLink: string;
  referenceImagePath: string | null;
  referenceImagePaths: string;
};

export function PurchaseItemReferenceCell({
  purchaseLink,
  referenceImagePath,
  referenceImagePaths,
}: Props) {
  const imagePaths = resolveItemReferenceImagePaths(
    referenceImagePaths,
    referenceImagePath,
  );
  if (imagePaths.length > 0) {
    return (
      <div
        className="flex max-w-[280px] flex-wrap gap-2"
        aria-label={`参考图片（${imagePaths.length} 张）`}
      >
        {imagePaths.map((imagePath) => (
          <AttachmentFileLink
            key={imagePath}
            filePath={imagePath}
            previewClassName="h-16 w-20 rounded border object-contain"
          />
        ))}
      </div>
    );
  }

  if (purchaseLink) {
    return (
      <a
        href={purchaseLink}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        链接
      </a>
    );
  }

  return <span className="text-muted-foreground">—</span>;
}
