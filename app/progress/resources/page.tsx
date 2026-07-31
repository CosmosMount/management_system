import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import {
  formatShanghaiDate,
  parseTimeCanvasUrlState,
} from "@/components/project-management/time-canvas/url-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { listTimelinePeople } from "@/lib/project-management/queries/resource-queries";
import { listTasks } from "@/lib/project-management/queries/task-queries";
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
  const defaultStartAt = startOfToday();
  const view = parseTimeCanvasUrlState(
    toUrlSearchParams(params),
    {
      startMs: defaultStartAt.getTime(),
      endMs: defaultStartAt.getTime() + 14 * 24 * 60 * 60 * 1_000,
    },
  );
  const startAt = new Date(view.range.startMs);
  const endAt = new Date(view.range.endMs);
  const taskId = view.taskIds[0];
  const personId = view.personIds[0];

  const [people, tasks, canvasResult] = await Promise.all([
    listTimelinePeople({ actor }),
    listTasks({ actor, input: { status: "ACTIVE", limit: 100 } }),
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
        statuses: [],
        groupBy: view.groupBy,
        includeTaskAnchors: false,
        includeActual:
          view.types.length === 0 || view.types.includes("ACTUAL"),
        includeBusyBlocks: view.groupBy === "PERSON",
        includeConflicts: true,
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

  return (
    <>
      <PageCommandBar
        title="人员计划"
        description="在统一时间画布查看计划、实际、其他占用与冲突；下方保留现有精确操作入口。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <form className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[160px_160px_160px_1fr_auto]">
            <Input
              name="from"
              type="date"
              defaultValue={formatShanghaiDate(startAt.getTime())}
              aria-label="开始日期"
            />
            <Input
              name="to"
              type="date"
              defaultValue={formatShanghaiDate(endAt.getTime())}
              aria-label="结束日期"
            />
            <select
              name="group"
              defaultValue={view.groupBy.toLowerCase()}
              aria-label="分组方式"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="person">按人员</option>
              <option value="task">按 Task</option>
            </select>
            <select
              name="people"
              defaultValue={personId ?? ""}
              aria-label="人员筛选"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="">全部可见人员</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
            {taskId && <input type="hidden" name="tasks" value={taskId} />}
            <input type="hidden" name="zoom" value={view.zoom.toLowerCase()} />
            <Button type="submit">刷新范围</Button>
          </form>
          {view.issues.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
              {view.issues.join("；")}
            </div>
          )}
          {canvasModel ? (
            <ResourcePlannerCanvasClient
              initialModel={canvasModel}
              people={people}
              tasks={tasks.items.map((task) => ({
                id: task.id,
                title: task.title,
                activeNodeId: task.activeMilestone?.nodeId ?? null,
              }))}
              defaultPersonId={actor.personId}
              initialZoom={view.zoom}
            />
          ) : (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive" role="alert">
              时间画布加载失败：{canvasResult.ok ? "未知错误" : canvasResult.message}。请调整筛选或刷新后重试；为避免绕过显式区间规则，失败状态不提供旧版自动切分操作。
            </div>
          )}
      </div>
    </>
  );
}

function startOfToday() {
  const now = new Date();
  return new Date(`${formatShanghaiDate(now.getTime())}T00:00:00.000+08:00`);
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
