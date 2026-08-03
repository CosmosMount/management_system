"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Search, X } from "lucide-react";
import {
  searchTagOptions,
} from "@/app/actions/project-management/options";
import { TaskMultiSelect } from "@/components/project-management/task-picker";
import { UserMultiSelect } from "@/components/project-management/user-picker";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";

type TagOption = { id: string; name: string; color: string };
type SegmentStatus =
  | "PLANNED"
  | "IN_PROGRESS"
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "CANCELLED";

export function ResourceFilterBar({
  initial,
  initialPeople,
  initialTasks,
  initialTags,
}: {
  initial: {
    from: string;
    to: string;
    groupBy: "PERSON" | "TASK";
    zoom: "HOUR" | "DAY" | "WEEK" | "MONTH";
    personIds: string[];
    taskIds: string[];
    tagIds: string[];
    types: Array<"PLANNED" | "ACTUAL">;
    statuses: SegmentStatus[];
  };
  initialPeople: PersonOptionDto[];
  initialTasks: TaskOptionPage["items"];
  initialTags: TagOption[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [tags, setTags] = useState(initialTags);
  const [personIds, setPersonIds] = useState(initial.personIds);
  const [taskIds, setTaskIds] = useState(initial.taskIds);
  const [tagIds, setTagIds] = useState(initial.tagIds);
  const [types, setTypes] = useState(initial.types);
  const [statuses, setStatuses] = useState(initial.statuses);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState(initial.groupBy);
  const [tagQuery, setTagQuery] = useState("");
  const [notice, setNotice] = useState("");

  const apply = () => {
    const params = new URLSearchParams();
    params.set("from", from);
    params.set("to", to);
    params.set("group", groupBy.toLowerCase());
    params.set("zoom", initial.zoom.toLowerCase());
    setList(params, "people", personIds);
    setList(params, "tasks", taskIds);
    setList(params, "tags", tagIds);
    setList(params, "types", types.map((value) => value.toLowerCase()));
    setList(params, "statuses", statuses.map((value) => value.toLowerCase()));
    router.push(`/progress/resources?${params.toString()}`);
  };

  const applyRange = (days: number) => {
    const startMs = Date.parse(`${from}T00:00:00.000+08:00`);
    if (!Number.isFinite(startMs)) return;
    const nextTo = formatShanghaiDate(startMs + days * 24 * 60 * 60 * 1_000);
    setTo(nextTo);
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="资源计划筛选">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          开始日期
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          结束日期
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-1" aria-label="常用时间范围">
          {[7, 14, 30].map((days) => (
            <Button key={days} type="button" size="sm" variant="outline" onClick={() => applyRange(days)}>
              {days} 天
            </Button>
          ))}
        </div>
        <label className="grid gap-1 text-sm">
          分组
          <select
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value === "TASK" ? "TASK" : "PERSON")}
          >
            <option value="PERSON">按人员</option>
            <option value="TASK">按 Task</option>
          </select>
        </label>
        <Button type="button" onClick={apply}>应用筛选</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(window.location.href).then(
              () => setNotice("已复制当前视图链接"),
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
            setPersonIds([]);
            setTaskIds([]);
            setTagIds([]);
            setTypes([]);
            setStatuses([]);
          }}
        >
          <X aria-hidden="true" />清除筛选
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <fieldset className="min-w-0 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">人员（{personIds.length}）</legend>
          <UserMultiSelect
            ariaLabel="筛选人员"
            scope={{ purpose: "VISIBLE" }}
            value={personIds}
            onValueChange={setPersonIds}
            initialOptions={initialPeople}
            disabled={isPending}
            placeholder="按姓名或拼音首字母搜索"
          />
        </fieldset>
        <fieldset className="min-w-0 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">Task（{taskIds.length}）</legend>
          <TaskMultiSelect
            ariaLabel="筛选 Task"
            value={taskIds}
            onValueChange={setTaskIds}
            initialOptions={initialTasks}
            statuses={["ACTIVE"]}
            disabled={isPending}
            placeholder="按标题、描述或拼音首字母搜索"
          />
        </fieldset>
        <FilterPicker
          label="Tag"
          query={tagQuery}
          onQueryChange={setTagQuery}
          options={tags.map((tag) => ({ id: tag.id, label: tag.name }))}
          selectedIds={tagIds}
          onToggle={(id) => setTagIds((current) => toggle(current, id))}
          disabled={isPending}
          onSearch={() => startTransition(async () => {
            const result = await searchTagOptions({ query: tagQuery || undefined, limit: 50 });
            if (!result.ok) return setNotice(result.error.message);
            setTags((current) => merge(current, result.data.items));
          })}
        />
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <CheckGroup
          label="类型"
          options={[{ value: "PLANNED", label: "Planned" }, { value: "ACTUAL", label: "Actual" }]}
          values={types}
          onToggle={(value) => setTypes((current) => toggle(current, value as "PLANNED" | "ACTUAL"))}
        />
        <CheckGroup
          label="状态"
          options={[
            { value: "PLANNED", label: "计划中" },
            { value: "IN_PROGRESS", label: "进行中" },
            { value: "PENDING_CONFIRMATION", label: "待确认" },
            { value: "CONFIRMED", label: "已确认" },
            { value: "CANCELLED", label: "已取消" },
          ]}
          values={statuses}
          onToggle={(value) => setStatuses((current) => toggle(current, value as SegmentStatus))}
        />
      </div>

      <div className="flex flex-wrap gap-2" aria-label="已选筛选">
        {selectedBadges(tagIds, tags, "name", (id) => setTagIds((current) => current.filter((value) => value !== id)))}
      </div>
      {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
    </section>
  );
}

