import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { TaskActionsPanel } from "@/components/progress/task-actions-panel";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  canApproveTask,
  canManageProject,
  canSubmitDelivery,
} from "@/lib/permissions-progress";
import {
  taskStatusLabels,
  taskCategoryLabels,
  urgencyLabels,
  importanceLabels,
} from "@/lib/progress-labels";
import { prisma } from "@/lib/prisma";

type Props = { params: Promise<{ id: string }> };

export default async function TaskDetailPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  const userOpenId = session?.user?.openId;
  const roles = userOpenId ? await getUserRoles(userOpenId) : [];

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      project: true,
      submissions: {
        orderBy: { submittedAt: "desc" },
        include: { approvals: true },
      },
      weeklyReports: { orderBy: { submittedAt: "desc" }, take: 8 },
      activityLogs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!task) notFound();

  const scope = { team: task.team, techGroup: task.techGroup };
  const isAssignee = canSubmitDelivery(userOpenId, task.assigneeOpenId);
  const canApprove = canApproveTask(roles, scope);
  const canManage = canManageProject(
    roles,
    scope,
    task.project.ownerOpenId,
    userOpenId,
  );

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout className="space-y-8">
          <div>
            <Link
              href={`/progress/projects/${task.projectId}`}
              className="text-sm text-muted-foreground hover:underline"
            >
              ← 返回项目 {task.project.name}
            </Link>
            <PageTitle subtitle={task.title} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge>{taskStatusLabels[task.status]}</Badge>
              {task.isOverdue && <Badge variant="destructive">逾期</Badge>}
              <Badge variant="outline">{taskCategoryLabels[task.category]}</Badge>
              <Badge variant="secondary">
                紧急 {urgencyLabels[task.urgency]} / 重要{" "}
                {importanceLabels[task.importance]}
              </Badge>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>任务信息</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                <p>
                  <span className="text-muted-foreground">负责人：</span>
                  {task.assigneeName}
                </p>
                <p>
                  <span className="text-muted-foreground">截止：</span>
                  {task.dueAt.toLocaleString("zh-CN")}
                </p>
                <p>
                  <span className="text-muted-foreground">车组/技术组：</span>
                  {task.team} / {task.techGroup}
                </p>
                <p className="md:col-span-2">
                  <span className="text-muted-foreground">指标：</span>
                  {task.metrics}
                </p>
                {task.goal && (
                  <p className="md:col-span-2">
                    <span className="text-muted-foreground">说明：</span>
                    {task.goal}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <TaskActionsPanel
              taskId={task.id}
              status={task.status}
              isAssignee={isAssignee}
              canApprove={canApprove}
              canManage={canManage}
              submissions={task.submissions.map((s) => ({
                ...s,
                submittedAt: s.submittedAt.toISOString(),
                approvals: s.approvals.map((a) => ({
                  ...a,
                  createdAt: a.createdAt.toISOString(),
                })),
              }))}
          />

          {task.weeklyReports.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>周报历史</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                {task.weeklyReports.map((r) => (
                  <div key={r.id} className="rounded-lg border p-4">
                    <p className="font-medium">
                      周起始 {new Date(r.weekStart).toLocaleDateString("zh-CN")}
                    </p>
                    <p className="mt-1">{r.progress}</p>
                    {r.risks && (
                      <p className="text-muted-foreground">风险：{r.risks}</p>
                    )}
                    {r.nextPlan && (
                      <p className="text-muted-foreground">下周：{r.nextPlan}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}
