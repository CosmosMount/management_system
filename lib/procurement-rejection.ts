import { OrderStatus } from "@prisma/client";

export function clearProcurementRejectionFields() {
  return {
    rejectionReason: null,
    rejectedAt: null,
    rejectedByName: null,
  };
}

/** 仅在仍需采购人处理的环节展示退回/驳回说明 */
export function shouldShowProcurementRejectionNotice(
  status: OrderStatus,
  rejectionReason?: string | null,
): boolean {
  if (!rejectionReason?.trim()) return false;
  return (
    status === OrderStatus.DRAFT ||
    status === OrderStatus.PENDING_APPLICANT_DOCS ||
    status === OrderStatus.REJECTED
  );
}