function FilterPicker({ label, query, onQueryChange, options, selectedIds, onToggle, onSearch, disabled }: {
  label: string;
  query: string;
  onQueryChange: (value: string) => void;
  options: Array<{ id: string; label: string }>;
  selectedIds: string[];
  onToggle: (id: string) => void;
  onSearch: () => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="min-w-0 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">{label}（{selectedIds.length}）</legend>
      <div className="flex gap-2">
        <Input value={query} onChange={(event) => onQueryChange(event.target.value)} aria-label={`搜索${label}`} />
        <Button type="button" size="icon" variant="outline" disabled={disabled} onClick={onSearch} aria-label={`执行${label}搜索`}>
          <Search aria-hidden="true" />
        </Button>
      </div>
      <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
        {options.map((option) => (
          <label key={option.id} className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
            <input type="checkbox" checked={selectedIds.includes(option.id)} onChange={() => onToggle(option.id)} />
            <span className="truncate" title={option.label}>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CheckGroup({ label, options, values, onToggle }: {
  label: string;
  options: Array<{ value: string; label: string }>;
  values: readonly string[];
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
      <legend className="sr-only">{label}</legend>
      <span className="font-medium">{label}</span>
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-1">
          <input type="checkbox" checked={values.includes(option.value)} onChange={() => onToggle(option.value)} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function selectedBadges<T extends { id: string }>(ids: string[], options: T[], key: keyof T, remove: (id: string) => void) {
  return ids.map((id) => {
    const option = options.find((item) => item.id === id);
    const label = option ? String(option[key]) : `已选对象 ${id.slice(0, 8)}`;
    return (
      <Badge key={id} variant="secondary" className="max-w-64 gap-1">
        <Check aria-hidden="true" className="size-3" />
        <span className="truncate">{label}</span>
        <button type="button" aria-label={`移除 ${label}`} onClick={() => remove(id)}><X aria-hidden="true" className="size-3" /></button>
      </Badge>
    );
  });
}

function toggle<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function merge<T extends { id: string }>(current: T[], incoming: T[]) {
  const result = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => result.set(item.id, item));
  return [...result.values()];
}

function setList(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, values.join(","));
}
