"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import type {
  PickerLoadOptions,
  PickerOption,
  PickerResolveOptions,
} from "@/components/entity-picker/picker-types";
import { useAsyncPickerOptions } from "@/components/entity-picker/use-async-picker-options";
import { cn } from "@/lib/utils";

type CommonProps<TOption extends PickerOption> = {
  initialOptions?: TOption[];
  loadOptions: PickerLoadOptions<TOption>;
  resolveOptions: PickerResolveOptions<TOption>;
  scopeKey: string;
  getOptionLabel: (option: TOption) => string;
  getOptionDescription?: (option: TOption) => string;
  renderOption: (option: TOption) => ReactNode;
  renderSelected?: (option: TOption) => ReactNode;
  excludeIds?: string[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  inputId?: string;
  ariaLabel: string;
  invalid?: boolean;
  ariaDescribedBy?: string;
  className?: string;
};

const NULL_OPTION_VALUE_PREFIX = "__entity_picker_null_option__";
const EMPTY_INITIAL_OPTIONS: [] = [];

export type AsyncComboboxProps<TOption extends PickerOption> = CommonProps<TOption> & {
  value: string | null;
  onValueChange: (value: string | null) => void;
  clearable?: boolean;
  nullOptionLabel?: string;
  openOnFocus?: boolean;
};

export type AsyncMultiComboboxProps<TOption extends PickerOption> =
  CommonProps<TOption> & {
    value: string[];
    onValueChange: (value: string[]) => void;
    clearable?: boolean;
    maxSelected?: number;
  };

export function AsyncCombobox<TOption extends PickerOption>({
  value,
  onValueChange,
  initialOptions = EMPTY_INITIAL_OPTIONS,
  loadOptions,
  resolveOptions,
  scopeKey,
  getOptionLabel,
  getOptionDescription,
  renderOption,
  excludeIds = [],
  placeholder = "输入关键词搜索",
  disabled = false,
  required = false,
  clearable = true,
  nullOptionLabel,
  openOnFocus = true,
  name,
  inputId,
  ariaLabel,
  invalid = false,
  ariaDescribedBy,
  className,
}: AsyncComboboxProps<TOption>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedIds = useMemo(() => (value ? [value] : []), [value]);
  const state = useAsyncPickerOptions({
    scopeKey,
    initialOptions,
    selectedIds,
    open,
    query,
    loadOptions,
    resolveOptions,
  });
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const visibleItems = useMemo(
    () => {
      const ids = state.items
        .filter((option) => !excluded.has(option.id))
        .map((option) => option.id);
      if (!query.trim()) {
        for (const option of state.optionCache.values()) {
          if (
            option.disabled &&
            !excluded.has(option.id) &&
            !ids.includes(option.id)
          ) {
            ids.push(option.id);
          }
        }
        if (
          value &&
          state.optionCache.has(value) &&
          !excluded.has(value) &&
          !ids.includes(value)
        ) {
          ids.unshift(value);
        }
      }
      return ids;
    },
    [excluded, query, state.items, state.optionCache, value],
  );
  const nullOptionValue = useMemo(() => {
    let candidate = NULL_OPTION_VALUE_PREFIX;
    const businessIds = new Set(visibleItems);
    if (value) businessIds.add(value);
    while (businessIds.has(candidate)) candidate += "#";
    return candidate;
  }, [value, visibleItems]);
  const pickerItems = useMemo<string[]>(
    () =>
      nullOptionLabel
        ? [nullOptionValue, ...visibleItems]
        : visibleItems,
    [nullOptionLabel, nullOptionValue, visibleItems],
  );
  const optionById = useCallback(
    (id: string) => state.optionCache.get(id),
    [state.optionCache],
  );

  return (
    <div className={cn("min-w-0", className)}>
      {name && (
        <input
          type="hidden"
          name={name}
          value={value ?? ""}
          disabled={disabled}
        />
      )}
      <Combobox.Root<string>
        items={pickerItems}
        filteredItems={pickerItems}
        filter={null}
        value={nullOptionLabel && value === null ? nullOptionValue : value}
        open={open}
        onValueChange={(nextValue) => {
          if (nextValue === nullOptionValue) {
            setQuery("");
            onValueChange(null);
            return;
          }
          if (!nextValue) {
            if (clearable) {
              setQuery("");
              onValueChange(null);
            }
            return;
          }
          const option = optionById(nextValue);
          if (!option || option.disabled || excluded.has(nextValue)) return;
          setQuery("");
          onValueChange(nextValue);
        }}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery("");
        }}
        onInputValueChange={(nextQuery, eventDetails) => {
          if (
            eventDetails.reason === "input-change" ||
            eventDetails.reason === "input-clear"
          ) {
            setQuery(nextQuery);
          }
        }}
        itemToStringLabel={(id) => {
          if (id === nullOptionValue) return nullOptionLabel ?? "";
          const option = optionById(id);
          return option ? getOptionLabel(option) : "已选项不可用";
        }}
        autoHighlight
        autoComplete="none"
        openOnInputClick
        disabled={disabled}
        required={required}
      >
        <Combobox.InputGroup
          data-invalid={invalid || undefined}
          className="flex min-h-9 w-full min-w-0 items-center rounded-md border border-input bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 data-[invalid=true]:border-destructive data-[invalid=true]:ring-3 data-[invalid=true]:ring-destructive/20 data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:data-[invalid=true]:border-destructive/50 dark:data-[invalid=true]:ring-destructive/40"
        >
          <Combobox.Input
            id={inputId}
            aria-label={ariaLabel}
            aria-invalid={invalid}
            aria-describedby={ariaDescribedBy}
            placeholder={placeholder}
            className="h-8 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
            onFocus={(event) => {
              setQuery("");
              if (openOnFocus) setOpen(true);
              event.currentTarget.select();
            }}
          />
          {clearable && value && !disabled && (
            <Combobox.Clear
              aria-label={`清空${ariaLabel}`}
              className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </Combobox.Clear>
          )}
          <Combobox.Trigger
            aria-label={`展开${ariaLabel}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className="size-4" />
          </Combobox.Trigger>
        </Combobox.InputGroup>
        <PickerPopup
          state={state}
          optionById={optionById}
          getOptionLabel={getOptionLabel}
          getOptionDescription={getOptionDescription}
          renderOption={renderOption}
          visibleItems={pickerItems}
          nullOptionLabel={nullOptionLabel}
          nullOptionValue={nullOptionValue}
        />
      </Combobox.Root>
    </div>
  );
}

export function AsyncMultiCombobox<TOption extends PickerOption>({
  value,
  onValueChange,
  initialOptions = EMPTY_INITIAL_OPTIONS,
  loadOptions,
  resolveOptions,
  scopeKey,
  getOptionLabel,
  getOptionDescription,
  renderOption,
  renderSelected,
  excludeIds = [],
  placeholder = "输入关键词搜索",
  disabled = false,
  required = false,
  clearable = true,
  maxSelected = 50,
  name,
  inputId,
  ariaLabel,
  invalid = false,
  ariaDescribedBy,
  className,
}: AsyncMultiComboboxProps<TOption>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedIds = useMemo(() => value, [value]);
  const state = useAsyncPickerOptions({
    scopeKey,
    initialOptions,
    selectedIds,
    open,
    query,
    loadOptions,
    resolveOptions,
  });
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const visibleItems = useMemo(
    () => {
      const ids = state.items
        .filter((option) => !excluded.has(option.id))
        .map((option) => option.id);
      if (!query.trim()) {
        for (const option of state.optionCache.values()) {
          if (
            option.disabled &&
            !excluded.has(option.id) &&
            !ids.includes(option.id)
          ) {
            ids.push(option.id);
          }
        }
        for (const id of value) {
          if (
            state.optionCache.has(id) &&
            !excluded.has(id) &&
            !ids.includes(id)
          ) {
            ids.push(id);
          }
        }
      }
      return ids;
    },
    [excluded, query, state.items, state.optionCache, value],
  );
  const optionById = useCallback(
    (id: string) => state.optionCache.get(id),
    [state.optionCache],
  );
  const atLimit = value.length >= maxSelected;

  return (
    <div className={cn("min-w-0", className)}>
      {name &&
        (value.length > 0 ? (
          value.map((id) => (
            <input
              key={id}
              type="hidden"
              name={name}
              value={id}
              disabled={disabled}
            />
          ))
        ) : (
          <input type="hidden" name={name} value="" disabled={disabled} />
        ))}
      <Combobox.Root<string, true>
        items={visibleItems}
        filteredItems={visibleItems}
        filter={null}
        multiple
        value={value}
        open={open}
        onValueChange={(nextValue) => {
          const deduplicated = [...new Set(nextValue)].filter((id) => !excluded.has(id));
          if (deduplicated.length > maxSelected) return;
          const added = deduplicated.filter((id) => !value.includes(id));
          if (added.some((id) => optionById(id)?.disabled)) {
            return;
          }
          if (added.length > 0 || deduplicated.length === 0) setQuery("");
          onValueChange(deduplicated);
        }}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery("");
        }}
        onInputValueChange={(nextQuery, eventDetails) => {
          if (
            eventDetails.reason === "input-change" ||
            eventDetails.reason === "input-clear"
          ) {
            setQuery(nextQuery);
          }
        }}
        itemToStringLabel={(id) => {
          const option = optionById(id);
          return option ? getOptionLabel(option) : "已选项不可用";
        }}
        autoHighlight
        autoComplete="none"
        openOnInputClick
        disabled={disabled}
        required={required}
      >
        <Combobox.InputGroup
          data-invalid={invalid || undefined}
          className="flex min-h-9 w-full min-w-0 items-center rounded-md border border-input bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 data-[invalid=true]:border-destructive data-[invalid=true]:ring-3 data-[invalid=true]:ring-destructive/20 data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:data-[invalid=true]:border-destructive/50 dark:data-[invalid=true]:ring-destructive/40"
        >
          <Combobox.Chips className="flex min-w-0 flex-1 flex-wrap items-center gap-1 p-1">
            <Combobox.Value>
              {(selectedValue: string[]) => (
                <>
                  {selectedValue.map((id) => {
                    const option = optionById(id);
                    const label = option ? getOptionLabel(option) : "已选项不可用";
                    return (
                      <Combobox.Chip
                        key={id}
                        aria-label={label}
                        className="group flex min-h-7 max-w-full items-center gap-1 rounded-md bg-muted px-2 text-xs focus-within:ring-2 focus-within:ring-ring"
                      >
                        <span className="max-w-48 truncate">
                          {option && renderSelected ? renderSelected(option) : label}
                        </span>
                        <Combobox.ChipRemove
                          aria-label={`移除${label}`}
                          className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-background focus-visible:outline-none"
                        >
                          <X className="size-3.5" />
                        </Combobox.ChipRemove>
                      </Combobox.Chip>
                    );
                  })}
                  <Combobox.Input
                    id={inputId}
                    aria-label={ariaLabel}
                    aria-invalid={invalid}
                    aria-describedby={ariaDescribedBy}
                    placeholder={selectedValue.length ? "" : placeholder}
                    className="h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
                    onFocus={() => {
                      setQuery("");
                      setOpen(true);
                    }}
                  />
                </>
              )}
            </Combobox.Value>
          </Combobox.Chips>
          {clearable && value.length > 0 && !disabled && (
            <Combobox.Clear
              aria-label={`清空${ariaLabel}`}
              className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </Combobox.Clear>
          )}
          <Combobox.Trigger
            aria-label={`展开${ariaLabel}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className="size-4" />
          </Combobox.Trigger>
        </Combobox.InputGroup>
        {atLimit && (
          <p className="mt-1 text-xs text-muted-foreground" role="status">
            已达到最多 {maxSelected} 项，仍可搜索浏览或移除已选项。
          </p>
        )}
        <PickerPopup
          state={state}
          optionById={optionById}
          getOptionLabel={getOptionLabel}
          getOptionDescription={getOptionDescription}
          renderOption={renderOption}
          visibleItems={visibleItems}
          selectedIds={value}
          disableNewItems={atLimit}
        />
      </Combobox.Root>
    </div>
  );
}

