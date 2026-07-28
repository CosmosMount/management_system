import { Fragment } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { statusLabels } from "@/lib/permissions-client";
import type { ProfileOrderRow } from "@/lib/profile-records";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

function formatScopeItem(value: string): string {
  return value || "未指定";
}

function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SectionIntro({
  activeCount,
  totalCount,
}: {
  activeCount: number;
  totalCount: number;
}) {
  if (totalCount === 0) {
    return null;
  }
  return (
    <p className="mb-4 text-sm text-muted-foreground">
      共 {totalCount} 条，进行中 {activeCount} 条（已优先展示）
    </p>
  );
}

function ActiveDivider({
  show,
  label,
}: {
  show: boolean;
  label: string;
}) {
  if (!show) {
    return null;
  }
  return (
    <li className="list-none pt-2">
      <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
    </li>
  );
}

export function ProfileOrderList({ orders }: { orders: ProfileOrderRow[] }) {
  if (orders.length === 0) {
    return <p className="text-muted-foreground">暂无采购申请</p>;
  }

  const activeCount = orders.filter((order) => order.isActive).length;
  const firstInactiveIndex = orders.findIndex((order) => !order.isActive);

  return (
    <>
      <SectionIntro activeCount={activeCount} totalCount={orders.length} />
      <ul className="space-y-2">
        {orders.map((order, index) => {
          const showDivider =
            index === firstInactiveIndex && activeCount > 0;
          return (
            <Fragment key={order.id}>
              <ActiveDivider show={showDivider} label="其他状态" />
              <li>
                <Link
                  href={routes.procurement.detail(order.id)}
                  className={cn(
                    "flex items-center justify-between rounded-lg border p-3 transition-colors hover:border-primary/30",
                    order.isActive && "border-primary/20 bg-primary/5",
                  )}
                >
                  <div className="min-w-0 pr-3">
                    <p className="font-medium">{order.orderNo}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatScopeItem(order.team)} /{" "}
                      {formatScopeItem(order.techGroup)} · ¥
                      {order.totalPrice.toFixed(2)} ·{" "}
                      {formatUpdatedAt(order.updatedAt)}
                    </p>
                  </div>
                  <Badge variant={order.isActive ? "default" : "secondary"}>
                    {statusLabels[order.status]}
                  </Badge>
                </Link>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}
