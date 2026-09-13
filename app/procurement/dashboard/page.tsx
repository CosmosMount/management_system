import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProcurementDashboardCharts } from "@/components/procurement-dashboard-charts";
import { ProcurementDashboardHeader } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { buildDashboardChartsData } from "@/lib/procurement-dashboard-stats";
import { resolveProcurementHandlerNames } from "@/lib/procurement-order-handlers";
import { listBudgetPoolViews } from "@/lib/procurement-budget";
import { currentBudgetPeriod } from "@/lib/procurement-budget-period";
import { procurementSummaryWhere } from "@/lib/procurement-visibility";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const [liveVersion, orders, budgetPools] = await Promise.all([
    getCurrentUserLiveVersion("procurement-dashboard"),
    prisma.purchaseOrder.findMany({
      where: procurementSummaryWhere(),
      select: {
        id: true,
        orderNo: true,
        initiatorName: true,
        team: true,
        techGroup: true,
        status: true,
        totalPrice: true,
        statusEnteredAt: true,
        teamApproved: true,
        techGroupApproved: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    listBudgetPoolViews(),
  ]);

  const budgetPeriod = currentBudgetPeriod();

  const activeOrders = orders.filter(
    (o) =>
      o.status !== "COMPLETED" &&
      o.status !== "REJECTED" &&
      o.status !== "DRAFT",
  );
  const handlerNamesByOrderId = await resolveProcurementHandlerNames(
    activeOrders.map((o) => ({
      id: o.id,
      status: o.status,
      team: o.team,
      techGroup: o.techGroup,
      initiatorName: o.initiatorName,
      teamApproved: o.teamApproved,
      techGroupApproved: o.techGroupApproved,
    })),
  );

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
    budgetPools,
    budgetPeriod,
    handlerNamesByOrderId,
  );

  return (
    <>
      <LiveAutoRefresh
        scope="procurement-dashboard"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <ProcurementDashboardHeader />
      <ProcurementPageLayout className="space-y-6">
        <ProcurementDashboardCharts data={chartData} />
      </ProcurementPageLayout>
    </>
  );
}
