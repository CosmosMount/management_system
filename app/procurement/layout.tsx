import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { ProcurementShell } from "@/components/procurement/procurement-shell";
import { auth } from "@/lib/auth";
import { isActiveFeishuOpenId } from "@/lib/active-account";

export default async function ProcurementLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await auth();
  const canWrite = session?.user?.openId
    ? await isActiveFeishuOpenId(session.user.openId)
    : false;
  return (
    <>
      <AppHeader />
      <PageShell>
        <ProcurementShell canWrite={canWrite}>{children}</ProcurementShell>
      </PageShell>
    </>
  );
}
