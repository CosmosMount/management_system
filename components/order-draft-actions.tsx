"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { submitDraftOrder } from "@/app/actions/updateOrder";
import { Button, buttonVariants } from "@/components/ui/button";
import type { OrderStatus } from "@prisma/client";
import { canEditDraftOrder } from "@/lib/permissions-client";
import { cn } from "@/lib/utils";
import { routes } from "@/lib/routes";

type Props = {
  orderId: string;
  status: OrderStatus;
  userOpenId?: string;
  initiatorOpenId: string;
};

export function OrderDraftActions({
  orderId,
  status,
  userOpenId,
  initiatorOpenId,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);

  if (!canEditDraftOrder(status, userOpenId, initiatorOpenId)) {
    return null;
  }

  function handleSubmit() {
    setLoading(true);
    startTransition(async () => {
      try {
        await submitDraftOrder(orderId);
        toast.success("申请已提交");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "提交失败");
      } finally {
        setLoading(false);
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Link
        href={`${routes.procurement.edit(orderId)}`}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        继续编辑
      </Link>
      <Button
        size="sm"
        onClick={handleSubmit}
        disabled={pending || loading}
      >
        提交申请
      </Button>
    </div>
  );
}
