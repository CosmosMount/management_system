import type { OrderStatus, UserRoleType } from "@prisma/client";

export type UserRoleRecord = {
  role: UserRoleType;
  team: string;
  techGroup: string;
};

export type OrderScope = {
  team: string;
  techGroup: string;
};

export type ManagementApprovalState = {
  teamApproved: boolean;
  techGroupApproved: boolean;
};

export function getStatusTransition(status: OrderStatus) {
  const statusTransitions: Partial<
    Record<OrderStatus, { role: UserRoleType; next: OrderStatus }>
  > = {
    TEACHER_REVIEW: { role: "TEACHER", next: "PENDING_APPLICANT_DOCS" },
  };
  return statusTransitions[status] ?? null;
}

function roleMatchesOrder(
  record: UserRoleRecord,
  requiredRole: UserRoleType,
  order: OrderScope,
): boolean {
  if (record.role !== requiredRole) return false;
  if (requiredRole === "TEAM_ADMIN" || requiredRole === "FINANCE") {
    return record.team === order.team;
  }
  if (
    requiredRole === "TECH_GROUP_ADMIN" ||
    requiredRole === "TEACHER"
  ) {
    return record.techGroup === order.techGroup;
  }
  return record.team === "" && record.techGroup === "";
}

export function canApproveTeamManagement(
  userRoles: UserRoleRecord[],
  order: OrderScope,
  state: ManagementApprovalState,
): boolean {
  if (state.teamApproved) return false;
  return userRoles.some(
    (r) => r.role === "TEAM_ADMIN" && r.team === order.team,
  );
}

export function canApproveTechGroupManagement(
  userRoles: UserRoleRecord[],
  order: OrderScope,
  state: ManagementApprovalState,
): boolean {
  if (state.techGroupApproved) return false;
  return userRoles.some(
    (r) => r.role === "TECH_GROUP_ADMIN" && r.techGroup === order.techGroup,
  );
}

/** 管理审核通过前须已上传电子签名（签名将填入验收清单） */
export function needsSignatureForProcurementApproval(
  status: OrderStatus,
  userRoles: UserRoleRecord[],
  order: OrderScope,
  managementState: ManagementApprovalState,
): boolean {
  if (status !== "MANAGEMENT_REVIEW") return false;
  return (
    canApproveTeamManagement(userRoles, order, managementState) ||
    canApproveTechGroupManagement(userRoles, order, managementState)
  );
}

export function canApproveOrder(
  status: OrderStatus,
  userRoles: UserRoleRecord[],
  order: OrderScope,
  managementState?: ManagementApprovalState,
): boolean {
  if (status === "REJECTED" || status === "COMPLETED" || status === "DRAFT") {
    return false;
  }
  if (status === "MANAGEMENT_REVIEW" && managementState) {
    return (
      canApproveTeamManagement(userRoles, order, managementState) ||
      canApproveTechGroupManagement(userRoles, order, managementState)
    );
  }

  const transition = getStatusTransition(status);
  if (!transition) return false;
  return userRoles.some((r) =>
    roleMatchesOrder(r, transition.role, order),
  );
}

export function isOrderInitiator(
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  return !!userOpenId && userOpenId === initiatorOpenId;
}

export function canEditDraftOrder(
  status: OrderStatus,
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  return status === "DRAFT" && isOrderInitiator(userOpenId, initiatorOpenId);
}

/** 老师审核通过前，采购人可编辑清单并重新提交 */
export function canEditProcurementOrder(
  status: OrderStatus,
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  if (!isOrderInitiator(userOpenId, initiatorOpenId)) {
    return false;
  }
  return (
    status === "DRAFT" ||
    status === "MANAGEMENT_REVIEW" ||
    status === "TEACHER_REVIEW"
  );
}

export function canWithdrawProcurementOrder(
  status: OrderStatus,
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  if (!isOrderInitiator(userOpenId, initiatorOpenId)) {
    return false;
  }
  return status === "MANAGEMENT_REVIEW" || status === "TEACHER_REVIEW";
}

export function canUploadApplicantDocs(
  status: OrderStatus,
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  return (
    status === "PENDING_APPLICANT_DOCS" &&
    isOrderInitiator(userOpenId, initiatorOpenId)
  );
}

export function canUploadFinanceScreenshot(
  status: OrderStatus,
  userRoles: UserRoleRecord[],
  order: OrderScope,
): boolean {
  return (
    status === "PENDING_FINANCE_REVIEW" &&
    userRoles.some(
      (r) => r.role === "FINANCE" && r.team === order.team,
    )
  );
}

export function canConfirmReimbursement(
  status: OrderStatus,
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  return (
    status === "PENDING_APPLICANT_CONFIRM" &&
    isOrderInitiator(userOpenId, initiatorOpenId)
  );
}

