import { redirect } from "next/navigation";
import { ApplyForm } from "@/components/apply-form";
import { InitiatorSignatureNotice } from "@/components/procurement/initiator-signature-notice";
import { ProcurementNewHeader } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { auth } from "@/lib/auth";
import { isActiveFeishuOpenId } from "@/lib/active-account";
import { routes } from "@/lib/routes";
import { userHasSignature } from "@/lib/user-signature";

export default async function ProcurementNewPage() {
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }
  if (!(await isActiveFeishuOpenId(session.user.openId))) {
    redirect(routes.procurement.dashboard);
  }

  const hasSignature = await userHasSignature(session.user.openId);

  return (
    <>
      <ProcurementNewHeader />
      <ProcurementPageLayout className="max-w-4xl space-y-4">
        {hasSignature ? (
          <ApplyForm hasSignature />
        ) : (
          <InitiatorSignatureNotice />
        )}
      </ProcurementPageLayout>
    </>
  );
}
