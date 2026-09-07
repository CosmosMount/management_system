"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  createTimeScale,
  intervalToRect,
  rangesIntersect,
  snapTime,
  snapTimeInRange,
  xToTime,
} from "@/components/project-management/time-canvas/time-math";
import {
  layoutIntervalLanes,
  layoutPointLanes,
} from "@/components/project-management/time-canvas/lane-layout";
import type {
  TimeCanvasAnchor,
  TimeCanvasBrushRequest,
  TimeCanvasInteractionOptions,
  TimeCanvasPhaseBand,
  TimeCanvasProps,
  TimeCanvasRange,
  TimeCanvasRow,
  TimeCanvasSegment,
  TimeCanvasSelection,
} from "@/components/project-management/time-canvas/types";
import { cn } from "@/lib/utils";
import { formatCanvasRange as formatRange } from "@/components/project-management/time-canvas/time-format";
import {
  clampTime,
  normalizeBrushRange,
  overflowFocusKey,
  transformedRange,
} from "@/components/project-management/time-canvas/interaction-math";
import { edgeScrollCanvas } from "@/components/project-management/time-canvas/time-canvas-dom";
import {
  PlanRail,
  TimeGrid,
  TodayLine,
} from "@/components/project-management/time-canvas/time-canvas-layers";
import {
  AnchorMarker,
  SegmentBlock,
} from "@/components/project-management/time-canvas/time-canvas-objects";

