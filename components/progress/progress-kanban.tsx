import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  taskStatusLabels,
  taskCategoryLabels,
  urgencyLabels,
} from "@/lib/progress-labels";
import type { TaskStatus } from "@prisma/client";
import { routes } from "@/lib/routes";

export type KanbanTask = {
  id: string;
  title: string;
  projectName: string;
  stageName: string | null;
  assigneeNames: string;
  team: string;
  techGroup: string;
  category: string;
  urgency: string;
  status: TaskStatus;
  isOverdue: boolean;
  hasRisk: boolean;
  dueAt: string;
};

type Props = {
  tasks: KanbanTask[];
  columns?: TaskStatus[];
};

const defaultColumns: TaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
  "COMPLETED",
];

export function ProgressKanban({ tasks, columns = defaultColumns }: Props) {
  return (
    <div className="grid gap-5 lg:grid-cols-4">
      {columns.map((col) => {
        const colTasks = tasks.filter((t) => t.status === col);
        return (
          <Card key={col} className="bg-card/80">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {taskStatusLabels[col]}
                <span className="ml-2 text-muted-foreground">({colTasks.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {colTasks.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无任务</p>
              )}
              {colTasks.map((task) => (
                <Link
                  key={task.id}
                  href={`${routes.progress.task(task.id)}`}
                  className="block rounded-lg border border-border/60 bg-background p-3 shadow-sm transition hover:border-primary/30"
                >
                  <p className="font-medium leading-snug">{task.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{task.projectName}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {task.isOverdue && (
                      <Badge variant="destructive" className="text-xs">
                        逾期
                      </Badge>
                    )}
                    {task.hasRisk && (
                      <Badge variant="destructive" className="text-xs">
                        风险
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {taskCategoryLabels[task.category as keyof typeof taskCategoryLabels] ?? task.category}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {urgencyLabels[task.urgency as keyof typeof urgencyLabels] ?? task.urgency}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {task.assigneeNames}
                    {task.stageName ? ` · ${task.stageName}` : ""} · 截止{" "}
                    {new Date(task.dueAt).toLocaleDateString("zh-CN")}
                  </p>
                </Link>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
