"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
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
  tagIds?: string[];
  mine?: boolean;
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
};

export function TaskSelect({
  value,
  onValueChange,
  clearable = true,
  allowIndependent = false,
  onOptionChange,
  ariaLabel = "选择 Task",
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
      nullOptionLabel={allowIndependent ? "独立投入（不关联 Task）" : undefined}
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
  ariaLabel = "选择 Task",
  ...props
}: CommonProps & {
  value: string[];
  onValueChange: (value: string[]) => void;
  clearable?: boolean;
  maxSelected?: number;
}) {
  const picker = useTaskPicker(
    props,
    props.initialOptions ?? EMPTY_TASK_OPTIONS,
  );
  return (
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
  );
}

function useTaskPicker(filters: TaskPickerFilters, initialOptions: TaskPickerOption[]) {
  const statusesKey = [...(filters.statuses ?? [])].sort().join(",");
  const tagIdsKey = [...(filters.tagIds ?? [])].sort().join(",");
  const scopeKey = `${statusesKey}|${tagIdsKey}|${filters.mine ? "mine" : "all"}`;
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
            ? "该 Task 不符合当前状态筛选，不能新增选择"
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
        tagIds: tagIdsKey ? tagIdsKey.split(",") : undefined,
        mine: filters.mine,
        cursor,
        limit: 50,
      });
      if (!result.ok) throw new Error(result.error.message);
      const items = decorate(result.data.items);
      for (const option of items) {
        optionCache.current.set(option.id, option);
      }
      return { ...result.data, items };
    },
    [decorate, filters.mine, tagIdsKey, statusesKey],
  );
  const resolveOptions = useCallback(async (ids: string[]) => {
    const result = await resolveTaskOptionsByIds({ ids });
    if (!result.ok) throw new Error(result.error.message);
    const items = decorate(result.data);
    for (const option of items) optionCache.current.set(option.id, option);
    return items;
  }, [decorate]);
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
