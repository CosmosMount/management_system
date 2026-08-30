"use client";

import { useState } from "react";
import { layoutIntervalLanes } from "@/components/project-management/time-canvas/lane-layout";
import {
  createTimeScale,
  moveTimePoint,
  timeToX,
} from "@/components/project-management/time-canvas/time-math";
import { edgeScrollCanvas } from "@/components/project-management/time-canvas/time-canvas-dom";
import {
  TimeGrid,
  TodayLine,
} from "@/components/project-management/time-canvas/time-canvas-layers";
import {
  ADMIN_MARKER_STAGE_HEIGHT,
  GLOBAL_MARKER_LABEL_TOP,
  GLOBAL_MARKER_LANE_STRIDE,
} from "@/components/project-management/time-canvas/time-canvas-layout";
import {
  formatCanvasDateTime as formatDateTime,
  formatCompactAnchorDate,
} from "@/components/project-management/time-canvas/time-format";
import type {
  TimeCanvasGlobalMarker,
  TimeCanvasInteractionOptions,
  TimeCanvasRange,
} from "@/components/project-management/time-canvas/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function GlobalMarkerOverlay({
  markers,
  scale,
  visibleWindow,
  rowHeaderWidth,
}: {
  markers: TimeCanvasGlobalMarker[];
  scale: ReturnType<typeof createTimeScale>;
  visibleWindow: TimeCanvasRange;
  rowHeaderWidth: number;
}) {
  if (markers.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-[24] overflow-hidden"
      style={{
        left: rowHeaderWidth,
        width: scale.contentWidthPx,
      }}
      aria-label="全局关键时间点"
      data-testid="time-canvas-global-markers"
    >
      <GlobalMarkerLines markers={markers} scale={scale} />
      <GlobalMarkerLabels
        markers={markers}
        scale={scale}
        visibleWindow={visibleWindow}
        showVisibleTime={false}
      />
    </div>
  );
}

export function AdminGlobalMarkerStage({
  markers,
  scale,
  visibleWindow,
  dayStripes,
  nowMs,
  rowHeaderWidth,
  interaction,
}: {
  markers: TimeCanvasGlobalMarker[];
  scale: ReturnType<typeof createTimeScale>;
  visibleWindow: TimeCanvasRange;
  dayStripes: number[];
  nowMs: number;
  rowHeaderWidth: number;
  interaction: TimeCanvasInteractionOptions | undefined;
}) {
  return (
    <div
      className="sticky top-16 z-[28] grid border-b border-border bg-card/95 backdrop-blur"
      style={{
        height: ADMIN_MARKER_STAGE_HEIGHT,
        gridTemplateColumns: `${rowHeaderWidth}px ${scale.contentWidthPx}px`,
      }}
      data-testid="time-canvas-global-marker-stage"
    >
      <div className="sticky left-0 z-30 border-r border-border bg-card" aria-hidden="true" />
      <div
        className="relative overflow-hidden bg-muted/20"
        aria-label="关键时间点拖动区域"
      >
        <TimeGrid dayStripes={dayStripes} scale={scale} />
        <GlobalMarkerLines markers={markers} scale={scale} />
        <GlobalMarkerLabels
          markers={markers}
          scale={scale}
          visibleWindow={visibleWindow}
          interaction={interaction}
          maximumVisibleLanes={4}
          showVisibleTime
        />
        <TodayLine scale={scale} nowMs={nowMs} overContent />
      </div>
    </div>
  );
}

