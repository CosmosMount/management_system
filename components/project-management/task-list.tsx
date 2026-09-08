import Link from "next/link";
import { ArrowRight, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import {
  formatDateTime,
  taskMemberRoleLabels,
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskListItem } from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";

export function TaskList({ tasks }: { tasks: TaskListItem[] }) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        当前没有可见任务。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => (
        <article
          key={task.id}
          className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40"
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 truncate text-base font-medium"><Link href={routes.progress.taskDetail(task.id)} className="hover:text-primary hover:underline">{task.title}</Link></h2>
                <Badge>{taskStatusLabels[task.status]}</Badge>
                <Badge variant="secondary">
                  {taskPriorityLabels[task.priority]}
                </Badge>
                {task.project && <Link href={routes.progress.projectDetail(task.project.id)} className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs hover:border-primary/50 hover:text-primary"><ProjectAvatar name={task.project.name} avatarPath={task.project.avatarPath} className="size-4" /><span className="max-w-48 truncate">{task.project.name}</span></Link>}
              </div>
              {task.description && (
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                  {task.description}
                </p>
              )}
              <p className="mt-2 text-sm text-muted-foreground">
                {task.team || "未设置战队"} / {task.techGroup || "未设置组别"} ·
                当前计划 v{task.currentPlanVersionNo}
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2 text-sm text-muted-foreground lg:w-80">
              {task.activeMilestone ? (
                <p className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4" aria-hidden="true" />
                  当前：{task.activeMilestone.goal} ·{" "}
                  {formatDateTime(task.activeMilestone.expectedCompletedAt)}
                </p>
              ) : task.activeTermination ? (
                <p className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4" aria-hidden="true" />
                  当前：{task.activeTermination.name} ·{" "}
                  {formatDateTime(task.activeTermination.plannedAt)}
                </p>
              ) : (
                <p>当前没有进行中的里程碑</p>
              )}
              <p>
                {task.members
                  .slice(0, 4)
                  .map(
                    (member) =>
                      `${member.displayName}(${taskMemberRoleLabels[member.role]})`,
                  )
                  .join("、")}
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Link href={routes.progress.taskDetail(task.id)} className="inline-flex items-center gap-1 text-sm text-primary">
              打开工作台
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
