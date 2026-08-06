"use client";

import { Check, Circle, Flag, GitCommitHorizontal, Play } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type TaskPlanNavigatorNode = {
  id: string;
  kind: "START" | "MILESTONE" | "REVISION" | "TERMINAL";
  label: string;
  at: string;
  status: string;
  completed?: boolean;
  disabled?: boolean;
  invalid?: boolean;
};

export function TaskPlanNodeNavigator({
  nodes,
  selectedId,
  onSelect,
  label = "Task 节点",
}: {
  nodes: TaskPlanNavigatorNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    const selected = container?.querySelector<HTMLElement>("[data-node-selected='true']");
    if (!container || !selected) return;
    const containerRect = container.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    if (selectedRect.left < containerRect.left) {
      container.scrollLeft -= containerRect.left - selectedRect.left;
    } else if (selectedRect.right > containerRect.right) {
      container.scrollLeft += selectedRect.right - containerRect.right;
    }
    if (selectedRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - selectedRect.top;
    } else if (selectedRect.bottom > containerRect.bottom) {
      container.scrollTop += selectedRect.bottom - containerRect.bottom;
    }
  }, [nodes.length, selectedId]);

  return (
    <div
      ref={containerRef}
      className="max-h-[32rem] min-w-0 overflow-auto rounded-xl border border-border bg-card p-4 sm:max-h-none sm:overflow-x-auto sm:overflow-y-hidden"
      aria-label={label}
      data-testid="task-plan-node-navigator"
    >
      <div className="flex min-w-0 flex-col gap-2 sm:min-w-max sm:flex-row sm:items-start sm:gap-0">
        {nodes.map((node, index) => {
          const selected = selectedId === node.id;
          const typeLabel = nodeTypeLabel(node.kind);
          return (
            <div
              key={node.id}
              className="relative flex min-w-0 flex-1 items-stretch sm:min-w-40 sm:items-start"
              data-node-selected={selected}
            >
              {index > 0 && (
                <span
                  className="absolute left-5 top-0 h-3 w-px bg-border sm:left-0 sm:top-5 sm:h-px sm:w-1/2"
                  aria-hidden="true"
                />
              )}
              {index < nodes.length - 1 && (
                <span
                  className="absolute bottom-0 left-5 h-3 w-px bg-border sm:bottom-auto sm:left-1/2 sm:top-5 sm:h-px sm:w-1/2"
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                className={cn(
                  "relative z-10 flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:flex-col sm:text-center",
                  selected ? "bg-primary/10 text-primary" : "hover:bg-muted",
                  node.disabled && "cursor-not-allowed opacity-60",
                )}
                aria-pressed={selected}
                aria-label={`${node.label}，${typeLabel}，${node.invalid ? "需修正，" : ""}${node.status}，${formatNodeDate(node.at)}`}
                disabled={node.disabled}
                onClick={() => onSelect(node.id)}
              >
                <NodeIcon node={node} selected={selected} />
                <span className="min-w-0 flex-1 sm:w-full">
                  <span className="block break-words text-sm font-medium">
                    {node.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {typeLabel}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 block text-xs text-muted-foreground",
                      node.invalid && "font-medium text-destructive",
                    )}
                  >
                    {node.invalid ? `需修正 · ${node.status}` : node.status}
                  </span>
                  <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                    {formatNodeDate(node.at)}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function nodeTypeLabel(kind: TaskPlanNavigatorNode["kind"]) {
  return {
    START: "Start",
    MILESTONE: "Milestone",
    REVISION: "Revision",
    TERMINAL: "Terminal",
  }[kind];
}

function NodeIcon({
  node,
  selected,
}: {
  node: TaskPlanNavigatorNode;
  selected: boolean;
}) {
  const className = cn(
    "flex size-10 shrink-0 items-center justify-center rounded-full border-2 bg-background",
    selected && "border-primary text-primary ring-4 ring-primary/10",
    node.completed && !selected && "border-emerald-500 text-emerald-600",
    node.invalid && "border-destructive text-destructive",
    !selected && !node.completed && !node.invalid && "border-border text-muted-foreground",
  );
  const iconClassName = "size-4";
  return (
    <span className={className} aria-hidden="true">
      {node.completed ? (
        <Check className={iconClassName} />
      ) : node.kind === "START" ? (
        <Play className={iconClassName} />
      ) : node.kind === "REVISION" ? (
        <GitCommitHorizontal className={iconClassName} />
      ) : node.kind === "TERMINAL" ? (
        <Flag className={iconClassName} />
      ) : (
        <Circle className={iconClassName} />
      )}
    </span>
  );
}

function formatNodeDate(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? `${value}:00+08:00`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "时间待修正";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
