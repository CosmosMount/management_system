import { redirect } from "next/navigation";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { ResourceFilterBar } from "@/components/project-management/resource-filter-bar";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { ViewportStateLink } from "@/components/project-management/time-canvas/viewport-state-link";
import {
  formatShanghaiDate,
  parseTimeCanvasUrlState,
  serializeTimeCanvasUrlState,
} from "@/components/project-management/time-canvas/url-state";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  getActorPersonOption,
  listTagOptions,
  resolvePeopleOptionsByIds,
  resolveTaskOptionsByIds,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import { getWorkSegment } from "@/lib/project-management/queries/resource-queries";
import { getTimeCanvasData } from "@/lib/project-management/queries/time-canvas-queries";
import { getProgressActorOrRedirect } from "../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressResourcesPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const requestedFocusId = firstParam(params.focus) ||
    firstParam(params.focusSegmentIds).split(",")[0] ||
    "";
  const focusedSegment = isUuid(requestedFocusId)
    ? await getWorkSegment({ actor, input: { segmentId: requestedFocusId } }).catch(
        (error: unknown) => {
          if (toProjectManagementServiceError(error).code === "NOT_FOUND") return null;
          throw error;
        },
      )
    : null;
  const defaultStartAt = focusedSegment
    ? startOfShanghaiDay(focusedSegment.startAt)
    : startOfToday();
  const parsedView = parseTimeCanvasUrlState(
    toUrlSearchParams(params),
    {
      startMs: defaultStartAt.getTime(),
      endMs: focusedSegment
        ? Math.max(
            defaultStartAt.getTime() + 24 * 60 * 60 * 1_000,
            startOfShanghaiDay(focusedSegment.endAt).getTime() +
              24 * 60 * 60 * 1_000,
          )
        : defaultStartAt.getTime() + 14 * 24 * 60 * 60 * 1_000,
    },
  );
  const view = focusSegmentView(parsedView, focusedSegment);
  const hasExplicitScale = hasValidExplicitScale(params);
  if (requestedFocusId && !focusedSegment) {
    const normalized = toUrlSearchParams(params);
    normalized.delete("focus");
    normalized.delete("focusSegmentIds");
    normalized.set("focusError", "1");
    redirect(`/progress/resources?${normalized.toString()}`);
  }
  if (focusedSegment) {
    const normalized = serializeTimeCanvasUrlState({
      range: view.range,
      zoom: view.zoom,
      groupBy: view.groupBy,
      personIds: view.personIds,
      taskIds: view.taskIds,
      tagIds: view.tagIds,
      types: view.types,
      statuses: view.statuses,
      focusId: focusedSegment.id,
    });
    normalized.set(
      "center",
      new Date(
        (Date.parse(focusedSegment.startAt) + Date.parse(focusedSegment.endAt)) / 2,
      ).toISOString(),
    );
    if (!hasExplicitScale) normalized.delete("scale");
    normalized.delete("focusError");
    if (canonicalSearch(toUrlSearchParams(params)) !== canonicalSearch(normalized)) {
      redirect(`/progress/resources?${normalized.toString()}`);
    }
  }
  const startAt = new Date(view.range.startMs);
  const endAt = new Date(view.range.endMs);
  const cursor = firstParam(params.cursor) || undefined;

  const [
    actorPerson,
    peoplePage,
    taskPage,
    tagPage,
    selectedPeople,
    selectedTasks,
    canvasResult,
  ] = await Promise.all([
    getActorPersonOption(actor),
    searchPeople({ actor, input: { purpose: "VISIBLE", limit: 50 } }),
    searchTaskOptions({ actor, input: { statuses: ["ACTIVE"], limit: 50 } }),
    listTagOptions({ actor, input: { limit: 50 } }),
    resolvePeopleOptionsByIds({
      actor,
      input: { scope: { purpose: "VISIBLE" }, ids: view.personIds },
    }),
    resolveTaskOptionsByIds({ actor, input: { ids: view.taskIds } }),
    getTimeCanvasData({
      actor,
      input: {
        scope: { kind: "RESOURCE_PLANNER" },
        rangeStart: startAt.toISOString(),
        rangeEnd: endAt.toISOString(),
        personIds: view.personIds,
        taskIds: view.taskIds,
        tagIds: view.tagIds,
        types: view.types,
        statuses: view.statuses,
        groupBy: view.groupBy,
        includeTaskAnchors: true,
        includeActual:
          view.types.length === 0 || view.types.includes("ACTUAL"),
        includeBusyBlocks: view.groupBy === "PERSON",
        cursor,
        rowLimit: 50,
      },
    })
      .then((data) => ({ ok: true as const, data }))
      .catch((error: unknown) => ({
        ok: false as const,
        message: toProjectManagementServiceError(error).message,
      })),
  ]);
  const canvasModel = canvasResult.ok
    ? timeCanvasDataToModel(canvasResult.data, "RESOURCE_PLANNER")
    : null;
  const requestedCanvasCenter = parseCenter(firstParam(params.center));
  const initialCanvasCenter = canvasModel
    ? centerWithinRange(requestedCanvasCenter, canvasModel.range) ??
      defaultExplicitCanvasCenter(canvasModel)
    : undefined;
  const canvasTasks = canvasResult.ok
    ? (
        await resolveTaskOptionsByIds({
          actor,
          input: { ids: canvasResult.data.anchors.map((task) => task.id) },
        })
      ).filter((task) => task.status === "ACTIVE")
    : [];
  const pickerPeople = mergeOptionsInPreferredOrder(
    selectedPeople,
    [actorPerson, ...peoplePage.items],
  );
  const pickerTasks = mergeOptionsInPreferredOrder(
    selectedTasks,
    canvasTasks,
    taskPage.items,
  );

  return (
    <>
      <PageCommandBar
        title="人员计划"
        description="多人员、Task 与 Tag 的统一时间画布；筛选、分组、范围和聚焦状态均可由 URL 复现。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <ResourceFilterBar
            key={resourceFilterStateKey({
              from: formatShanghaiDate(startAt.getTime()),
              to: formatShanghaiDate(endAt.getTime()),
              groupBy: view.groupBy,
              personIds: view.personIds,
              taskIds: view.taskIds,
              tagIds: view.tagIds,
              types: view.types,
              statuses: view.statuses,
            })}
            initial={{
              from: formatShanghaiDate(startAt.getTime()),
              to: formatShanghaiDate(endAt.getTime()),
              groupBy: view.groupBy,
              zoom: view.zoom,
              personIds: view.personIds,
              taskIds: view.taskIds,
              tagIds: view.tagIds,
              types: view.types,
              statuses: view.statuses,
            }}
            initialPeople={pickerPeople}
            initialTasks={pickerTasks}
            initialTags={tagPage.items}
          />
          {view.issues.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              {view.issues.join("；")}
            </div>
          )}
          {firstParam(params.focusError) === "1" && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              无法定位该时间对象，请确认链接仍然有效且你有权查看。
            </div>
          )}
          {canvasModel ? (
            <ResourcePlannerCanvasClient
              initialModel={canvasModel}
              peopleOptions={pickerPeople}
              taskOptions={pickerTasks}
              defaultPersonId={actor.personId}
              initialZoom={hasExplicitScale ? view.zoom : undefined}
              initialCenterMs={initialCanvasCenter}
              initialFocusId={view.focusId}
              persistViewportInUrl
            />
          ) : (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" role="alert">
              时间画布加载失败：{canvasResult.ok ? "未知错误" : canvasResult.message}。请调整筛选或刷新后重试；为避免绕过显式区间规则，失败状态不提供旧版自动切分操作。
            </div>
          )}
          {canvasResult.ok && (cursor || canvasResult.data.nextCursor) && (
            <nav className="flex flex-wrap items-center gap-3" aria-label="资源计划行分页">
              {cursor && (
                <ViewportStateLink className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={resourceHref(params, null)}>
                  返回第一页
                </ViewportStateLink>
              )}
              {canvasResult.data.nextCursor && (
                <ViewportStateLink className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={resourceHref(params, canvasResult.data.nextCursor)}>
                  下一页人员 / Task
                </ViewportStateLink>
              )}
              <span className="text-sm text-muted-foreground">每页最多 50 行；分页不会静默截断。</span>
            </nav>
          )}
      </div>
    </>
  );
}

