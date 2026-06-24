import type { OrderStatus, Prisma } from "@prisma/client";

/** 订单列表 / 首页：草稿仅发起人本人可见 */
export function procurementListWhere(
  userOpenId?: string,
  options?: { includeRejected?: boolean },
): Prisma.PurchaseOrderWhereInput {
  const nonDraft: Prisma.PurchaseOrderWhereInput = options?.includeRejected
    ? { status: { not: "DRAFT" } }
    : { status: { notIn: ["DRAFT", "REJECTED"] } };

  if (!userOpenId) {
    return nonDraft;
  }

  const ownDraft: Prisma.PurchaseOrderWhereInput = {
    status: "DRAFT",
    initiator: { openId: userOpenId },
  };

  if (options?.includeRejected) {
    return {
      OR: [nonDraft, ownDraft, { status: "REJECTED", initiator: { openId: userOpenId } }],
    };
  }

  return {
    OR: [nonDraft, ownDraft],
  };
}

/** 看板明细汇总：仅已提交（非草稿、非驳回） */
export function procurementSummaryWhere(): Prisma.PurchaseOrderWhereInput {
  return { status: { notIn: ["DRAFT", "REJECTED"] } };
}

export function canViewProcurementOrder(
  status: OrderStatus,
  viewerOpenId: string | undefined,
  initiatorOpenId: string,
  viewerIsSuperAdmin: boolean,
): boolean {
  if (status !== "DRAFT") return true;
  if (viewerIsSuperAdmin) return true;
  return !!viewerOpenId && viewerOpenId === initiatorOpenId;
}
