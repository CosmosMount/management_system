"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { resolveActiveProjectOptions, searchActiveProjectOptions } from "@/app/actions/project-management/projects";
import { AsyncCombobox } from "@/components/entity-picker/async-combobox";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import type { ProjectOption } from "@/lib/project-management/queries/project-queries";

const EMPTY_PROJECT_OPTIONS: ProjectOption[] = [];

export function ProjectSelect({ value, onValueChange, initialOptions = EMPTY_PROJECT_OPTIONS, disabled = false, inputId, ariaLabel = "选择所属 Project", placeholder = "搜索 Project" }: { value: string | null; onValueChange: (value: string | null) => void; initialOptions?: ProjectOption[]; disabled?: boolean; inputId?: string; ariaLabel?: string; placeholder?: string }) {
  const optionCache = useRef(new Map(initialOptions.map((option) => [option.id, option])));
  useEffect(() => { for (const option of initialOptions) optionCache.current.set(option.id, option); }, [initialOptions]);
  const initialKey = useMemo(() => initialOptions.map((option) => option.id).sort().join(","), [initialOptions]);
  const loadOptions = useCallback(async ({ query, cursor }: { query: string; cursor?: string }) => {
    const result = await searchActiveProjectOptions({ query: query || undefined, cursor: cursor ?? null, limit: 50 });
    if (!result.ok) throw new Error(result.error.message);
    for (const option of result.data.items) optionCache.current.set(option.id, option);
    return result.data;
  }, []);
  const resolveOptions = useCallback(async (ids: string[]) => {
    const result = await resolveActiveProjectOptions({ ids });
    if (!result.ok) throw new Error(result.error.message);
    for (const option of result.data) optionCache.current.set(option.id, option);
    return result.data;
  }, []);
  return <AsyncCombobox scopeKey={`active-projects:${initialKey}`} initialOptions={initialOptions} loadOptions={loadOptions} resolveOptions={resolveOptions} value={value} onValueChange={onValueChange} clearable disabled={disabled} inputId={inputId} ariaLabel={ariaLabel} placeholder={placeholder} nullOptionLabel="无所属 Project" getOptionLabel={(option) => option.name} getOptionDescription={() => "进行中"} renderOption={(option) => <span className="flex min-w-0 items-center gap-2"><ProjectAvatar name={option.name} avatarPath={option.avatarPath} className="size-7" /><span className="truncate">{option.name}</span></span>} />;
}