function PickerPopup<TOption extends PickerOption>({
  state,
  optionById,
  getOptionLabel,
  getOptionDescription,
  renderOption,
  visibleItems,
  selectedIds = [],
  disableNewItems = false,
  nullOptionLabel,
  nullOptionValue,
}: {
  state: ReturnType<typeof useAsyncPickerOptions<TOption>>;
  optionById: (id: string) => TOption | undefined;
  getOptionLabel: (option: TOption) => string;
  getOptionDescription?: (option: TOption) => string;
  renderOption: (option: TOption) => ReactNode;
  visibleItems: string[];
  selectedIds?: string[];
  disableNewItems?: boolean;
  nullOptionLabel?: string;
  nullOptionValue?: string;
}) {
  const descriptionIdPrefix = useId();
  const descriptionIdByOption = useMemo(
    () =>
      new Map(
        visibleItems.map((id, index) => [
          id,
          `${descriptionIdPrefix}-option-${index}`,
        ]),
      ),
    [descriptionIdPrefix, visibleItems],
  );
  return (
    <Combobox.Portal>
      <Combobox.Positioner
        data-testid="entity-picker-positioner"
        className="z-[100] max-w-[calc(100vw-1rem)] outline-none"
        side="bottom"
        sideOffset={4}
        align="start"
        collisionAvoidance={{
          side: "flip",
          align: "shift",
          fallbackAxisSide: "none",
        }}
      >
        <Combobox.Popup className="max-h-[min(var(--available-height),22rem)] min-w-[min(var(--anchor-width),calc(100vw-1rem))] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
          {state.loading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground" role="status">
              <LoaderCircle className="size-4 animate-spin" />正在加载…
            </div>
          ) : state.error ? (
            <div className="space-y-2 px-3 py-3 text-sm" role="alert">
              <p className="text-destructive">{state.error}</p>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={state.retry}
              >
                <RotateCcw className="size-3.5" />重试
              </button>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">没有匹配项。</div>
          ) : (
            <Combobox.List>
              {(id: string) => {
                if (nullOptionLabel && id === nullOptionValue) {
                  return (
                    <Combobox.Item
                      key={id}
                      value={id}
                      className="grid min-w-0 cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                    >
                      <span className="flex size-4 items-center justify-center">
                        <Combobox.ItemIndicator>
                          <Check className="size-4" />
                        </Combobox.ItemIndicator>
                      </span>
                      <span>{nullOptionLabel}</span>
                    </Combobox.Item>
                  );
                }
                const option = optionById(id);
                if (!option) return null;
                const selected = selectedIds.includes(id);
                const disabled = option.disabled || (disableNewItems && !selected);
                const description = getOptionDescription?.(option);
                const descriptionId = description
                  ? descriptionIdByOption.get(id)
                  : undefined;
                return (
                  <Combobox.Item
                    key={id}
                    value={id}
                    aria-label={getOptionLabel(option)}
                    aria-describedby={descriptionId}
                    disabled={disabled}
                    title={disabled ? option.disabledReason ?? (disableNewItems ? "已达到选择上限" : undefined) : undefined}
                    className="grid min-w-0 cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-disabled:cursor-not-allowed data-disabled:opacity-45 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <span className="flex size-4 items-center justify-center">
                      <Combobox.ItemIndicator>
                        <Check className="size-4" />
                      </Combobox.ItemIndicator>
                    </span>
                    <div className="min-w-0">{renderOption(option)}</div>
                    {description && (
                      <span id={descriptionId} className="sr-only">
                        {description}
                      </span>
                    )}
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
          )}
          {state.hasMoreByQuery && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground" role="status">
              结果较多，请继续输入关键词缩小范围。
            </p>
          )}
          {state.nextCursor && !state.loading && !state.error && (
            <button
              type="button"
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-sm border-t px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={state.loadingMore}
              onClick={() => void state.loadMore()}
            >
              {state.loadingMore && <LoaderCircle className="size-4 animate-spin" />}
              {state.loadingMore ? "正在加载…" : "加载更多"}
            </button>
          )}
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}