export function TimelineRow({
  mode,
  row,
  scale,
  visibleWindow,
  viewportWindow,
  dayStripes,
  segments,
  anchors,
  phaseBands,
  nowMs,
  selection,
  activeFocusKey,
  interaction,
  creationRows,
  onSelect,
  onObjectFocus,
}: {
  mode: TimeCanvasProps["mode"];
  row: TimeCanvasRow;
  scale: ReturnType<typeof createTimeScale>;
  visibleWindow: { startMs: number; endMs: number };
  viewportWindow: { startMs: number; endMs: number };
  dayStripes: number[];
  segments: TimeCanvasSegment[];
  anchors: TimeCanvasAnchor[];
  phaseBands: TimeCanvasPhaseBand[];
  nowMs: number;
  selection: TimeCanvasSelection;
  activeFocusKey: string | null;
  interaction: TimeCanvasInteractionOptions | undefined;
  creationRows: Array<{ id: string; sourceId: string; label: string }>;
  onSelect: (selection: TimeCanvasSelection) => void;
  onObjectFocus: (key: string) => void;
}) {
  type ActiveBrush = {
    pointerId: number;
    anchorMs: number;
    currentMs: number;
  };
  type ActiveAnchorMarquee = {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    currentClientX: number;
    currentClientY: number;
    rowLeft: number;
    rowTop: number;
    rowWidth: number;
    rowHeight: number;
    additive: boolean;
    active: boolean;
  };
  const brushRef = useRef<ActiveBrush | null>(null);
  const [brush, setBrush] = useState<ActiveBrush | null>(null);
  const anchorMarqueeRef = useRef<ActiveAnchorMarquee | null>(null);
  const [anchorMarquee, setAnchorMarquee] =
    useState<ActiveAnchorMarquee | null>(null);
  const suppressAnchorCreateRef = useRef(false);
  const [anchorPreview, setAnchorPreview] = useState<{
    anchorId: string;
    atMs: number;
    anchorIds: string[];
  } | null>(null);
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const previewDeltaMs = anchorPreview
    ? anchorPreview.atMs - (anchorById.get(anchorPreview.anchorId)?.atMs ?? anchorPreview.atMs)
    : 0;
  const previewAnchorIds = new Set(anchorPreview?.anchorIds ?? []);
  const previewAnchors = anchorPreview
    ? anchors.map((anchor) =>
        previewAnchorIds.has(anchor.id)
          ? { ...anchor, atMs: anchor.atMs + previewDeltaMs }
          : anchor,
      )
    : anchors;
  const layout = layoutIntervalLanes(
    segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
  );
  const visiblePlacements = layout.placements.filter((placement) =>
    rangesIntersect(placement, visibleWindow),
  );
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const visibleAnchors = anchors.filter(
    (anchor) =>
      previewAnchorIds.has(anchor.id) ||
      (anchor.atMs >= visibleWindow.startMs && anchor.atMs < visibleWindow.endMs),
  );
  const anchorLanes = layoutPointLanes(
    visibleAnchors.map((anchor) => ({
      id: anchor.id,
        atMs: previewAnchorIds.has(anchor.id)
          ? anchor.atMs + previewDeltaMs
          : anchor.atMs,
      sequence: anchor.sequence,
    })),
    scale.msPerPixel * 96,
  );
  const maximumPlanLabelLane = Math.max(
    0,
    Math.floor((row.height - 80) / 22),
  );

  const brushRange = brush
    ? normalizeBrushRange(brush.anchorMs, brush.currentMs, scale)
    : null;
  const creationRange = interaction?.creationRange?.rowId === row.id
    ? interaction.creationRange
    : null;
  const canBrush =
    Boolean(interaction?.enableBrushCreate && interaction.onBrushCreate) &&
    row.editable &&
    row.kind === "PERSON";
  const canCreateAnchor =
    Boolean(interaction?.enableAnchorCreate && interaction.onAnchorCreate) &&
    row.editable &&
    row.kind === "PLAN";
  const canSelectAnchorsWithMarquee =
    Boolean(
      interaction?.enableAnchorMarqueeSelection &&
        interaction.onAnchorMarqueeSelection,
    ) &&
    row.editable &&
    row.kind === "PLAN";

  function marqueeStyle(active: ActiveAnchorMarquee) {
    const left = Math.max(
      0,
      Math.min(active.startClientX, active.currentClientX) - active.rowLeft,
    );
    const top = Math.max(
      0,
      Math.min(active.startClientY, active.currentClientY) - active.rowTop,
    );
    const right = Math.min(
      active.rowWidth,
      Math.max(active.startClientX, active.currentClientX) - active.rowLeft,
    );
    const bottom = Math.min(
      active.rowHeight,
      Math.max(active.startClientY, active.currentClientY) - active.rowTop,
    );
    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function pointerTime(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampTime(
      snapTime(xToTime(event.clientX - rect.left, scale), scale.snapMs),
      scale.startMs,
      scale.endMs,
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden bg-background",
        canBrush && "cursor-crosshair touch-none",
        canCreateAnchor && "cursor-cell",
        canSelectAnchorsWithMarquee && "cursor-crosshair touch-none",
        "data-[creation-drop-state=valid]:bg-emerald-50/70 data-[creation-drop-state=valid]:ring-2 data-[creation-drop-state=valid]:ring-inset data-[creation-drop-state=valid]:ring-emerald-500",
        "data-[creation-drop-state=invalid]:bg-destructive/10 data-[creation-drop-state=invalid]:ring-2 data-[creation-drop-state=invalid]:ring-inset data-[creation-drop-state=invalid]:ring-destructive",
      )}
      data-canvas-row={row.id}
      data-canvas-row-source={row.sourceId}
      data-canvas-row-kind={row.kind}
      data-anchor-preview={anchorPreview?.anchorId ?? ""}
      data-anchor-preview-ids={anchorPreview?.anchorIds.join(",") ?? ""}
      aria-label={`${row.label} 时间行`}
      onPointerDown={(event) => {
        const target = event.target;
        const startedOnObject =
          target instanceof Element && Boolean(target.closest("[data-canvas-object]"));
        if (
          canSelectAnchorsWithMarquee &&
          event.button === 0 &&
          !startedOnObject
        ) {
          const rowRect = event.currentTarget.getBoundingClientRect();
          const nextMarquee = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            currentClientX: event.clientX,
            currentClientY: event.clientY,
            rowLeft: rowRect.left,
            rowTop: rowRect.top,
            rowWidth: rowRect.width,
            rowHeight: rowRect.height,
            additive: event.shiftKey,
            active: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          anchorMarqueeRef.current = nextMarquee;
          setAnchorMarquee(nextMarquee);
          return;
        }
        if (
          !canBrush ||
          event.button !== 0 ||
          startedOnObject
        ) {
          return;
        }
        const atMs = pointerTime(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        const nextBrush = {
          pointerId: event.pointerId,
          anchorMs: atMs,
          currentMs: atMs,
        };
        brushRef.current = nextBrush;
        setBrush(nextBrush);
      }}
      onPointerMove={(event) => {
        const activeMarquee = anchorMarqueeRef.current;
        if (activeMarquee?.pointerId === event.pointerId) {
          const active =
            activeMarquee.active ||
            Math.hypot(
              event.clientX - activeMarquee.startClientX,
              event.clientY - activeMarquee.startClientY,
            ) >= 6;
          const nextMarquee = {
            ...activeMarquee,
            currentClientX: event.clientX,
            currentClientY: event.clientY,
            active,
          };
          anchorMarqueeRef.current = nextMarquee;
          setAnchorMarquee(nextMarquee);
          if (active) event.preventDefault();
          return;
        }
        const activeBrush = brushRef.current;
        if (!activeBrush || activeBrush.pointerId !== event.pointerId) return;
        const currentMs = pointerTime(event);
        const nextBrush = { ...activeBrush, currentMs };
        brushRef.current = nextBrush;
        setBrush(nextBrush);
      }}
      onPointerCancel={(event) => {
        if (anchorMarqueeRef.current?.pointerId === event.pointerId) {
          anchorMarqueeRef.current = null;
          setAnchorMarquee(null);
          return;
        }
        if (brushRef.current?.pointerId !== event.pointerId) return;
        brushRef.current = null;
        setBrush(null);
      }}
      onLostPointerCapture={(event) => {
        if (anchorMarqueeRef.current?.pointerId === event.pointerId) {
          anchorMarqueeRef.current = null;
          setAnchorMarquee(null);
          return;
        }
        if (brushRef.current?.pointerId !== event.pointerId) return;
        brushRef.current = null;
        setBrush(null);
      }}
      onPointerUp={(event) => {
        const activeMarquee = anchorMarqueeRef.current;
        if (activeMarquee?.pointerId === event.pointerId) {
          anchorMarqueeRef.current = null;
          setAnchorMarquee(null);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (!activeMarquee.active) return;
          suppressAnchorCreateRef.current = true;
          const selectionRect = normalizedClientRect(
            activeMarquee.startClientX,
            activeMarquee.startClientY,
            event.clientX,
            event.clientY,
          );
          const anchorIds = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              '[data-anchor-editable="true"][data-anchor-id]',
            ),
          ]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return pointInsideRectangle(
                selectionRect,
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
            })
            .map((element) => element.dataset.anchorId)
            .filter((anchorId): anchorId is string => Boolean(anchorId));
          interaction?.onAnchorMarqueeSelection?.({
            anchorIds,
            additive: activeMarquee.additive,
          });
          return;
        }
        const activeBrush = brushRef.current;
        if (!activeBrush || activeBrush.pointerId !== event.pointerId) return;
        const range = normalizeBrushRange(
          activeBrush.anchorMs,
          pointerTime(event),
          scale,
        );
        brushRef.current = null;
        setBrush(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        interaction?.onBrushCreate?.({
          rowId: row.id,
          rowKind: row.kind,
          sourceId: row.sourceId,
          ...range,
        });
      }}
      onClick={(event) => {
        if (suppressAnchorCreateRef.current) {
          suppressAnchorCreateRef.current = false;
          return;
        }
        const target = event.target;
        if (
          !canCreateAnchor ||
          (target instanceof Element && target.closest("[data-canvas-object]"))
        ) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const atMs = snapTimeInRange(
          xToTime(event.clientX - rect.left, scale),
          scale.anchorSnapMs,
          scale,
        );
        if (atMs === null) {
          interaction?.onInvalidDrop?.(
            "当前时间范围内没有可用吸附位置，请放大画布后重试。",
          );
          return;
        }
        interaction?.onAnchorCreate?.({
          rowId: row.id,
          rowKind: row.kind,
          sourceId: row.sourceId,
          atMs,
          snapMs: scale.anchorSnapMs,
        });
      }}
    >
      <TimeGrid dayStripes={dayStripes} scale={scale} />
      {brushRange && (
        <span
          className="pointer-events-none absolute inset-y-1 z-[15] rounded border-2 border-dashed border-primary bg-primary/15"
          style={intervalToRect(brushRange.startMs, brushRange.endMs, scale)}
          aria-hidden="true"
          data-testid="time-canvas-brush-preview"
        />
      )}
      {anchorMarquee?.active && (
        <span
          className="pointer-events-none absolute z-[35] rounded border-2 border-dashed border-primary bg-primary/10"
          style={marqueeStyle(anchorMarquee)}
          aria-hidden="true"
          data-testid="time-canvas-anchor-marquee"
        />
      )}
      {!brushRange && creationRange && (
        <CreationRangeBlock
          range={creationRange}
          scale={scale}
          rowTargets={creationRows}
          onTransform={interaction?.onCreationRangeTransform}
          onInvalidDrop={interaction?.onInvalidDrop}
        />
      )}
      {row.kind === "PLAN" && (
        <PlanRail
          anchors={previewAnchors}
          phaseBands={anchorPreview ? [] : phaseBands}
          viewportWindow={viewportWindow}
          scale={scale}
          rowId={row.id}
          selectedAnchorId={
            selection?.kind === "ANCHOR" ? selection.id : null
          }
          onSelectAnchor={(anchorId) =>
            onSelect({ kind: "ANCHOR", id: anchorId })
          }
        />
      )}
      {visiblePlacements.map((placement) => {
        if (placement.aggregated) {
          const firstId = placement.aggregatedIds[0];
          const first = firstId ? segmentById.get(firstId) : null;
          if (!first) return null;
          const rect = intervalToRect(placement.startMs, placement.endMs, scale);
          const focusKey = overflowFocusKey(row.id, placement.id);
          return (
            <button
              key={placement.id}
              type="button"
              className="absolute z-10 h-5 overflow-hidden rounded border border-border bg-muted px-1 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: rect.left, width: rect.width, top: 8 + placement.lane * 24 }}
              onClick={() => onSelect({ kind: "SEGMENT", id: first.id })}
              onFocus={() => onObjectFocus(focusKey)}
              tabIndex={activeFocusKey === focusKey ? 0 : -1}
              aria-label={`${placement.aggregatedIds.length} 条重叠安排，打开第一条`}
              data-canvas-object
              data-canvas-object-key={focusKey}
            >
              +{placement.aggregatedIds.length} 条重叠
            </button>
          );
        }
        const segment = segmentById.get(placement.id);
        if (!segment) return null;
        return (
          <SegmentBlock
            key={segment.id}
            segment={segment}
            lane={placement.lane}
            scale={scale}
            selected={selection?.kind === "SEGMENT" && selection.id === segment.id}
            activeFocusKey={activeFocusKey}
            interaction={interaction}
            onSelect={onSelect}
            onObjectFocus={onObjectFocus}
          />
        );
      })}

      {visibleAnchors.map((anchor, index) => (
        <AnchorMarker
          key={anchor.id}
          mode={mode}
          planRow={row.kind === "PLAN"}
          anchor={anchor}
          lane={
            row.kind === "PLAN"
              ? Math.min(anchorLanes.get(anchor.id) ?? 0, maximumPlanLabelLane)
              : anchorLanes.get(anchor.id) ?? 0
          }
          offset={index % 10}
          scale={scale}
          selected={selection?.kind === "ANCHOR" && selection.id === anchor.id}
          multiSelected={Boolean(interaction?.selectedAnchorIds?.has(anchor.id))}
          groupAnchors={
            interaction?.selectedAnchorIds?.has(anchor.id)
              ? anchors.filter(
                  (candidate) =>
                    candidate.editable &&
                    interaction.selectedAnchorIds?.has(candidate.id),
                )
              : [anchor]
          }
          groupPreviewAtMs={
            previewAnchorIds.has(anchor.id)
              ? anchor.atMs + previewDeltaMs
              : null
          }
          activeFocusKey={activeFocusKey}
          interaction={interaction}
          onSelect={onSelect}
          onObjectFocus={onObjectFocus}
          onPreviewChange={(anchorId, atMs, anchorIds) =>
            setAnchorPreview(
              atMs === null ? null : { anchorId, atMs, anchorIds },
            )
          }
        />
      ))}

      <TodayLine scale={scale} nowMs={nowMs} />
    </div>
  );
}

