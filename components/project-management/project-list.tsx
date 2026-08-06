import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import type { ProjectListItem } from "@/lib/project-management/queries/project-queries";
import { routes } from "@/lib/routes";

const labels = { DRAFT: "草稿", PENDING_APPROVAL: "立项审批中", ACTIVE: "进行中", COMPLETED: "已结束" } as const;

export function ProjectList({ projects }: { projects: ProjectListItem[] }) {
  if (!projects.length) return <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">没有符合条件的 Project</div>;
  return <div className="grid min-w-0 gap-4 lg:grid-cols-2">{projects.map((project) => (
    <Card key={project.id} className="min-w-0">
      <CardHeader className="grid-cols-[auto_1fr_auto] items-start gap-3">
        <ProjectAvatar name={project.name} avatarPath={project.avatarPath} />
        <div className="min-w-0"><CardTitle className="break-words text-lg">{project.name}</CardTitle><p className="mt-1 text-xs text-muted-foreground">负责人：{project.owners.map((owner) => owner.displayName).join("、") || "未设置"}</p></div>
        <Badge variant="secondary">{labels[project.status]}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="line-clamp-3 break-words text-sm text-muted-foreground">{project.description}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
          <span className="text-muted-foreground">{project.completedTaskCount}/{project.taskCount} Task 已完成 · {project.participantCount} 位参与人</span>
          <Link href={routes.progress.projectDetail(project.id)} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">打开 Project<ArrowRight className="size-4" /></Link>
        </div>
      </CardContent>
    </Card>
  ))}</div>;
}
