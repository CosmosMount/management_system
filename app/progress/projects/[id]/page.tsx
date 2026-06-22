import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { ProjectMilestonePanel } from "@/components/progress/project-milestone-panel";
import { TaskForm } from "@/components/progress/task-form";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  canApproveTask,
  canManageProject,
} from "@/lib/permissions-progress";
import {
  projectStatusLabels,
  taskStatusLabels,
  taskCategoryLabels,
} from "@/lib/progress-labels";
import { prisma } from "@/lib/prisma";

type Props = { params: Promise<{ id: string }> };

export default async function ProjectDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      milestones: { orderBy: { sortOrder: "asc" } },
      tasks: { orderBy: { createdAt: "desc" } },
      activityLogs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!project) notFound();

  const scope = { team: project.team, techGroup: project.techGroup };
  const canManage = canManageProject(
    roles,
    scope,
    project.ownerOpenId,
    userOpenId,
  );
  const canApprove = canApproveTask(roles, scope);

  const users = await prisma.user.findMany({
    orderBy: { name: "asc" },
    select: { openId: true, name: true },
  });

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout className="space-y-8">
          <div>
            <Link
              href="/progress"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← 返回进度管理
            </Link>
            <PageTitle subtitle={project.name} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge>{projectStatusLabels[project.status]}</Badge>
              <Badge variant="outline">{project.team}</Badge>
              <Badge variant="outline">{project.techGroup}</Badge>
            </div>
            {project.description && (
              <p className="mt-3 text-muted-foreground">{project.description}</p>
            )}
          </div>

          <div className="grid gap-8 xl:grid-cols-[1.2fr_1fr]">
            <ProjectMilestonePanel
              projectId={project.id}
              status={project.status}
              milestones={project.milestones.map((m) => ({
                ...m,
                submissionId: m.submissionId,
              }))}
              canManage={canManage}
              canApprove={canApprove}
            />

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>挂载任务</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {project.tasks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无任务</p>
                  ) : (
                    <ul className="space-y-2">
                      {project.tasks.map((t) => (
                        <li key={t.id}>
                          <Link
                            href={`/progress/tasks/${t.id}`}
                            className="flex items-center justify-between rounded-lg border p-3 hover:border-primary/30"
                          >
                            <span className="font-medium">{t.title}</span>
                            <div className="flex gap-2">
                              {t.isOverdue && (
                                <Badge variant="destructive">逾期</Badge>
                              )}
                              <Badge variant="secondary">
                                {taskStatusLabels[t.status]}
                              </Badge>
                              <Badge variant="outline">
                                {taskCategoryLabels[t.category]}
                              </Badge>
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage && project.status !== "ARCHIVED" && (
                    <div className="border-t pt-4">
                      <p className="mb-3 font-medium">新建任务</p>
                      <TaskForm projectId={project.id} users={users} />
                    </div>
                  )}
                </CardContent>
              </Card>

              {project.activityLogs.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>最近动态</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    {project.activityLogs.map((log) => (
                      <p key={log.id} className="text-muted-foreground">
                        {log.actorName} · {log.action} ·{" "}
                        {new Date(log.createdAt).toLocaleString("zh-CN")}
                      </p>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
