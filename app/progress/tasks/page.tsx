import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskList } from "@/components/project-management/task-list";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
        title="全部任务"
        description="按状态、优先级和关键词查看当前可见任务。"
        actions={
          actor.isActive === false ? null : (
            <Link href={routes.progress.taskNew} className={cn(buttonVariants())}>
              新建任务
            </Link>
          )
        }
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          {firstParam(params.cursorError) === "1" && (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              任务列表已变化，已为你返回第一页。
            </p>
          )}
          <form className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[1fr_160px_160px_auto_auto]">
            <Input
              name="q"
              defaultValue={query}
              placeholder="搜索任务名称或描述"
              aria-label="搜索任务名称或描述"
            />
            <select
              name="status"
              defaultValue={status}
              aria-label="任务状态"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="">全部状态</option>
              {statusValues.map((value) => (
                <option key={value} value={value}>
                  {taskStatusLabels[value]}
                </option>
              ))}
            </select>
            <select
              name="priority"
              defaultValue={priority}
              aria-label="任务优先级"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="">全部优先级</option>
              {priorityValues.map((value) => (
                <option key={value} value={value}>
                  {taskPriorityLabels[value]}
                </option>
              ))}
            </select>
            <label className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
              <input type="hidden" name="mine" value="0" />
              <input
                type="checkbox"
                name="mine"
                value="1"
                defaultChecked={mine}
              />
              只看我参与
            </label>
            <Button type="submit">筛选</Button>
          </form>
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
