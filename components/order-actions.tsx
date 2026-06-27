"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { approveManagementReview } from "@/app/actions/approveManagementReview";
import { rejectProcurementOrder } from "@/app/actions/rejectOrder";
import { updateOrderStatus } from "@/app/actions/updateOrderStatus";
import { ProcurementRejectDialog } from "@/components/procurement-reject-dialog";
import { SignatureRequiredDialog } from "@/components/signature-required-dialog";
import { Button } from "@/components/ui/button";
import { OrderStatus } from "@prisma/client";
import {
  canApproveOrder,
  canApproveTeamManagement,
  canApproveTechGroupManagement,
  canRejectProcurement,
  getStatusTransition,
  needsSignatureForProcurementApproval,
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
  hasSignature: boolean;
};

export function OrderActions({
  orderId,
  status,
  order,
  userRoles,
  managementState,
  hasSignature,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [signatureDialogOpen, setSignatureDialogOpen] = useState(false);

  const canReject = canRejectProcurement(status, userRoles, order);
  const signatureRequired = needsSignatureForProcurementApproval(
    status,
    userRoles,
    order,
    managementState,
  );

  function guardApprove(action: () => void) {
    if (signatureRequired && !hasSignature) {
      setSignatureDialogOpen(true);
      return;
    }
    action();
  }

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

    async function handleReject(reason: string, outcome: "terminate" | "resubmit") {
      try {
        await rejectProcurementOrder({ orderId, reason, outcome });
        toast.success(
          outcome === "terminate" ? "已驳回，已通知采购人" : "已退回草稿，已通知采购人修改",
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败");
        throw err;
      }
    }

    return (
      <>
        <div className="flex flex-wrap gap-2">
          {showTeam && (
            <Button
              onClick={() => guardApprove(handleManagementApprove)}
              disabled={pending || loading}
              size="sm"
            >
              {roleLabels.TEAM_ADMIN}通过
            </Button>
          )}
          {showTech && (
            <Button
              onClick={() => guardApprove(handleManagementApprove)}
              disabled={pending || loading}
              size="sm"
            >
              {roleLabels.TECH_GROUP_ADMIN}通过
            </Button>
          )}
          {canReject && (
            <ProcurementRejectDialog
              stage="approval"
              title="驳回采购申请"
              reasonLabel="驳回说明"
              disabled={pending || loading}
              onConfirm={handleReject}
            />
          )}
        </div>
        <SignatureRequiredDialog
          open={signatureDialogOpen}
          onOpenChange={setSignatureDialogOpen}
        />
      </>
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

  async function handleReject(reason: string, outcome: "terminate" | "resubmit") {
    try {
      await rejectProcurementOrder({ orderId, reason, outcome });
      toast.success(
        outcome === "terminate" ? "已驳回，已通知采购人" : "已退回草稿，已通知采购人修改",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
      throw err;
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {canApprove && (
          <Button
            onClick={() => guardApprove(handleApprove)}
            disabled={pending || loading}
            size="sm"
          >
            {label}
          </Button>
        )}
        {canReject && (
          <ProcurementRejectDialog
            stage="approval"
            title="驳回采购申请"
            reasonLabel="驳回说明"
            disabled={pending || loading}
            onConfirm={handleReject}
          />
        )}
      </div>
      <SignatureRequiredDialog
        open={signatureDialogOpen}
        onOpenChange={setSignatureDialogOpen}
      />
    </>
  );
}
