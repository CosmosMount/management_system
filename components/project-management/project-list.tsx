import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import type { ProjectListItem } from "@/lib/project-management/queries/project-queries";
import { routes } from "@/lib/routes";

const labels = { DRAFT: "草稿", PENDING_APPROVAL: "立项审批中", ACTIVE: "进行中", COMPLETED: "已结束" } as const;
const columns = "lg:grid-cols-[minmax(0,2fr)_7rem_minmax(0,1fr)_10rem_6rem]";

export function ProjectList({ projects }: { projects: ProjectListItem[] }) {
  if (!projects.length) return <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">没有符合条件的项目</div>;
  return (
    <section aria-label="项目列表" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div aria-hidden="true" className={`hidden gap-4 border-b bg-muted/40 px-4 py-3 text-xs text-muted-foreground lg:grid ${columns}`}>
        <span>项目</span><span>状态</span><span>负责人</span><span>任务与参与人</span><span>操作</span>
      </div>
      {projects.map((project) => (
        <article key={project.id} data-testid={`project-list-item-${project.id}`} className={`grid min-w-0 gap-3 border-b px-4 py-3 text-sm last:border-b-0 hover:bg-muted/20 lg:items-start lg:gap-4 ${columns}`}>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <ProjectAvatar name={project.name} avatarPath={project.avatarPath} className="size-8 shrink-0" />
              <h2 className="min-w-0 truncate text-base font-medium"><Link href={routes.progress.projectDetail(project.id)} className="hover:text-primary hover:underline">{project.name}</Link></h2>
            </div>
            <details className="mt-2 min-w-0">
              <summary className="w-fit cursor-pointer rounded text-xs text-primary focus-visible:outline-2 focus-visible:outline-ring">展开完整内容</summary>
              <div className="mt-2 space-y-2 text-muted-foreground [overflow-wrap:anywhere]">
                <p>项目名称：{project.name}</p>
                <p className="whitespace-pre-wrap">项目简介：{project.description || "暂无项目简介"}</p>
                <p>负责人：{project.owners.map((owner) => owner.displayName).join("、") || "未设置"}</p>
              </div>
            </details>
          </div>
          <div><Badge variant="secondary">{labels[project.status]}</Badge></div>
          <p className="min-w-0 truncate text-muted-foreground"><span className="lg:hidden">负责人：</span>{project.owners.map((owner) => owner.displayName).join("、") || "未设置"}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>已完成 {project.completedTaskCount} / {project.taskCount} 项任务</span><span>参与人 {project.participantCount} 位</span>
          </div>
          <Link href={routes.progress.projectDetail(project.id)} className="inline-flex items-center justify-end gap-1 font-medium text-primary hover:underline lg:justify-start">打开项目<ArrowRight className="size-4" aria-hidden="true" /></Link>
        </article>
      ))}
    </section>
  );
}
