import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isControlledPlaywrightServer } from "@/lib/playwright-fixture-guard";
import { prisma } from "@/lib/prisma";
import { toOrderFormInput } from "@/lib/validations/order";
import { ProcurementOrderActionFixtureClient } from "@/components/procurement-order-action-fixture-client";

export default async function ProcurementOrderActionFixturesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isControlledPlaywrightServer()) notFound();
  const session = await auth();
  const query = await searchParams;
  const orderId = typeof query.orderId === "string" ? query.orderId : "";
  const mode = typeof query.mode === "string" ? query.mode : "";
  if (
    !session?.user?.openId ||
    !["foreign", "own", "stale-upload", "two-upload"].includes(mode)
  ) {
    notFound();
  }
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: orderId, initiator: { openId: session.user.openId } },
    include: { items: { orderBy: { name: "asc" } } },
  });
  if (!order) notFound();
  const values = toOrderFormInput(order);
  return (
    <ProcurementOrderActionFixtureClient
      orderId={order.id}
      expectedUpdatedAt={order.updatedAt.toISOString()}
      team={values.team}
      techGroup={values.techGroup}
      items={values.items}
      mode={mode as "foreign" | "own" | "stale-upload" | "two-upload"}
      foreignPath={
        typeof query.foreignPath === "string" ? query.foreignPath : null
      }
    />
  );
}
