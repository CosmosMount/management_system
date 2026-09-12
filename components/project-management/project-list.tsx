"use client";

import Link from "next/link";
import { Tooltip } from "@base-ui/react/tooltip";
import { Badge } from "@/components/ui/badge";
import { TextTooltip } from "@/components/ui/text-tooltip";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import { OwnerAvatarGroup } from "@/components/project-management/owner-avatar-group";
import { ProjectTaskOverview } from "@/components/project-management/project-task-overview";
import { useProgressNow } from "@/components/project-management/progress-clock";
import { getProjectTaskOverview } from "@/lib/project-management/project-task-summary";
import { taskStatusLabels } from "@/lib/project-management/labels";
import type { ProjectListItem } from "@/lib/project-management/queries/project-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const labels = { DRAFT: "草稿", PENDING_APPROVAL: "立项审批中", ACTIVE: "进行中", COMPLETED: "已结束" } as const;
const statusClasses = {
  DRAFT: "bg-muted text-muted-foreground",
  PENDING_APPROVAL: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  ACTIVE: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200",
  COMPLETED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200",
};
const columns = "xl:grid-cols-[minmax(12rem,1.1fr)_minmax(0,2.4fr)_minmax(10rem,1.1fr)_5.5rem_6.5rem_6rem_4rem]";
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" });
const relativeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
const avatarClasses = [
  "bg-blue-50 text-blue-600 ring-blue-100 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-900",
  "bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
  "bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-900",
  "bg-rose-50 text-rose-500 ring-rose-100 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900",
  "bg-teal-50 text-teal-600 ring-teal-100 dark:bg-teal-950 dark:text-teal-300 dark:ring-teal-900",
  "bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
];

export function ProjectList({ projects }: { projects: ProjectListItem[] }) {
  const nowMs = useProgressNow() ?? Number.NaN;
  if (!projects.length) return <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">没有符合条件的项目</div>;
  return <Tooltip.Provider>
    <section aria-label="项目列表" className="min-w-0 rounded-xl border bg-card">
      <div aria-hidden="true" className={cn("hidden items-center gap-3 rounded-t-xl border-b bg-muted/25 px-4 py-4 text-sm font-medium text-muted-foreground xl:grid", columns)}>
        <span>项目</span><span>任务概览</span><span>汇总</span><span>项目状态</span><span>负责人</span><span>更新时间</span><span>操作</span>
      </div>
      {projects.map((project) => {
        const overview = getProjectTaskOverview(project.tasks, nowMs);
        return <article key={project.id} data-testid={`project-list-item-${project.id}`} className={cn("grid min-w-0 gap-4 border-b px-4 py-4 text-sm hover:bg-muted/10 xl:min-h-32 xl:items-center xl:gap-3", columns)}>
          <TextTooltip text={`${project.name}：${project.description || "暂无项目简介"}`}>
            <Link href={routes.progress.projectDetail(project.id)} className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
              <ProjectAvatar name={project.name} avatarPath={project.avatarPath} className={cn("size-12", !project.avatarPath && avatarClasses[Array.from(project.id).reduce((total, character) => total + character.charCodeAt(0), 0) % avatarClasses.length])} />
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{project.name}</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{project.description || "暂无项目简介"}</p>
              </div>
            </Link>
          </TextTooltip>
          <ProjectTaskOverview tasks={overview.tasks} projectName={project.name} nowMs={nowMs} />
          <ProjectTaskSummary project={project} overdueCount={overview.overdueCount} dueSoonCount={overview.dueSoonCount} />
          <div className="min-w-0"><span className="mr-2 text-xs text-muted-foreground xl:hidden">项目状态</span><Badge className={cn("h-auto whitespace-normal border-0 px-2.5 py-1 text-sm", statusClasses[project.status])}>{labels[project.status]}</Badge></div>
          <OwnerAvatarGroup owners={project.owners} label="项目负责人" />
          <div className="text-sm tabular-nums">
            <span className="mr-2 text-muted-foreground xl:hidden">更新时间</span>
            <time dateTime={project.updatedAt}>{dateFormatter.format(new Date(project.updatedAt))}</time>
            <p className="mt-1 text-muted-foreground">{relativeUpdatedAt(project.updatedAt, nowMs)}</p>
          </div>
          <Link href={routes.progress.projectDetail(project.id)} className="inline-flex w-fit items-center justify-center rounded-lg bg-primary/5 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring">打开</Link>
        </article>;
      })}
      <footer className="space-y-2 px-4 py-4 text-xs text-muted-foreground">
        <div aria-label="任务期限图例" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <LegendDot className="bg-red-600" label="已逾期" /><LegendDot className="bg-amber-600" label="72 小时内到期" /><LegendDot className="bg-emerald-600" label="距到期超过 3 天" /><LegendDot className="bg-muted-foreground" label="草稿／暂无有效期限" />
        </div>
        <p>任务概览仅展示草稿与进行中的任务，紧急优先；颜色表示当前节点期限，不代表完成状态。完成进度统计全部非取消任务，期限预警与进行中计数重叠。</p>
      </footer>
    </section>
  </Tooltip.Provider>;
}

function ProjectTaskSummary({ project, overdueCount, dueSoonCount }: { project: ProjectListItem; overdueCount: number; dueSoonCount: number }) {
  const percent = project.completionTaskTotalCount ? Math.round(project.completedTaskCount / project.completionTaskTotalCount * 100) : 0;
  return <div className="min-w-0 space-y-1.5" data-testid="project-task-summary">
    <p className="text-base font-semibold tabular-nums" aria-label={`已完成 ${project.completedTaskCount} / ${project.completionTaskTotalCount} 个非取消任务`}>{project.completedTaskCount} / {project.completionTaskTotalCount}</p>
    <div role="progressbar" aria-label={`${project.name}任务完成进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
    </div>
    <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {(["COMPLETED", "ACTIVE", "DRAFT", "FAILED", "TIMEOUT", "ARCHIVED"] as const).map((status) => (
        (["COMPLETED", "ACTIVE", "DRAFT"].includes(status) || project.taskStatusCounts[status] > 0) && <span key={status} className="whitespace-nowrap">{taskStatusLabels[status]} <span className="font-medium tabular-nums text-foreground">{project.taskStatusCounts[status]}</span></span>
      ))}
    </div>
    {(overdueCount > 0 || dueSoonCount > 0) && <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs" aria-label="进行中任务期限预警">
      {overdueCount > 0 && <span className="text-red-700 dark:text-red-300">已逾期 {overdueCount}</span>}
      {dueSoonCount > 0 && <span className="text-amber-800 dark:text-amber-200">即将到期 {dueSoonCount}</span>}
    </p>}
  </div>;
}

function LegendDot({ label, className }: { label: string; className: string }) {
  return <span className="inline-flex items-center gap-2"><span aria-hidden="true" className={cn("size-2 rounded-full", className)} />{label}</span>;
}

function relativeUpdatedAt(updatedAt: string, nowMs: number) {
  if (!Number.isFinite(nowMs)) return "";
  const seconds = (Date.parse(updatedAt) - nowMs) / 1_000;
  if (Math.abs(seconds) < 60) return "刚刚";
  if (Math.abs(seconds) < 3_600) return relativeFormatter.format(Math.trunc(seconds / 60), "minute");
  if (Math.abs(seconds) < 86_400) return relativeFormatter.format(Math.trunc(seconds / 3_600), "hour");
  return relativeFormatter.format(Math.trunc(seconds / 86_400), "day");
}