function mergeOptionsInPreferredOrder<T extends { id: string }>(
  ...groups: T[][]
) {
  const result = new Map<string, T>();
  for (const group of groups) {
    for (const option of group) {
      if (!result.has(option.id)) result.set(option.id, option);
    }
  }
  return [...result.values()];
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function hasValidExplicitScale(params: SearchParams) {
  const scale = firstParam(params.scale).toUpperCase();
  if (scale) {
    return ["HOUR", "DAY", "WEEK", "MONTH", "QUARTER", "YEAR"].includes(scale);
  }
  const legacyZoom = firstParam(params.zoom).toUpperCase();
  return ["HOUR", "DAY", "WEEK", "MONTH"].includes(legacyZoom);
}

function resourceHref(params: SearchParams, cursor: string | null) {
  const search = toUrlSearchParams(params);
  if (cursor) search.set("cursor", cursor);
  else search.delete("cursor");
  return `/progress/resources?${search.toString()}`;
}

function startOfToday() {
  const now = new Date();
  return new Date(`${formatShanghaiDate(now.getTime())}T00:00:00.000+08:00`);
}

function startOfShanghaiDay(value: string) {
  return new Date(`${formatShanghaiDate(Date.parse(value))}T00:00:00.000+08:00`);
}

function focusSegmentView(
  view: ReturnType<typeof parseTimeCanvasUrlState>,
  segment: Awaited<ReturnType<typeof getWorkSegment>> | null,
) {
  if (!segment) return view;
  const overlaps =
    Date.parse(segment.startAt) < view.range.endMs &&
    Date.parse(segment.endAt) > view.range.startMs;
  const start = startOfShanghaiDay(segment.startAt).getTime();
  const end = startOfShanghaiDay(segment.endAt).getTime() + 24 * 60 * 60 * 1_000;
  return {
    ...view,
    focusId: segment.id,
    range: overlaps ? view.range : { startMs: start, endMs: Math.max(end, start + 86_400_000) },
    groupBy: view.groupBy === "TASK" && !segment.taskId ? "PERSON" as const : view.groupBy,
    personIds:
      view.groupBy === "PERSON" || !segment.taskId
        ? [segment.personId, ...view.personIds.filter((id) => id !== segment.personId)].slice(
            0,
            50,
          )
        : view.personIds,
    taskIds:
      !segment.taskId
        ? []
        : view.groupBy === "TASK"
        ? [segment.taskId, ...view.taskIds.filter((id) => id !== segment.taskId)].slice(
            0,
            50,
          )
        : view.taskIds,
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseCenter(value: string) {
  const parsed = Date.parse(value);
  return value && Number.isFinite(parsed) ? parsed : null;
}

function centerWithinRange(
  centerMs: number | null,
  range: { startMs: number; endMs: number },
) {
  return centerMs !== null && centerMs >= range.startMs && centerMs < range.endMs
    ? centerMs
    : null;
}

function defaultExplicitCanvasCenter(
  model: ReturnType<typeof timeCanvasDataToModel>,
) {
  const candidates = [
    ...model.segments.flatMap((segment) =>
      segment.startMs < model.range.endMs && segment.endMs > model.range.startMs
        ? [Math.max(segment.startMs, model.range.startMs)]
        : [],
    ),
    ...model.anchors.flatMap((anchor) =>
      anchor.atMs >= model.range.startMs && anchor.atMs < model.range.endMs
        ? [anchor.atMs]
        : [],
    ),
  ];
  return candidates.length > 0
    ? Math.min(...candidates)
    : (model.range.startMs + model.range.endMs) / 2;
}

function resourceFilterStateKey(input: {
  from: string;
  to: string;
  groupBy: "PERSON" | "TASK";
  personIds: string[];
  taskIds: string[];
  tagIds: string[];
  types: string[];
  statuses: string[];
}) {
  return JSON.stringify([
    input.from,
    input.to,
    input.groupBy,
    input.personIds,
    input.taskIds,
    input.tagIds,
    input.types,
    input.statuses,
  ]);
}

function toUrlSearchParams(params: SearchParams) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item) => result.append(key, item));
    } else if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

function canonicalSearch(params: URLSearchParams) {
  return [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
