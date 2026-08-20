import { redirect } from "next/navigation";
import { WorkshopFeeHeader } from "@/components/procurement/procurement-back-link";
import { ProcurementPageLayout } from "@/components/procurement/procurement-page-layout";
import { WorkshopFeeForm } from "@/components/workshop-fee-form";
import { auth } from "@/lib/auth";
import { isActiveFeishuOpenId } from "@/lib/active-account";
import { routes } from "@/lib/routes";

export default async function WorkshopFeePage() {
  const session = await auth();
  if (!session?.user?.openId) redirect("/login");
  if (!(await isActiveFeishuOpenId(session.user.openId))) {
    redirect(routes.procurement.dashboard);
  }

  return (
    <>
      <WorkshopFeeHeader />
      <ProcurementPageLayout className="max-w-4xl space-y-4">
        <WorkshopFeeForm />
      </ProcurementPageLayout>
    </>
  );
}
