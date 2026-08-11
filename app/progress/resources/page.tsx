import { redirect } from "next/navigation";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { ResourceFilterBar } from "@/components/project-management/resource-filter-bar";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import type { TimeCanvasZoom } from "@/components/project-management/time-canvas/types";
import { ViewportStateLink } from "@/components/project-management/time-canvas/viewport-state-link";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  getActorPersonOption,
  resolvePeopleOptionsByIds,
  resolveTaskOptionsByIds,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import {
  resolveVisibleProjectOptions,
  searchVisibleProjectOptions,
} from "@/lib/project-management/queries/project-queries";
import { getWorkSegment } from "@/lib/project-management/queries/resource-queries";
import { resolveResourcePlanExplicitIds } from "@/lib/project-management/queries/resource-plan-queries";
import { getResourcePlanPageData } from "@/lib/project-management/queries/time-canvas-queries";
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
        (error: unknown) => {
          if (toProjectManagementServiceError(error).code === "NOT_FOUND") return null;
          throw error;
        },
      )
    : null;
  if (requestedFocusId && !focusedSegment) {
    const search = selectionSearchParams(params);
    search.delete("focus");
    search.set("focusError", "1");
    redirect(`/progress/resources?${search.toString()}`);
  }

  const parsedProjects = parseIdList(firstParam(params.projects));
  const parsedTasks = parseIdList(firstParam(params.tasks));
  const parsedPeople = parseIdList(firstParam(params.people));
  const hasExplicitSelection = parsedProjects.ids.length > 0 ||
    parsedTasks.ids.length > 0 ||
    parsedPeople.ids.length > 0;
  const showAll = firstParam(params.all) === "0"
    ? false
    : firstParam(params.all) === "1"
      ? true
      : !hasExplicitSelection;
  const [normalizedSelection, focusedTaskOptions] = await Promise.all([
    showAll
      ? Promise.resolve({ projectIds: [], taskIds: [], personIds: [] })
      : resolveResourcePlanExplicitIds({
          actor,
          input: {
            projectIds: parsedProjects.ids,
            taskIds: parsedTasks.ids,
            personIds: parsedPeople.ids,
          },
        }),
    focusedSegment?.taskId
      ? resolveTaskOptionsByIds({ actor, input: { ids: [focusedSegment.taskId] } })
      : Promise.resolve([]),
  ]);
  const { projectIds, taskIds, personIds } = normalizedSelection;
  const normalizedSearch = normalizedSelectionSearchParams(params, {
    showAll,
    projectIds,
    taskIds,
    personIds,
  });
  if (resourceSelectionNeedsRedirect(params, normalizedSearch)) {
    redirect(`/progress/resources?${normalizedSearch.toString()}`);
  }
  const taskCursor = focusedSegment ? undefined : firstParam(params.taskCursor) || undefined;
  const personCursor = focusedSegment ? undefined : firstParam(params.personCursor) || undefined;
  const pinnedTaskIds = focusedSegment?.taskId && focusedTaskOptions.length > 0
    ? [focusedSegment.taskId]
    : [];
  const pinnedPersonIds = focusedSegment ? [focusedSegment.personId] : [];
  const requestedCenter = focusedSegment
    ? (Date.parse(focusedSegment.startAt) + Date.parse(focusedSegment.endAt)) / 2
    : parseCenter(firstParam(params.center)) ?? undefined;
  const scale = parseScale(firstParam(params.scale));

  const [actorPerson, peoplePage, taskPage, projectPage, selectedPeople, selectedTasks, selectedProjects, canvasResult] =
    await Promise.all([
      getActorPersonOption(actor),
      searchPeople({ actor, input: { purpose: "VISIBLE", limit: 50 } }),
      searchTaskOptions({ actor, input: { limit: 50 } }),
      searchVisibleProjectOptions({ limit: 50 }),
      resolvePeopleOptionsByIds({
        actor,
        input: { scope: { purpose: "VISIBLE" }, ids: personIds },
      }),
      resolveTaskOptionsByIds({ actor, input: { ids: taskIds } }),
      resolveVisibleProjectOptions({ ids: projectIds }),
      getResourcePlanPageData({
        actor,
        input: {
          all: showAll,
          projectIds,
          taskIds,
          personIds,
          pinnedTaskIds,
          pinnedPersonIds,
          taskCursor,
          personCursor,
        },
        preferredCenterMs: requestedCenter,
        load: { mode: "INITIAL" },
      })
        .then((data) => ({ ok: true as const, data }))
        .catch((error: unknown) => ({
          ok: false as const,
          error: toProjectManagementServiceError(error),
        })),
    ]);

  if (
    !canvasResult.ok &&
    (taskCursor || personCursor) &&
    canvasResult.error.code === "VALIDATION_ERROR"
  ) {
    const search = selectionSearchParams(params);
    search.delete("taskCursor");
    search.delete("personCursor");
    redirect(`/progress/resources?${search.toString()}`);
  }

  const baseModel = canvasResult.ok
    ? timeCanvasDataToModel(canvasResult.data.data, "RESOURCE_PLANNER")
    : null;
  const model = canvasResult.ok && baseModel
    ? {
        ...baseModel,
        contentRange: canvasResult.data.contentRange,
        fullRange: canvasResult.data.fullRange,
        rangeClipped: canvasResult.data.rangeClipped,
        loadedRanges: [canvasResult.data.loadedRange],
        loadedLeafBlockCounts: [canvasResult.data.leafBlockCount],
        failedRanges: canvasResult.data.failedRanges,
      }
    : null;
  const canvasPeople = canvasResult.ok
    ? await resolvePeopleOptionsByIds({
        actor,
        input: {
          scope: { purpose: "VISIBLE" },
          ids: canvasResult.data.selection.personIds,
        },
      })
    : [];
  const canvasTasks = canvasResult.ok
    ? (await resolveTaskOptionsByIds({
        actor,
        input: { ids: canvasResult.data.selection.taskIds },
      })).filter((task) => task.status === "ACTIVE")
    : [];
  const resolvedCenterMs = canvasResult.ok ? canvasResult.data.resolvedCenterMs : 0;
  const pickerPeople = mergeById(selectedPeople, canvasPeople, [actorPerson], peoplePage.items);
  const pickerTasks = mergeById(selectedTasks, canvasTasks, taskPage.items);
  const pickerProjects = mergeById(selectedProjects, projectPage.items);
  const issues = [
    ...parsedProjects.issues,
    ...parsedTasks.issues,
    ...parsedPeople.issues,
  ];

  return (
    <>
      <PageCommandBar
        title="资源计划"
        description="聚合选中 Project、Task 与人员的 Current Plan 和完整投入时间线。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <ResourceFilterBar
          key={JSON.stringify([showAll, projectIds, taskIds, personIds])}
          initial={{ all: showAll, projectIds, taskIds, personIds }}
          initialProjects={pickerProjects}
          initialPeople={pickerPeople}
          initialTasks={pickerTasks}
        />
        {issues.length > 0 && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            {issues.join("；")}
          </p>
        )}
        {firstParam(params.focusError) === "1" && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            无法定位该时间对象，请确认链接仍然有效且你有权查看。
          </p>
        )}
        {model ? (
          <ResourcePlannerCanvasClient
            initialModel={model}
            peopleOptions={pickerPeople}
            taskOptions={pickerTasks.filter((task) => task.status === "ACTIVE")}
            defaultPersonId={actor.personId}
            initialZoom={scale}
            initialCenterMs={canvasResult.ok ? canvasResult.data.resolvedCenterMs : undefined}
            initialFocusId={focusedSegment?.id}
            persistViewportInUrl
            adaptiveBlockQuery={{
              kind: "RESOURCE_PLAN",
              preferredCenterMs: resolvedCenterMs,
              all: showAll,
              projectIds,
              taskIds,
              personIds,
              pinnedTaskIds,
              pinnedPersonIds,
              taskCursor,
              personCursor,
            }}
          />
        ) : (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" role="alert">
            资源计划加载失败：{canvasResult.ok ? "未知错误" : canvasResult.error.message}。请调整选择或刷新后重试。
          </div>
        )}
        {canvasResult.ok && (
          <ResourcePagination
            params={params}
            taskCursor={taskCursor}
            personCursor={personCursor}
            nextTaskCursor={canvasResult.data.selection.nextTaskCursor}
            nextPersonCursor={canvasResult.data.selection.nextPersonCursor}
          />
        )}
      </div>
    </>
  );
}

