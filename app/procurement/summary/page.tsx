import { ProcurementSummaryTable, type SummaryRow } from "@/components/procurement-summary-table";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProcurementSummaryHeader } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { procurementSummaryWhere } from "@/lib/procurement-visibility";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { prisma } from "@/lib/prisma";

export default async function ProcurementSummaryPage() {
  const [liveVersion, orders] = await Promise.all([
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
        createdAt: true,
        items: {
          select: {
            name: true,
            spec: true,
            itemKind: true,
            purchaseLink: true,
            referenceImagePath: true,
            processingVendor: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

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
      <LiveAutoRefresh
        scope="procurement-dashboard"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <ProcurementSummaryHeader />
      <ProcurementPageLayout>
        <ProcurementSummaryTable rows={rows} />
      </ProcurementPageLayout>
    </>
  );
}
