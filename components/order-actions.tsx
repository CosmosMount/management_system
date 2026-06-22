"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateOrderStatus } from "@/app/actions/updateOrderStatus";
import { Button } from "@/components/ui/button";
import type { UserRoleType } from "@prisma/client";
import { OrderStatus } from "@prisma/client";
import { getStatusTransition, roleLabels } from "@/lib/permissions-client";

type Props = {
  orderId: string;
  status: OrderStatus;
  userRole: UserRoleType | null;
};

export function OrderActions({ orderId, status, userRole }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);

  const transition = getStatusTransition(status);
  if (!transition || transition.role !== userRole) {
    return null;
  }

  const label =
    status === OrderStatus.PENDING_REIMBURSE
      ? "接单报销"
      : `${roleLabels[transition.role]}通过`;

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

  return (
    <Button onClick={handleApprove} disabled={pending || loading} size="sm">
      {label}
    </Button>
  );
}