function ResourcePagination({
  params,
  taskCursor,
  personCursor,
  nextTaskCursor,
  nextPersonCursor,
}: {
  params: SearchParams;
  taskCursor?: string;
  personCursor?: string;
  nextTaskCursor: string | null;
  nextPersonCursor: string | null;
}) {
  if (!taskCursor && !personCursor && !nextTaskCursor && !nextPersonCursor) return null;
  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="资源计划分页">
      {taskCursor && <ViewportStateLink className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={pageHref(params, "taskCursor", null)}>Task 返回第一页</ViewportStateLink>}
      {nextTaskCursor && <ViewportStateLink className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={pageHref(params, "taskCursor", nextTaskCursor)}>下一页 Task</ViewportStateLink>}
      {personCursor && <ViewportStateLink className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={pageHref(params, "personCursor", null)}>人员返回第一页</ViewportStateLink>}
      {nextPersonCursor && <ViewportStateLink className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={pageHref(params, "personCursor", nextPersonCursor)}>下一页人员</ViewportStateLink>}
      <span className="text-sm text-muted-foreground">每页最多 25 条 Task Plan、50 条人员。</span>
    </nav>
  );
}

function parseIdList(value: string) {
  const raw = value.split(",").map((id) => id.trim()).filter(Boolean);
  const valid = raw.filter(isUuid).map((id) => id.toLowerCase());
  const unique = [...new Set(valid)].sort();
  const ids = unique.slice(0, 50);
  const issues: string[] = [];
  if (valid.length !== raw.length) issues.push("已忽略格式不正确的资源 ID");
  if (unique.length !== valid.length) issues.push("已忽略重复的资源 ID");
  if (unique.length > 50) issues.push("每类资源最多选择 50 个，已忽略超出部分");
  return { ids, issues };
}

