"use client";

import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AsyncCombobox,
  AsyncMultiCombobox,
} from "@/components/entity-picker/async-combobox";
import type {
  PickerLoadOptions,
  PickerOption,
  PickerResolveOptions,
} from "@/components/entity-picker/picker-types";

type FixtureOption = PickerOption & { label: string };

const INTERNAL_VALUE_COLLISION_ID = "__entity_picker_null_option__";
const STANDARD_OPTIONS: FixtureOption[] = [
  { id: "task-1", label: "普通 Task" },
  { id: INTERNAL_VALUE_COLLISION_ID, label: "不透明 ID Task" },
];
const LIMIT_OPTIONS: FixtureOption[] = Array.from({ length: 51 }, (_, index) => ({
  id: `limit-${index + 1}`,
  label: `上限选项 ${String(index + 1).padStart(2, "0")}`,
}));

export function EntityPickerFixtureClient() {
  return (
    <main className="mx-auto grid w-full min-w-0 max-w-4xl gap-8 px-4 py-8 sm:px-6">
      <RaceAndRetryFixture />
      <KeyboardFocusFixture />
      <ResolverFixture />
      <LimitFixture />
      <FormFixture />
    </main>
  );
}

function KeyboardFocusFixture() {
  const [singleValue, setSingleValue] = useState<string | null>("task-1");
  const [multiValue, setMultiValue] = useState<string[]>([]);
  const loadOptions = useCallback<PickerLoadOptions<FixtureOption>>(
    async ({ query }) =>
      page(
        STANDARD_OPTIONS.filter((option) =>
          option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        ),
      ),
    [],
  );
  const resolveOptions = useCallback<PickerResolveOptions<FixtureOption>>(
    async (ids) => STANDARD_OPTIONS.filter((option) => ids.includes(option.id)),
    [],
  );

  return (
    <FixtureSection title="键盘聚焦与查询复位">
      <button type="button" data-testid="single-tab-start" className="w-fit rounded-md border px-2 py-1 text-sm">
        单选 Tab 起点
      </button>
      <AsyncCombobox
        ariaLabel="键盘聚焦单选"
        value={singleValue}
        onValueChange={setSingleValue}
        initialOptions={STANDARD_OPTIONS}
        loadOptions={loadOptions}
        resolveOptions={resolveOptions}
        scopeKey="fixture-keyboard-single"
        getOptionLabel={(option) => option.label}
        renderOption={(option) => option.label}
      />
      <button type="button" data-testid="multi-tab-start" className="w-fit rounded-md border px-2 py-1 text-sm">
        多选 Tab 起点
      </button>
      <AsyncMultiCombobox
        ariaLabel="键盘聚焦多选"
        value={multiValue}
        onValueChange={setMultiValue}
        initialOptions={STANDARD_OPTIONS}
        loadOptions={loadOptions}
        resolveOptions={resolveOptions}
        scopeKey="fixture-keyboard-multi"
        getOptionLabel={(option) => option.label}
        renderOption={(option) => option.label}
      />
    </FixtureSection>
  );
}

function RaceAndRetryFixture() {
  const [value, setValue] = useState<string | null>(null);
  const attempts = useRef(new Map<string, number>());
  const loadOptions = useCallback<PickerLoadOptions<FixtureOption>>(
    async ({ query, cursor }) => {
      const attempt = (attempts.current.get(query) ?? 0) + 1;
      attempts.current.set(query, attempt);

      if (query === "slow") {
        await delay(900);
        return page([{ id: "slow-result", label: "过期慢响应" }]);
      }
      if (query === "fast") {
        await delay(40);
        return page([{ id: "fast-result", label: "最新快响应" }]);
      }
      if (query === "failure") {
        await delay(30);
        if (attempt === 1) throw new Error("受控加载失败");
        return page([{ id: "retry-result", label: "重试恢复结果" }]);
      }
      if (query === "page-reset") {
        if (cursor) {
          await delay(900);
          return page([{ id: "stale-page-2", label: "过期分页结果" }]);
        }
        await delay(30);
        return page(
          [{ id: "stale-page-1", label: "旧查询第一页" }],
          "stale-cursor",
        );
      }
      if (query === "new-page") {
        await delay(cursor ? 40 : 30);
        return cursor
          ? page([{ id: "new-page-2", label: "新查询第二页" }])
          : page(
              [{ id: "new-page-1", label: "新查询第一页" }],
              "new-cursor",
            );
      }
      await delay(20);
      return page([{ id: "default-result", label: "默认结果" }]);
    },
    [],
  );
  const resolveOptions = useCallback<PickerResolveOptions<FixtureOption>>(
    async (ids) => STANDARD_OPTIONS.filter((option) => ids.includes(option.id)),
    [],
  );

  return (
    <FixtureSection title="竞态、分页与重试">
      <label htmlFor="fixture-race-picker" className="text-sm font-medium">
        竞态与重试选择器
      </label>
      <AsyncCombobox
        inputId="fixture-race-picker"
        ariaLabel="竞态与重试选择器"
        value={value}
        onValueChange={setValue}
        initialOptions={[]}
        loadOptions={loadOptions}
        resolveOptions={resolveOptions}
        scopeKey="fixture-race"
        getOptionLabel={(option) => option.label}
        renderOption={(option) => option.label}
      />
    </FixtureSection>
  );
}

