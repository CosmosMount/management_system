import { AppHeader } from "@/components/app-header";
import { ProjectForm } from "@/components/progress/project-form";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";

export default function NewProjectPage() {
  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout className="max-w-4xl">
          <PageTitle subtitle="新建项目" />
          <ProjectForm />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
