import { notFound, redirect } from "next/navigation";
import { ApplyForm } from "@/components/apply-form";
import { AppHeader } from "@/components/app-header";
import { EditDraftHeader } from "@/components/procurement/procurement-back-link";
import { OrderRejectionNotice } from "@/components/procurement/order-rejection-notice";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { auth } from "@/lib/auth";
import { canEditProcurementOrder } from "@/lib/permissions";
import { ensureProcurementOrderEditableDraft } from "@/lib/procurement-order-draft";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { toOrderFormInput } from "@/lib/validations/order";
import { userHasSignature } from "@/lib/user-signature";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ withdraw?: string }>;
};

export default async function EditOrderPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { withdraw } = await searchParams;
  const wantsWithdraw = withdraw === "1";
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
    !canEditProcurementOrder(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    notFound();
  }

  let editableOrder = order;
  if (order.status === "DRAFT") {
    editableOrder = order;
  } else if (
    wantsWithdraw &&
    (order.status === "MANAGEMENT_REVIEW" || order.status === "TEACHER_REVIEW")
  ) {
    editableOrder = await ensureProcurementOrderEditableDraft(
      id,
      session.user.openId,
    );
  } else {
    redirect(routes.procurement.detail(id));
  }

  const hasSignature = await userHasSignature(session.user.openId);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProcurementPageLayout className="max-w-4xl space-y-3">
          <EditDraftHeader orderNo={editableOrder.orderNo} />
          {editableOrder.rejectionReason ? (
            <OrderRejectionNotice
              reason={editableOrder.rejectionReason}
              status={editableOrder.status}
              rejectedByName={editableOrder.rejectedByName}
              rejectedAt={editableOrder.rejectedAt}
            />
          ) : null}
          <ApplyForm
            orderId={editableOrder.id}
            initialValues={toOrderFormInput(editableOrder)}
            hasSignature={hasSignature}
          />
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
