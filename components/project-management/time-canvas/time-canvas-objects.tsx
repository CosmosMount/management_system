"use client";

import { useRef, useState } from "react";
import {
  Check,
  Circle,
  Diamond,
  Flag,
  GitBranch,
} from "lucide-react";
import {
  createTimeScale,
  intervalToRect,
  moveTimePoints,
  snapTime,
  timeToX,
} from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasAnchor,
  TimeCanvasAnchorMoveRequest,
  TimeCanvasAnchorMoveResolution,
  TimeCanvasInteractionOptions,
  TimeCanvasProps,
  TimeCanvasSegment,
  TimeCanvasSelection,
} from "@/components/project-management/time-canvas/types";
import { cn } from "@/lib/utils";
import { evaluateDeadline } from "@/lib/project-management/current-node-deadline";
import { deadlinePresentation } from "@/components/project-management/node-deadline";
import {
  formatCanvasDateTime as formatDateTime,
  formatCanvasRange as formatRange,
  formatCompactAnchorDate,
} from "@/components/project-management/time-canvas/time-format";
import {
  anchorFocusKey,
  clampTime,
  segmentFocusKey,
  transformedRange,
} from "@/components/project-management/time-canvas/interaction-math";
import { edgeScrollCanvas } from "@/components/project-management/time-canvas/time-canvas-dom";
import { PLAN_RAIL_TOP } from "@/components/project-management/time-canvas/time-canvas-layout";

