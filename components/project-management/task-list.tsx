import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import { OwnerAvatarGroup } from "@/components/project-management/owner-avatar-group";
import { NodeDeadline } from "@/components/project-management/node-deadline";
import { formatDateTime, taskPriorityLabels, taskStatusLabels } from "@/lib/project-management/labels";
import type { TaskListItem } from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";

const columns = "grid-cols-[minmax(19rem,2.6fr)_7rem_6.5rem_minmax(7rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_8rem]";

const statusClass: Record<string, string> = {
  ACTIVE: "border-blue-200 bg-blue-50 text-blue-700",
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  DRAFT: "border-slate-200 bg-slate-50 text-slate-600",
  FAILED: "border-red-200 bg-red-50 text-red-700",
  CANCELLED: "border-slate-200 bg-slate-50 text-slate-600",
  TIMEOUT: "border-red-200 bg-red-50 text-red-700",
  ARCHIVED: "border-slate-200 bg-slate-50 text-slate-600",
};
const priorityClass: Record<string, string> = {
  CRITICAL: "border-red-200 bg-red-50 text-red-700",
  HIGH: "border-rose-200 bg-rose-50 text-rose-700",
  MEDIUM: "border-amber-200 bg-amber-50 text-amber-700",
  LOW: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

export function TaskList({ tasks }: { tasks: TaskListItem[] }) {
  if (tasks.length === 0) return <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">当前没有可见任务。</div>;
  return (
    <section aria-label="任务列表" className="min-w-0 overflow-x-auto rounded-2xl border border-slate-200 bg-card shadow-sm">
      <div aria-hidden="true" className={`grid gap-4 bg-slate-50/80 px-5 py-3 text-xs font-medium text-slate-500 ${columns}`}>
        <span>任务信息</span><span>状态</span><span>优先级</span><span>负责人</span><span>当前节点</span><span>计划时间</span><span>操作</span>
      </div>
      {tasks.map((task) => {
        const owners = task.members.filter((member) => member.role === "OWNER");
        const node = task.activeMilestone?.goal ?? task.activeTermination?.name ?? "暂无进行中的节点";
        const plannedAt = task.activeMilestone?.expectedCompletedAt ?? task.activeTermination?.plannedAt;
        return (
          <article key={task.id} data-testid={`task-list-item-${task.id}`} className={`grid min-w-0 gap-4 items-center border-t border-slate-100 px-5 py-4 text-sm first:border-t-0 ${columns}`}>
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg font-semibold text-primary">{task.title.slice(0, 1)}</div>
              <div className="min-w-0">
                <Link href={routes.progress.taskDetail(task.id)} className="block truncate text-[15px] font-semibold text-foreground hover:text-primary hover:underline">{task.title}</Link>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {task.project ? <Link href={routes.progress.projectDetail(task.project.id)} className="inline-flex min-w-0 items-center gap-1 hover:text-primary"><ProjectAvatar name={task.project.name} avatarPath={task.project.avatarPath} className="size-4" /><span className="truncate">所属项目：{task.project.name}</span></Link> : <span>未关联项目</span>}
                  <span aria-hidden="true">·</span><span>#{task.id.slice(0, 6).toUpperCase()}</span>
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{task.description || "暂无任务描述"}</p>
              </div>
            </div>
            <Badge variant="outline" className={statusClass[task.status]}>{taskStatusLabels[task.status]}</Badge>
            <Badge variant="outline" className={priorityClass[task.priority]}>{taskPriorityLabels[task.priority]}</Badge>
            <OwnerAvatarGroup owners={owners} label="任务负责人" />
            <div className="min-w-0 truncate text-muted-foreground" title={node}>{node}</div>
            <div className="min-w-0 text-muted-foreground"><div>{plannedAt ? formatDateTime(plannedAt) : "未设置"}</div><NodeDeadline target={task.currentNodeDeadline} className="mt-1" /></div>
            <div className="flex items-center gap-2"><Link href={routes.progress.taskDetail(task.id)} className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-primary hover:underline">打开工作台<ArrowRight className="size-4" /></Link></div>
          </article>
        );
      })}
    </section>
  );
}
