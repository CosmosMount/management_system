"use client";

import Link from "next/link";
import {
  ArchivedProjectDeleteButton,
  ArchivedTaskDeleteButton,
} from "@/components/admin-delete-actions";
import { Badge } from "@/components/ui/badge";
import type { ProjectStatus, TaskStatus } from "@prisma/client";
import { routes } from "@/lib/routes";
import {
  projectStatusLabels,
  taskStatusLabels,
} from "@/lib/progress-labels";

type ArchivedProjectRow = {
  id: string;
  name: string;
  team: string;
  techGroup: string;
  status: ProjectStatus;
  archivedAtLabel: string | null;
};

type ArchivedTaskRow = {
  id: string;
  title: string;
  projectName: string;
  assigneeNames: string;
  status: TaskStatus;
};

export function ArchivedProjectList({
  projects,
  isSuperAdmin,
}: {
  projects: ArchivedProjectRow[];
  isSuperAdmin: boolean;
}) {
  if (projects.length === 0) {
    return <p className="text-muted-foreground">暂无</p>;
  }

  return (
    <div className="space-y-2">
      {projects.map((project) => (
        <div
          key={project.id}
          className="flex items-center justify-between gap-3 rounded border p-3 hover:border-primary/30"
        >
          <Link
            href={`${routes.progress.project(project.id)}`}
            className="min-w-0 flex-1"
          >
            <p className="font-medium">{project.name}</p>
            <p className="text-sm text-muted-foreground">
              {formatScopeItem(project.team)} /{" "}
              {formatScopeItem(project.techGroup)}
              {project.archivedAtLabel ? ` · ${project.archivedAtLabel}` : ""}
            </p>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Badge>{projectStatusLabels[project.status]}</Badge>
            <ArchivedProjectDeleteButton
              projectId={project.id}
              status={project.status}
              isSuperAdmin={isSuperAdmin}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ArchivedTaskList({
  tasks,
  isSuperAdmin,
}: {
  tasks: ArchivedTaskRow[];
  isSuperAdmin: boolean;
}) {
  if (tasks.length === 0) {
    return <p className="text-muted-foreground">暂无</p>;
  }

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center justify-between gap-3 rounded border p-3 hover:border-primary/30"
        >
          <Link
            href={`${routes.progress.task(task.id)}`}
            className="min-w-0 flex-1"
          >
            <p className="font-medium">{task.title}</p>
            <p className="text-sm text-muted-foreground">
              {task.projectName} · {task.assigneeNames}
            </p>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary">
              {taskStatusLabels[task.status]}
            </Badge>
            <ArchivedTaskDeleteButton
              taskId={task.id}
              status={task.status}
              isSuperAdmin={isSuperAdmin}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatScopeItem(value: string): string {
  return value || "未指定";
}
