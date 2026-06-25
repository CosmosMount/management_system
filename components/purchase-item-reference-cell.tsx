import { AttachmentFileLink } from "@/components/attachment-file-link";
import type { PurchaseItemKind } from "@/lib/purchase-item-kind";

type Props = {
  itemKind: PurchaseItemKind;
  purchaseLink: string;
  referenceImagePath: string | null;
};

export function PurchaseItemReferenceCell({
  purchaseLink,
  referenceImagePath,
}: Props) {
  if (referenceImagePath) {
    return (
      <AttachmentFileLink
        filePath={referenceImagePath}
        previewClassName="max-h-16 max-w-[120px] rounded border object-contain"
      />
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
