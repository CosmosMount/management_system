export type ProcurementOrderStatus =
  | "DRAFT"
  | "MANAGEMENT_REVIEW"
  | "TEACHER_REVIEW"
  | "PENDING_APPLICANT_DOCS"
  | "PENDING_FINANCE_REVIEW"
  | "PENDING_APPLICANT_CONFIRM"
  | "COMPLETED"
  | "REJECTED";

export type OrderItemSummary = {
  name: string;
  quantity: number;
  unitPrice: number;
};

export function mapOrderItems(
  items: { name: string; quantity: number; unitPrice: number }[],
): OrderItemSummary[] {
  return items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  }));
}

export type OrderCardPayload = {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: ProcurementOrderStatus;
  team: string;
  techGroup: string;
  items?: OrderItemSummary[];
  screenshotPath?: string | null;
  invoicePaths?: string | null;
  invoicePath?: string | null;
  listDocPath?: string | null;
};

export type BudgetThresholdPayload = {
  description: string;
  team: string;
  /** 旧通知兼容字段；新预算事件只按兵种组聚合。 */
  techGroup?: string;
  period: string;
  budgetAmount: number;
  usedAmount: number;
  usagePercent: number;
  threshold: number;
  recipientOpenIds: string[];
};
