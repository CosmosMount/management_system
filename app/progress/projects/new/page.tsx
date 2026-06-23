import { AppHeader } from "@/components/app-header";
import { ProjectForm } from "@/components/progress/project-form";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { prisma } from "@/lib/prisma";

export default async function NewProjectPage() {
  const users = await prisma.user.findMany({
    orderBy: { name: "asc" },
    select: { openId: true, name: true, avatar: true },
  });

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout className="max-w-4xl">
          <PageTitle subtitle="新建项目" />
          <ProjectForm users={users} />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