function GlobalMarkerLabels({
  markers,
  scale,
  visibleWindow,
  interaction,
  maximumVisibleLanes = 2,
  showVisibleTime,
}: {
  markers: TimeCanvasGlobalMarker[];
  scale: ReturnType<typeof createTimeScale>;
  visibleWindow: TimeCanvasRange;
  interaction?: TimeCanvasInteractionOptions;
  maximumVisibleLanes?: number;
  showVisibleTime: boolean;
}) {
  const [prioritizedMarkerId, setPrioritizedMarkerId] = useState<string | null>(
    null,
  );
  const visibleMarkers = markers.filter(
    (marker) =>
      marker.atMs >= visibleWindow.startMs && marker.atMs < visibleWindow.endMs,
  );
  const markerById = new Map(visibleMarkers.map((marker) => [marker.id, marker]));
  const halfLabelDurationMs = scale.msPerPixel * 104;
  const layout = layoutIntervalLanes(
    visibleMarkers.map((marker) => ({
      id: marker.id,
      startMs: marker.atMs - halfLabelDurationMs,
      endMs: marker.atMs + halfLabelDurationMs,
    })),
    maximumVisibleLanes,
  );
  const prioritizedOverflow = prioritizedMarkerId
    ? layout.placements.find(
        (placement) =>
          placement.aggregated &&
          placement.aggregatedIds.includes(prioritizedMarkerId),
      )
    : undefined;
  const displacedPlacement = prioritizedOverflow && prioritizedMarkerId
    ? layout.placements
        .filter((placement) => {
          if (placement.aggregated) return false;
          const marker = markerById.get(placement.id);
          const prioritized = markerById.get(prioritizedMarkerId);
          return Boolean(
            marker &&
              prioritized &&
              Math.abs(marker.atMs - prioritized.atMs) <
                halfLabelDurationMs * 2,
          );
        })
        .sort((left, right) => right.lane - left.lane)[0]
    : undefined;
  const placements = prioritizedOverflow && displacedPlacement && prioritizedMarkerId
    ? layout.placements.map((placement) => {
        if (placement.id === displacedPlacement.id) {
          const prioritized = markerById.get(prioritizedMarkerId);
          return prioritized
            ? {
                id: prioritized.id,
                startMs: prioritized.atMs - halfLabelDurationMs,
                endMs: prioritized.atMs + halfLabelDurationMs,
                lane: displacedPlacement.lane,
                aggregated: false,
                aggregatedIds: [],
              }
            : placement;
        }
        if (placement.id === prioritizedOverflow.id) {
          return {
            ...placement,
            aggregatedIds: [
              ...placement.aggregatedIds.filter(
                (id) => id !== prioritizedMarkerId,
              ),
              displacedPlacement.id,
            ],
          };
        }
        return placement;
      })
    : layout.placements;

  return placements.map((placement) => {
    if (placement.aggregated) {
      const aggregatedMarkers = placement.aggregatedIds.flatMap((id) => {
        const marker = markerById.get(id);
        return marker ? [marker] : [];
      });
      return aggregatedMarkers.length > 0 ? (
        <GlobalMarkerOverflow
          key={placement.id}
          markers={aggregatedMarkers}
          lane={placement.lane}
          scale={scale}
          onPrioritize={setPrioritizedMarkerId}
        />
      ) : null;
    }
    const marker = markerById.get(placement.id);
    return marker ? (
      <GlobalMarkerHandle
        key={marker.id}
        marker={marker}
        lane={placement.lane}
        scale={scale}
        interaction={interaction}
        showVisibleTime={showVisibleTime}
      />
    ) : null;
  });
}

