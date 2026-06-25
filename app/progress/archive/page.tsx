import { AppHeader } from "@/components/app-header";
import { ArchivedProjectList, ArchivedTaskList } from "@/components/progress/archive-record-lists";
import { LiveAutoRefresh } from "@/components/live-auto-refresh";
import {
  MineScopeToggle,
  readMineSearchParam,
} from "@/components/progress/mine-scope-toggle";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getCurrentUserLiveVersion } from "@/lib/live-version-current";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
import { getUserRoles, isSuperAdmin } from "@/lib/permissions";
import {
  progressProjectMineWhere,
  progressProjectReadableWhere,
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ArchivePage({ searchParams }: Props) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const mine = await readMineSearchParam(searchParams);
  const [liveVersion, roles, admin] = await Promise.all([
    getCurrentUserLiveVersion("progress-archive", undefined, { mine }),
    userOpenId ? getUserRoles(userOpenId) : Promise.resolve([]),
    userOpenId ? isSuperAdmin(userOpenId) : Promise.resolve(false),
  ]);

  const [projects, tasks] = await Promise.all([
    prisma.project.findMany({
      where: {
        AND: [
          progressProjectReadableWhere(roles, userOpenId),
          mine ? progressProjectMineWhere(userOpenId) : {},
          { status: { in: ["COMPLETED", "CANCELED"] } },
        ],
      },
      orderBy: { archivedAt: "desc" },
    }),
    prisma.task.findMany({
      where: {
        AND: [
          progressTaskReadableWhere(roles, userOpenId),
          mine ? progressTaskMineWhere(userOpenId) : {},
          { status: { in: ["ARCHIVED", "PROJECT_CANCELED"] } },
        ],
      },
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
        scope="progress-archive"
        initialVersion={liveVersion}
        intervalMs={10000}
        mine={mine}
      />
      <PageShell>
        <ProgressPageLayout className="space-y-8">
          <ProgressBackLink />
          <PageTitle subtitle="归档检索" />
          <MineScopeToggle basePath={routes.progress.archive} mine={mine} />

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
              <CardTitle>已结束任务 ({tasks.length})</CardTitle>
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
