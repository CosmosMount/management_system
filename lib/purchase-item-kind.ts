export const PURCHASE_ITEM_KINDS = [
  "COMPONENT",
  "STANDARD_PART",
  "PROCESSING_FEE",
] as const;

export type PurchaseItemKind = (typeof PURCHASE_ITEM_KINDS)[number];

export const purchaseItemKindLabels: Record<PurchaseItemKind, string> = {
  COMPONENT: "元器件",
  STANDARD_PART: "标准件",
  PROCESSING_FEE: "加工费",
};

export function formatPurchaseItemKind(
  kind: PurchaseItemKind | string | null | undefined,
): string {
  if (!kind) return "—";
  return purchaseItemKindLabels[kind as PurchaseItemKind] ?? String(kind);
}

export function itemKindNeedsLink(kind: PurchaseItemKind): boolean {
  return kind === "COMPONENT";
}

export function itemKindNeedsImage(kind: PurchaseItemKind): boolean {
  return kind === "STANDARD_PART" || kind === "PROCESSING_FEE";
}
