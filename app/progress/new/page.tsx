import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ProjectForm } from "@/components/progress/project-form";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import { canCreateProject } from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";

export default async function NewProjectPage() {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];
  if (!canCreateProject(roles)) {
    notFound();
  }

  const [users, projectTemplates] = await Promise.all([
    prisma.user.findMany({
      orderBy: { name: "asc" },
      select: { openId: true, name: true, avatar: true },
    }),
    prisma.projectTemplate.findMany({
      where: { enabled: true },
      include: {
        stages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
      orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }],
    }),
  ]);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout className="max-w-4xl">
          <ProgressBackLink />
          <PageTitle subtitle="新建项目" />
          <ProjectForm
            users={users}
            projectTemplates={projectTemplates.map((template) => ({
              id: template.id,
              name: template.name,
              description: template.description,
              isDefault: template.isDefault,
              stages: template.stages.map((stage) => ({
                name: stage.name,
                goal: stage.goal,
                durationDays: stage.dueOffsetDays,
              })),
            }))}
          />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