export function SegmentBlock({
  segment,
  lane,
  scale,
  selected,
  activeFocusKey,
  interaction,
  onSelect,
  onObjectFocus,
}: {
  segment: TimeCanvasSegment;
  lane: number;
  scale: ReturnType<typeof createTimeScale>;
  selected: boolean;
  activeFocusKey: string | null;
  interaction: TimeCanvasInteractionOptions | undefined;
  onSelect: (selection: TimeCanvasSelection) => void;
  onObjectFocus: (key: string) => void;
}) {
  const [transform, setTransform] = useState<{
    pointerId: number;
    kind: "MOVE" | "RESIZE_START" | "RESIZE_END";
    clientX: number;
    scrollLeft: number;
    startMs: number;
    endMs: number;
    rowTop: number;
    rowBottom: number;
  } | null>(null);
  const [preview, setPreview] = useState<{
    startMs: number;
    endMs: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const displayed = preview ?? segment;
  const rect = intervalToRect(displayed.startMs, displayed.endMs, scale);
  const focusKey = segmentFocusKey(segment.id);

  function requestKeyboardTransform(
    kind: "KEYBOARD_MOVE" | "RESIZE_END",
    direction: -1 | 1,
  ) {
    const onSegmentTransform = interaction?.onSegmentTransform;
    if (!onSegmentTransform) return;
    if (kind === "KEYBOARD_MOVE" && !segment.permissions.canMove) return;
    if (kind === "RESIZE_END" && !segment.permissions.canResize) return;
    const duration = segment.endMs - segment.startMs;
    const nextStart =
      kind === "KEYBOARD_MOVE"
        ? clampTime(
            segment.startMs + direction * scale.snapMs,
            scale.startMs,
            scale.endMs - duration,
          )
        : segment.startMs;
    const nextEnd =
      kind === "KEYBOARD_MOVE"
        ? nextStart + duration
        : clampTime(
            segment.endMs + direction * scale.snapMs,
            segment.startMs + scale.snapMs,
            scale.endMs,
          );
    onSegmentTransform({
      segmentId: segment.id,
      kind,
      startMs: nextStart,
      endMs: nextEnd,
    });
  }

  return (
    <button
      type="button"
      className={cn(
        "absolute z-10 flex h-5 min-w-px items-center gap-1 overflow-hidden rounded px-1 text-left text-[10px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        "touch-none",
        segment.type === "WORK" &&
          "border border-sky-600 bg-sky-100/90 text-sky-950 dark:bg-sky-950/60 dark:text-sky-50",
        segment.type === "BUSY" &&
          "border border-slate-400 bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_4px,var(--background)_4px,var(--background)_8px)] text-foreground",
        selected && "ring-2 ring-primary ring-offset-1",
        transform && "cursor-grabbing opacity-80",
      )}
      style={{ left: rect.left, width: rect.width, top: 8 + lane * 24 }}
      aria-pressed={selected}
      aria-label={segmentAriaLabel(segment)}
      title={segmentHoverTitle(segment)}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        onSelect(selected ? null : { kind: "SEGMENT", id: segment.id });
      }}
      onDoubleClick={(event) => {
        if (!segment.permissions.canViewDetails || !interaction?.onSegmentOpen) return;
        event.preventDefault();
        event.stopPropagation();
        interaction.onSegmentOpen(segment.id);
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          segment.permissions.canViewDetails &&
          interaction?.onSegmentOpen
        ) {
          event.preventDefault();
          event.stopPropagation();
          interaction.onSegmentOpen(segment.id);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          requestKeyboardTransform("KEYBOARD_MOVE", direction);
        } else if (event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          requestKeyboardTransform("RESIZE_END", direction);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !interaction?.onSegmentTransform) return;
        const target = event.target;
        const handle =
          target instanceof HTMLElement
            ? target.closest<HTMLElement>("[data-resize-handle]")?.dataset
                .resizeHandle
            : undefined;
        const kind =
          handle === "start"
            ? "RESIZE_START"
            : handle === "end"
              ? "RESIZE_END"
              : "MOVE";
        if (kind === "MOVE" && !segment.permissions.canMove) return;
        if (kind !== "MOVE" && !segment.permissions.canResize) return;
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        const row = event.currentTarget.closest<HTMLElement>("[data-canvas-row]");
        const rowRect = row?.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setTransform({
          pointerId: event.pointerId,
          kind,
          clientX: event.clientX,
          scrollLeft: scroller?.scrollLeft ?? 0,
          startMs: segment.startMs,
          endMs: segment.endMs,
          rowTop: rowRect?.top ?? Number.NEGATIVE_INFINITY,
          rowBottom: rowRect?.bottom ?? Number.POSITIVE_INFINITY,
        });
        setPreview({ startMs: segment.startMs, endMs: segment.endMs });
      }}
      onPointerMove={(event) => {
        if (!transform || transform.pointerId !== event.pointerId) return;
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        if (scroller) edgeScrollCanvas(scroller, event.clientX);
        const scrollDelta = (scroller?.scrollLeft ?? 0) - transform.scrollLeft;
        const rawDelta =
          (event.clientX - transform.clientX + scrollDelta) * scale.msPerPixel;
        const deltaMs = snapTime(rawDelta, scale.snapMs, "round", 0);
        setPreview(
          transformedRange(transform, deltaMs, scale.startMs, scale.endMs, scale.snapMs),
        );
        if (Math.abs(deltaMs) >= scale.snapMs) suppressClickRef.current = true;
      }}
      onPointerCancel={() => {
        setTransform(null);
        setPreview(null);
      }}
      onPointerUp={(event) => {
        if (!transform || transform.pointerId !== event.pointerId) return;
        const result = preview;
        const droppedOutsideOriginalRow =
          event.clientY < transform.rowTop || event.clientY >= transform.rowBottom;
        setTransform(null);
        setPreview(null);
        if (suppressClickRef.current) {
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        }
        if (droppedOutsideOriginalRow) {
          suppressClickRef.current = true;
          interaction?.onInvalidDrop?.("不支持跨人员行拖放，投入仍保留在原位置。");
          return;
        }
        if (
          result &&
          (result.startMs !== segment.startMs || result.endMs !== segment.endMs)
        ) {
          interaction?.onSegmentTransform?.({
            segmentId: segment.id,
            kind: transform.kind,
            ...result,
          });
        }
      }}
      onFocus={() => onObjectFocus(focusKey)}
      tabIndex={activeFocusKey === focusKey ? 0 : -1}
      data-canvas-object
      data-canvas-object-key={focusKey}
      data-testid={`segment-block-${segment.id}`}
    >
      {segment.permissions.canResize && interaction?.onSegmentTransform && (
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-2 max-w-[25%] cursor-ew-resize",
          )}
          data-resize-handle="start"
          aria-hidden="true"
        />
      )}
      <span className="truncate">{segment.title}</span>
      {segment.permissions.canResize && interaction?.onSegmentTransform && (
        <span
          className={cn(
            "absolute inset-y-0 right-0 w-2 max-w-[25%] cursor-ew-resize",
          )}
          data-resize-handle="end"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export function AnchorMarker({
  nowMs,
  mode,
  planRow,
  anchor,
  lane,
  offset,
  scale,
  selected,
  multiSelected,
  groupAnchors,
  groupPreviewAtMs,
  activeFocusKey,
  interaction,
  onSelect,
  onObjectFocus,
  onPreviewChange,
}: {
  nowMs: number;
  mode: TimeCanvasProps["mode"];
  planRow: boolean;
  anchor: TimeCanvasAnchor;
  lane: number;
  offset: number;
  scale: ReturnType<typeof createTimeScale>;
  selected: boolean;
  multiSelected: boolean;
  groupAnchors: TimeCanvasAnchor[];
  groupPreviewAtMs: number | null;
  activeFocusKey: string | null;
  interaction: TimeCanvasInteractionOptions | undefined;
  onSelect: (selection: TimeCanvasSelection) => void;
  onObjectFocus: (key: string) => void;
  onPreviewChange: (
    anchorId: string,
    atMs: number | null,
    anchorIds: string[],
  ) => void;
}) {
  const [move, setMove] = useState<{
    pointerId: number;
    clientX: number;
    scrollLeft: number;
    rowTop: number;
    rowBottom: number;
  } | null>(null);
  const [previewAtMs, setPreviewAtMs] = useState<number | null>(null);
  const previewBlockedMessageRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const displayedAtMs = previewAtMs ?? groupPreviewAtMs ?? anchor.atMs;
  const completed = anchor.completed ?? anchor.status === "COMPLETED";
  const deadlineStatus = evaluateDeadline(
    completed || anchor.visualState || mode === "TASK_COMPOSER" ? null : anchor.currentNodeDeadline,
    nowMs,
  );
  const deadline = deadlineStatus === "NONE" ? null : deadlinePresentation[deadlineStatus];
  const left = timeToX(displayedAtMs, scale) + (planRow ? 0 : offset * 2);
  const top = planRow ? PLAN_RAIL_TOP + 2 : 8 + lane * 22;
  const iconKind =
    anchor.kind === "TERMINATION"
      ? "FLAG"
      : anchor.kind === "REVISION"
        ? "BRANCH"
        : mode === "TASK_COMPOSER" && anchor.kind === "MILESTONE"
          ? "DIAMOND"
          : completed
            ? "CHECK"
            : "CIRCLE";
  const Icon =
    iconKind === "FLAG"
      ? Flag
      : iconKind === "BRANCH"
        ? GitBranch
        : iconKind === "DIAMOND"
          ? Diamond
          : iconKind === "CHECK"
            ? Check
            : Circle;
  const focusKey = anchorFocusKey(anchor.id);
  const canMove = anchor.editable && Boolean(interaction?.onAnchorMove);
  const selectedForGroup = selected || multiSelected;
  const movableGroup =
    selectedForGroup && groupAnchors.length > 0 ? groupAnchors : [anchor];
  const announcedStatus =
    anchor.visualState === "TEMPORARY"
      ? "临时"
      : anchor.visualState === "INVALID"
        ? "需修正"
        : anchor.status;

  function requestKeyboardMove(direction: -1 | 1) {
    if (!canMove) return;
    const canvasResult = moveAnchorGroupOnCanvas({
      rawDeltaMs: direction * scale.anchorSnapMs,
    });
    const result = constrainMove(canvasResult, "KEYBOARD_MOVE");
    if (result.deltaMs === 0) {
      interaction?.onInvalidDrop?.(
        result.blockedMessage ?? "节点已到当前时间范围边界，无法继续移动。",
      );
      return;
    }
    interaction?.onAnchorMove?.({
      anchorId: anchor.id,
      rowId: anchor.rowId,
      kind: "KEYBOARD_MOVE",
      ...result,
      snapMs: scale.anchorSnapMs,
    });
  }

  function moveAnchorGroupOnCanvas({ rawDeltaMs }: { rawDeltaMs: number }) {
    const result = moveTimePoints({
      pointsMs: movableGroup.map((candidate) => candidate.atMs),
      rawDeltaMs,
      snapMs: scale.anchorSnapMs,
      range: scale,
    });
    const anchorIndex = movableGroup.findIndex(
      (candidate) => candidate.id === anchor.id,
    );
    return {
      atMs: result.pointsMs[anchorIndex < 0 ? 0 : anchorIndex]!,
      deltaMs: result.deltaMs,
    };
  }

  function constrainMove(
    result: { atMs: number; deltaMs: number },
    kind: TimeCanvasAnchorMoveRequest["kind"],
  ): TimeCanvasAnchorMoveResolution {
    return interaction?.constrainAnchorMove?.({
      anchorId: anchor.id,
      rowId: anchor.rowId,
      kind,
      ...result,
      snapMs: scale.anchorSnapMs,
    }) ?? result;
  }

  return (
    <button
      type="button"
      className={cn(
        "absolute z-20 flex max-w-40 -translate-x-1/2 flex-col items-center rounded px-1 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        canMove && "touch-none cursor-grab",
        move && "cursor-grabbing opacity-80",
        selectedForGroup && "bg-primary/10 ring-2 ring-primary",
        multiSelected && !selected && "ring-primary/70",
        completed && "text-emerald-700 dark:text-emerald-300",
        anchor.visualState === "TEMPORARY" && "text-amber-700",
        anchor.visualState === "INVALID" && "text-destructive",
      )}
      style={{ left, top }}
      aria-pressed={selectedForGroup}
      aria-label={`${anchor.kind === "TERMINATION" ? "终止节点" : "计划节点"} ${anchor.label}，${formatDateTime(displayedAtMs)}，状态 ${announcedStatus}${deadline ? `，${deadline.label}` : ""}${canMove ? "，按左右方向键可移动" : ""}`}
      title={`${anchor.label} · ${formatDateTime(displayedAtMs)}${deadline ? ` · ${deadline.label}` : ""}`}
      onClick={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        if (interaction?.onAnchorSelect) {
          interaction.onAnchorSelect(anchor.id, { toggle: event.shiftKey });
          return;
        }
        onSelect(selected ? null : { kind: "ANCHOR", id: anchor.id });
      }}
      onKeyDown={(event) => {
        if (
          !canMove ||
          (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        requestKeyboardMove(event.key === "ArrowLeft" ? -1 : 1);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !canMove) return;
        if (!event.shiftKey && !multiSelected) {
          interaction?.onAnchorSelect?.(anchor.id, { toggle: false });
        }
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        const row = event.currentTarget.closest<HTMLElement>("[data-canvas-row]");
        const rowRect = row?.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setMove({
          pointerId: event.pointerId,
          clientX: event.clientX,
          scrollLeft: scroller?.scrollLeft ?? 0,
          rowTop: rowRect?.top ?? Number.NEGATIVE_INFINITY,
          rowBottom: rowRect?.bottom ?? Number.POSITIVE_INFINITY,
        });
        setPreviewAtMs(anchor.atMs);
        previewBlockedMessageRef.current = null;
        onPreviewChange(
          anchor.id,
          anchor.atMs,
          movableGroup.map((candidate) => candidate.id),
        );
      }}
      onPointerMove={(event) => {
        if (!move || move.pointerId !== event.pointerId) return;
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        if (scroller) edgeScrollCanvas(scroller, event.clientX);
        const scrollDelta = (scroller?.scrollLeft ?? 0) - move.scrollLeft;
        const rawDelta =
          (event.clientX - move.clientX + scrollDelta) * scale.msPerPixel;
        const canvasResult = moveAnchorGroupOnCanvas({ rawDeltaMs: rawDelta });
        const result = constrainMove(canvasResult, "MOVE");
        setPreviewAtMs(result.atMs);
        previewBlockedMessageRef.current = result.blockedMessage ?? null;
        onPreviewChange(
          anchor.id,
          result.atMs,
          movableGroup.map((candidate) => candidate.id),
        );
        if (Math.abs(rawDelta) >= scale.anchorSnapMs) {
          suppressClickRef.current = true;
        }
      }}
      onPointerCancel={() => {
        setMove(null);
        setPreviewAtMs(null);
        previewBlockedMessageRef.current = null;
        onPreviewChange(anchor.id, null, []);
      }}
      onPointerUp={(event) => {
        if (!move || move.pointerId !== event.pointerId) return;
        const result = previewAtMs;
        const blockedMessage = previewBlockedMessageRef.current;
        const attemptedMove = suppressClickRef.current;
        const droppedOutsideOriginalRow =
          event.clientY < move.rowTop || event.clientY >= move.rowBottom;
        setMove(null);
        setPreviewAtMs(null);
        previewBlockedMessageRef.current = null;
        onPreviewChange(anchor.id, null, []);
        if (suppressClickRef.current) {
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        }
        if (droppedOutsideOriginalRow) {
          suppressClickRef.current = true;
          interaction?.onInvalidDrop?.("不支持跨计划行拖放，节点仍保留在原位置。");
          return;
        }
        if (result !== null && result !== anchor.atMs) {
          interaction?.onAnchorMove?.({
            anchorId: anchor.id,
            rowId: anchor.rowId,
            kind: "MOVE",
            atMs: result,
            deltaMs: result - anchor.atMs,
            snapMs: scale.anchorSnapMs,
          });
        } else if (attemptedMove) {
          interaction?.onInvalidDrop?.(
            blockedMessage ?? "节点已到当前时间范围边界，仍保留在原位置。",
          );
        }
      }}
      onFocus={() => onObjectFocus(focusKey)}
      tabIndex={activeFocusKey === focusKey ? 0 : -1}
      data-canvas-object
      data-canvas-object-key={focusKey}
      data-anchor-icon={iconKind}
      data-anchor-completed={completed ? "true" : "false"}
      data-anchor-id={anchor.id}
      data-deadline-status={deadlineStatus}
      data-anchor-editable={anchor.editable ? "true" : "false"}
      data-anchor-multi-selected={multiSelected ? "true" : "false"}
      data-anchor-visual-state={anchor.visualState ?? "DEFAULT"}
      data-anchor-label-lane={planRow ? lane : undefined}
      data-testid={`milestone-marker-${anchor.id}`}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          anchorToneClassName(anchor),
          completed && "text-emerald-600 dark:text-emerald-400",
          anchor.status === "ACTIVE" && "fill-primary text-primary",
          anchor.visualState === "TEMPORARY" &&
            "text-amber-600 [stroke-dasharray:3_2] dark:text-amber-400",
          anchor.visualState === "INVALID" && "text-destructive",
        )}
        aria-hidden="true"
        data-testid={`anchor-symbol-${anchor.id}`}
      />
      <span
        className="max-w-32 truncate"
        style={{ marginTop: planRow ? 4 + lane * 22 : 2 }}
      >
        {anchor.visualState === "TEMPORARY" ? `临时 · ${anchor.label}` : anchor.label}
      </span>
      {(planRow || deadline) && (
        <span className={cn("max-w-32 truncate rounded border border-transparent px-1 text-[9px] text-muted-foreground", deadline?.className)}>
          {deadline ? `${deadline.label} · ` : ""}{formatCompactAnchorDate(displayedAtMs, false)}
        </span>
      )}
    </button>
  );
}
function segmentAriaLabel(segment: TimeCanvasSegment) {
  const type = segment.type === "BUSY" ? "其他占用" : "投入记录";
  const task = segment.type === "BUSY"
    ? ""
    : `，任务 ${segment.taskTitle ?? "独立投入"}`;
  return `${type} ${segment.title}${task}，${formatRange(segment.startMs, segment.endMs)}`;
}