function mergeById<T extends { id: string }>(...groups: T[][]) {
  const byId = new Map<string, T>();
  for (const group of groups) for (const item of group) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

function pageHref(params: SearchParams, key: "taskCursor" | "personCursor", value: string | null) {
  const search = selectionSearchParams(params);
  if (value) search.set(key, value);
  else search.delete(key);
  return `/progress/resources?${search.toString()}`;
}

function selectionSearchParams(params: SearchParams) {
  const search = new URLSearchParams();
  for (const key of ["all", "projects", "tasks", "people", "taskCursor", "personCursor", "scale", "center", "focus", "focusError"] as const) {
    const value = firstParam(params[key]);
    if (value) search.set(key, value);
  }
  return search;
}

function normalizedSelectionSearchParams(
  params: SearchParams,
  selection: {
    showAll: boolean;
    projectIds: string[];
    taskIds: string[];
    personIds: string[];
  },
) {
  const search = selectionSearchParams(params);
  if (selection.showAll) {
    if (firstParam(params.all)) search.set("all", "1");
    else search.delete("all");
    search.delete("projects");
    search.delete("tasks");
    search.delete("people");
  } else {
    search.set("all", "0");
    setIdSearchParam(search, "projects", selection.projectIds);
    setIdSearchParam(search, "tasks", selection.taskIds);
    setIdSearchParam(search, "people", selection.personIds);
  }
  return search;
}

function resourceSelectionNeedsRedirect(
  params: SearchParams,
  normalized: URLSearchParams,
) {
  const keys = ["all", "projects", "tasks", "people"] as const;
  return keys.some(
    (key) => firstParam(params[key]) !== (normalized.get(key) ?? ""),
  );
}

function setIdSearchParam(
  search: URLSearchParams,
  key: "projects" | "tasks" | "people",
  ids: string[],
) {
  if (ids.length > 0) search.set(key, ids.join(","));
  else search.delete(key);
}

function parseScale(value: string): TimeCanvasZoom | undefined {
  const normalized = value.toUpperCase();
  return normalized === "WEEK" || normalized === "MONTH" ||
    normalized === "QUARTER" || normalized === "YEAR"
    ? normalized
    : undefined;
}

function parseCenter(value: string) {
  const parsed = Date.parse(value);
  return value && Number.isFinite(parsed) ? parsed : null;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
