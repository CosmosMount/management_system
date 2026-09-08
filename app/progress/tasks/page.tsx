import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskList } from "@/components/project-management/task-list";
import { buttonVariants } from "@/components/ui/button";
import { ListFilterForm } from "@/components/project-management/list-filter-form";
import {
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import { listTasks } from "@/lib/project-management/queries/task-queries";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getProgressActorOrRedirect } from "../_auth";

const statusValues = [
  "DRAFT",
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "ARCHIVED",
] as const;
const priorityValues = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressTasksPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const status = params.status === undefined ? "ACTIVE" : firstParam(params.status);
  const priority = firstParam(params.priority);
  const query = firstParam(params.q);
  const mine = params.mine === undefined ? true : paramValues(params.mine).includes("1");
  const cursor = firstParam(params.cursor) || undefined;
  let tasks;
  try {
    tasks = await listTasks({
      actor,
      input: {
        status: statusValues.includes(status as (typeof statusValues)[number])
          ? (status as (typeof statusValues)[number])
          : undefined,
        priority: priorityValues.includes(
          priority as (typeof priorityValues)[number],
        )
          ? (priority as (typeof priorityValues)[number])
          : undefined,
        mine,
        query,
        limit: 50,
        cursor,
      },
    });
  } catch (error) {
    const mapped = toProjectManagementServiceError(error);
    if (
      cursor &&
      mapped.code === "VALIDATION_ERROR" &&
      mapped.message === "Task 分页游标无效"
    ) {
      redirect(taskRecoveryHref(params));
    }
    throw error;
  }

  return (
    <>
      <PageCommandBar
        title="任务"
        actions={
          actor.isActive === false ? null : (
            <Link href={routes.progress.taskNew} className={cn(buttonVariants())}>
              新建任务
            </Link>
          )
        }
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
          {firstParam(params.cursorError) === "1" && (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              任务列表已变化，已为你返回第一页。
            </p>
          )}
          <ListFilterForm
            action={routes.progress.tasks}
            label="任务筛选"
            searchLabel="搜索任务名称或描述"
            query={query}
            filters={[
              { name: "mine", label: "任务范围", value: mine ? "1" : "0", options: [{ value: "1", label: "我参与的任务" }, { value: "0", label: "全部可见任务" }] },
              { name: "status", label: "任务状态", value: statusValues.includes(status as (typeof statusValues)[number]) ? status : "", options: [{ value: "", label: "全部状态" }, ...statusValues.map((value) => ({ value, label: taskStatusLabels[value] }))] },
              { name: "priority", label: "任务优先级", value: priorityValues.includes(priority as (typeof priorityValues)[number]) ? priority : "", options: [{ value: "", label: "全部优先级" }, ...priorityValues.map((value) => ({ value, label: taskPriorityLabels[value] }))] },
            ]}
            className="grid min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-3 lg:grid-cols-[minmax(0,1fr)_150px_130px_130px_auto_auto]"
          />
          <details data-testid="task-list-scope" className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">{query ? "本次搜索" : "本页"}显示 {tasks.items.length} 项 · 筛选说明</summary>
            <p className="mt-2">
              当前范围：{mine ? "我参与的任务" : "全部可见任务"} · {statusValues.includes(status as (typeof statusValues)[number]) ? taskStatusLabels[status as (typeof statusValues)[number]] : "全部状态（含终态与归档）"} · {priorityValues.includes(priority as (typeof priorityValues)[number]) ? taskPriorityLabels[priority as (typeof priorityValues)[number]] : "全部优先级"}{query ? ` · 关键词：${query}` : ""}
            </p>
          </details>
          {tasks.hasMoreByQuery && (
            <p className="text-sm text-amber-700" role="status">
              搜索结果较多，仅显示最相关的 50 条，请继续输入关键词缩小范围。
            </p>
          )}
          <TaskList tasks={tasks.items} />
          {!query && tasks.nextCursor && (
            <div className="flex justify-end">
              <Link
                href={taskPageHref(params, tasks.nextCursor)}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                下一页任务
              </Link>
            </div>
          )}
      </div>
    </>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function paramValues(value: string | string[] | undefined) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function taskPageHref(params: SearchParams, cursor: string) {
  const search = new URLSearchParams();
  const query = firstParam(params.q);
  const status = firstParam(params.status);
  const priority = firstParam(params.priority);
  if (query) search.set("q", query);
  if (params.status !== undefined) search.set("status", status);
  if (priority) search.set("priority", priority);
  for (const mine of paramValues(params.mine)) search.append("mine", mine);
  search.set("cursor", cursor);
  return `${routes.progress.tasks}?${search.toString()}`;
}

function taskRecoveryHref(params: SearchParams) {
  const search = new URLSearchParams();
  const query = firstParam(params.q);
  const status = firstParam(params.status);
  const priority = firstParam(params.priority);
  if (query) search.set("q", query);
  if (params.status !== undefined) search.set("status", status);
  if (priority) search.set("priority", priority);
  for (const mine of paramValues(params.mine)) search.append("mine", mine);
  search.set("cursorError", "1");
  return `${routes.progress.tasks}?${search.toString()}`;
}
