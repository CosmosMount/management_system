"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, X } from "lucide-react";
import { ProjectMultiSelect } from "@/components/project-management/project-picker";
import { TaskMultiSelect } from "@/components/project-management/task-picker";
import { UserMultiSelect } from "@/components/project-management/user-picker";
import { Button } from "@/components/ui/button";
import type { ProjectOption } from "@/lib/project-management/queries/project-queries";
import { taskStatusLabels } from "@/lib/project-management/labels";
import {
  RESOURCE_PLAN_TASK_STATUS_OPTIONS,
  removeRetiredResourcePlanSearchParams,
  removeTransientResourcePlanSearchParams,
  serializeResourcePlanTaskStatuses,
  type ResourcePlanTaskStatus,
} from "@/lib/project-management/resource-plan-url";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";

export function ResourceFilterBar({
  initial,
  initialProjects,
  initialPeople,
  initialTasks,
}: {
  initial: {
    all: boolean;
    projectIds: string[];
    taskIds: string[];
    personIds: string[];
    taskStatuses: ResourcePlanTaskStatus[];
  };
  initialProjects: ProjectOption[];
  initialPeople: PersonOptionDto[];
  initialTasks: TaskOptionPage["items"];
}) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(initial.all);
  const [projectIds, setProjectIds] = useState(initial.projectIds);
  const [taskIds, setTaskIds] = useState(initial.taskIds);
  const [personIds, setPersonIds] = useState(initial.personIds);
  const [taskStatuses, setTaskStatuses] = useState(initial.taskStatuses);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("taskStatusNotice")) return;
    removeTransientResourcePlanSearchParams(url.searchParams);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const apply = () => {
    const current = new URL(window.location.href);
    const params = new URLSearchParams();
    params.set("all", showAll ? "1" : "0");
    const serializedTaskStatuses = serializeResourcePlanTaskStatuses(
      taskStatuses,
    );
    if (serializedTaskStatuses !== null) {
      params.set("taskStatuses", serializedTaskStatuses);
    }
    if (!showAll) {
      setList(params, "projects", projectIds);
      setList(params, "tasks", taskIds);
      setList(params, "people", personIds);
    }
    for (const key of ["scale", "center"] as const) {
      const value = current.searchParams.get(key);
      if (value) params.set(key, value);
    }
    router.push(`/progress/resources?${params.toString()}`);
  };

  const selectedCount = projectIds.length + taskIds.length + personIds.length;
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-4"
      aria-label="资源计划选择"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <input
            className="size-4 accent-primary"
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          <span className="min-w-0">
            <span className="block font-medium">显示全部资源</span>
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={apply}>应用选择</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const url = new URL(window.location.href);
              removeRetiredResourcePlanSearchParams(url.searchParams);
              removeTransientResourcePlanSearchParams(url.searchParams);
              void navigator.clipboard.writeText(url.toString()).then(
                () => setNotice("已复制当前资源计划链接"),
                () => setNotice("无法访问剪贴板，请复制浏览器地址栏链接"),
              );
            }}
          >
            <Copy aria-hidden="true" />复制视图链接
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setShowAll(false);
              setProjectIds([]);
              setTaskIds([]);
              setPersonIds([]);
            }}
          >
            <X aria-hidden="true" />清空选择
          </Button>
        </div>
      </div>

      <fieldset className="min-w-0 border-t border-border pt-3">
        <legend className="pr-3 text-xs font-medium text-muted-foreground">
          任务状态（{taskStatuses.length}）
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {RESOURCE_PLAN_TASK_STATUS_OPTIONS.map((status) => (
            <label
              key={status}
              className="flex min-w-0 items-center gap-2 text-sm"
            >
              <input
                className="size-4 shrink-0 accent-primary"
                type="checkbox"
                checked={taskStatuses.includes(status)}
                onChange={(event) => {
                  setTaskStatuses((current) =>
                    RESOURCE_PLAN_TASK_STATUS_OPTIONS.filter((candidate) =>
                      candidate === status
                        ? event.target.checked
                        : current.includes(candidate),
                    ),
                  );
                }}
              />
              <span>{taskStatusLabels[status]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={showAll ? "hidden" : "grid gap-3 lg:grid-cols-3"} aria-disabled={showAll}>
        <fieldset
          className="min-w-0 rounded-lg border border-border p-3 disabled:opacity-60"
          disabled={showAll}
        >
          <legend className="px-1 text-sm font-medium">项目（{projectIds.length}）</legend>
          <ProjectMultiSelect
            value={projectIds}
            onValueChange={setProjectIds}
            initialOptions={initialProjects}
            disabled={showAll}
          />
        </fieldset>
        <fieldset className="min-w-0 rounded-lg border border-border p-3 disabled:opacity-60" disabled={showAll}>
          <legend className="px-1 text-sm font-medium">任务（{taskIds.length}）</legend>
          <TaskMultiSelect
            ariaLabel="筛选任务"
            value={taskIds}
            onValueChange={setTaskIds}
            initialOptions={initialTasks}
            disabled={showAll || taskStatuses.length === 0}
            statuses={taskStatuses}
            maxSelected={Number.POSITIVE_INFINITY}
            placeholder="按标题、描述或拼音首字母搜索"
          />
        </fieldset>
        <fieldset className="min-w-0 rounded-lg border border-border p-3 disabled:opacity-60" disabled={showAll}>
          <legend className="px-1 text-sm font-medium">人员（{personIds.length}）</legend>
          <UserMultiSelect
            ariaLabel="筛选人员"
            scope={{ purpose: "VISIBLE" }}
            value={personIds}
            onValueChange={setPersonIds}
            initialOptions={initialPeople}
            disabled={showAll}
            maxSelected={Number.POSITIVE_INFINITY}
            placeholder="按姓名或拼音首字母搜索"
          />
        </fieldset>
      </div>

      <p className="text-xs text-muted-foreground" role="status">
        {showAll
          ? taskStatuses.length > 0
            ? `当前展示全部可见人员，以及 ${taskStatuses.length} 种状态的任务计划。`
            : "当前展示全部可见人员，不显示任务计划。"
          : selectedCount > 0
            ? `已选择 ${projectIds.length} 个项目、${taskIds.length} 个任务、${personIds.length} 个人员；显示 ${taskStatuses.length} 种状态的任务计划，关联成员会自动并入。`
            : "当前未选择资源，应用后显示空画布。"}
        {notice ? ` ${notice}` : ""}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">筛选范围说明</summary>
        <p className="mt-2">任务状态仅筛选任务计划轨道；进入画布的人员仍展示全部可见投入。取消“显示全部资源”后，可按项目、任务或人员缩小范围。</p>
      </details>
    </section>
  );
}

function setList(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, [...new Set(values)].sort().join(","));
}
