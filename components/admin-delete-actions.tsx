"use client";

import { deletePurchaseOrder } from "@/app/actions/adminDeleteRecords";
import { AdminDeleteRecordButton } from "@/components/admin-delete-record-button";
import { isSuperAdmin, type UserRoleRecord } from "@/lib/permissions-client";
import { routes } from "@/lib/routes";

type PurchaseOrderDeleteProps = {
  orderId: string;
  userRoles: UserRoleRecord[];
  redirectTo?: string;
};

export function PurchaseOrderDeleteButton({
  orderId,
  userRoles,
  redirectTo = routes.procurement.list,
}: PurchaseOrderDeleteProps) {
  if (!isSuperAdmin(userRoles)) return null;

  return (
    <AdminDeleteRecordButton
      title="删除采购订单"
      description="将永久删除该订单、明细及已上传附件，此操作不可恢复。"
      onConfirm={() => deletePurchaseOrder(orderId)}
      redirectTo={redirectTo}
    />
  );
}

type PurchaseOrderDeleteByAdminProps = {
  orderId: string;
  isSuperAdmin: boolean;
  redirectTo?: string;
};

export function PurchaseOrderDeleteByAdminButton({
  orderId,
  isSuperAdmin: admin,
  redirectTo = routes.procurement.list,
}: PurchaseOrderDeleteByAdminProps) {
  if (!admin) return null;

  return (
    <AdminDeleteRecordButton
      title="删除采购订单"
      description="将永久删除该订单、明细及已上传附件，此操作不可恢复。"
      onConfirm={() => deletePurchaseOrder(orderId)}
      redirectTo={redirectTo}
    />
  );
}
