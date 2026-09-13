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
import { getProgressActorOrRedirect, getProgressRequestTime } from "../_auth";
import { evaluateDeadline } from "@/lib/project-management/current-node-deadline";

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
  const status = firstParam(params.status);
  const priority = firstParam(params.priority);
  const query = firstParam(params.q);
  const mine = params.mine === undefined ? false : paramValues(params.mine).includes("1");
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
      <div className="mx-auto flex w-full min-w-0 max-w-[100rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
          <div className="-mt-2">
            <p className="text-sm text-muted-foreground">在这里查看和管理项目的任务进度，快速了解每个任务的状态。</p>
          </div>
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
            className="grid min-w-0 items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm lg:grid-cols-[minmax(0,1fr)_170px_140px_140px_auto_auto]"
          />
          <TaskStats tasks={tasks.items} nowMs={getProgressRequestTime()} />
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

function TaskStats({ tasks, nowMs }: { tasks: Awaited<ReturnType<typeof listTasks>>["items"]; nowMs: number }) {
  const stats = [
    { label: "当前结果", value: tasks.length, tone: "text-slate-700", ring: "border-slate-300" },
    { label: "进行中", value: tasks.filter((task) => task.status === "ACTIVE").length, tone: "text-blue-700", ring: "border-blue-500" },
    { label: "已完成", value: tasks.filter((task) => task.status === "COMPLETED").length, tone: "text-emerald-700", ring: "border-emerald-500" },
    { label: "已逾期", value: tasks.filter((task) => evaluateDeadline(task.currentNodeDeadline, nowMs) === "OVERDUE").length, tone: "text-red-700", ring: "border-red-500" },
    { label: "未开始", value: tasks.filter((task) => task.status === "DRAFT").length, tone: "text-slate-600", ring: "border-slate-300" },
  ];
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{stats.map((stat) => <div key={stat.label} className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 shadow-sm"><span className={`flex size-12 shrink-0 items-center justify-center rounded-full border-[6px] bg-background text-sm font-semibold ${stat.ring} ${stat.tone}`}>{stat.value}</span><div><p className="text-sm text-muted-foreground">{stat.label}</p><p className={`text-xl font-semibold ${stat.tone}`}>{stat.value}</p></div></div>)}</div>;
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
