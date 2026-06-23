import { AppHeader } from "@/components/app-header";
import {
  ProcurementSummaryTable,
  type SummaryRow,
} from "@/components/procurement-summary-table";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const orders = await prisma.purchaseOrder.findMany({
    where: { status: { not: "REJECTED" } },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

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
        <main className="mx-auto max-w-7xl flex-1 p-4 py-8">
          <PageTitle subtitle="看板 · 采购汇总表" />
          <ProcurementSummaryTable rows={rows} />
        </main>
      </PageShell>
    </>
  );
}