function GlobalMarkerOverflow({
  markers,
  lane,
  scale,
  onPrioritize,
}: {
  markers: TimeCanvasGlobalMarker[];
  lane: number;
  scale: ReturnType<typeof createTimeScale>;
  onPrioritize: (markerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sorted = [...markers].sort(
    (left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id),
  );
  const representative = sorted[Math.floor(sorted.length / 2)];
  if (!representative) return null;
  const details = sorted
    .map((marker) => `${marker.label} · ${formatDateTime(marker.atMs)}`)
    .join("\n");
  const accessibleLabel = `${sorted.length} 个重叠关键时间点：${sorted
    .map((marker) => `${marker.label}，${formatDateTime(marker.atMs)}`)
    .join("；")}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="pointer-events-auto absolute z-20 flex h-5 -translate-x-1/2 items-center rounded-full border border-violet-200 bg-background px-2 text-[10px] font-medium text-violet-700 shadow-sm outline-none hover:border-violet-300 focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-violet-800 dark:text-violet-300"
            style={{
              left: timeToX(representative.atMs, scale),
              top: GLOBAL_MARKER_LABEL_TOP + lane * GLOBAL_MARKER_LANE_STRIDE,
            }}
            aria-label={accessibleLabel}
            title={details}
            data-testid="global-time-marker-overflow"
          >
            +{sorted.length} 个关键点
          </button>
        }
      />
      <DialogContent data-testid="global-time-marker-overflow-dialog">
        <DialogHeader>
          <DialogTitle>重叠关键时间点</DialogTitle>
          <DialogDescription>
            选择一个时间点在线上显示；管理员随后可直接拖动该时间点。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60dvh,24rem)] space-y-2 overflow-y-auto">
          {sorted.map((marker) => (
            <button
              key={marker.id}
              type="button"
              className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-violet-500"
              onClick={() => {
                onPrioritize(marker.id);
                setOpen(false);
              }}
              data-testid={`global-time-marker-overflow-item-${marker.id}`}
            >
              <span className="min-w-0 flex-1 truncate font-medium" title={marker.label}>
                {marker.label}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatCompactAnchorDate(marker.atMs, true)}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GlobalMarkerHandle({
  marker,
  lane,
  scale,
  interaction,
  showVisibleTime,
}: {
  marker: TimeCanvasGlobalMarker;
  lane: number;
  scale: ReturnType<typeof createTimeScale>;
  interaction: TimeCanvasInteractionOptions | undefined;
  showVisibleTime: boolean;
}) {
  const [move, setMove] = useState<{
    pointerId: number;
    clientX: number;
    scrollLeft: number;
    stageTop: number;
    stageBottom: number;
  } | null>(null);
  const [previewAtMs, setPreviewAtMs] = useState<number | null>(null);
  const displayedAtMs = previewAtMs ?? marker.atMs;
  const canMove = marker.editable && Boolean(interaction?.onGlobalMarkerMove);
  const markerClassName = cn(
    "absolute z-20 flex h-5 max-w-52 -translate-x-1/2 items-center gap-1.5 rounded-full border border-violet-200 bg-background px-2 text-[10px] shadow-sm outline-none transition-[box-shadow,opacity] dark:border-violet-800",
    canMove &&
      "pointer-events-auto touch-none cursor-grab hover:border-violet-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:border-violet-700",
    !canMove &&
      (showVisibleTime ? "pointer-events-none" : "pointer-events-auto cursor-help"),
    move && "cursor-grabbing border-violet-400 opacity-80 shadow-md",
  );
  const markerStyle = {
    left: timeToX(displayedAtMs, scale),
    top: GLOBAL_MARKER_LABEL_TOP + lane * GLOBAL_MARKER_LANE_STRIDE,
  };
  const markerTitle = `${marker.label} · ${formatDateTime(displayedAtMs)}`;
  const markerContent = (
    <>
      <span
        className="size-1.5 shrink-0 rounded-full bg-violet-500 ring-2 ring-violet-100 dark:ring-violet-950"
        aria-hidden="true"
      />
      <span className="max-w-28 truncate font-medium text-foreground">
        {marker.label}
      </span>
      {showVisibleTime && (
        <span className="shrink-0 text-muted-foreground">
          {formatCompactAnchorDate(displayedAtMs, true)}
        </span>
      )}
    </>
  );

  function commitKeyboardMove(direction: -1 | 1) {
    if (!canMove) return;
    const result = moveTimePoint({
      atMs: marker.atMs,
      rawDeltaMs: direction * scale.anchorSnapMs,
      snapMs: scale.anchorSnapMs,
      range: scale,
    });
    if (result.deltaMs === 0) {
      interaction?.onInvalidDrop?.("关键时间点已到当前范围边界，无法继续移动。");
      return;
    }
    interaction?.onGlobalMarkerMove?.({
      markerId: marker.id,
      kind: "KEYBOARD_MOVE",
      ...result,
      snapMs: scale.anchorSnapMs,
    });
  }

  if (!canMove) {
    return (
      <div
        className={markerClassName}
        style={markerStyle}
        role="img"
        aria-label={`关键时间点 ${marker.label}，${formatDateTime(displayedAtMs)}`}
        title={markerTitle}
        data-testid={`global-time-marker-${marker.id}`}
      >
        {markerContent}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={markerClassName}
      style={markerStyle}
      aria-label={`关键时间点 ${marker.label}，${formatDateTime(displayedAtMs)}，可拖动或按左右方向键移动`}
      title={markerTitle}
      onKeyDown={(event) => {
        if (!canMove || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        commitKeyboardMove(event.key === "ArrowLeft" ? -1 : 1);
      }}
      onPointerDown={(event) => {
        if (!canMove || event.button !== 0) return;
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        const stage = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-global-marker-stage']",
        );
        const stageRect = stage?.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setMove({
          pointerId: event.pointerId,
          clientX: event.clientX,
          scrollLeft: scroller?.scrollLeft ?? 0,
          stageTop: stageRect?.top ?? Number.NEGATIVE_INFINITY,
          stageBottom: stageRect?.bottom ?? Number.POSITIVE_INFINITY,
        });
        setPreviewAtMs(marker.atMs);
      }}
      onPointerMove={(event) => {
        if (!move || move.pointerId !== event.pointerId) return;
        const scroller = event.currentTarget.closest<HTMLElement>(
          "[data-testid='time-canvas-scroll']",
        );
        if (scroller) edgeScrollCanvas(scroller, event.clientX);
        const scrollDelta = (scroller?.scrollLeft ?? 0) - move.scrollLeft;
        const rawDeltaMs =
          (event.clientX - move.clientX + scrollDelta) * scale.msPerPixel;
        const result = moveTimePoint({
          atMs: marker.atMs,
          rawDeltaMs,
          snapMs: scale.anchorSnapMs,
          range: scale,
        });
        setPreviewAtMs(result.atMs);
      }}
      onPointerCancel={() => {
        setMove(null);
        setPreviewAtMs(null);
      }}
      onLostPointerCapture={() => {
        setMove(null);
        setPreviewAtMs(null);
      }}
      onPointerUp={(event) => {
        if (!move || move.pointerId !== event.pointerId) return;
        const result = previewAtMs;
        const droppedOutsideStage =
          event.clientY < move.stageTop || event.clientY >= move.stageBottom;
        setMove(null);
        setPreviewAtMs(null);
        if (droppedOutsideStage) {
          interaction?.onInvalidDrop?.("请在关键时间点区域内完成拖动。");
          return;
        }
        if (result !== null && result !== marker.atMs) {
          interaction?.onGlobalMarkerMove?.({
            markerId: marker.id,
            kind: "MOVE",
            atMs: result,
            deltaMs: result - marker.atMs,
            snapMs: scale.anchorSnapMs,
          });
        }
      }}
      data-canvas-object
      data-testid={`global-time-marker-${marker.id}`}
    >
      {markerContent}
    </button>
  );
}

function GlobalMarkerLines({
  markers,
  scale,
}: {
  markers: TimeCanvasGlobalMarker[];
  scale: ReturnType<typeof createTimeScale>;
}) {
  return markers.map((marker) => {
    if (marker.atMs < scale.startMs || marker.atMs >= scale.endMs) return null;
    return (
      <span
        key={marker.id}
        className="pointer-events-none absolute inset-y-0 z-[6] w-px bg-violet-400/60 dark:bg-violet-500/55"
        style={{ left: timeToX(marker.atMs, scale) }}
        aria-hidden="true"
        data-testid={`global-time-marker-line-${marker.id}`}
      />
    );
  });
}
