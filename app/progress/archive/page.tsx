import { AppHeader } from "@/components/app-header";
import { ArchivedProjectList, ArchivedTaskList } from "@/components/progress/archive-record-lists";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
import { isSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export default async function ArchivePage() {
  const liveVersion = await getCurrentUserLiveVersion("progress");
  const session = await auth();
  const admin = session?.user?.openId
    ? await isSuperAdmin(session.user.openId)
    : false;

  const [projects, tasks] = await Promise.all([
    prisma.project.findMany({
      where: { status: { in: ["COMPLETED", "CANCELED"] } },
      orderBy: { archivedAt: "desc" },
    }),
    prisma.task.findMany({
      where: { status: "ARCHIVED" },
      include: {
        project: { select: { name: true } },
        assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
      orderBy: { archivedAt: "desc" },
    }),
  ]);

  const projectRows = projects.map((project) => ({
    id: project.id,
    name: project.name,
    team: project.team,
    techGroup: project.techGroup,
    status: project.status,
    archivedAtLabel: project.archivedAt
      ? project.archivedAt.toLocaleDateString("zh-CN")
      : null,
  }));

  const taskRows = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    projectName: task.project.name,
    assigneeNames: getTaskAssigneeNames(task),
    status: task.status,
  }));

  return (
    <>
      <AppHeader />
      <LiveAutoRefresh
        scope="progress"
        initialVersion={liveVersion}
        intervalMs={10000}
      />
      <PageShell>
        <ProgressPageLayout className="space-y-8">
          <ProgressBackLink />
          <PageTitle subtitle="归档检索" />

          <Card>
            <CardHeader>
              <CardTitle>已结束项目 ({projects.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ArchivedProjectList
                projects={projectRows}
                isSuperAdmin={admin}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>已归档任务 ({tasks.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ArchivedTaskList tasks={taskRows} isSuperAdmin={admin} />
            </CardContent>
          </Card>
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
