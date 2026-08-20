import { notFound, redirect } from "next/navigation";
import { ApplyForm } from "@/components/apply-form";
import { EditDraftHeader } from "@/components/procurement/procurement-back-link";
import { OrderRejectionNotice } from "@/components/procurement/order-rejection-notice";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { auth } from "@/lib/auth";
import { canEditProcurementOrder } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { toOrderFormInput } from "@/lib/validations/order";
import { userHasSignature } from "@/lib/user-signature";
import { isActiveFeishuOpenId } from "@/lib/active-account";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function EditOrderPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }
  if (!(await isActiveFeishuOpenId(session.user.openId))) {
    notFound();
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
    !canEditProcurementOrder(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    notFound();
  }

  if (order.status !== "DRAFT") {
    redirect(routes.procurement.detail(id));
  }

  const hasSignature = await userHasSignature(session.user.openId);

  return (
    <>
      <EditDraftHeader orderNo={order.orderNo} />
      <ProcurementPageLayout className="max-w-4xl space-y-3">
        {order.rejectionReason ? (
          <OrderRejectionNotice
            reason={order.rejectionReason}
            status={order.status}
            rejectedByName={order.rejectedByName}
            rejectedAt={order.rejectedAt}
          />
        ) : null}
        <ApplyForm
          orderId={order.id}
          expectedUpdatedAt={order.updatedAt.toISOString()}
          initialValues={toOrderFormInput(order)}
          hasSignature={hasSignature}
        />
      </ProcurementPageLayout>
    </>
  );
}
