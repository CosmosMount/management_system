"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  resolveTaskOptionsByIds,
  searchTaskOptions,
} from "@/app/actions/project-management/options";
import {
  AsyncCombobox,
  AsyncMultiCombobox,
} from "@/components/entity-picker/async-combobox";
import { Badge } from "@/components/ui/badge";
import {
  formatDateTime,
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskOptionPage } from "@/lib/project-management/types/time-canvas";

type TaskPickerOption = TaskOptionPage["items"][number] & {
  disabled?: boolean;
  disabledReason?: string;
};

const EMPTY_TASK_OPTIONS: TaskPickerOption[] = [];

export type TaskPickerFilters = {
  statuses?: TaskPickerOption["status"][];
  mine?: boolean;
  projectCandidates?: boolean;
};

type CommonProps = TaskPickerFilters & {
  initialOptions?: TaskPickerOption[];
  excludeIds?: string[];
  name?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  inputId?: string;
  ariaLabel?: string;
  invalid?: boolean;
  ariaDescribedBy?: string;
};

export function TaskSelect({
  value,
  onValueChange,
  clearable = true,
  allowIndependent = false,
  onOptionChange,
  ariaLabel = "选择任务",
  ...props
}: CommonProps & {
  value: string | null;
  onValueChange: (value: string | null) => void;
  clearable?: boolean;
  allowIndependent?: boolean;
  onOptionChange?: (option: TaskPickerOption | null) => void;
}) {
  const picker = useTaskPicker(
    props,
    props.initialOptions ?? EMPTY_TASK_OPTIONS,
  );
  return (
    <AsyncCombobox
      {...props}
      {...picker}
      ariaLabel={ariaLabel}
      value={value}
      onValueChange={(nextValue) => {
        onValueChange(nextValue);
        onOptionChange?.(
          nextValue ? picker.optionById(nextValue) ?? null : null,
        );
      }}
      clearable={clearable || allowIndependent}
      nullOptionLabel={allowIndependent ? "独立投入（不关联任务）" : undefined}
      getOptionLabel={(option) => option.title}
      getOptionDescription={getTaskOptionDescription}
      renderOption={(option) => <TaskOptionContent option={option} />}
    />
  );
}

export function TaskMultiSelect({
  value,
  onValueChange,
  clearable = true,
  maxSelected = 50,
  showSelectedList = false,
  ariaLabel = "选择任务",
  ...props
}: CommonProps & {
  value: string[];
  onValueChange: (value: string[]) => void;
  clearable?: boolean;
  maxSelected?: number;
  showSelectedList?: boolean;
}) {
  const picker = useTaskPicker(
    props,
    props.initialOptions ?? EMPTY_TASK_OPTIONS,
  );
  return <div className="space-y-3">
    <AsyncMultiCombobox
        {...props}
        {...picker}
        ariaLabel={ariaLabel}
        value={value}
        onValueChange={onValueChange}
        clearable={clearable}
        maxSelected={maxSelected}
        getOptionLabel={(option) => option.title}
        getOptionDescription={getTaskOptionDescription}
        renderOption={(option) => <TaskOptionContent option={option} />}
      />
    {showSelectedList && value.length > 0 && <div className="space-y-2">
      <p className="text-sm font-medium">已选择 {value.length} 个任务</p>
      <ul className="divide-y rounded-lg border" aria-label="已选择的任务">
        {value.map((id) => {
          const option = picker.optionById(id);
          return <li key={id} className="flex min-w-0 items-center gap-3 p-3">
            <div className="min-w-0 flex-1">{option ? <TaskOptionContent option={option} /> : <span className="text-sm text-muted-foreground">正在加载已选择的任务…</span>}</div>
            <button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`移除${option?.title ?? "已选择的任务"}`} onClick={() => onValueChange(value.filter((taskId) => taskId !== id))}><X className="size-4" aria-hidden="true" /></button>
          </li>;
        })}
      </ul>
    </div>}
  </div>;
}

function useTaskPicker(filters: TaskPickerFilters, initialOptions: TaskPickerOption[]) {
  const [, setOptionRevision] = useState(0);
  const statusesKey = [...(filters.statuses ?? [])].sort().join(",");
  const scopeKey = `${statusesKey}|${filters.mine ? "mine" : "all"}|${filters.projectCandidates ? "project-candidates" : "all-projects"}`;
  const decorate = useCallback(
    (options: TaskOptionPage["items"]): TaskPickerOption[] =>
      options.map((option) => {
        const disabled = Boolean(
          statusesKey && !statusesKey.split(",").includes(option.status),
        );
        return {
          ...option,
          disabled,
          disabledReason: disabled
            ? "该任务不符合当前状态筛选，不能新增选择"
            : undefined,
        };
      }),
    [statusesKey],
  );
  const decoratedInitialOptions = useMemo(
    () => decorate(initialOptions),
    [decorate, initialOptions],
  );
  const optionCache = useRef(
    new Map(decoratedInitialOptions.map((option) => [option.id, option])),
  );
  useEffect(() => {
    for (const option of decoratedInitialOptions) {
      optionCache.current.set(option.id, option);
    }
  }, [decoratedInitialOptions]);
  const loadOptions = useCallback(
    async ({ query, cursor }: { query: string; cursor?: string }) => {
      const result = await searchTaskOptions({
        query: query || undefined,
        statuses: statusesKey
          ? (statusesKey.split(",") as TaskPickerOption["status"][])
          : undefined,
        mine: filters.mine,
        projectCandidates: filters.projectCandidates,
        cursor,
        limit: 50,
      });
      if (!result.ok) throw new Error(result.error.message);
      const items = decorate(result.data.items);
      for (const option of items) {
        optionCache.current.set(option.id, option);
      }
      setOptionRevision((current) => current + 1);
      return { ...result.data, items };
    },
    [decorate, filters.mine, filters.projectCandidates, statusesKey],
  );
  const resolveOptions = useCallback(async (ids: string[]) => {
    const result = await resolveTaskOptionsByIds({ ids, projectCandidates: filters.projectCandidates });
    if (!result.ok) throw new Error(result.error.message);
    const items = decorate(result.data);
    for (const option of items) optionCache.current.set(option.id, option);
    setOptionRevision((current) => current + 1);
    return items;
  }, [decorate, filters.projectCandidates]);
  const optionById = useCallback(
    (id: string) => optionCache.current.get(id),
    [],
  );
  return {
    scopeKey,
    initialOptions: decoratedInitialOptions,
    loadOptions,
    resolveOptions,
    optionById,
  };
}

function TaskOptionContent({ option }: { option: TaskPickerOption }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="max-w-full truncate font-medium">{option.title}</span>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {taskStatusLabels[option.status]}
        </Badge>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {taskPriorityLabels[option.priority]}
        </Badge>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {option.team || "未设置车组"} / {option.techGroup || "未设置技术组"}
        {option.activeMilestone
          ? ` · ${option.activeMilestone.goal} · ${formatDateTime(option.activeMilestone.expectedCompletedAt)}`
          : " · 无当前里程碑"}
      </p>
    </div>
  );
}

function getTaskOptionDescription(option: TaskPickerOption) {
  const organization = `${option.team || "未设置车组"} / ${option.techGroup || "未设置技术组"}`;
  const milestone = option.activeMilestone
    ? `${option.activeMilestone.goal} · ${formatDateTime(option.activeMilestone.expectedCompletedAt)}`
    : "无当前里程碑";
  return `${taskStatusLabels[option.status]} · ${taskPriorityLabels[option.priority]} · ${organization} · ${milestone}`;
}
