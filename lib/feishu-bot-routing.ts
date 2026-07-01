import type { OrderStatus } from "@prisma/client";
import type { FeishuBotKind } from "@/lib/feishu-app-config";

const PROGRESS_APPROVAL_NOTIFICATION_TYPES = new Set<string>([
  "project_establishment_requested",
  "stage_pending_acceptance",
  "project_stage_extension_requested",
  "project_stage_batch_due_change_requested",
  "project_stage_due_change_requested",
  "task_ddl_change_requested",
  "task_delete_requested",
  "task_creation_requested",
  "task_bulk_creation_requested",
  "task_pending_acceptance",
]);

const PROCUREMENT_APPROVAL_STATUSES = new Set<OrderStatus>([
  "MANAGEMENT_REVIEW",
  "TEACHER_REVIEW",
  "PENDING_FINANCE_REVIEW",
  "PENDING_APPLICANT_CONFIRM",
]);

export function resolveProgressBotKind(type: string): FeishuBotKind {
  return PROGRESS_APPROVAL_NOTIFICATION_TYPES.has(type)
    ? "approval"
    : "notification";
}

export function resolveProcurementBotKind(
  status: OrderStatus,
): FeishuBotKind {
  return PROCUREMENT_APPROVAL_STATUSES.has(status)
    ? "approval"
    : "notification";
}

export function isProgressApprovalNotification(type: string): boolean {
  return resolveProgressBotKind(type) === "approval";
}

export function isProcurementApprovalNotification(
  status: OrderStatus,
): boolean {
  return resolveProcurementBotKind(status) === "approval";
}
