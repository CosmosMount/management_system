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

export type TaskPlanRevisionHistoryControls = {
  byNodeId: Record<
    string,
    {
      checked: boolean;
      loading: boolean;
      error?: string;
    }
  >;
  onCheckedChange: (nodeId: string, checked: boolean) => void;
  onRetry: (nodeId: string) => void;
};

export function TaskPlanNodeNavigator({
  nodes,
  selectedId,
  onSelect,
  label = "任务节点",
  revisionHistory,
}: {
  nodes: TaskPlanNavigatorNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  label?: string;
  revisionHistory?: TaskPlanRevisionHistoryControls;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    const selected = container?.querySelector<HTMLElement>("[data-node-selected='true']");
    if (!container || !selected) return;
    const revealSelected = () => {
      const containerRect = container.getBoundingClientRect();
      const selectedRect = selected.getBoundingClientRect();
      container.scrollLeft = Math.max(
        0,
        container.scrollLeft +
          selectedRect.left -
          containerRect.left -
          container.clientLeft -
          (container.clientWidth - selectedRect.width) / 2,
      );
      container.scrollTop = Math.max(
        0,
        container.scrollTop +
          selectedRect.top -
          containerRect.top -
          container.clientTop -
          (container.clientHeight - selectedRect.height) / 2,
      );
    };
    revealSelected();
    const frame = window.requestAnimationFrame(revealSelected);
    return () => window.cancelAnimationFrame(frame);
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
          const historyControl =
            node.kind === "REVISION"
              ? revisionHistory?.byNodeId[node.id]
              : undefined;
          const historyErrorId = `revision-history-${node.id}-error`;
          return (
            <div
              key={node.id}
              className="relative flex min-w-0 flex-1 flex-col items-stretch sm:w-40 sm:min-w-40 sm:max-w-40 sm:flex-none"
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
                  <span className="line-clamp-2 block break-all text-sm font-medium">
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
              {historyControl && (
                <div
                  className="relative z-10 min-w-0 px-2 pb-2 text-xs sm:w-full sm:text-center"
                  data-testid={`revision-history-control-${node.id}`}
                >
                  <label
                    className={cn(
                      "relative inline-flex min-w-0 items-start gap-1.5 text-left text-muted-foreground",
                      historyControl.loading ? "cursor-wait" : "cursor-pointer",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="peer absolute left-0 top-0 z-10 m-0 h-4 w-7 cursor-pointer appearance-none rounded-full opacity-0 disabled:cursor-wait"
                      checked={historyControl.checked}
                      disabled={historyControl.loading}
                      aria-label={`显示计划修订「${node.label}」之前的计划`}
                      aria-describedby={
                        historyControl.error ? historyErrorId : undefined
                      }
                      onChange={(event) =>
                        revisionHistory?.onCheckedChange(
                          node.id,
                          event.currentTarget.checked,
                        )
                      }
                    />
                    <span
                      aria-hidden="true"
                      data-slot="revision-history-switch-track"
                      data-state={historyControl.checked ? "checked" : "unchecked"}
                      className="pointer-events-none h-4 w-7 shrink-0 rounded-full bg-muted-foreground/35 shadow-inner transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card peer-disabled:opacity-60 data-[state=checked]:bg-primary motion-reduce:transition-none"
                    />
                    <span
                      aria-hidden="true"
                      data-slot="revision-history-switch-thumb"
                      data-state={historyControl.checked ? "checked" : "unchecked"}
                      className="pointer-events-none absolute left-0.5 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform peer-disabled:opacity-80 data-[state=checked]:translate-x-3 motion-reduce:transition-none"
                    />
                    <span className="min-w-0 break-words">
                      {historyControl.loading
                        ? "正在加载修订前计划…"
                        : "显示修订前计划"}
                    </span>
                  </label>
                  {historyControl.error && (
                    <div className="mt-1.5 space-y-1 text-left">
                      <p
                        id={historyErrorId}
                        className="break-words text-destructive"
                        role="alert"
                      >
                        {historyControl.error}
                      </p>
                      <button
                        type="button"
                        className="font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`重新加载计划修订「${node.label}」之前的计划`}
                        onClick={() => revisionHistory?.onRetry(node.id)}
                      >
                        重新加载
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function nodeTypeLabel(kind: TaskPlanNavigatorNode["kind"]) {
  return {
    START: "开始节点",
    MILESTONE: "里程碑",
    REVISION: "计划修订",
    TERMINAL: "结束节点",
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
