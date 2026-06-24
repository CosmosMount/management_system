import { ApplyForm } from "@/components/apply-form";
import { AppHeader } from "@/components/app-header";
import { ProcurementBackLink } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";

export default function ProcurementNewPage() {
  return (
    <>
      <AppHeader />
      <PageShell>
        <ProcurementPageLayout className="max-w-4xl">
          <ProcurementBackLink />
          <PageTitle subtitle="采购申请" />
          <ApplyForm />
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
