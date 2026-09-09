import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { ProjectManagementShell } from "@/components/project-management/shell/project-management-shell";
import { getProgressRequestTime, getProgressUnreadNotificationCount } from "./_auth";
import { ProgressClockProvider } from "@/components/project-management/progress-clock";

export default async function ProgressLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const unreadCount = await getProgressUnreadNotificationCount();
  const initialNowMs = getProgressRequestTime();

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProjectManagementShell unreadCount={unreadCount}>
          <ProgressClockProvider initialNowMs={initialNowMs}>{children}</ProgressClockProvider>
        </ProjectManagementShell>
      </PageShell>
    </>
  );
}
