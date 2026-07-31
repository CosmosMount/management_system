"use client";

import { AlertTriangle, Clock3, Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type {
  TimeCanvasDisplayOptions,
  TimeCanvasModel,
  TimeCanvasSelection,
} from "@/components/project-management/time-canvas/types";

type AgendaItem = {
  id: string;
  selection: NonNullable<TimeCanvasSelection>;
  atMs: number;
  endMs: number | null;
  title: string;
  meta: string;
  state: string;
  kind: "ANCHOR" | "SEGMENT" | "CONFLICT";
};

export function TimeAgenda({
  model,
  display,
  selection,
  onSelect,
  emptyMessage,
}: {
  model: TimeCanvasModel;
  display: TimeCanvasDisplayOptions;
  selection: TimeCanvasSelection;
  onSelect: (selection: TimeCanvasSelection) => void;
  emptyMessage: string;
}) {
  const groups = groupAgendaItems(model, display);
  if (groups.length === 0) {
    return (
      <div
        className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground"
        data-testid="time-agenda-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="time-agenda">
      <p className="sr-only">
        移动端按日期展示时间对象。选择卡片可查看只读详情。
      </p>
      {groups.map((group) => (
        <section key={group.dateKey} aria-labelledby={`agenda-${group.dateKey}`}>
          <h2
            id={`agenda-${group.dateKey}`}
            className="sticky top-28 z-10 rounded-lg bg-background/95 px-1 py-2 text-sm font-semibold backdrop-blur"
          >
            {group.label}
          </h2>
          <ul className="space-y-2">
            {group.items.map((item) => {
              const selected =
                selection?.kind === item.selection.kind &&
                selection.id === item.selection.id;
              return (
                <li key={`${item.kind}:${item.id}`}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-3 text-left outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : item.selection)}
                    data-testid={`agenda-item-${item.id}`}
                  >
                    <AgendaIcon kind={item.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-muted-foreground">
                        {formatTime(item.atMs)}
                        {item.endMs !== null ? `–${formatTime(item.endMs)}` : ""}
                      </span>
                      <span className="mt-1 block break-words text-sm font-medium">
                        {item.title}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {item.meta}
                      </span>
                    </span>
                    <Badge variant={item.kind === "CONFLICT" ? "destructive" : "secondary"}>
                      {item.state}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function groupAgendaItems(
  model: TimeCanvasModel,
  display: TimeCanvasDisplayOptions,
) {
  const items: AgendaItem[] = [];
  for (const anchor of model.anchors) {
    if (anchor.atMs < model.range.startMs || anchor.atMs >= model.range.endMs) {
      continue;
    }
    items.push({
      id: anchor.id,
      selection: { kind: "ANCHOR", id: anchor.id },
      atMs: anchor.atMs,
      endMs: null,
      title: anchor.label,
      meta: anchor.kind === "TERMINATION" ? "计划终止" : "计划节点",
      state: anchor.status,
      kind: "ANCHOR",
    });
  }
  for (const segment of model.segments) {
    if (segment.type === "ACTUAL" && display.showActual === false) continue;
    if (segment.type === "BUSY" && display.showBusy === false) continue;
    if (
      segment.startMs >= model.range.endMs ||
      segment.endMs <= model.range.startMs
    ) {
      continue;
    }
    const startsBeforeRange = segment.startMs < model.range.startMs;
    const visibleStartMs = Math.max(segment.startMs, model.range.startMs);
    const visibleEndMs = Math.min(segment.endMs, model.range.endMs);
    const allocationMeta =
      segment.type === "BUSY"
        ? "其他占用（详情受限）"
        : segment.allocation === null
          ? "未填写投入比例"
          : `投入 ${segment.allocation}%`;
    items.push({
      id: segment.id,
      selection: { kind: "SEGMENT", id: segment.id },
      atMs: visibleStartMs,
      endMs: visibleEndMs,
      title: segment.title,
      meta: startsBeforeRange ? `范围开始时已在进行 · ${allocationMeta}` : allocationMeta,
      state: segment.type === "BUSY" ? "忙碌" : `${segment.type} · ${segment.status}`,
      kind: "SEGMENT",
    });
  }
  if (display.showConflicts !== false) {
    for (const conflict of model.conflicts) {
      if (conflict.visibility !== "VISIBLE" || conflict.startMs === null) continue;
      const conflictEndMs = conflict.endMs ?? conflict.startMs + 1;
      if (
        conflict.startMs >= model.range.endMs ||
        conflictEndMs <= model.range.startMs
      ) {
        continue;
      }
      items.push({
        id: conflict.id,
        selection: { kind: "CONFLICT", id: conflict.id },
        atMs: Math.max(conflict.startMs, model.range.startMs),
        endMs:
          conflict.endMs === null
            ? null
            : Math.min(conflict.endMs, model.range.endMs),
        title: "资源冲突",
        meta: conflict.reason ?? "冲突详情",
        state: conflict.severity,
        kind: "CONFLICT",
      });
    }
  }

  items.sort((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id));
  const byDate = new Map<string, AgendaItem[]>();
  for (const item of items) {
    const dateKey = formatDateKey(item.atMs);
    const group = byDate.get(dateKey) ?? [];
    group.push(item);
    byDate.set(dateKey, group);
  }
  return [...byDate].map(([dateKey, groupedItems]) => ({
    dateKey,
    label: formatDateLabel(groupedItems[0]?.atMs ?? model.range.startMs),
    items: groupedItems,
  }));
}

function AgendaIcon({ kind }: { kind: AgendaItem["kind"] }) {
  const className = "mt-1 size-4 shrink-0 text-muted-foreground";
  if (kind === "CONFLICT") return <AlertTriangle className={className} aria-hidden="true" />;
  if (kind === "ANCHOR") return <Flag className={className} aria-hidden="true" />;
  return <Clock3 className={className} aria-hidden="true" />;
}

const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateLabelFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "long",
  day: "numeric",
  weekday: "short",
});
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatDateKey(timeMs: number) {
  return dateKeyFormatter.format(new Date(timeMs));
}

function formatDateLabel(timeMs: number) {
  return dateLabelFormatter.format(new Date(timeMs));
}

function formatTime(timeMs: number) {
  return timeFormatter.format(new Date(timeMs));
}
