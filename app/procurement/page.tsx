import Link from "next/link";
import {
  ClipboardList,
  FilePlus2,
  Hammer,
  LayoutDashboard,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { NavCard } from "@/components/nav-card";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { statusLabels } from "@/lib/permissions";
import { procurementListWhere } from "@/lib/procurement-visibility";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { auth } from "@/lib/auth";

export default async function ProcurementHomePage() {
  const liveVersion = await getCurrentUserLiveVersion("procurement");
  const session = await auth();
  const orders = await prisma.purchaseOrder.findMany({
    where: procurementListWhere(session?.user?.openId),
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="procurement"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <ProcurementPageLayout>
          <PageTitle subtitle="采购管理" />

          <div className="mb-10 flex w-full flex-col gap-4">
            <NavCard
              variant="wide"
              href={routes.procurement.new}
              title="新建申请"
              description="填写采购明细并提交审批"
              icon={FilePlus2}
            />
            <NavCard
              variant="wide"
              href={routes.procurement.workshopFee}
              title="工坊加工费"
              description="录入加工费并上传图片，直接计入采购汇总"
              icon={Hammer}
            />
            <NavCard
              variant="wide"
              href={routes.procurement.list}
              title="订单列表"
              description="查看与管理全部采购订单"
              icon={ClipboardList}
            />
            <NavCard
              variant="wide"
              href={routes.procurement.dashboard}
              title="采购看板"
              description="采购统计图表与明细汇总"
              icon={LayoutDashboard}
            />
          </div>

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
                <ul className="space-y-2">
                  {orders.map((order) => (
                    <li key={order.id}>
                      <Link
                        href={routes.procurement.detail(order.id)}
                        className="flex items-center justify-between rounded-lg border p-3 hover:border-primary/30"
                      >
                        <div>
                          <p className="font-medium">{order.orderNo}</p>
                          <p className="text-sm text-muted-foreground">
                            {order.initiatorName} · {order.team} /{" "}
                            {order.techGroup} · ¥{order.totalPrice.toFixed(2)}
                          </p>
                        </div>
                        <Badge variant="secondary">
                          {statusLabels[order.status]}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
