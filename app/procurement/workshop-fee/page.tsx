import { AppHeader } from "@/components/app-header";
import { ProcurementBackLink } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { WorkshopFeeForm } from "@/components/workshop-fee-form";

export default function WorkshopFeePage() {
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
