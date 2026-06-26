import type { OrderStatus, PurchaseItemKind } from "@prisma/client";

export type SummaryRow = {
  orderId: string;
  orderNo: string;
  initiatorName: string;
  team: string;
  techGroup: string;
  status: OrderStatus;
  itemName: string;
  spec: string;
  itemKind: PurchaseItemKind;
  purchaseLink: string;
  referenceImagePath: string | null;
  processingVendor: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  orderTotal: number;
  createdAt: string;
};
