"use client";

import Link from "next/link";
import { forwardRef } from "react";
import { Lock } from "lucide-react";
import { createTimeScale, timeToX } from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasProps,
  TimeCanvasRow,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatCanvasTick as formatTick,
  formatCanvasAxisGroup as formatAxisGroup,
  formatCanvasDateTime,
} from "@/components/project-management/time-canvas/time-format";
import { AXIS_HEIGHT } from "@/components/project-management/time-canvas/time-canvas-layout";
import { TodayLine } from "@/components/project-management/time-canvas/time-canvas-layers";

const zoomOrder: TimeCanvasZoom[] = ["WEEK", "MONTH", "QUARTER", "YEAR"];
const zoomLabels: Record<TimeCanvasZoom, string> = {
  WEEK: "周",
  MONTH: "月",
  QUARTER: "季",
  YEAR: "年",
};

export function TimeCanvasToolbar({
  presentation,
  zoom,
  canGoToday,
  onToday,
  onZoomChange,
}: {
  presentation: TimeCanvasProps["presentation"];
  zoom: TimeCanvasZoom;
  canGoToday: boolean;
  onToday: () => void;
  onZoomChange: (zoom: TimeCanvasZoom) => void;
}) {
  if (presentation === "COMPACT") return null;
  return (
    <div className="flex min-h-12 min-w-0 flex-wrap items-center justify-end gap-2 border-b border-border bg-card px-3 py-2" data-testid="time-canvas-toolbar">
      <div className="flex items-center overflow-hidden rounded-md border border-border" aria-label="显示尺度">
        {zoomOrder.map((item) => (
          <Button
            key={item}
            type="button"
            size="sm"
            variant={zoom === item ? "secondary" : "ghost"}
            className="rounded-none px-3"
            aria-label={zoomLabels[item]}
            aria-pressed={zoom === item}
            onClick={() => onZoomChange(item)}
          >
            {zoomLabels[item]}
          </Button>
        ))}
      </div>
      <span
        className="inline-flex"
        title={canGoToday ? undefined : "今天不在当前时间范围内"}
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onToday}
          disabled={!canGoToday}
          aria-label={canGoToday ? "今天" : "今天（不在当前时间范围内）"}
        >
          今天
        </Button>
      </span>
    </div>
  );
}
export function TimeAxis({
  ticks,
  scale,
  zoom,
  timezone,
  nowMs,
  rowHeaderWidth,
  leadingLabel,
}: {
  ticks: number[];
  scale: ReturnType<typeof createTimeScale>;
  zoom: TimeCanvasZoom;
  timezone: string;
  nowMs: number;
  rowHeaderWidth: number;
  leadingLabel: string;
}) {
  const inRangeTicks = ticks.filter((tick) => tick >= scale.startMs && tick < scale.endMs);
  const boundaryOnly = inRangeTicks.length === 0;
  const displayedTicks = boundaryOnly ? [scale.startMs] : inRangeTicks;
  const minorLabelStep = Math.max(
    1,
    Math.ceil(48 / Math.max(1, tickPixelDistance(ticks, scale))),
  );
  return (
    <div
      className="sticky top-0 z-30 grid border-b border-border bg-background/95 backdrop-blur"
      style={{
        height: AXIS_HEIGHT,
        gridTemplateColumns: `${rowHeaderWidth}px ${scale.contentWidthPx}px`,
      }}
    >
      <div className="sticky left-0 z-40 flex min-w-0 items-center border-r border-border bg-background px-3 text-xs font-medium text-muted-foreground">
        <span className="truncate">{leadingLabel}</span>
      </div>
      <div className="relative overflow-hidden" aria-label={`${timezone} ${zoomLabels[zoom]}级时间轴`} role="img">
        {displayedTicks.map((tick, index) => {
          const group = formatAxisGroup(tick, zoom);
          const previousGroup = index > 0 ? formatAxisGroup(displayedTicks[index - 1] ?? tick, zoom) : null;
          return (
          <div
            key={tick}
            className="absolute inset-y-0 border-l border-border/80"
            style={{ left: timeToX(tick, scale) }}
          >
            {group !== previousGroup && (
              <span className="absolute left-1 top-1 whitespace-nowrap text-[11px] font-medium text-foreground">
                {group}
              </span>
            )}
            {index % minorLabelStep === 0 && (
              <span className="absolute left-1 top-8 whitespace-nowrap text-[11px] text-muted-foreground">
                {boundaryOnly ? formatCanvasDateTime(tick) : formatTick(tick, zoom)}
              </span>
            )}
          </div>
          );
        })}
        <TodayLine scale={scale} nowMs={nowMs} axis />
      </div>
    </div>
  );
}

export const TimeCanvasBottomScrollbar = forwardRef<
  HTMLDivElement,
  {
    hidden: boolean;
    rowHeaderWidth: number;
    contentWidthPx: number;
    onScroll: (left: number) => void;
  }
>(function TimeCanvasBottomScrollbar(
  { hidden, rowHeaderWidth, contentWidthPx, onScroll },
  ref,
) {
  if (hidden) return null;
  return (
    <div
      className="sticky bottom-0 z-40 grid h-4 border-t border-border bg-background"
      style={{ gridTemplateColumns: `${rowHeaderWidth}px minmax(0,1fr)` }}
      data-testid="time-canvas-bottom-scrollbar"
    >
      <div className="border-r border-border bg-card" aria-hidden="true" />
      <div
        ref={ref}
        className="overflow-x-auto overflow-y-hidden"
        tabIndex={0}
        aria-label="时间轴横向滚动"
        onScroll={(event) => onScroll(event.currentTarget.scrollLeft)}
      >
        <div style={{ width: contentWidthPx, height: 1 }} />
      </div>
    </div>
  );
});

export function RowHeader({
  row,
  onNavigate,
}: {
  row: TimeCanvasRow;
  onNavigate?: (row: TimeCanvasRow) => boolean;
}) {
  return (
    <div
      className="sticky left-0 z-[25] flex min-w-0 flex-col justify-center border-r border-border bg-card px-3"
      data-testid={`time-canvas-row-header-${row.id}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {row.href ? (
          <Link
            href={row.href}
            prefetch={false}
            className="min-w-0 flex-1 truncate rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={row.label}
            onClick={(event) => {
              if (onNavigate?.(row) === false) event.preventDefault();
            }}
          >
            {row.label}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.label}>
            {row.label}
          </span>
        )}
        {row.editable ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">可编辑</Badge>
        ) : (
          <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="只读" />
        )}
      </div>
      {row.sublabel && (
        <p className="mt-1 truncate text-xs text-muted-foreground" title={row.sublabel}>
          {row.sublabel}
        </p>
      )}
    </div>
  );
}
function tickPixelDistance(
  ticks: number[],
  scale: ReturnType<typeof createTimeScale>,
) {
  if (ticks.length < 2) return scale.viewportWidthPx;
  return Math.abs(
    timeToX(ticks[1] ?? ticks[0] ?? 0, scale) -
      timeToX(ticks[0] ?? 0, scale),
  );
}
