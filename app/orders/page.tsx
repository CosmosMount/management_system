import { auth } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { OrdersTable } from "@/components/orders-table";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";

export default async function OrdersPage() {
  const session = await auth();
  const userRoles = session?.user?.openId
    ? await getUserRoles(session.user.openId)
    : [];

  const orders = await prisma.purchaseOrder.findMany({
    include: {
      items: true,
      initiator: { select: { openId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const rows = orders.map((order) => ({
    id: order.id,
    orderNo: order.orderNo,
    initiatorName: order.initiatorName,
    initiatorOpenId: order.initiator.openId,
    team: order.team,
    techGroup: order.techGroup,
    totalPrice: order.totalPrice,
    status: order.status,
    teamApproved: order.teamApproved,
    techGroupApproved: order.techGroupApproved,
    invoicePaths: order.invoicePaths,
    invoicePath: order.invoicePath,
    listDocPath: order.listDocPath,
    screenshotPath: order.screenshotPath,
    createdAt: order.createdAt.toISOString(),
    items: order.items,
  }));

  return (
    <>
      <AppHeader />
      <PageShell>
        <main className="mx-auto max-w-6xl flex-1 p-4 py-8">
          <PageTitle subtitle="订单列表" />
          <OrdersTable
            orders={rows}
            userRoles={userRoles}
            userOpenId={session?.user?.openId}
          />
        </main>
      </PageShell>
    </>
  );
}
