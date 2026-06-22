import { auth } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { OrdersTable } from "@/components/orders-table";
import { prisma } from "@/lib/prisma";
import { getUserRole } from "@/lib/permissions";

export default async function OrdersPage() {
  const session = await auth();
  const userRole = session?.user?.openId
    ? await getUserRole(session.user.openId)
    : null;

  const orders = await prisma.purchaseOrder.findMany({
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

  const rows = orders.map((order) => ({
    ...order,
    createdAt: order.createdAt.toISOString(),
  }));

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl flex-1 p-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">订单列表</h1>
        <OrdersTable orders={rows} userRole={userRole} />
      </main>
    </>
  );
}
