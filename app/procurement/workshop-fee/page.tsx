import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ProcurementBackLink } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { WorkshopFeeForm } from "@/components/workshop-fee-form";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import { canAccessWorkshopFee } from "@/lib/workshop-fee-permissions";

export default async function WorkshopFeePage() {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];
  if (!canAccessWorkshopFee(roles)) {
    notFound();
  }

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProcurementPageLayout className="max-w-4xl">
          <ProcurementBackLink />
          <PageTitle subtitle="工坊加工费录入" />
          <WorkshopFeeForm />
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
