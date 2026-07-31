import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { ProjectManagementShell } from "@/components/project-management/shell/project-management-shell";
import { getProgressUnreadNotificationCount } from "./_auth";

export default async function ProgressLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const unreadCount = await getProgressUnreadNotificationCount();

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProjectManagementShell unreadCount={unreadCount}>
          {children}
        </ProjectManagementShell>
      </PageShell>
    </>
  );
}
