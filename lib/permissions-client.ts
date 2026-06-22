import type { OrderStatus, UserRoleType } from "@prisma/client";

export function getStatusTransition(status: OrderStatus) {
  const statusTransitions: Partial<
    Record<OrderStatus, { role: UserRoleType; next: OrderStatus }>
  > = {
    TECH_REVIEW: { role: "TECH", next: "TEACHER_REVIEW" },
    TEACHER_REVIEW: { role: "TEACHER", next: "PENDING_REIMBURSE" },
    PENDING_REIMBURSE: { role: "FINANCE", next: "REIMBURSING" },
  };
  return statusTransitions[status] ?? null;
}

export function canUploadReimbursement(
  status: OrderStatus,
  role: UserRoleType | null,
): boolean {
  return (
    role === "FINANCE" &&
    (status === "PENDING_REIMBURSE" || status === "REIMBURSING")
  );
}

export const statusLabels: Record<OrderStatus, string> = {
  DRAFT: "草稿",
  TECH_REVIEW: "技术组审核",
  TEACHER_REVIEW: "老师审核",
  PENDING_REIMBURSE: "待报销",
  REIMBURSING: "报销中",
  COMPLETED: "已完成",
};

export const roleLabels: Record<UserRoleType, string> = {
  TECH: "技术组",
  TEACHER: "指导老师",
  FINANCE: "报销员",
};
