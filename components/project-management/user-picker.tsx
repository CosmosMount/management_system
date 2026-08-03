"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  resolvePeopleOptionsByIds,
  searchPeopleOptions,
} from "@/app/actions/project-management/options";
import {
  AsyncCombobox,
  AsyncMultiCombobox,
} from "@/components/entity-picker/async-combobox";
import type { PersonOptionDto } from "@/lib/project-management/types/time-canvas";

export type UserPickerScope =
  | { purpose: "VISIBLE" }
  | { purpose: "TASK_CREATE"; team: string; techGroup: string }
  | { purpose: "TASK_MEMBERS"; taskId: string }
  | { purpose: "TASK_SEGMENT_CREATE"; taskId: string };

type UserPickerOption = PersonOptionDto & {
  disabled?: boolean;
  disabledReason?: string;
};

const EMPTY_PERSON_OPTIONS: PersonOptionDto[] = [];

type CommonProps = {
  scope: UserPickerScope;
  initialOptions?: PersonOptionDto[];
  excludeIds?: string[];
  name?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  inputId?: string;
  ariaLabel?: string;
};

export function UserSelect({
  value,
  onValueChange,
  onOptionChange,
  clearable = true,
  ariaLabel = "选择人员",
  ...props
}: CommonProps & {
  value: string | null;
  onValueChange: (value: string | null) => void;
  onOptionChange?: (option: PersonOptionDto | null) => void;
  clearable?: boolean;
}) {
  const picker = useUserPicker(
    props.scope,
    props.initialOptions ?? EMPTY_PERSON_OPTIONS,
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
      clearable={clearable}
      getOptionLabel={(option) => option.displayName}
      getOptionDescription={getUserOptionDescription}
      renderOption={(option) => <UserOptionContent option={option} />}
    />
  );
}

export function UserMultiSelect({
  value,
  onValueChange,
  clearable = true,
  maxSelected = 50,
  ariaLabel = "选择人员",
  ...props
}: CommonProps & {
  value: string[];
  onValueChange: (value: string[]) => void;
  clearable?: boolean;
  maxSelected?: number;
}) {
  const picker = useUserPicker(
    props.scope,
    props.initialOptions ?? EMPTY_PERSON_OPTIONS,
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
      getOptionLabel={(option) => option.displayName}
      getOptionDescription={getUserOptionDescription}
      renderOption={(option) => <UserOptionContent option={option} />}
    />
  );
}

function useUserPicker(scope: UserPickerScope, initialOptions: PersonOptionDto[]) {
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);
  const decorate = useCallback(
    (options: PersonOptionDto[]): UserPickerOption[] =>
      options.map((option) => ({
        ...option,
        disabled: option.status === "INACTIVE",
        disabledReason:
          option.status === "INACTIVE" ? "该人员已停用，不能新增选择" : undefined,
      })),
    [],
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
      const result = await searchPeopleOptions({
        ...scope,
        query: query || undefined,
        cursor,
        limit: 50,
      });
      if (!result.ok) throw new Error(result.error.message);
      const items = decorate(result.data.items);
      for (const option of items) optionCache.current.set(option.id, option);
      return { ...result.data, items };
    },
    [decorate, scope],
  );
  const resolveOptions = useCallback(
    async (ids: string[]) => {
      const result = await resolvePeopleOptionsByIds({ scope, ids });
      if (!result.ok) throw new Error(result.error.message);
      const items = decorate(result.data);
      for (const option of items) optionCache.current.set(option.id, option);
      return items;
    },
    [decorate, scope],
  );
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

function UserOptionContent({ option }: { option: UserPickerOption }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {option.avatar ? (
        <Image
          src={option.avatar}
          alt=""
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {option.displayName.slice(0, 1)}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{option.displayName}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {getUserOptionDescription(option)}
        </span>
      </span>
    </div>
  );
}

function getUserOptionDescription(option: UserPickerOption) {
  if (option.status === "INACTIVE") return "人员已停用";
  return option.accountBinding === "BOUND" ? "已绑定账号" : "未绑定账号";
}
