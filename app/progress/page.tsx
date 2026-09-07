import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, Bell, CheckSquare2, ClipboardList } from "lucide-react";
import { ActionInbox } from "@/components/project-management/action-inbox";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import type { TimeCanvasZoom } from "@/components/project-management/time-canvas/types";
import { ViewportStateLink } from "@/components/project-management/time-canvas/viewport-state-link";
import { Badge } from "@/components/ui/badge";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { formatDateTime, taskStatusLabels } from "@/lib/project-management/labels";
import { getActionInbox } from "@/lib/project-management/queries/action-inbox-queries";
import { getMyWorkMetrics } from "@/lib/project-management/queries/dashboard-queries";
import { listInAppNotifications } from "@/lib/project-management/queries/notification-queries";
import {
  getActorPersonOption,
  listMyTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import { getWorkSegment } from "@/lib/project-management/queries/resource-queries";
import { hasRetiredResourcePlanSearchParams } from "@/lib/project-management/resource-plan-url";
import {
  getMyTimelinePageData,
} from "@/lib/project-management/queries/time-canvas-queries";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "./_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const showAllTasks = firstParam(params.tasks) === "all";
  const requestedFocusId = firstParam(params.focus);
  const focusedSegment = isUuid(requestedFocusId)
    ? await getWorkSegment({ actor, input: { segmentId: requestedFocusId } }).catch(
        (error: unknown) => {
          if (toProjectManagementServiceError(error).code === "NOT_FOUND") return null;
          throw error;
        },
      )
    : null;
  const focusId = focusedSegment?.personId === actor.personId
    ? focusedSegment.id
    : null;
  const requestedCenter = focusId && focusedSegment
    ? Date.parse(focusedSegment.startAt)
    : parseCenter(firstParam(params.center)) ?? undefined;
  const requestedScale = parseScale(firstParam(params.scale));

  if (
    hasRetiredResourcePlanSearchParams(searchParamsFromRecord(params)) ||
    (requestedFocusId && !focusId)
  ) {
    redirect(myWorkHref({
      showAllTasks,
      focusId,
      centerMs: requestedCenter,
      scale: requestedScale,
      focusError: Boolean(requestedFocusId && !focusId),
    }));
  }

  const [actorPerson, timelineResult, metrics, inbox, notifications] =
    await Promise.all([
      getActorPersonOption(actor),
      getMyTimelinePageData({
        actor,
        input: { showAll: showAllTasks },
        preferredCenterMs: requestedCenter,
        load: { mode: "INITIAL" },
      })
        .then((data) => ({ ok: true as const, data }))
        .catch((error: unknown) => {
          const mapped = toProjectManagementServiceError(error);
          return {
            ok: false as const,
            code: mapped.code,
            message: mapped.message,
          };
        }),
      getMyWorkMetrics(actor),
      getActionInbox({ actor, input: { limit: 8 } }),
      listInAppNotifications({ actor, input: { limit: 5 } }),
    ]);
  const tasks = timelineResult.ok
    ? timelineResult.data.tasks
    : await listMyTaskOptions({
        actor,
        statuses: showAllTasks ? [] : ["ACTIVE"],
      });
  const baseModel = timelineResult.ok
    ? timeCanvasDataToModel(timelineResult.data.data, "TASK_WORKBENCH")
    : null;
  const model = timelineResult.ok && baseModel
    ? {
        ...baseModel,
        contentRange: timelineResult.data.contentRange,
        fullRange: timelineResult.data.fullRange,
        rangeClipped: timelineResult.data.rangeClipped,
        loadedRanges: [timelineResult.data.loadedRange],
        loadedLeafBlockCounts: [timelineResult.data.leafBlockCount],
        failedRanges: timelineResult.data.failedRanges,
        rows: baseModel.rows.map((row) =>
          row.kind === "PLAN" ? { ...row, editable: false } : row,
        ),
      }
    : null;
  const resolvedCenter = timelineResult.ok
    ? timelineResult.data.resolvedCenterMs
    : requestedCenter;
  const taskOptions = tasks.filter((task) => task.status === "ACTIVE");
  const hrefState = {
    showAllTasks,
    focusId: null,
    centerMs: resolvedCenter,
    scale: requestedScale,
  };

  return (
    <>
      <PageCommandBar
        title="我的工作"
        description="个人时间、行动待办、参与 Task 与通知集中在一个驾驶舱。"
        actions={
          actor.isActive === false ? null : (
            <Link
              className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
              href={routes.progress.taskNew}
            >
              新建 Task
            </Link>
          )
        }
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        {firstParam(params.focusError) === "1" && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            无法定位该时间对象，请确认链接仍然有效且你有权查看。
          </p>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="工作指标">
          <Metric icon={ClipboardList} label="Active Task" value={metrics.activeTaskCount} />
          <Metric icon={CheckSquare2} label="行动待办" value={inbox.totalCount} />
          <Metric icon={AlertTriangle} label="紧急待办" value={inbox.criticalCount} />
          <Metric icon={Bell} label="未读通知" value={metrics.unreadNotificationCount} />
        </section>

        {model ? (
          <ResourcePlannerCanvasClient
            initialModel={model}
            peopleOptions={[actorPerson]}
            taskOptions={taskOptions}
            defaultPersonId={actor.personId}
            initialZoom={requestedScale}
            initialCenterMs={resolvedCenter}
            mode="PERSONAL_TIMELINE"
            allowIndependent
            initialFocusId={focusId}
            persistViewportInUrl
            adaptiveBlockQuery={{
              kind: "MY_TIMELINE",
              preferredCenterMs: resolvedCenter ?? 0,
              showAll: showAllTasks,
            }}
          />
        ) : (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" role="alert">
            个人时间线加载失败：{timelineResult.ok ? "未知错误" : timelineResult.message}
          </div>
        )}

        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.9fr)]">
          <section className="min-w-0 rounded-xl border border-border bg-card p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">行动待办</h2>
                <p className="mt-1 text-sm text-muted-foreground">汇总当前节点和需要处理的审批。</p>
              </div>
              <Link href={routes.progress.approvals} className="text-sm text-primary hover:underline">查看全部</Link>
            </div>
            <ActionInbox initialPage={inbox} compact />
          </section>

          <section className="min-w-0 rounded-xl border border-border bg-card p-4" aria-labelledby="my-task-list-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="my-task-list-title" className="font-medium">参与 Task</h2>
                <p className="mt-1 text-sm text-muted-foreground">全部参与 Task 与上方 Plan 轨道同步。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <ViewportStateLink
                  className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                  href={myWorkHref({ ...hrefState, showAllTasks: !showAllTasks })}
                >
                  {showAllTasks ? "只看进行中" : "显示全部"}
                </ViewportStateLink>
              </div>
            </div>
            {tasks.length === 0 ? (
              <Empty text="当前没有有效参与的 Task。" />
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[42rem] text-left text-sm">
                  <thead className="text-muted-foreground">
                    <tr><th className="pb-2 font-medium">Task</th><th className="pb-2 font-medium">状态</th><th className="pb-2 font-medium">当前节点</th><th className="pb-2 font-medium">版本</th></tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id} className="border-t border-border">
                        <td className="max-w-64 py-3 pr-3"><Link href={routes.progress.taskDetail(task.id)} className="break-words font-medium hover:underline">{task.title}</Link></td>
                        <td className="py-3 pr-3"><Badge variant="secondary">{taskStatusLabels[task.status]}</Badge></td>
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
          <summary className="cursor-pointer font-medium">最近通知 · {metrics.unreadNotificationCount} 条未读</summary>
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

function myWorkHref({
  showAllTasks = false,
  focusId,
  centerMs,
  scale,
  focusError = false,
}: {
  showAllTasks?: boolean;
  focusId?: string | null;
  centerMs?: number;
  scale?: TimeCanvasZoom;
  focusError?: boolean;
}) {
  const search = new URLSearchParams();
  if (showAllTasks) search.set("tasks", "all");
  if (focusId) search.set("focus", focusId);
  if (Number.isFinite(centerMs)) search.set("center", new Date(centerMs!).toISOString());
  if (scale) search.set("scale", scale.toLowerCase());
  if (focusError) search.set("focusError", "1");
  const query = search.toString();
  return query ? `/progress?${query}` : "/progress";
}

function parseCenter(value: string) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseScale(value: string): TimeCanvasZoom | undefined {
  const normalized = value.toUpperCase();
  return normalized === "WEEK" ||
    normalized === "MONTH" ||
    normalized === "QUARTER" ||
    normalized === "YEAR"
    ? normalized
    : undefined;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function searchParamsFromRecord(params: SearchParams) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else if (value !== undefined) search.set(key, value);
  }
  return search;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  return <div className="mt-4 rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{text}</div>;
}
