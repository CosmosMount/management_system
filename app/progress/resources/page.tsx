import Link from "next/link";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { ResourceFilterBar } from "@/components/project-management/resource-filter-bar";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import {
  formatShanghaiDate,
  parseTimeCanvasUrlState,
} from "@/components/project-management/time-canvas/url-state";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  getActorPersonOption,
  listTagOptions,
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
  const requestedFocusId = firstParam(params.focus);
  const focusedSegment = isUuid(requestedFocusId)
    ? await getWorkSegment({ actor, input: { segmentId: requestedFocusId } }).catch(
        () => null,
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
  const startAt = new Date(view.range.startMs);
  const endAt = new Date(view.range.endMs);
  const cursor = firstParam(params.cursor) || undefined;

  const [actorPerson, peoplePage, taskPage, tagPage, canvasResult] = await Promise.all([
    getActorPersonOption(actor),
    searchPeople({ actor, input: { purpose: "VISIBLE", limit: 50 } }),
    searchTaskOptions({ actor, input: { statuses: ["ACTIVE"], limit: 50 } }),
    listTagOptions({ actor, input: { limit: 50 } }),
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
  const people = mergePeople(
    [actorPerson, ...peoplePage.items],
    canvasModel?.rows
      .filter((row) => row.kind === "PERSON")
      .map((row) => ({ id: row.sourceId, displayName: row.label })) ?? [],
  );
  const tasks = mergeTasks(
    taskPage.items.map((task) => ({
      id: task.id,
      title: task.title,
      activeNodeId: task.activeMilestone?.nodeId ?? null,
    })),
    canvasResult.ok
      ? canvasResult.data.anchors
          .filter((task) => task.status === "ACTIVE")
          .map((task) => ({
            id: task.id,
            title: task.title,
            activeNodeId:
              task.nodes.find(
                (node) =>
                  node.type === "MILESTONE" && node.status === "ACTIVE",
              )?.id ?? null,
          }))
      : [],
  );

  return (
    <>
      <PageCommandBar
        title="人员计划"
        description="多人员、Task 与 Tag 的统一时间画布；筛选、分组、范围和聚焦状态均可由 URL 复现。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <ResourceFilterBar
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
            initialPeople={people}
            initialTasks={taskPage.items}
            initialTags={tagPage.items}
          />
          {view.issues.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              {view.issues.join("；")}
            </div>
          )}
          {canvasModel ? (
            <ResourcePlannerCanvasClient
              initialModel={canvasModel}
              people={people}
              tasks={tasks}
              defaultPersonId={actor.personId}
              initialZoom={view.zoom}
              initialFocusId={view.focusId}
            />
          ) : (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" role="alert">
              时间画布加载失败：{canvasResult.ok ? "未知错误" : canvasResult.message}。请调整筛选或刷新后重试；为避免绕过显式区间规则，失败状态不提供旧版自动切分操作。
            </div>
          )}
          {canvasResult.ok && (cursor || canvasResult.data.nextCursor) && (
            <nav className="flex flex-wrap items-center gap-3" aria-label="资源计划行分页">
              {cursor && (
                <Link className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={resourceHref(params, null)}>
                  返回第一页
                </Link>
              )}
              {canvasResult.data.nextCursor && (
                <Link className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={resourceHref(params, canvasResult.data.nextCursor)}>
                  下一页人员 / Task
                </Link>
              )}
              <span className="text-sm text-muted-foreground">每页最多 50 行；分页不会静默截断。</span>
            </nav>
          )}
      </div>
    </>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function mergePeople(
  first: Array<{ id: string; displayName: string }>,
  second: Array<{ id: string; displayName: string }>,
) {
  const people = new Map(first.map((person) => [person.id, person]));
  second.forEach((person) => people.set(person.id, person));
  return [...people.values()];
}

function mergeTasks(
  first: Array<{ id: string; title: string; activeNodeId: string | null }>,
  second: Array<{ id: string; title: string; activeNodeId: string | null }>,
) {
  const tasks = new Map(first.map((task) => [task.id, task]));
  second.forEach((task) => tasks.set(task.id, task));
  return [...tasks.values()];
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
    personIds:
      view.groupBy === "PERSON"
        ? [segment.personId, ...view.personIds.filter((id) => id !== segment.personId)].slice(
            0,
            50,
          )
        : view.personIds,
    taskIds:
      view.groupBy === "TASK" && segment.taskId
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
