"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { approveManagementReview } from "@/app/actions/approveManagementReview";
import { rejectProcurementOrder } from "@/app/actions/rejectOrder";
import { updateOrderStatus } from "@/app/actions/updateOrderStatus";
import { ReasonConfirmDialog } from "@/components/reason-confirm-dialog";
import { Button } from "@/components/ui/button";
import { OrderStatus } from "@prisma/client";
import {
  canApproveOrder,
  canApproveTeamManagement,
  canApproveTechGroupManagement,
  canRejectProcurement,
  getStatusTransition,
  roleLabels,
  type ManagementApprovalState,
  type OrderScope,
  type UserRoleRecord,
} from "@/lib/permissions-client";

type Props = {
  orderId: string;
  status: OrderStatus;
  order: OrderScope;
  userRoles: UserRoleRecord[];
  managementState: ManagementApprovalState;
};

export function OrderActions({
  orderId,
  status,
  order,
  userRoles,
  managementState,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);

  const canReject = canRejectProcurement(status, userRoles, order);

  if (status === OrderStatus.MANAGEMENT_REVIEW) {
    const showTeam = canApproveTeamManagement(
      userRoles,
      order,
      managementState,
    );
    const showTech = canApproveTechGroupManagement(
      userRoles,
      order,
      managementState,
    );

    if (!showTeam && !showTech && !canReject) return null;

    function handleManagementApprove() {
      setLoading(true);
      startTransition(async () => {
        try {
          await approveManagementReview(orderId);
          toast.success("管理审核已通过");
          router.refresh();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "操作失败");
        } finally {
          setLoading(false);
        }
      });
    }

    async function handleReject(reason: string) {
      await rejectProcurementOrder({ orderId, reason });
      toast.success("已驳回，已通知采购人");
      router.refresh();
    }

    return (
      <div className="flex flex-wrap gap-2">
        {showTeam && (
          <Button
            onClick={handleManagementApprove}
            disabled={pending || loading}
            size="sm"
          >
            {roleLabels.TEAM_ADMIN}通过
          </Button>
        )}
        {showTech && (
          <Button
            onClick={handleManagementApprove}
            disabled={pending || loading}
            size="sm"
          >
            {roleLabels.TECH_GROUP_ADMIN}通过
          </Button>
        )}
        {canReject && (
          <ReasonConfirmDialog
            triggerLabel="驳回"
            title="驳回采购申请"
            description="驳回后本次采购终止，不计入采购汇总，原因将发送给采购人。"
            reasonLabel="驳回原因"
            confirmLabel="确认驳回"
            disabled={pending || loading}
            onConfirm={handleReject}
          />
        )}
      </div>
    );
  }

  const canApprove = canApproveOrder(
    status,
    userRoles,
    order,
    managementState,
  );

  if (!canApprove && !canReject) return null;

  const transition = getStatusTransition(status);
  const label = transition
    ? `${roleLabels[transition.role]}通过`
    : "通过";

  function handleApprove() {
    setLoading(true);
    startTransition(async () => {
      try {
        await updateOrderStatus(orderId);
        toast.success("操作成功");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败");
      } finally {
        setLoading(false);
      }
    });
  }

  async function handleReject(reason: string) {
    await rejectProcurementOrder({ orderId, reason });
    toast.success("已驳回，已通知采购人");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canApprove && (
        <Button onClick={handleApprove} disabled={pending || loading} size="sm">
          {label}
        </Button>
      )}
      {canReject && (
        <ReasonConfirmDialog
          triggerLabel="驳回"
          title="驳回采购申请"
          description="驳回后本次采购终止，不计入采购汇总，原因将发送给采购人。"
          reasonLabel="驳回原因"
          confirmLabel="确认驳回"
          disabled={pending || loading}
          onConfirm={handleReject}
        />
      )}
    </div>
  );
}
