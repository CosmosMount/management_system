import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { ProjectStagePanel } from "@/components/progress/project-stage-panel";
import { TaskForm } from "@/components/progress/task-form";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  canManageProject,
  canApproveStage as canApproveStagePermission,
  canSubmitStage as canSubmitStagePermission,
  canUpdateProjectLifecycle,
} from "@/lib/permissions-progress";
import {
  projectStatusLabels,
  taskStatusLabels,
  taskCategoryLabels,
} from "@/lib/progress-labels";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
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
      stages: {
        orderBy: { sortOrder: "asc" },
        include: {
          submissions: {
            orderBy: { submittedAt: "desc" },
            include: { approvals: true },
          },
        },
      },
      tasks: {
        orderBy: { createdAt: "desc" },
        include: {
          stage: { select: { name: true } },
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
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
  const canUpdateLifecycle = canUpdateProjectLifecycle(
    roles,
    project.ownerOpenId,
    userOpenId,
  );

  const users = await prisma.user.findMany({
    orderBy: { name: "asc" },
    select: { openId: true, name: true, avatar: true },
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
            <ProjectStagePanel
              projectId={project.id}
              status={project.status}
              stages={project.stages.map((s) => ({
                ...s,
                canSubmit: canSubmitStagePermission(
                  roles,
                  s.ownerOpenId,
                  userOpenId,
                ),
                dueAt: s.dueAt ? s.dueAt.toISOString() : null,
                submissions: s.submissions.map((sub) => ({
                  ...sub,
                  canApprove: canApproveStagePermission(
                    roles,
                    scope,
                    project.ownerOpenId,
                    sub.submittedBy,
                    project.allowOwnerSelfApproval,
                    userOpenId,
                  ),
                  submittedAt: sub.submittedAt.toISOString(),
                  approvals: sub.approvals.map((a) => ({
                    ...a,
                    createdAt: a.createdAt.toISOString(),
                  })),
                })),
              }))}
              canUpdateLifecycle={canUpdateLifecycle}
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
                            <div>
                              <span className="font-medium">{t.title}</span>
                              <p className="text-sm text-muted-foreground">
                                负责人：{getTaskAssigneeNames(t)}
                              </p>
                            </div>
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
                              {t.stage && (
                                <Badge variant="outline">
                                  {t.stage.name}
                                </Badge>
                              )}
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage &&
                    project.status !== "COMPLETED" &&
                    project.status !== "CANCELED" && (
                      <div className="border-t pt-4">
                        <p className="mb-3 font-medium">新建任务</p>
                        <TaskForm
                          projectId={project.id}
                          users={users}
                          stages={project.stages.map((s) => ({
                            id: s.id,
                            name: s.name,
                          }))}
                        />
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
