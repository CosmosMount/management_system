import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import { NodeDeadline } from "@/components/project-management/node-deadline";
import {
  formatDateTime,
  taskMemberRoleLabels,
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskListItem } from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";

const columns = "lg:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1fr)_minmax(0,1fr)_7rem]";

export function TaskList({ tasks }: { tasks: TaskListItem[] }) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        当前没有可见任务。
      </div>
    );
  }

  return (
    <section aria-label="任务列表" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div aria-hidden="true" className={`hidden gap-4 border-b bg-muted/40 px-4 py-3 text-xs text-muted-foreground lg:grid ${columns}`}>
        <span>任务 / 所属项目</span><span>状态 / 优先级</span><span>成员</span><span>当前节点 / 计划时间</span><span>操作</span>
      </div>
      {tasks.map((task) => (
        <article
          key={task.id}
          data-testid={`task-list-item-${task.id}`}
          className={`grid min-w-0 gap-3 border-b px-4 py-3 text-sm last:border-b-0 hover:bg-muted/20 lg:items-start lg:gap-4 ${columns}`}
        >
            <div className="min-w-0">
              <h2 className="min-w-0 truncate text-base font-medium"><Link href={routes.progress.taskDetail(task.id)} className="hover:text-primary hover:underline">{task.title}</Link></h2>
              {task.project ? <Link href={routes.progress.projectDetail(task.project.id)} className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs hover:border-primary/50 hover:text-primary"><ProjectAvatar name={task.project.name} avatarPath={task.project.avatarPath} className="size-4 shrink-0" /><span className="min-w-0 truncate">{task.project.name}</span></Link> : <p className="mt-1 text-xs text-muted-foreground">未关联项目</p>}
              <details className="mt-2 min-w-0">
                <summary className="w-fit cursor-pointer rounded text-xs text-primary focus-visible:outline-2 focus-visible:outline-ring">展开完整内容</summary>
                <div className="mt-2 space-y-2 text-muted-foreground [overflow-wrap:anywhere]">
                  <p>任务名称：{task.title}</p>
                  <p className="whitespace-pre-wrap">任务描述：{task.description || "暂无任务描述"}</p>
                  <p>所属项目：{task.project?.name || "未关联项目"}</p>
                  <p>战队 / 组别：{task.team || "未设置战队"} / {task.techGroup || "未设置组别"} · 当前计划 v{task.currentPlanVersionNo}</p>
                  <p>成员：{task.members.map((member) => `${member.displayName}(${taskMemberRoleLabels[member.role]})`).join("、") || "未设置"}</p>
                  <p>当前节点：{task.activeMilestone?.goal || task.activeTermination?.name || "当前没有进行中的里程碑"}</p>
                </div>
              </details>
            </div>
            <div className="flex flex-wrap gap-2 lg:flex-col lg:items-start">
              <Badge>{taskStatusLabels[task.status]}</Badge>
              <Badge variant="secondary">{taskPriorityLabels[task.priority]}</Badge>
            </div>
            <p className="min-w-0 line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">
              <span className="lg:hidden">成员：</span>
              {task.members.slice(0, 4).map((member) => `${member.displayName}(${taskMemberRoleLabels[member.role]})`).join("、") || "未设置"}
              {task.members.length > 4 && ` 等 ${task.members.length} 位成员`}
            </p>
            <div className="min-w-0 text-muted-foreground">
              <NodeDeadline target={task.currentNodeDeadline} className="mb-1" />
              {task.activeMilestone ? (
                <><p className="line-clamp-2 [overflow-wrap:anywhere]">当前：{task.activeMilestone.goal}</p><p className="mt-1 text-xs">{formatDateTime(task.activeMilestone.expectedCompletedAt)}</p></>
              ) : task.activeTermination ? (
                <><p className="line-clamp-2 [overflow-wrap:anywhere]">当前：{task.activeTermination.name}</p><p className="mt-1 text-xs">{formatDateTime(task.activeTermination.plannedAt)}</p></>
              ) : (
                <p>当前没有进行中的里程碑</p>
              )}
            </div>
          <div className="flex justify-end lg:justify-start">
            <Link href={routes.progress.taskDetail(task.id)} className="inline-flex items-center gap-1 text-sm text-primary">
              打开工作台
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </article>
      ))}
    </section>
  );
}
