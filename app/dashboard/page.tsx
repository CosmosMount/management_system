import { AppHeader } from "@/components/app-header";
import { ProcurementDashboardCharts } from "@/components/procurement-dashboard-charts";
import {
  ProcurementSummaryTable,
  type SummaryRow,
} from "@/components/procurement-summary-table";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { buildDashboardChartsData } from "@/lib/procurement-dashboard-stats";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const orders = await prisma.purchaseOrder.findMany({
    where: { status: { not: "REJECTED" } },
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
      purchaseLink: item.purchaseLink,
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
      <PageShell>
        <main className="mx-auto max-w-7xl flex-1 space-y-8 p-4 py-8">
          <PageTitle subtitle="看板 · 采购统计与汇总" />
          <ProcurementDashboardCharts data={chartData} />
          <div>
            <h2 className="mb-4 text-lg font-semibold">明细汇总表</h2>
            <ProcurementSummaryTable rows={rows} />
          </div>
        </main>
      </PageShell>
    </>
  );
}
