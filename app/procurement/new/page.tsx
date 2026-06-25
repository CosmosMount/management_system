import { redirect } from "next/navigation";
import { ApplyForm } from "@/components/apply-form";
import { AppHeader } from "@/components/app-header";
import { InitiatorSignatureNotice } from "@/components/procurement/initiator-signature-notice";
import { ProcurementBackLink } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { userHasSignature } from "@/lib/user-signature";

export default async function ProcurementNewPage() {
  const session = await auth();
  if (!session?.user?.openId) {
    redirect("/login");
  }

  const hasSignature = await userHasSignature(session.user.openId);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProcurementPageLayout className="max-w-4xl">
          <ProcurementBackLink />
          <PageTitle subtitle="采购申请" />
          {hasSignature ? (
            <ApplyForm hasSignature />
          ) : (
            <InitiatorSignatureNotice />
          )}
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
