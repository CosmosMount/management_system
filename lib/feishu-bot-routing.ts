import type { OrderStatus } from "@prisma/client";
import type { FeishuBotKind } from "@/lib/feishu-app-config";

const PROCUREMENT_APPROVAL_STATUSES = new Set<OrderStatus>([
  "MANAGEMENT_REVIEW",
  "TEACHER_REVIEW",
  "PENDING_FINANCE_REVIEW",
  "PENDING_APPLICANT_CONFIRM",
]);

export function resolveProcurementBotKind(
  status: OrderStatus,
): FeishuBotKind {
  return PROCUREMENT_APPROVAL_STATUSES.has(status)
    ? "approval"
    : "notification";
}

export function isProcurementApprovalNotification(
  status: OrderStatus,
): boolean {
  return resolveProcurementBotKind(status) === "approval";
}
