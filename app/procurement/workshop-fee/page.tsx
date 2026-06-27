import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { WorkshopFeeHeader } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { PageShell } from "@/components/page-shell";
import { WorkshopFeeForm } from "@/components/workshop-fee-form";
import { auth } from "@/lib/auth";

export default async function WorkshopFeePage() {
  const session = await auth();
  if (!session?.user?.openId) redirect("/login");

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProcurementPageLayout className="max-w-4xl space-y-4">
          <WorkshopFeeHeader />
          <WorkshopFeeForm />
        </ProcurementPageLayout>
      </PageShell>
    </>
  );
}
