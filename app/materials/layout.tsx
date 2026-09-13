import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { MaterialShell } from "@/components/material-management/material-shell";
import { PageShell } from "@/components/page-shell";
import { auth } from "@/lib/auth";
import { isActiveFeishuOpenId } from "@/lib/active-account";

export default async function MaterialsLayout({
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
        <MaterialShell canWrite={canWrite}>{children}</MaterialShell>
      </PageShell>
    </>
  );
}
