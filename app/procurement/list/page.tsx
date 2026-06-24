import { auth } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { OrdersTable } from "@/components/orders-table";
import { ProcurementBackLink } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { prisma } from "@/lib/prisma";
import { getUserRoles } from "@/lib/permissions";
import { procurementListWhere } from "@/lib/procurement-visibility";
import { userHasSignature } from "@/lib/user-signature";

export default async function OrdersPage() {
  const session = await auth();
  const userRoles = session?.user?.openId
    ? await getUserRoles(session.user.openId)
    : [];
  const hasSignature = session?.user?.openId
    ? await userHasSignature(session.user.openId)
    : false;

  const orders = await prisma.purchaseOrder.findMany({
    where: procurementListWhere(session?.user?.openId, {
      includeRejected: true,
    }),
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
        <ProcurementPageLayout>
          <ProcurementBackLink />
          <PageTitle subtitle="订单列表" />
          <OrdersTable
            orders={rows}
            userRoles={userRoles}
            userOpenId={session?.user?.openId}
            hasSignature={hasSignature}
          />
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
