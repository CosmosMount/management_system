import Link from "next/link";
import { redirect } from "next/navigation";
import { PersonalDueQueue } from "@/components/project-management/personal-due-queue";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import { ViewportStateLink } from "@/components/project-management/time-canvas/viewport-state-link";
import type { TimeCanvasZoom } from "@/components/project-management/time-canvas/types";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { taskStatusLabels } from "@/lib/project-management/labels";
import {
  getActorPersonOption,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import { getWorkSegment } from "@/lib/project-management/queries/resource-queries";
import {
  getMyTimelinePageData,
  getPersonalDueSegments,
} from "@/lib/project-management/queries/time-canvas-queries";
import { getProgressActorOrRedirect } from "../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressMyTimelinePage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const taskCursor = firstParam(params.taskCursor) || undefined;
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
  const legacyCenter = parseLegacyCenter(params);
  const requestedCenter = focusId && focusedSegment
    ? Date.parse(focusedSegment.startAt)
    : parseCenter(firstParam(params.center)) ?? legacyCenter ?? undefined;
  const requestedScale = parseScale(firstParam(params.scale))
    ?? parseLegacyScale(params);

  if (hasLegacyDisplayState(params) || (requestedFocusId && !focusId)) {
    const normalized = timelineHref({
      taskCursor,
      showAllTasks,
      focusId,
      centerMs: requestedCenter,
      scale: requestedScale ?? (hasLegacyDisplayState(params) ? "WEEK" : undefined),
      focusError: Boolean(requestedFocusId && !focusId),
    });
    redirect(normalized);
  }

  const [actorPerson, timelineResult, duePage] = await Promise.all([
    getActorPersonOption(actor),
    getMyTimelinePageData({
      actor,
      input: { showAll: showAllTasks, taskCursor },
      preferredCenterMs: requestedCenter,
      load: { mode: "INITIAL" },
    })
      .then((data) => ({ ok: true as const, data }))
      .catch((error: unknown) => ({
        ok: false as const,
        message: toProjectManagementServiceError(error).message,
      })),
    getPersonalDueSegments({ actor, limit: 100 }),
  ]);
  const fallbackTaskPage = timelineResult.ok
    ? timelineResult.data.taskPage
    : await searchTaskOptions({
        actor,
        input: {
          mine: true,
          statuses: showAllTasks ? [] : ["ACTIVE"],
          cursor: taskCursor,
          limit: 25,
        },
      });
  const model = timelineResult.ok
    ? {
        ...timeCanvasDataToModel(timelineResult.data.data, "TASK_WORKBENCH"),
        contentRange: timelineResult.data.contentRange,
        fullRange: timelineResult.data.fullRange,
        rangeClipped: timelineResult.data.rangeClipped,
        loadedRanges: [timelineResult.data.loadedRange],
        loadedLeafBlockCounts: [timelineResult.data.leafBlockCount],
        failedRanges: timelineResult.data.failedRanges,
        rows: timeCanvasDataToModel(
          timelineResult.data.data,
          "TASK_WORKBENCH",
        ).rows.map((row) =>
          row.kind === "PLAN" ? { ...row, editable: false } : row,
        ),
      }
    : null;
  const resolvedCenter = timelineResult.ok
    ? timelineResult.data.resolvedCenterMs
    : requestedCenter;
  const taskOptions = fallbackTaskPage.items.filter(
    (task) => task.status === "ACTIVE",
  );
  const dueSegments = duePage.items.map((segment) => ({
    id: segment.id,
    title: segment.content,
    startAt: segment.startAt,
    endAt: segment.endAt,
    versionToken: segment.versionToken,
    canConfirm: segment.permissions.canConfirm,
    canCancel: segment.permissions.canCancel,
  }));
  const hrefState = {
    showAllTasks,
    focusId: null,
    centerMs: resolvedCenter,
    scale: requestedScale,
  };

  return (
    <>
      <PageCommandBar title="我的时间" />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        {firstParam(params.focusError) === "1" && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            无法定位该时间对象，请确认链接仍然有效且你有权查看。
          </p>
        )}
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
                taskCursor,
              }}
          />
        ) : (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" role="alert">
            个人时间线加载失败：{timelineResult.ok ? "未知错误" : timelineResult.message}
          </div>
        )}

        <section className="rounded-md border border-border bg-card p-4" aria-labelledby="my-task-list-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="my-task-list-title" className="font-semibold">参与 Task</h2>
              <p className="mt-1 text-sm text-muted-foreground">默认只显示进行中的 Task；当前页与上方计划轨道同步，每页最多 25 条。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ViewportStateLink
                className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                href={timelineHref({ ...hrefState, showAllTasks: !showAllTasks })}
              >
                {showAllTasks ? "只看进行中" : "显示全部"}
              </ViewportStateLink>
              {taskCursor && (
                <ViewportStateLink
                  className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                  href={timelineHref(hrefState)}
                >
                  返回第一页
                </ViewportStateLink>
              )}
              {fallbackTaskPage.nextCursor && (
                <ViewportStateLink
                  className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                  href={timelineHref({ ...hrefState, taskCursor: fallbackTaskPage.nextCursor })}
                >
                  下一页
                </ViewportStateLink>
              )}
            </div>
          </div>
          {fallbackTaskPage.items.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">当前没有有效参与的 Task。</p>
          ) : (
            <ul className="mt-4 divide-y rounded-md border border-border" aria-label="参与 Task 列表">
              {fallbackTaskPage.items.map((task) => (
                <li key={task.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3">
                  <Link className="min-w-0 break-words font-medium hover:underline" href={`/progress/tasks/${task.id}`}>{task.title}</Link>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">{taskStatusLabels[task.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <PersonalDueQueue segments={dueSegments} truncated={Boolean(duePage.nextCursor)} />
      </div>
    </>
  );
}

function timelineHref({
  taskCursor,
  showAllTasks = false,
  focusId,
  centerMs,
  scale,
  focusError = false,
}: {
  taskCursor?: string;
  showAllTasks?: boolean;
  focusId?: string | null;
  centerMs?: number;
  scale?: TimeCanvasZoom;
  focusError?: boolean;
}) {
  const search = new URLSearchParams();
  if (taskCursor) search.set("taskCursor", taskCursor);
  if (showAllTasks) search.set("tasks", "all");
  if (focusId) search.set("focus", focusId);
  if (Number.isFinite(centerMs)) search.set("center", new Date(centerMs!).toISOString());
  if (scale) search.set("scale", scale.toLowerCase());
  if (focusError) search.set("focusError", "1");
  const query = search.toString();
  return query ? `/progress/my-timeline?${query}` : "/progress/my-timeline";
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

function parseLegacyCenter(params: SearchParams) {
  const date = firstParam(params.date);
  if (!validDate(date)) return null;
  const startMs = Date.parse(`${date}T00:00:00.000+08:00`);
  return startMs + (firstParam(params.mode) === "week" ? 3.5 : 0.5) * 24 * 60 * 60 * 1_000;
}

function parseLegacyScale(params: SearchParams): TimeCanvasZoom | undefined {
  const zoom = firstParam(params.zoom).toUpperCase();
  if (zoom === "HOUR") return "WEEK";
  if (zoom === "DAY") return "MONTH";
  if (zoom === "WEEK") return "QUARTER";
  if (zoom === "MONTH") return "YEAR";
  if (firstParam(params.mode) === "day") return "WEEK";
  if (firstParam(params.mode) === "week") return "MONTH";
  return undefined;
}

function hasLegacyDisplayState(params: SearchParams) {
  return Boolean(params.date !== undefined || params.mode !== undefined || params.zoom !== undefined);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000+08:00`);
  return Number.isFinite(parsed) && formatShanghaiDate(parsed) === value;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
