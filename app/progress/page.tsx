import Link from "next/link";
import { AlertTriangle, Bell, CalendarClock, CheckSquare2, ClipboardList } from "lucide-react";
import { ActionInbox } from "@/components/project-management/action-inbox";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/project-management/labels";
import { getActionInbox } from "@/lib/project-management/queries/action-inbox-queries";
import { getMyWorkDashboard } from "@/lib/project-management/queries/dashboard-queries";
import { listInAppNotifications } from "@/lib/project-management/queries/notification-queries";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "./_auth";

export default async function ProgressPage() {
  const actor = await getProgressActorOrRedirect();
  const [dashboard, inbox, notifications] = await Promise.all([
    getMyWorkDashboard({ actor }),
    getActionInbox({ actor, limit: 20 }),
    listInAppNotifications({ actor, input: { limit: 5 } }),
  ]);
  const canvasModel = timeCanvasDataToModel(dashboard.personalTime, "PERSONAL_TIMELINE");

  return (
    <>
      <PageCommandBar
        title="我的工作"
        description="个人时间、行动待办、Active Task 与通知集中在一个驾驶舱。"
        actions={<Link className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" href={routes.progress.taskNew}>新建 Task</Link>}
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="工作指标">
          <Metric icon={ClipboardList} label="Active Task" value={dashboard.activeTaskCount} />
          <Metric icon={CheckSquare2} label="行动待办" value={inbox.totalCount} />
          <Metric icon={AlertTriangle} label="紧急待办" value={inbox.criticalCount} />
          <Metric icon={Bell} label="未读通知" value={dashboard.unreadNotificationCount} />
        </section>

        <section className="min-w-0 rounded-xl border border-border bg-card p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-medium"><CalendarClock className="size-4" aria-hidden="true" />未来 7 天个人时间</h2>
              <p className="mt-1 text-sm text-muted-foreground">所有视口使用同一横向时间画布，窄屏可在画布内滚动。</p>
            </div>
            <Link href={routes.progress.myTimeline} className="text-sm text-primary hover:underline">打开个人时间线</Link>
          </div>
          <TimeCanvas
            mode="PERSONAL_TIMELINE"
            model={canvasModel}
            initialZoom="DAY"
            display={{ showActual: true, showBusy: false, showInspector: false }}
            emptyMessage="未来 7 天没有个人投入。"
          />
        </section>

        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)]">
          <section className="min-w-0 rounded-xl border border-border bg-card p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-medium">行动待办</h2>
              <Link href={routes.progress.approvals} className="text-sm text-primary hover:underline">查看全部</Link>
            </div>
            <ActionInbox items={inbox.items} compact />
          </section>

          <section className="min-w-0 rounded-xl border border-border bg-card p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-medium">Active Task</h2>
              <Link href={routes.progress.tasks} className="text-sm text-primary hover:underline">全部 Task</Link>
            </div>
            {dashboard.activeTasks.length === 0 ? (
              <Empty text="当前没有参与中的 Active Task。" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <thead className="text-muted-foreground"><tr><th className="pb-2 font-medium">Task</th><th className="pb-2 font-medium">当前节点</th><th className="pb-2 font-medium">版本</th></tr></thead>
                  <tbody>
                    {dashboard.activeTasks.map((task) => (
                      <tr key={task.id} className="border-t border-border">
                        <td className="max-w-64 py-3 pr-3"><Link href={routes.progress.taskDetail(task.id)} className="break-words font-medium hover:underline">{task.title}</Link></td>
                        <td className="py-3 pr-3 text-muted-foreground">{task.activeMilestone ? `${task.activeMilestone.goal} · ${formatDateTime(task.activeMilestone.expectedCompletedAt)}` : task.activeTermination ? `${task.activeTermination.name} · ${formatDateTime(task.activeTermination.plannedAt)}` : "暂无"}</td>
                        <td className="py-3"><Badge variant="secondary">v{task.currentPlanVersionNo}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <details className="rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer font-medium">最近通知 · {dashboard.unreadNotificationCount} 条未读</summary>
          <div className="mt-4 grid gap-2">
            {notifications.items.length === 0 ? <Empty text="当前没有站内通知。" /> : notifications.items.map((notification) => (
              <div key={notification.id} className="rounded-lg border border-border bg-background p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{notification.title}</span>{!notification.readAt && <Badge>未读</Badge>}</div>
                <p className="mt-1 break-words text-muted-foreground">{notification.summary || "无摘要"}</p>
              </div>
            ))}
            <Link href={routes.progress.notifications} className="mt-1 text-sm text-primary hover:underline">打开通知中心与通知偏好</Link>
          </div>
        </details>
      </div>
    </>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof ClipboardList; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="size-4" aria-hidden="true" />{label}</div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{text}</div>;
}
