import Link from "next/link";
import { AlertTriangle, Bell, CalendarClock, ClipboardList } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { ProgressShell } from "@/components/project-management/progress-shell";
import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import {
  conflictKindLabels,
  formatDateTime,
  workSegmentStatusLabels,
  workSegmentTypeLabels,
} from "@/lib/project-management/labels";
import { getProjectManagementOverview } from "@/lib/project-management/queries/overview-queries";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "./_auth";

export default async function ProgressPage() {
  const actor = await getProgressActorOrRedirect();
  const overview = await getProjectManagementOverview(actor);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressShell
          title="我的工作"
          subtitle="查看当前 Task、待确认投入、资源冲突和站内通知。"
          unreadCount={overview.unreadNotificationCount}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-medium">
                  <ClipboardList className="h-4 w-4" aria-hidden="true" />
                  我的 Active Task
                </h2>
                <Link
                  href={routes.progress.tasks}
                  className="text-sm text-primary hover:underline"
                >
                  全部 Task
                </Link>
              </div>
              <div className="mt-4 space-y-3">
                {overview.activeTasks.length === 0 ? (
                  <EmptyState text="当前没有参与中的 Active Task。" />
                ) : (
                  overview.activeTasks.map((task) => (
                    <Link
                      key={task.id}
                      href={routes.progress.taskDetail(task.id)}
                      className="block rounded-lg border border-border bg-background p-3 hover:border-primary/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate font-medium">{task.title}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {task.activeMilestone
                              ? `${task.activeMilestone.goal} · ${formatDateTime(
                                  task.activeMilestone.expectedCompletedAt,
                                )}`
                              : "暂无 Active Milestone"}
                          </p>
                        </div>
                        <Badge variant="secondary">
                          v{task.currentPlanVersionNo}
                        </Badge>
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-medium">
                  <CalendarClock className="h-4 w-4" aria-hidden="true" />
                  未来 7 天投入
                </h2>
                <Link
                  href={routes.progress.resources}
                  className="text-sm text-primary hover:underline"
                >
                  资源时间轴
                </Link>
              </div>
              <div className="mt-4 space-y-3">
                {overview.upcomingSegments.length === 0 ? (
                  <EmptyState text="未来 7 天没有计划或实际投入。" />
                ) : (
                  overview.upcomingSegments.map((segment) => (
                    <div
                      key={segment.id}
                      className="rounded-lg border border-border bg-background p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-medium">{segment.content}</h3>
                        <Badge variant="outline">
                          {workSegmentTypeLabels[segment.type]}
                        </Badge>
                        <Badge variant="secondary">
                          {workSegmentStatusLabels[segment.status]}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {formatDateTime(segment.startAt)} -{" "}
                        {formatDateTime(segment.endAt)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                待确认与资源冲突
              </h2>
              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    待确认 Planned
                  </h3>
                  {overview.pendingConfirmations.length === 0 ? (
                    <EmptyState text="没有待确认计划。" />
                  ) : (
                    overview.pendingConfirmations.map((segment) => (
                      <Link
                        key={segment.id}
                        href={routes.progress.resources}
                        className="block rounded-lg border border-border bg-background p-3 hover:border-primary/40"
                      >
                        <p className="truncate font-medium">{segment.content}</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {formatDateTime(segment.endAt)}
                        </p>
                      </Link>
                    ))
                  )}
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    开放冲突
                  </h3>
                  {overview.openConflicts.length === 0 ? (
                    <EmptyState text="没有开放中的资源冲突。" />
                  ) : (
                    overview.openConflicts.map((conflict) => (
                      <Link
                        key={conflict.id}
                        href={`${routes.progress.conflicts}?conflictId=${conflict.id}`}
                        className="block rounded-lg border border-border bg-background p-3 hover:border-primary/40"
                      >
                        <p className="font-medium">
                          {conflictKindLabels[conflict.kind]}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {formatDateTime(conflict.startAt)} -{" "}
                          {formatDateTime(conflict.endAt)}
                        </p>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-medium">
                  <Bell className="h-4 w-4" aria-hidden="true" />
                  站内通知
                </h2>
                <Link
                  href={routes.progress.notifications}
                  className="text-sm text-primary hover:underline"
                >
                  打开通知中心
                </Link>
              </div>
              <div className="mt-4 rounded-lg border border-border bg-background p-5">
                <p className="text-2xl font-semibold">
                  {overview.unreadNotificationCount}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">未读通知</p>
              </div>
            </section>
          </div>
        </ProgressShell>
      </PageShell>
    </>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
      {text}
    </div>
  );
}
