import { notFound, redirect } from "next/navigation";
import { ApplyForm } from "@/components/apply-form";
import { AppHeader } from "@/components/app-header";
import { BackLink } from "@/components/back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { canEditDraftOrder } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { toOrderFormInput } from "@/lib/validations/order";
import { routes } from "@/lib/routes";
import { userHasSignature } from "@/lib/user-signature";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function EditOrderPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      items: true,
      initiator: { select: { openId: true } },
    },
  });

  if (!order) {
    notFound();
  }

  if (
    !canEditDraftOrder(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    notFound();
  }

  const hasSignature = await userHasSignature(session.user.openId);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProcurementPageLayout className="max-w-4xl space-y-4">
          <BackLink
            href={routes.procurement.detail(order.id)}
            label="返回订单详情"
          />
          <PageTitle subtitle={`编辑草稿 ${order.orderNo}`} />
          <ApplyForm
            orderId={order.id}
            initialValues={toOrderFormInput(order)}
            hasSignature={hasSignature}
          />
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
