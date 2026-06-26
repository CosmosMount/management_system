import { AppHeader } from "@/components/app-header";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProcurementDashboardCharts } from "@/components/procurement-dashboard-charts";
import {
  ProcurementSummaryTable,
  type SummaryRow,
} from "@/components/procurement-summary-table";
import { ProcurementBackLink } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { buildDashboardChartsData } from "@/lib/procurement-dashboard-stats";
import { procurementSummaryWhere } from "@/lib/procurement-visibility";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const liveVersion = await getCurrentUserLiveVersion("procurement-dashboard");
  const orders = await prisma.purchaseOrder.findMany({
    where: procurementSummaryWhere(),
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

  const chartData = buildDashboardChartsData(
    orders.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      initiatorName: o.initiatorName,
      team: o.team,
      techGroup: o.techGroup,
      status: o.status,
      totalPrice: o.totalPrice,
      statusEnteredAt: o.statusEnteredAt,
    })),
  );

  const rows: SummaryRow[] = orders.flatMap((order) =>
    order.items.map((item) => ({
      orderId: order.id,
      orderNo: order.orderNo,
      initiatorName: order.initiatorName,
      team: order.team,
      techGroup: order.techGroup,
      status: order.status,
      itemName: item.name,
      spec: item.spec,
      itemKind: item.itemKind,
      purchaseLink: item.purchaseLink,
      referenceImagePath: item.referenceImagePath,
      processingVendor: item.processingVendor,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.quantity * item.unitPrice,
      orderTotal: order.totalPrice,
      createdAt: order.createdAt.toISOString(),
    })),
  );

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="procurement-dashboard"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <ProcurementPageLayout className="space-y-8">
          <div>
            <ProcurementBackLink />
            <PageTitle subtitle="采购看板" />
          </div>
          <ProcurementDashboardCharts data={chartData} />
          <div>
            <h2 className="mb-4 text-lg font-semibold">明细汇总表</h2>
            <ProcurementSummaryTable rows={rows} />
          </div>
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