function segmentHoverTitle(segment: TimeCanvasSegment) {
  const range = formatRange(segment.startMs, segment.endMs);
  if (segment.type === "BUSY") return `其他占用 · ${range}`;
  return `${segment.title} · 任务：${segment.taskTitle ?? "独立投入"} · ${range}`;
}

function anchorToneClassName(anchor: TimeCanvasAnchor) {
  if (anchor.visualState === "TEMPORARY") return "text-amber-600 dark:text-amber-400";
  if (anchor.visualState === "INVALID") return "text-destructive";
  if (anchor.tone === "BLUE") return "text-blue-600 dark:text-blue-400";
  if (anchor.tone === "VIOLET") return "text-violet-600 dark:text-violet-400";
  if (anchor.tone === "AMBER") return "text-amber-600 dark:text-amber-400";
  if (anchor.tone === "EMERALD") return "text-emerald-600 dark:text-emerald-400";
  if (anchor.tone === "ROSE") return "text-rose-600 dark:text-rose-400";
  if (anchor.tone === "SLATE") return "text-slate-600 dark:text-slate-400";
  if (anchor.kind === "PLAN_START") return "text-blue-600 dark:text-blue-400";
  if (anchor.kind === "TERMINATION") return "text-destructive";
  return "text-foreground";
}