/** 采购人或超级管理员可催促当前环节审批人 */
export function canNotifyProcurementApprover(
  status: OrderStatus,
  userOpenId: string | undefined,
  initiatorOpenId: string,
  userRoles: UserRoleRecord[] = [],
): boolean {
  const remindableStatuses: OrderStatus[] = [
    "MANAGEMENT_REVIEW",
    "TEACHER_REVIEW",
    "PENDING_FINANCE_REVIEW",
  ];
  if (!remindableStatuses.includes(status)) {
    return false;
  }
  return (
    isOrderInitiator(userOpenId, initiatorOpenId) ||
    isSuperAdmin(userRoles)
  );
}

/** 报销相关附件：采购人、对应车组报销员、超级管理员可查看 */
export function canViewReimbursementAttachments(
  status: OrderStatus,
  userRoles: UserRoleRecord[],
  order: OrderScope,
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  const financeStages: OrderStatus[] = [
    "PENDING_FINANCE_REVIEW",
    "PENDING_APPLICANT_CONFIRM",
    "COMPLETED",
  ];
  if (!financeStages.includes(status)) {
    return isOrderInitiator(userOpenId, initiatorOpenId);
  }
  if (isOrderInitiator(userOpenId, initiatorOpenId)) return true;
  if (isSuperAdmin(userRoles)) return true;
  return userRoles.some(
    (r) => r.role === "FINANCE" && r.team === order.team,
  );
}

export function isSuperAdmin(userRoles: UserRoleRecord[]): boolean {
  return userRoles.some((r) => r.role === "SUPER_ADMIN");
}

/** 采购审批阶段（管理/老师）是否可驳回 */
export function canRejectProcurement(
  status: OrderStatus,
  userRoles: UserRoleRecord[],
  order: OrderScope,
): boolean {
  if (isSuperAdmin(userRoles)) {
    return status === "MANAGEMENT_REVIEW" || status === "TEACHER_REVIEW";
  }
  if (status === "MANAGEMENT_REVIEW") {
    return userRoles.some(
      (r) =>
        (r.role === "TEAM_ADMIN" && r.team === order.team) ||
        (r.role === "TECH_GROUP_ADMIN" && r.techGroup === order.techGroup),
    );
  }
  if (status === "TEACHER_REVIEW") {
    return userRoles.some(
      (r) => r.role === "TEACHER" && r.techGroup === order.techGroup,
    );
  }
  return false;
}

/** 各审批环节是否可驳回（含报销员退回凭证） */
export function canRejectProcurementOrder(
  status: OrderStatus,
  userRoles: UserRoleRecord[],
  order: OrderScope,
): boolean {
  return (
    canRejectProcurement(status, userRoles, order) ||
    canRequestApplicantResubmit(status, userRoles, order)
  );
}

/** 报销员要求采购人重新提交凭证 */
export function canRequestApplicantResubmit(
  status: OrderStatus,
  userRoles: UserRoleRecord[],
  order: OrderScope,
): boolean {
  return (
    status === "PENDING_FINANCE_REVIEW" &&
    userRoles.some(
      (r) => r.role === "FINANCE" && r.team === order.team,
    )
  );
}

export const statusLabels: Record<OrderStatus, string> = {
  DRAFT: "草稿",
  MANAGEMENT_REVIEW: "管理审核",
  TEACHER_REVIEW: "老师审核",
  PENDING_APPLICANT_DOCS: "待上传凭证",
  PENDING_FINANCE_REVIEW: "待报销截图",
  PENDING_APPLICANT_CONFIRM: "待确认",
  COMPLETED: "已完成",
  REJECTED: "已驳回",
};

export const roleLabels: Record<UserRoleType, string> = {
  SUPER_ADMIN: "超级管理员",
  TEAM_ADMIN: "车组组长",
  TECH_GROUP_ADMIN: "技术组组长",
  TEACHER: "指导老师",
  FINANCE: "报销员",
  PROJECT_MANAGER: "项管",
};

/** 订单处于该状态时，应私信通知的审批角色（管理审核单独处理） */
export const statusApproverRole: Partial<Record<OrderStatus, UserRoleType>> = {
  TEACHER_REVIEW: "TEACHER",
  PENDING_FINANCE_REVIEW: "FINANCE",
};

export function formatRoleLabel(record: UserRoleRecord): string {
  const base = roleLabels[record.role];
  if (
    (record.role === "TECH_GROUP_ADMIN" || record.role === "TEACHER") &&
    record.techGroup
  ) {
    return `${base}（${record.techGroup}）`;
  }
  if (record.team) {
    return `${base}（${record.team}）`;
  }
  return base;
}
