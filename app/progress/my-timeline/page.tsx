import Link from "next/link";
import { PersonalDueQueue } from "@/components/project-management/personal-due-queue";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { taskStatusLabels } from "@/lib/project-management/labels";
import {
  getActorPersonOption,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import { getWorkSegment } from "@/lib/project-management/queries/resource-queries";
import {
  getPersonalDueSegments,
  getTimeCanvasData,
} from "@/lib/project-management/queries/time-canvas-queries";
import { getProgressActorOrRedirect } from "../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressMyTimelinePage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const mode = firstParam(params.mode) === "day" ? "day" : "week";
  const taskCursor = firstParam(params.taskCursor) || undefined;
  const showAllTasks = firstParam(params.tasks) === "all";
  const requestedFocusId = firstParam(params.focus);
  const focusedSegment = isUuid(requestedFocusId)
    ? await getWorkSegment({ actor, input: { segmentId: requestedFocusId } }).catch(
        () => null,
      )
    : null;
  const focusId = focusedSegment?.personId === actor.personId
    ? focusedSegment.id
    : null;
  const requestedDate = firstParam(params.date);
  const today = formatShanghaiDate(new Date().getTime());
  const date = focusedSegment && focusId
    ? formatShanghaiDate(Date.parse(focusedSegment.startAt))
    : validDate(requestedDate)
      ? requestedDate
      : today;
  const startMs = Date.parse(`${date}T00:00:00.000+08:00`);
  const endMs = startMs + (mode === "day" ? 1 : 7) * 24 * 60 * 60 * 1_000;

  const [actorPerson, taskPage, canvasResult, duePage] = await Promise.all([
    getActorPersonOption(actor),
    searchTaskOptions({
      actor,
      input: {
        mine: true,
        statuses: showAllTasks ? [] : ["ACTIVE"],
        cursor: taskCursor,
        limit: 25,
      },
    }),
    getTimeCanvasData({
      actor,
      input: {
        scope: { kind: "PERSONAL" },
        rangeStart: new Date(startMs).toISOString(),
        rangeEnd: new Date(endMs).toISOString(),
        personIds: [actor.personId],
        taskIds: [],
        tagIds: [],
        types: [],
        statuses: [],
        groupBy: "PERSON",
        includeTaskAnchors: true,
        includeActual: true,
        includeBusyBlocks: false,
        rowLimit: 25,
      },
    }).then((data) => ({ ok: true as const, data })).catch((error: unknown) => ({
      ok: false as const,
      message: toProjectManagementServiceError(error).message,
    })),
    getPersonalDueSegments({ actor, limit: 100 }),
  ]);
  const taskPlanResult = taskPage.items.length > 0
    ? await getTimeCanvasData({
        actor,
        input: {
          scope: { kind: "PERSONAL" },
          rangeStart: new Date(startMs).toISOString(),
          rangeEnd: new Date(endMs).toISOString(),
          personIds: [actor.personId],
          taskIds: taskPage.items.map((task) => task.id),
          tagIds: [],
          types: [],
          statuses: [],
          groupBy: "TASK",
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: false,
          rowLimit: 25,
        },
      }).then((data) => ({ ok: true as const, data })).catch((error: unknown) => ({
        ok: false as const,
        message: toProjectManagementServiceError(error).message,
      }))
    : null;
  const model = canvasResult.ok
    ? mergePersonalTimelineModels(
        timeCanvasDataToModel(canvasResult.data, "PERSONAL_TIMELINE"),
        taskPlanResult?.ok
          ? timeCanvasDataToModel(taskPlanResult.data, "TASK_WORKBENCH")
          : null,
      )
    : null;
  const taskOptions = taskPage.items.filter((task) => task.status === "ACTIVE");
  const dueSegments = duePage.items.map((segment) => ({
    id: segment.id,
    title: segment.content,
    startAt: segment.startAt,
    endAt: segment.endAt,
    versionToken: segment.versionToken,
    canConfirm: segment.permissions.canConfirm,
    canCancel: segment.permissions.canCancel,
  }));

  return (
    <>
      <PageCommandBar
        title="我的时间"
        description={`${mode === "day" ? "日" : "周"}视图 · ${formatShanghaiDate(startMs)} 至 ${formatShanghaiDate(endMs - 1)}`}
        actions={(
          <>
            <Link className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={timelineHref(today, "day")}>今天</Link>
            <Link className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={timelineHref(date, mode === "day" ? "week" : "day")}>{mode === "day" ? "周视图" : "日视图"}</Link>
          </>
        )}
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <form className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
          <label className="grid gap-1 text-sm">选择日期<input className="h-8 rounded-lg border border-input bg-background px-2" name="date" type="date" defaultValue={date} /></label>
          <input type="hidden" name="mode" value={mode} />
          <button className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" type="submit">打开日期</button>
          <span className="text-sm text-muted-foreground">所有视口使用同一时间画布；双击投入打开详情。</span>
        </form>
        {model ? (
          <ResourcePlannerCanvasClient
            initialModel={model}
            peopleOptions={[actorPerson]}
            taskOptions={taskOptions}
            defaultPersonId={actor.personId}
            initialZoom={mode === "day" ? "HOUR" : "DAY"}
            mode="PERSONAL_TIMELINE"
            allowIndependent
            initialFocusId={focusId}
            navigateRangeByDate
          />
        ) : (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" role="alert">个人时间线加载失败：{canvasResult.ok ? "未知错误" : canvasResult.message}</div>
        )}
        <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="my-task-list-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="my-task-list-title" className="font-semibold">参与 Task</h2>
              <p className="mt-1 text-sm text-muted-foreground">默认只显示进行中的 Task；当前页与上方计划轨道同步，每页最多 25 条。</p>
            </div>
            <div className="flex gap-2">
              <Link className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={timelineHref(date, mode, undefined, !showAllTasks)}>{showAllTasks ? "只看进行中" : "显示全部"}</Link>
              {taskCursor && <Link className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={timelineHref(date, mode, undefined, showAllTasks)}>返回第一页</Link>}
              {taskPage.nextCursor && <Link className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" href={timelineHref(date, mode, taskPage.nextCursor, showAllTasks)}>下一页</Link>}
            </div>
          </div>
          {taskPage.items.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">当前没有有效参与的 Task。</p>
          ) : (
            <ul className="mt-4 divide-y rounded-lg border border-border" aria-label="参与 Task 列表">
              {taskPage.items.map((task) => (
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

function timelineHref(
  date: string,
  mode: "day" | "week",
  taskCursor?: string,
  showAllTasks = false,
) {
  const search = new URLSearchParams({ date, mode });
  if (taskCursor) search.set("taskCursor", taskCursor);
  if (showAllTasks) search.set("tasks", "all");
  return `/progress/my-timeline?${search.toString()}`;
}

function mergePersonalTimelineModels(
  personal: ReturnType<typeof timeCanvasDataToModel>,
  taskPlans: ReturnType<typeof timeCanvasDataToModel> | null,
) {
  if (!taskPlans) return personal;
  return {
    ...personal,
    rows: [
      ...taskPlans.rows.filter((row) => row.kind === "PLAN").map((row) => ({ ...row, editable: false })),
      ...personal.rows,
    ],
    anchors: taskPlans.anchors.map((anchor) => ({ ...anchor, editable: false })),
  };
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