function CreationRangeBlock({
  range,
  scale,
  rowTargets,
  onTransform,
  onInvalidDrop,
}: {
  range: TimeCanvasBrushRequest;
  scale: ReturnType<typeof createTimeScale>;
  rowTargets: Array<{ id: string; sourceId: string; label: string }>;
  onTransform: TimeCanvasInteractionOptions["onCreationRangeTransform"];
  onInvalidDrop: TimeCanvasInteractionOptions["onInvalidDrop"];
}) {
  const [drag, setDrag] = useState<{
    pointerId: number;
    kind: "MOVE" | "RESIZE_START" | "RESIZE_END";
    clientX: number;
    scrollLeft: number;
    startMs: number;
    endMs: number;
  } | null>(null);
  const [preview, setPreview] = useState<TimeCanvasRange | null>(null);
  const [dropState, setDropState] = useState<"valid" | "invalid" | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{
    range: TimeCanvasRange;
    target: ReturnType<typeof creationDropTargetAtPoint>;
  } | null>(null);
  const highlightedRowRef = useRef<HTMLElement | null>(null);
  const displayed = preview ?? range;
  const rect = intervalToRect(displayed.startMs, displayed.endMs, scale);
  const currentRowLabel = rowTargets.find((row) => row.id === range.rowId)?.label;

  function submit(
    kind: "MOVE" | "RESIZE_START" | "RESIZE_END" | "KEYBOARD_MOVE",
    next: TimeCanvasRange,
    targetRowId = range.rowId,
    targetSourceId = range.sourceId,
  ) {
    onTransform?.({ kind, ...next, targetRowId, targetSourceId });
  }

  function applyDropTarget(
    target: ReturnType<typeof creationDropTargetAtPoint> | null,
  ) {
    highlightedRowRef.current?.removeAttribute("data-creation-drop-state");
    highlightedRowRef.current = target?.element ?? null;
    if (target?.element) {
      target.element.dataset.creationDropState = target.valid ? "valid" : "invalid";
    }
    setDropState(target ? (target.valid ? "valid" : "invalid") : null);
  }

  function clearPendingPointerFrame() {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    pendingPointerRef.current = null;
  }

  useEffect(() => () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
    }
    highlightedRowRef.current?.removeAttribute("data-creation-drop-state");
  }, []);

  return (
    <button
      type="button"
      className={cn(
        "pointer-events-none absolute inset-y-1 z-[15] rounded border-2 border-dashed border-primary bg-primary/15 text-[10px] font-medium text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-events-auto sm:touch-none",
        dropState === "valid" && "border-emerald-600 bg-emerald-100/70 text-emerald-900",
        dropState === "invalid" && "border-destructive bg-destructive/15 text-destructive",
      )}
      style={{ left: rect.left, width: rect.width }}
      aria-label={`待创建投入${currentRowLabel ? `，${currentRowLabel}` : ""}，${formatRange(displayed.startMs, displayed.endMs)}；可移动、跨行或调整边缘`}
      data-canvas-object
      data-testid="time-canvas-creation-range"
      data-drop-state={dropState ?? undefined}
      onKeyDown={(event) => {
        if (
          event.altKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          const currentIndex = rowTargets.findIndex((row) => row.id === range.rowId);
          const target = rowTargets[
            currentIndex + (event.key === "ArrowUp" ? -1 : 1)
          ];
          event.preventDefault();
          event.stopPropagation();
          if (!target) {
            onInvalidDrop?.("当前方向没有其他可创建的人员行。");
            return;
          }
          submit(
            "KEYBOARD_MOVE",
            { startMs: range.startMs, endMs: range.endMs },
            target.id,
            target.sourceId,
          );
          window.requestAnimationFrame(() => {
            document
              .querySelector<HTMLElement>("[data-testid='time-canvas-creation-range']")
              ?.focus();
          });
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (!event.shiftKey && !event.altKey) return;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const kind = event.altKey
          ? event.shiftKey
            ? "RESIZE_START"
            : "RESIZE_END"
          : "KEYBOARD_MOVE";
        const deltaMs = direction * scale.snapMs;
        const next = transformedRange(
          {
            kind: kind === "KEYBOARD_MOVE" ? "MOVE" : kind,
            startMs: range.startMs,
            endMs: range.endMs,
          },
          deltaMs,
          scale.startMs,
          scale.endMs,
          scale.snapMs,
        );
        event.preventDefault();
        event.stopPropagation();
        submit(kind, next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !onTransform) return;
        clearPendingPointerFrame();
        applyDropTarget(null);
        const target = event.target;
        const handle = target instanceof HTMLElement
          ? target.closest<HTMLElement>("[data-create-resize-handle]")?.dataset
              .createResizeHandle
          : undefined;
        const kind = handle === "start"
          ? "RESIZE_START"
          : handle === "end"
            ? "RESIZE_END"
            : "MOVE";
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        setDrag({
          pointerId: event.pointerId,
          kind,
          clientX: event.clientX,
          scrollLeft: scroller?.scrollLeft ?? 0,
          startMs: range.startMs,
          endMs: range.endMs,
        });
        setPreview({ startMs: range.startMs, endMs: range.endMs });
      }}
      onPointerMove={(event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        if (scroller) edgeScrollCanvas(scroller, event.clientX, event.clientY);
        const scrollDelta = (scroller?.scrollLeft ?? 0) - drag.scrollLeft;
        const deltaMs = snapTime(
          (event.clientX - drag.clientX + scrollDelta) * scale.msPerPixel,
          scale.snapMs,
          "round",
          0,
        );
        pendingPointerRef.current = {
          range: transformedRange(
            drag,
            deltaMs,
            scale.startMs,
            scale.endMs,
            scale.snapMs,
          ),
          target: creationDropTargetAtPoint(
            event.clientX,
            event.clientY,
            rowTargets,
          ),
        };
        if (previewFrameRef.current !== null) return;
        previewFrameRef.current = window.requestAnimationFrame(() => {
          previewFrameRef.current = null;
          const pending = pendingPointerRef.current;
          pendingPointerRef.current = null;
          if (!pending) return;
          setPreview(pending.range);
          applyDropTarget(pending.target);
        });
      }}
      onPointerCancel={() => {
        clearPendingPointerFrame();
        applyDropTarget(null);
        setDrag(null);
        setPreview(null);
      }}
      onLostPointerCapture={() => {
        clearPendingPointerFrame();
        applyDropTarget(null);
        setDrag(null);
        setPreview(null);
      }}
      onPointerUp={(event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const next = pendingPointerRef.current?.range ?? preview ?? range;
        const target = creationDropTargetAtPoint(
          event.clientX,
          event.clientY,
          rowTargets,
        );
        clearPendingPointerFrame();
        applyDropTarget(null);
        setDrag(null);
        setPreview(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (!target.valid || !target.rowId || !target.sourceId) {
          onInvalidDrop?.("待创建投入只能移动到当前已加载且可编辑的人员行。");
          return;
        }
        submit(drag.kind, next, target.rowId, target.sourceId);
      }}
    >
      <span
        className="absolute inset-y-0 left-0 hidden w-3 cursor-ew-resize sm:block"
        data-create-resize-handle="start"
        aria-hidden="true"
      />
      <span className="sr-only">待创建投入</span>
      <span
        className="absolute inset-y-0 right-0 hidden w-3 cursor-ew-resize sm:block"
        data-create-resize-handle="end"
        aria-hidden="true"
      />
    </button>
  );
}

type ClientRectangle = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function normalizedClientRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): ClientRectangle {
  return {
    left: Math.min(startX, endX),
    right: Math.max(startX, endX),
    top: Math.min(startY, endY),
    bottom: Math.max(startY, endY),
  };
}

function pointInsideRectangle(rectangle: ClientRectangle, x: number, y: number) {
  return (
    x >= rectangle.left &&
    x <= rectangle.right &&
    y >= rectangle.top &&
    y <= rectangle.bottom
  );
}
function creationDropTargetAtPoint(
  clientX: number,
  clientY: number,
  rowTargets: Array<{ id: string; sourceId: string }>,
) {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>("[data-canvas-row]") ?? null;
  const rowId = element?.dataset.canvasRow;
  const sourceId = element?.dataset.canvasRowSource;
  const valid = Boolean(
    element?.dataset.canvasRowKind === "PERSON" &&
    rowId &&
    sourceId &&
    rowTargets.some((row) => row.id === rowId && row.sourceId === sourceId),
  );
  return { element, rowId, sourceId, valid };
}