function ResolverFixture() {
  const [value, setValue] = useState(["resolve-a"]);
  const loadOptions = useCallback<PickerLoadOptions<FixtureOption>>(
    async () => page([]),
    [],
  );
  const resolveOptions = useCallback<PickerResolveOptions<FixtureOption>>(
    async (ids) => {
      await delay(ids.includes("resolve-a") ? 700 : 40);
      return ids.map((id) => ({
        id,
        label: id === "resolve-a" ? "并发恢复 A" : "并发恢复 B",
      }));
    },
    [],
  );

  return (
    <FixtureSection title="选中项并发恢复">
      <AsyncMultiCombobox
        ariaLabel="并发恢复选择器"
        value={value}
        onValueChange={setValue}
        initialOptions={[]}
        loadOptions={loadOptions}
        resolveOptions={resolveOptions}
        scopeKey="fixture-resolver"
        getOptionLabel={(option) => option.label}
        renderOption={(option) => option.label}
      />
      <button
        type="button"
        className="w-fit rounded-md border px-3 py-2 text-sm"
        onClick={() => setValue((current) => [...new Set([...current, "resolve-b"])])}
      >
        并发加入 B
      </button>
    </FixtureSection>
  );
}

function LimitFixture() {
  const [value, setValue] = useState(LIMIT_OPTIONS.slice(0, 50).map((option) => option.id));
  const loadOptions = useCallback<PickerLoadOptions<FixtureOption>>(
    async () => page(LIMIT_OPTIONS),
    [],
  );
  const resolveOptions = useCallback<PickerResolveOptions<FixtureOption>>(
    async (ids) => LIMIT_OPTIONS.filter((option) => ids.includes(option.id)),
    [],
  );

  return (
    <FixtureSection title="多选上限">
      <AsyncMultiCombobox
        ariaLabel="50 项上限选择器"
        name="limitedValues"
        value={value}
        onValueChange={setValue}
        initialOptions={LIMIT_OPTIONS}
        loadOptions={loadOptions}
        resolveOptions={resolveOptions}
        scopeKey="fixture-limit"
        maxSelected={50}
        getOptionLabel={(option) => option.label}
        renderOption={(option) => option.label}
      />
      <output data-testid="limit-count">{value.length}</output>
    </FixtureSection>
  );
}

function FormFixture() {
  const [value, setValue] = useState<string | null>("task-1");
  const [submitted, setSubmitted] = useState("");
  const loadOptions = useCallback<PickerLoadOptions<FixtureOption>>(
    async ({ query }) =>
      page(
        STANDARD_OPTIONS.filter((option) =>
          option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        ),
      ),
    [],
  );
  const resolveOptions = useCallback<PickerResolveOptions<FixtureOption>>(
    async (ids) => STANDARD_OPTIONS.filter((option) => ids.includes(option.id)),
    [],
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(JSON.stringify([...new FormData(event.currentTarget).entries()]));
  };

  return (
    <FixtureSection title="键盘、隐藏字段与不透明 ID">
      <form className="grid gap-3" onSubmit={submit}>
        <label htmlFor="fixture-independent-picker" className="text-sm font-medium">
          独立投入选择器
        </label>
        <AsyncCombobox
          inputId="fixture-independent-picker"
          ariaLabel="独立投入选择器"
          name="enabledTask"
          value={value}
          onValueChange={setValue}
          initialOptions={STANDARD_OPTIONS}
          loadOptions={loadOptions}
          resolveOptions={resolveOptions}
          scopeKey="fixture-form-enabled"
          nullOptionLabel="独立投入（不关联 Task）"
          getOptionLabel={(option) => option.label}
          renderOption={(option) => option.label}
        />
        <AsyncCombobox
          ariaLabel="禁用单选"
          name="disabledSingle"
          value="task-1"
          onValueChange={() => undefined}
          initialOptions={STANDARD_OPTIONS}
          loadOptions={loadOptions}
          resolveOptions={resolveOptions}
          scopeKey="fixture-form-disabled-single"
          disabled
          getOptionLabel={(option) => option.label}
          renderOption={(option) => option.label}
        />
        <AsyncMultiCombobox
          ariaLabel="禁用多选"
          name="disabledMulti"
          value={["task-1", INTERNAL_VALUE_COLLISION_ID]}
          onValueChange={() => undefined}
          initialOptions={STANDARD_OPTIONS}
          loadOptions={loadOptions}
          resolveOptions={resolveOptions}
          scopeKey="fixture-form-disabled-multi"
          disabled
          getOptionLabel={(option) => option.label}
          renderOption={(option) => option.label}
        />
        <button type="submit" className="w-fit rounded-md border px-3 py-2 text-sm">
          提交夹具表单
        </button>
      </form>
      <output data-testid="selected-opaque-value">
        {value === INTERNAL_VALUE_COLLISION_ID ? "不透明 ID 已保留" : value ?? "独立投入"}
      </output>
      <output data-testid="submitted-form-data">{submitted}</output>
    </FixtureSection>
  );
}

function FixtureSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-3 rounded-xl border bg-card p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function page(items: FixtureOption[], nextCursor: string | null = null) {
  return { items, nextCursor, hasMoreByQuery: false };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}
