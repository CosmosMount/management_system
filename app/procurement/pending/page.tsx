import Link from "next/link";
import {
  ArrowRight,
  ClipboardCheck,
  ClipboardList,
  FileText,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProcurementPageHeader } from "@/components/procurement/procurement-page-header";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getUserRoles, statusLabels } from "@/lib/permissions";
import {
  getProcurementPendingOrders,
  procurementPendingOrderHref,
} from "@/lib/procurement-pending-orders";
import { procurementListWhere } from "@/lib/procurement-visibility";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { isActiveFeishuOpenId } from "@/lib/active-account";

export default async function ProcurementPendingPage() {
  const liveVersion = await getCurrentUserLiveVersion("procurement");
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const activeOpenId =
    userOpenId && (await isActiveFeishuOpenId(userOpenId))
      ? userOpenId
      : undefined;
  const roles = activeOpenId ? await getUserRoles(activeOpenId) : [];
  const [pendingOrders, orders] = await Promise.all([
    getProcurementPendingOrders({ userOpenId: activeOpenId, roles }),
    prisma.purchaseOrder.findMany({
      where: procurementListWhere(userOpenId),
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <>
      <LiveAutoRefresh
        scope="procurement"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <ProcurementPageHeader
        title="待办与最近"
        description="集中查看当前需要处理的订单和最近订单"
      />
      <ProcurementPageLayout className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5" />
              待处理订单
              {pendingOrders.length > 0 && (
                <Badge variant="secondary">{pendingOrders.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingOrders.length === 0 ? (
              <p className="text-muted-foreground">暂无待处理订单</p>
            ) : (
              <OrderLinks
                orders={pendingOrders.map((order) => ({
                  ...order,
                  href: procurementPendingOrderHref(order.id, order.status),
                }))}
                testId="procurement-pending-orders"
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" />
              最近订单
            </CardTitle>
            <Link
              href={routes.procurement.list}
              className="text-sm text-primary hover:underline"
            >
              查看全部
            </Link>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <p className="text-muted-foreground">暂无订单</p>
            ) : (
              <OrderLinks
                orders={orders.map((order) => ({
                  ...order,
                  href: routes.procurement.detail(order.id),
                }))}
              />
            )}
          </CardContent>
        </Card>
      </ProcurementPageLayout>
    </>
  );
}

function OrderLinks({
  orders,
  testId,
}: {
  orders: Array<{
    id: string;
    href: string;
    orderNo: string;
    initiatorName: string;
    team: string;
    techGroup: string;
    totalPrice: number;
    status: keyof typeof statusLabels;
  }>;
  testId?: string;
}) {
  return (
    <ul className="space-y-2" data-testid={testId}>
      {orders.map((order) => (
        <li key={order.id}>
          <Link
            href={order.href}
            className="flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:border-primary/30 hover:bg-muted/30"
          >
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-1.5 font-medium">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{order.orderNo}</span>
              </p>
              <p className="break-words text-sm text-muted-foreground">
                {order.initiatorName} · {order.team} / {order.techGroup} · ¥
                {order.totalPrice.toFixed(2)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary">{statusLabels[order.status]}</Badge>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
