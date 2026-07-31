import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskList } from "@/components/project-management/task-list";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import { listTasks } from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import Link from "next/link";
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
  const status = firstParam(params.status);
  const priority = firstParam(params.priority);
  const query = firstParam(params.q);
  const tasks = await listTasks({
    actor,
    input: {
      status: statusValues.includes(status as (typeof statusValues)[number])
        ? (status as (typeof statusValues)[number])
        : undefined,
      priority: priorityValues.includes(priority as (typeof priorityValues)[number])
        ? (priority as (typeof priorityValues)[number])
        : undefined,
      mine: firstParam(params.mine) === "1",
      query,
      limit: 50,
    },
  });

  return (
    <>
      <PageCommandBar
        title="全部 Task"
        description="按状态、优先级和关键词查看当前可见 Task。"
        actions={
          <Link href={routes.progress.taskNew} className={cn(buttonVariants())}>
            新建 Task
          </Link>
        }
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <form className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[1fr_160px_160px_auto_auto]">
            <Input
              name="q"
              defaultValue={query}
              placeholder="搜索 Task 名称或描述"
              aria-label="搜索 Task 名称或描述"
            />
            <select
              name="status"
              defaultValue={status}
              aria-label="Task 状态"
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
              aria-label="Task 优先级"
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
              <input
                type="checkbox"
                name="mine"
                value="1"
                defaultChecked={firstParam(params.mine) === "1"}
              />
              只看我参与
            </label>
            <Button type="submit">筛选</Button>
          </form>
          <TaskList tasks={tasks.items} />
      </div>
    </>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
