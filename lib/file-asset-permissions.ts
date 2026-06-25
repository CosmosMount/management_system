import type { FileAsset, UserRoleType } from "@prisma/client";
import { canViewReimbursementAttachments } from "@/lib/permissions-client";
import { canViewProcurementOrder } from "@/lib/procurement-visibility";
import { prisma } from "@/lib/prisma";
import type { UserRoleRecord } from "@/lib/permissions-client";

function isSuperAdmin(roles: UserRoleRecord[]): boolean {
  return roles.some((role) => role.role === "SUPER_ADMIN");
}

function canViewOrderItemImage({
  orderStatus,
  userOpenId,
  initiatorOpenId,
  roles,
}: {
  orderStatus: Parameters<typeof canViewProcurementOrder>[0];
  userOpenId: string;
  initiatorOpenId: string;
  roles: UserRoleRecord[];
}): boolean {
  if (canViewProcurementOrder(orderStatus, userOpenId, initiatorOpenId, isSuperAdmin(roles))) {
    return true;
  }
  return false;
}

async function canViewOrderAsset(
  asset: FileAsset,
  userOpenId: string,
  roles: UserRoleRecord[],
): Promise<boolean> {
  if (!asset.orderId) return false;
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: asset.orderId },
    include: { initiator: { select: { openId: true } } },
  });
  if (!order) return false;

  if (asset.kind === "ORDER_ITEM_IMAGE") {
    return canViewOrderItemImage({
      orderStatus: order.status,
      userOpenId,
      initiatorOpenId: order.initiator.openId,
      roles,
    });
  }

  return canViewReimbursementAttachments(
    order.status,
    roles,
    { team: order.team, techGroup: order.techGroup },
    userOpenId,
    order.initiator.openId,
  );
}

async function canViewFeedbackAsset(
  asset: FileAsset,
  userOpenId: string,
  roles: UserRoleRecord[],
): Promise<boolean> {
  if (!asset.feedbackId) return false;
  if (isSuperAdmin(roles)) return true;
  const feedback = await prisma.feedback.findUnique({
    where: { id: asset.feedbackId },
    select: { submitterOpenId: true },
  });
  return feedback?.submitterOpenId === userOpenId;
}

export async function canViewFileAsset({
  asset,
  userOpenId,
  roles,
}: {
  asset: FileAsset;
  userOpenId: string;
  roles: UserRoleRecord[];
}): Promise<boolean> {
  if (isSuperAdmin(roles)) return true;

  if (asset.ownerOpenId && asset.ownerOpenId === userOpenId) return true;

  switch (asset.kind) {
    case "ORDER_ATTACHMENT":
    case "ORDER_ITEM_IMAGE":
      return canViewOrderAsset(asset, userOpenId, roles);
    case "FEEDBACK_ATTACHMENT":
      return canViewFeedbackAsset(asset, userOpenId, roles);
    case "USER_SIGNATURE":
      return asset.signatureOwnerOpenId === userOpenId;
    case "TEMP_UPLOAD":
      return asset.ownerOpenId === userOpenId;
    default: {
      const _exhaustive: never = asset.kind;
      void _exhaustive;
      return false;
    }
  }
}

export function roleTypes(roles: UserRoleRecord[]): UserRoleType[] {
  return roles.map((role) => role.role);
}
