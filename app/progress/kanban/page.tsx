import { AppHeader } from "@/components/app-header";
import { ProgressKanban } from "@/components/progress/progress-kanban";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { prisma } from "@/lib/prisma";

export default async function KanbanPage() {
  const tasks = await prisma.task.findMany({
    where: { status: { not: "ARCHIVED" } },
    include: { project: { select: { name: true } } },
    orderBy: [{ isOverdue: "desc" }, { dueAt: "asc" }],
  });

  const rows = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    projectName: t.project.name,
    assigneeName: t.assigneeName,
    team: t.team,
    techGroup: t.techGroup,
    category: t.category,
    urgency: t.urgency,
    status: t.status,
    isOverdue: t.isOverdue,
    dueAt: t.dueAt.toISOString(),
  }));

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout>
          <PageTitle subtitle="任务看板" />
          <ProgressKanban tasks={rows} />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
