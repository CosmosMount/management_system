"use client";

import { useCallback, useMemo } from "react";
import { AsyncMultiCombobox } from "@/components/entity-picker/async-combobox";
import type { PickerPage, PickerOption } from "@/components/entity-picker/picker-types";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";

export type ReminderRecipientOption = PickerOption & {
  displayName: string;
  description?: string;
};

export const REMINDER_RECIPIENT_LIMIT = 50;

type ReminderRecipientPickerProps = {
  options: ReminderRecipientOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  scopeKey: string;
  ariaLabel: string;
  inputId: string;
  placeholder?: string;
  disabled?: boolean;
  maxSelected?: number;
};

const EMPTY_PAGE: PickerPage<ReminderRecipientOption> = {
  items: [],
  nextCursor: null,
  hasMoreByQuery: false,
};

/**
 * A context-bound recipient picker for reminders. The server supplies the
 * candidate set; searching only ranks that set locally, so opening a reminder
 * can never expose people outside the business operation's authorization
 * boundary.
 */
export function ReminderRecipientPicker({
  options,
  value,
  onValueChange,
  scopeKey,
  ariaLabel,
  inputId,
  placeholder = "搜索姓名或拼音首字母",
  disabled = false,
  maxSelected = REMINDER_RECIPIENT_LIMIT,
}: ReminderRecipientPickerProps) {
  const optionsById = useMemo(
    () => new Map(options.map((option) => [option.id, option])),
    [options],
  );
  const loadOptions = useCallback(
    async ({ query }: { query: string; cursor?: string }) => {
      if (!query.trim()) return { ...EMPTY_PAGE, items: options };
      return {
        ...EMPTY_PAGE,
        items: rankFuzzyMatches(
          options,
          query,
          (option) => [{ text: option.displayName, weight: 2, pinyin: true }],
          (left, right) =>
            left.displayName.localeCompare(right.displayName, "zh-CN") ||
            left.id.localeCompare(right.id),
        ).map(({ item }) => item),
      };
    },
    [options],
  );
  const resolveOptions = useCallback(
    async (ids: string[]) =>
      ids.flatMap((id) => {
        const option = optionsById.get(id);
        return option ? [option] : [];
      }),
    [optionsById],
  );

  return (
    <div className="min-w-0" data-testid="reminder-recipient-picker">
      <AsyncMultiCombobox
        ariaLabel={ariaLabel}
        inputId={inputId}
        scopeKey={scopeKey}
        initialOptions={options}
        loadOptions={loadOptions}
        resolveOptions={resolveOptions}
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        disabled={disabled}
        maxSelected={maxSelected}
        clearable
        getOptionLabel={(option) => option.displayName}
        getOptionDescription={getRecipientDescription}
        renderOption={(option) => <RecipientOptionContent option={option} />}
      />
    </div>
  );
}

function getRecipientDescription(option: ReminderRecipientOption) {
  return [option.description, option.disabledReason].filter(Boolean).join(" · ");
}

function RecipientOptionContent({ option }: { option: ReminderRecipientOption }) {
  const description = getRecipientDescription(option);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {option.displayName.slice(0, 1)}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{option.displayName}</span>
        {description && (
          <span className="block truncate text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </div>
  );
}
