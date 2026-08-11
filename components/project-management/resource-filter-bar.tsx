"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, X } from "lucide-react";
import { ProjectMultiSelect } from "@/components/project-management/project-picker";
import { TaskMultiSelect } from "@/components/project-management/task-picker";
import { UserMultiSelect } from "@/components/project-management/user-picker";
import { Button } from "@/components/ui/button";
import type { ProjectOption } from "@/lib/project-management/queries/project-queries";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import { removeRetiredResourcePlanSearchParams } from "@/lib/project-management/resource-plan-url";

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
  const [notice, setNotice] = useState("");

  const apply = () => {
    const current = new URL(window.location.href);
    const params = new URLSearchParams();
    params.set("all", showAll ? "1" : "0");
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
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      aria-label="资源计划选择"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-w-0 items-start gap-3 rounded-lg border border-border px-3 py-2">
          <input
            className="mt-1"
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          <span className="min-w-0">
            <span className="block font-medium">显示全部资源</span>
            <span className="block text-sm text-muted-foreground">
              显示全部可见 Task 的 Current Plan 和全部可见人员投入。
            </span>
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

      <div className="grid gap-3 lg:grid-cols-3" aria-disabled={showAll}>
        <fieldset className="min-w-0 rounded-lg border border-border p-3 disabled:opacity-60" disabled={showAll}>
          <legend className="px-1 text-sm font-medium">Project（{projectIds.length}）</legend>
          <ProjectMultiSelect
            value={projectIds}
            onValueChange={setProjectIds}
            initialOptions={initialProjects}
            disabled={showAll}
          />
        </fieldset>
        <fieldset className="min-w-0 rounded-lg border border-border p-3 disabled:opacity-60" disabled={showAll}>
          <legend className="px-1 text-sm font-medium">Task（{taskIds.length}）</legend>
          <TaskMultiSelect
            ariaLabel="筛选 Task"
            value={taskIds}
            onValueChange={setTaskIds}
            initialOptions={initialTasks}
            disabled={showAll}
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
            placeholder="按姓名或拼音首字母搜索"
          />
        </fieldset>
      </div>

      <p className="text-sm text-muted-foreground" role="status">
        {showAll
          ? "当前包含全部可见资源；Task 与人员分别分页。"
          : selectedCount > 0
            ? `已选择 ${projectIds.length} 个 Project、${taskIds.length} 个 Task、${personIds.length} 个人员；关联 Task 和成员会自动并入。`
            : "当前未选择资源，应用后显示空画布。"}
        {notice ? ` ${notice}` : ""}
      </p>
    </section>
  );
}

function setList(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, [...new Set(values)].sort().join(","));
}
