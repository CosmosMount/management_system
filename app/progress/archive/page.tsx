import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  projectStatusLabels,
  taskStatusLabels,
} from "@/lib/progress-labels";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
import { prisma } from "@/lib/prisma";

export default async function ArchivePage() {
  const [projects, tasks] = await Promise.all([
    prisma.project.findMany({
      where: { status: { in: ["COMPLETED", "CANCELED"] } },
      orderBy: { archivedAt: "desc" },
    }),
    prisma.task.findMany({
      where: { status: "ARCHIVED" },
      include: {
        project: { select: { name: true } },
        assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
      orderBy: { archivedAt: "desc" },
    }),
  ]);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout className="space-y-8">
          <PageTitle subtitle="归档检索" />

          <Card>
            <CardHeader>
              <CardTitle>已结束项目 ({projects.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {projects.length === 0 ? (
                <p className="text-muted-foreground">暂无</p>
              ) : (
                projects.map((p) => (
                  <Link
                    key={p.id}
                    href={`/progress/projects/${p.id}`}
                    className="flex items-center justify-between rounded border p-3 hover:border-primary/30"
                  >
                    <div>
                      <p className="font-medium">{p.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatScopeItem(p.team)} /{" "}
                        {formatScopeItem(p.techGroup)}
                        {p.archivedAt &&
                          ` · ${p.archivedAt.toLocaleDateString("zh-CN")}`}
                      </p>
                    </div>
                    <Badge>{projectStatusLabels[p.status]}</Badge>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>已归档任务 ({tasks.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {tasks.length === 0 ? (
                <p className="text-muted-foreground">暂无</p>
              ) : (
                tasks.map((t) => (
                  <Link
                    key={t.id}
                    href={`/progress/tasks/${t.id}`}
                    className="flex items-center justify-between rounded border p-3 hover:border-primary/30"
                  >
                    <div>
                      <p className="font-medium">{t.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {t.project.name} · {getTaskAssigneeNames(t)}
                      </p>
                    </div>
                    <Badge variant="secondary">
                      {taskStatusLabels[t.status]}
                    </Badge>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}

function formatScopeItem(value: string): string {
  return value || "未指定";
}
