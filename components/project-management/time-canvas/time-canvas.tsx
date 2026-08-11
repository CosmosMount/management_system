"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  Circle,
  Diamond,
  Flag,
  GitBranch,
  Lock,
  X,
} from "lucide-react";
import {
  DAY_MS,
  axisTicks,
  createTimeScale,
  intervalToRect,
  moveTimePoint,
  rangesIntersect,
  snapTime,
  snapTimeInRange,
  scrollLeftForCenter,
  timeToX,
  viewportCenterTime,
  visibleTimeWindow,
  xToTime,
} from "@/components/project-management/time-canvas/time-math";
import { layoutIntervalLanes, layoutPointLanes } from "@/components/project-management/time-canvas/lane-layout";
import {
  buildPlanPhaseBands,
  findPhaseEndpointAnchor,
} from "@/components/project-management/time-canvas/plan-phase-bands";
import type {
  TimeCanvasAnchor,
  TimeCanvasAnchorMoveRequest,
  TimeCanvasAnchorMoveResolution,
  TimeCanvasBrushRequest,
  TimeCanvasDisplayOptions,
  TimeCanvasInteractionOptions,
  TimeCanvasPhaseBand,
  TimeCanvasProps,
  TimeCanvasRange,
  TimeCanvasRow,
  TimeCanvasSegment,
  TimeCanvasSelection,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatCanvasDateTime as formatDateTime,
  formatCanvasRange as formatRange,
  formatCanvasTick as formatTick,
  formatCanvasAxisGroup as formatAxisGroup,
  formatCompactAnchorDate,
  isShanghaiWeekend,
} from "@/components/project-management/time-canvas/time-format";

const AXIS_HEIGHT = 64;
const PLAN_RAIL_TOP = 28;
const DEFAULT_ZOOM: TimeCanvasZoom = "WEEK";
const zoomOrder: TimeCanvasZoom[] = ["WEEK", "MONTH", "QUARTER", "YEAR"];
const zoomLabels: Record<TimeCanvasZoom, string> = {
  WEEK: "周",
  MONTH: "月",
  QUARTER: "季",
  YEAR: "年",
};

export function TimeCanvas({
  mode,
  model,
  presentation = "FULL",
  initialZoom,
  initialCenterMs,
  display: displayInput,
  interaction,
  selection: controlledSelection,
  initialSelection = null,
  emptyMessage = "选择人员或 Task 后查看计划",
  onRangeChange,
  navigationRange,
  onRequestCenter,
  onViewportChange,
  onZoomChange,
  onSelectionChange,
}: TimeCanvasProps) {
  const display: Required<TimeCanvasDisplayOptions> = {
    showActual: displayInput?.showActual ?? true,
    showBusy: displayInput?.showBusy ?? true,
    showInspector: displayInput?.showInspector ?? true,
  };
  const [zoom, setZoom] = useState<TimeCanvasZoom>(initialZoom ?? DEFAULT_ZOOM);
  const [internalSelection, setInternalSelection] =
    useState<TimeCanvasSelection>(initialSelection);
  const appliedInitialSelectionKeyRef = useRef<string | null>(null);
  const selection = controlledSelection === undefined
    ? internalSelection
    : controlledSelection;
  const [scrollState, setScrollState] = useState({ left: 0, width: 900 });
  const [rowHeaderWidth, setRowHeaderWidth] = useState(240);
  const [activeFocusKey, setActiveFocusKey] = useState<string | null>(null);
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null);
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const bottomScrollbarRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const layoutScrollLeftRef = useRef<number | null>(null);
  const viewportChangeSourceRef = useRef<"LAYOUT" | "USER">("LAYOUT");
  const viewportCenterRef = useRef<number | null>(
    Number.isFinite(initialCenterMs) ? (initialCenterMs ?? null) : null,
  );
  const externalCenterRef = useRef(initialCenterMs);
  const externalZoomRef = useRef(initialZoom);
  const scaleLayoutKeyRef = useRef("");
  const filteredSegments = useMemo(
    () =>
      model.segments.filter(
        (segment) =>
          (display.showActual || segment.type !== "ACTUAL") &&
          (display.showBusy || segment.type !== "BUSY"),
      ),
    [display.showActual, display.showBusy, model.segments],
  );
  const segmentsByRow = useMemo(
    () => groupByRow(filteredSegments),
    [filteredSegments],
  );
  const anchorsByRow = useMemo(() => groupByRow(model.anchors), [model.anchors]);
  const phaseBandsByRow = useMemo(
    () => groupByRow(model.phaseBands ?? []),
    [model.phaseBands],
  );
  const liveNowMs = useLiveNow(model.generatedAt);
  const focusTargets = useMemo(
    () =>
      buildCanvasFocusTargets(model, filteredSegments),
    [filteredSegments, model],
  );
  const currentFocusKey =
    activeFocusKey && focusTargets.some((target) => target.key === activeFocusKey)
      ? activeFocusKey
      : (focusTargets[0]?.key ?? null);

  const scale = useMemo(
    () =>
      createTimeScale({
        range: model.range,
        viewportWidthPx: scrollState.width,
        zoom,
      }),
    [model.range, scrollState.width, zoom],
  );
  const visibleWindow = useMemo(
    () =>
      visibleTimeWindow({
        scale,
        scrollLeftPx: scrollState.left,
        viewportWidthPx: scrollState.width,
      }),
    [scale, scrollState],
  );
  const viewportWindow = useMemo(
    () =>
      visibleTimeWindow({
        scale,
        scrollLeftPx: scrollState.left,
        viewportWidthPx: scrollState.width,
        overscanPx: 0,
      }),
    [scale, scrollState],
  );
  const ticks = useMemo(
    () => axisTicks({ window: visibleWindow, zoom }),
    [visibleWindow, zoom],
  );
  const dayStripes = useMemo(
    () => axisTicks({ window: visibleWindow, zoom: "WEEK" }),
    [visibleWindow],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the frozen S3 headless virtualizer; row inputs and keys remain explicit and stable.
  const rowVirtualizer = useVirtualizer({
    count: model.rows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => model.rows[index]?.height ?? 48,
    getItemKey: (index) => model.rows[index]?.id ?? index,
    scrollMargin: AXIS_HEIGHT,
    // A creation draft can cross rows while the pointer is captured. Keeping
    // the bounded current row page mounted prevents virtualization from
    // discarding the active drag state when vertical edge scrolling.
    overscan: interaction?.creationRange ? model.rows.length : 6,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualRowSignature = virtualRows
    .map((virtualRow) => `${virtualRow.key}:${virtualRow.start}`)
    .join("|");

  useEffect(() => {
    if (!initialSelection) {
      appliedInitialSelectionKeyRef.current = null;
      return;
    }
    const key = initialSelection.kind === "SEGMENT"
      ? segmentFocusKey(initialSelection.id)
      : anchorFocusKey(initialSelection.id);
    if (appliedInitialSelectionKeyRef.current === key) return;
    const target = focusTargets.find((item) => item.key === key);
    if (!target) return;
    appliedInitialSelectionKeyRef.current = key;
    viewportCenterRef.current = target.atMs;
    setActiveFocusKey(key);
    setPendingFocusKey(key);
    rowVirtualizer.scrollToIndex(target.rowIndex, { align: "center" });
    const element = scrollElementRef.current;
    if (element) {
      element.scrollLeft = scrollLeftForCenter(scale, target.atMs, scrollState.width);
    }
  }, [focusTargets, initialSelection, rowVirtualizer, scale, scrollState.width]);

  useEffect(() => {
    if (Object.is(externalCenterRef.current, initialCenterMs)) return;
    externalCenterRef.current = initialCenterMs;
    viewportCenterRef.current = Number.isFinite(initialCenterMs)
      ? (initialCenterMs ?? null)
      : null;
  }, [initialCenterMs]);

  useEffect(() => {
    if (externalZoomRef.current === initialZoom) return;
    externalZoomRef.current = initialZoom;
    const nextZoom = initialZoom ?? DEFAULT_ZOOM;
    setZoom(nextZoom);
    onZoomChange?.(nextZoom);
  }, [initialZoom, onZoomChange]);

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!element) return;
    const updateWidth = () => {
      const nextHeaderWidth = responsiveRowHeaderWidth(element.clientWidth);
      const nextViewportWidth = Math.max(1, element.clientWidth - nextHeaderWidth);
      setRowHeaderWidth(nextHeaderWidth);
      setScrollState((current) => ({
        ...current,
        width: nextViewportWidth,
      }));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!element) return;
    const measuredHeaderWidth = responsiveRowHeaderWidth(element.clientWidth);
    const measuredViewportWidth = Math.max(
      1,
      element.clientWidth - measuredHeaderWidth,
    );
    if (
      measuredHeaderWidth !== rowHeaderWidth ||
      Math.abs(measuredViewportWidth - scrollState.width) > 1
    ) {
      return;
    }
    const layoutKey = `${model.range.startMs}:${model.range.endMs}:${zoom}:${scrollState.width}:${initialCenterMs ?? "auto"}`;
    if (scaleLayoutKeyRef.current === layoutKey) return;
    scaleLayoutKeyRef.current = layoutKey;
    const fallbackCenter = liveNowMs >= model.range.startMs && liveNowMs < model.range.endMs
      ? liveNowMs
      : model.range.startMs;
    const center = Math.max(
      model.range.startMs,
      Math.min(viewportCenterRef.current ?? fallbackCenter, model.range.endMs - 1),
    );
    const left = scrollLeftForCenter(scale, center, scrollState.width);
    layoutScrollLeftRef.current = left;
    viewportChangeSourceRef.current = "LAYOUT";
    element.scrollLeft = left;
    const effectiveLeft = element.scrollLeft;
    if (bottomScrollbarRef.current) {
      bottomScrollbarRef.current.scrollLeft = effectiveLeft;
    }
    setScrollState((current) => ({ ...current, left: effectiveLeft }));
    onViewportChange?.(
      visibleTimeWindow({
        scale,
        scrollLeftPx: effectiveLeft,
        viewportWidthPx: scrollState.width,
        overscanPx: 0,
      }),
      "LAYOUT",
    );
  }, [
    liveNowMs,
    initialCenterMs,
    model.range,
    onViewportChange,
    rowHeaderWidth,
    scale,
    scrollState.width,
    zoom,
  ]);

  useEffect(() => {
    const source = viewportChangeSourceRef.current;
    viewportChangeSourceRef.current = "LAYOUT";
    onViewportChange?.(
      visibleTimeWindow({
        scale,
        scrollLeftPx: scrollState.left,
        viewportWidthPx: scrollState.width,
        overscanPx: 0,
      }),
      source,
    );
  }, [onViewportChange, scale, scrollState.left, scrollState.width]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!pendingFocusKey) return;
    const frame = requestAnimationFrame(() => {
      const root = scrollElementRef.current?.closest<HTMLElement>(
        "[data-testid='time-canvas-root']",
      );
      const target = root
        ? [...root.querySelectorAll<HTMLElement>("[data-canvas-object-key]")].find(
            (element) => element.dataset.canvasObjectKey === pendingFocusKey,
          )
        : null;
      if (!target) return;
      target.focus({ preventScroll: true });
      setPendingFocusKey(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocusKey, scrollState.left, virtualRowSignature]);

  const select = useCallback(
    (next: TimeCanvasSelection) => {
      if (controlledSelection === undefined) {
        setInternalSelection(next);
      }
      interaction?.onAnchorSelectionChange?.(
        next?.kind === "ANCHOR" ? next.id : null,
      );
      onSelectionChange?.(next);
    },
    [controlledSelection, interaction, onSelectionChange],
  );

  const scrollToToday = useCallback(() => {
    const now = liveNowMs;
    if (now < model.range.startMs || now >= model.range.endMs) {
      if (
        onRequestCenter &&
        navigationRange &&
        now >= navigationRange.startMs &&
        now < navigationRange.endMs
      ) {
        onRequestCenter(now);
        return;
      }
      if (onRangeChange) {
        const duration = model.range.endMs - model.range.startMs;
        onRangeChange({ startMs: now - duration / 2, endMs: now + duration / 2 });
      }
      return;
    }
    const element = scrollElementRef.current;
    if (!element) return;
    viewportCenterRef.current = now;
    element.scrollTo({
      left: scrollLeftForCenter(scale, now, scrollState.width),
      behavior: "auto",
    });
  }, [
    liveNowMs,
    model.range,
    navigationRange,
    onRangeChange,
    onRequestCenter,
    scale,
    scrollState.width,
  ]);

  const changeZoom = useCallback((nextZoom: TimeCanvasZoom) => {
    const element = scrollElementRef.current;
    if (element) {
      viewportCenterRef.current = viewportCenterTime(scale, element.scrollLeft, scrollState.width);
    }
    setZoom(nextZoom);
    onZoomChange?.(nextZoom);
  }, [onZoomChange, scale, scrollState.width]);

  const handleKeyboard = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches("input, textarea, select")) return;
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        scrollToToday();
        return;
      }
      const focusKey = target.dataset.canvasObjectKey;
      if (!focusKey) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        return;
      }
      const current = focusTargets.find((item) => item.key === focusKey);
      if (!current) return;
      event.preventDefault();
      const next = nextFocusTarget(focusTargets, current, event.key);
      if (!next) return;
      setActiveFocusKey(next.key);
      setPendingFocusKey(next.key);
      rowVirtualizer.scrollToIndex(next.rowIndex, { align: "auto" });
      const element = scrollElementRef.current;
      if (element) {
        const targetX = timeToX(next.atMs, scale);
        const visibleLeft = element.scrollLeft;
        const visibleRight = visibleLeft + scrollState.width;
        if (targetX < visibleLeft || targetX > visibleRight) {
          element.scrollTo({
            left: Math.max(0, targetX - scrollState.width / 2),
            behavior: "auto",
          });
        }
      }
    },
    [focusTargets, rowVirtualizer, scale, scrollState.width, scrollToToday],
  );

  const selectedEntity = resolveSelection(model, selection);
  return (
    <section
      className="min-w-0 max-w-full"
      aria-label="时间画布"
      data-mode={mode}
      data-zoom={zoom}
      data-range-start-ms={model.range.startMs}
      data-range-end-ms={model.range.endMs}
      data-loaded-ranges={model.loadedRanges
        ?.map((range) => `${range.startMs}:${range.endMs}`)
        .join("|")}
      data-testid="time-canvas-root"
      onKeyDown={handleKeyboard}
    >
      <TimeCanvasToolbar
        presentation={presentation}
        zoom={zoom}
        canGoToday={
          liveNowMs >= (navigationRange?.startMs ?? model.range.startMs) &&
          liveNowMs < (navigationRange?.endMs ?? model.range.endMs)
        }
        onToday={scrollToToday}
        onZoomChange={changeZoom}
      />

      <div
        className={cn(
          "min-w-0 gap-0 md:grid",
          display.showInspector && selectedEntity
            ? "md:grid-cols-[minmax(0,1fr)_20rem]"
            : "md:grid-cols-1",
        )}
      >
        <div className="min-w-0">
          <div
            ref={scrollElementRef}
            className="relative max-h-[min(68dvh,44rem)] min-h-72 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain"
            data-testid="time-canvas-scroll"
            onScroll={(event) => {
              const element = event.currentTarget;
              if (animationFrameRef.current !== null) return;
                animationFrameRef.current = requestAnimationFrame(() => {
                  animationFrameRef.current = null;
                  const left = element.scrollLeft;
                  const layoutLeft = layoutScrollLeftRef.current;
                  layoutScrollLeftRef.current = null;
                  const source = layoutLeft === null || Math.abs(layoutLeft - left) > 1
                    ? "USER"
                    : "LAYOUT";
                  viewportChangeSourceRef.current = source;
                  if (source === "USER") {
                    viewportCenterRef.current = viewportCenterTime(
                      scale,
                      left,
                      scrollState.width,
                    );
                  }
                  if (bottomScrollbarRef.current && bottomScrollbarRef.current.scrollLeft !== left) {
                  bottomScrollbarRef.current.scrollLeft = left;
                }
                setScrollState((current) => ({ ...current, left }));
              });
            }}
          >
            <div
              className="relative min-w-full"
              style={{ width: rowHeaderWidth + scale.contentWidthPx }}
            >
              <TimeAxis
                ticks={ticks}
                scale={scale}
                zoom={zoom}
                timezone={model.timezone}
                nowMs={liveNowMs}
                rowHeaderWidth={rowHeaderWidth}
              />

              {model.rows.length === 0 ? (
                <div
                  className="sticky left-0 flex min-h-64 w-[calc(100vw-2rem)] max-w-full items-center justify-center p-8 text-center text-sm text-muted-foreground"
                  data-testid="time-canvas-empty"
                >
                  {emptyMessage}
                </div>
              ) : (
                <div
                  className="relative"
                  style={{ height: rowVirtualizer.getTotalSize() }}
                  data-testid="time-canvas-rows"
                >
                  {virtualRows.map((virtualRow) => {
                    const row = model.rows[virtualRow.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.id}
                        className="absolute left-0 top-0 grid border-b border-border/70"
                        style={{
                          width: rowHeaderWidth + scale.contentWidthPx,
                          height: virtualRow.size,
                          gridTemplateColumns: `${rowHeaderWidth}px ${scale.contentWidthPx}px`,
                          transform: `translateY(${virtualRow.start - AXIS_HEIGHT}px)`,
                        }}
                        data-testid={`timeline-row-${row.id}`}
                      >
                        <RowHeader row={row} />
                        <TimelineRow
                          mode={mode}
                          row={row}
                          scale={scale}
                          visibleWindow={visibleWindow}
                          viewportWindow={viewportWindow}
                          dayStripes={dayStripes}
                          segments={segmentsByRow.get(row.id) ?? []}
                          anchors={anchorsByRow.get(row.id) ?? []}
                          phaseBands={phaseBandsByRow.get(row.id) ?? []}
                          nowMs={liveNowMs}
                          selection={selection}
                          activeFocusKey={currentFocusKey}
                          interaction={interaction}
                          creationRows={model.rows
                            .filter((candidate) => candidate.kind === "PERSON" && candidate.editable)
                            .map((candidate) => ({
                              id: candidate.id,
                              sourceId: candidate.sourceId,
                              label: candidate.label,
                            }))}
                          onSelect={select}
                          onObjectFocus={setActiveFocusKey}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <TimeCanvasBottomScrollbar
            ref={bottomScrollbarRef}
            hidden={scale.contentWidthPx <= scrollState.width}
            rowHeaderWidth={rowHeaderWidth}
            contentWidthPx={scale.contentWidthPx}
            onScroll={(left) => {
              const element = scrollElementRef.current;
              if (!element || element.scrollLeft === left) return;
              element.scrollLeft = left;
            }}
          />
        </div>

        {display.showInspector && selectedEntity && (
          <TimeCanvasInspector entity={selectedEntity} onClose={() => select(null)} />
        )}
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {selectedEntity ? selectionAnnouncement(selectedEntity) : "未选择时间对象"}
      </div>
    </section>
  );
}

function useLiveNow(generatedAt: string) {
  const [nowMs, setNowMs] = useState(() => {
    const generatedAtMs = Date.parse(generatedAt);
    return Number.isFinite(generatedAtMs) ? generatedAtMs : 0;
  });

  useEffect(() => {
    const refresh = () => setNowMs(Date.now());
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  return nowMs;
}

function TimeCanvasToolbar({
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

function TimeAxis({
  ticks,
  scale,
  zoom,
  timezone,
  nowMs,
  rowHeaderWidth,
}: {
  ticks: number[];
  scale: ReturnType<typeof createTimeScale>;
  zoom: TimeCanvasZoom;
  timezone: string;
  nowMs: number;
  rowHeaderWidth: number;
}) {
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
        <span className="truncate">任务 / 人员</span>
      </div>
      <div className="relative overflow-hidden" aria-label={`${timezone} ${zoomLabels[zoom]}级时间轴`} role="img">
        {ticks.map((tick, index) => {
          const group = formatAxisGroup(tick, zoom);
          const previousGroup = index > 0 ? formatAxisGroup(ticks[index - 1] ?? tick, zoom) : null;
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
                {formatTick(tick, zoom)}
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

const TimeCanvasBottomScrollbar = forwardRef<
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

function RowHeader({ row }: { row: TimeCanvasRow }) {
  return (
    <div
      className="sticky left-0 z-[25] flex min-w-0 flex-col justify-center border-r border-border bg-card px-3"
      data-testid={`time-canvas-row-header-${row.id}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.label}>
          {row.label}
        </span>
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

function TimelineRow({
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
  const brushRef = useRef<ActiveBrush | null>(null);
  const [brush, setBrush] = useState<ActiveBrush | null>(null);
  const [anchorPreview, setAnchorPreview] = useState<{
    anchorId: string;
    atMs: number;
  } | null>(null);
  const previewAnchors = anchorPreview
    ? anchors.map((anchor) =>
        anchor.id === anchorPreview.anchorId
          ? { ...anchor, atMs: anchorPreview.atMs }
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
      anchor.id === anchorPreview?.anchorId ||
      (anchor.atMs >= visibleWindow.startMs && anchor.atMs < visibleWindow.endMs),
  );
  const anchorLanes = layoutPointLanes(
    visibleAnchors.map((anchor) => ({
      id: anchor.id,
      atMs:
        anchor.id === anchorPreview?.anchorId
          ? anchorPreview.atMs
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
        "data-[creation-drop-state=valid]:bg-emerald-50/70 data-[creation-drop-state=valid]:ring-2 data-[creation-drop-state=valid]:ring-inset data-[creation-drop-state=valid]:ring-emerald-500",
        "data-[creation-drop-state=invalid]:bg-destructive/10 data-[creation-drop-state=invalid]:ring-2 data-[creation-drop-state=invalid]:ring-inset data-[creation-drop-state=invalid]:ring-destructive",
      )}
      data-canvas-row={row.id}
      data-canvas-row-source={row.sourceId}
      data-canvas-row-kind={row.kind}
      data-anchor-preview={anchorPreview?.anchorId ?? ""}
      aria-label={`${row.label} 时间行`}
      onPointerDown={(event) => {
        const target = event.target;
        if (
          !canBrush ||
          event.button !== 0 ||
          (target instanceof Element && target.closest("[data-canvas-object]"))
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
        const activeBrush = brushRef.current;
        if (!activeBrush || activeBrush.pointerId !== event.pointerId) return;
        const currentMs = pointerTime(event);
        const nextBrush = { ...activeBrush, currentMs };
        brushRef.current = nextBrush;
        setBrush(nextBrush);
      }}
      onPointerCancel={(event) => {
        if (brushRef.current?.pointerId !== event.pointerId) return;
        brushRef.current = null;
        setBrush(null);
      }}
      onLostPointerCapture={(event) => {
        if (brushRef.current?.pointerId !== event.pointerId) return;
        brushRef.current = null;
        setBrush(null);
      }}
      onPointerUp={(event) => {
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
            multiSelected={Boolean(
              interaction?.selectedSegmentIds?.has(segment.id),
            )}
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
          activeFocusKey={activeFocusKey}
          interaction={interaction}
          onSelect={onSelect}
          onObjectFocus={onObjectFocus}
          onPreviewChange={(anchorId, atMs) =>
            setAnchorPreview(atMs === null ? null : { anchorId, atMs })
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

function TimeGrid({
  dayStripes,
  scale,
}: {
  dayStripes: number[];
  scale: ReturnType<typeof createTimeScale>;
}) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {dayStripes.map((day) => {
        const next = day + DAY_MS;
        const rect = intervalToRect(day, next, scale);
        const weekend = isShanghaiWeekend(day);
        return (
          <span
            key={day}
            className={cn(
              "absolute inset-y-0 border-l border-border/50",
              weekend && "bg-muted/35",
            )}
            style={{ left: rect.left, width: rect.width }}
          />
        );
      })}
    </div>
  );
}

function PlanRail({
  anchors,
  phaseBands,
  viewportWindow,
  scale,
  rowId,
  selectedAnchorId,
  onSelectAnchor,
}: {
  anchors: TimeCanvasAnchor[];
  phaseBands: TimeCanvasPhaseBand[];
  viewportWindow: { startMs: number; endMs: number };
  scale: ReturnType<typeof createTimeScale>;
  rowId: string;
  selectedAnchorId: string | null;
  onSelectAnchor: (anchorId: string) => void;
}) {
  if (phaseBands.length > 0) {
    return (
      <PhaseBands
        bands={phaseBands}
        viewportWindow={viewportWindow}
        scale={scale}
        rowId={rowId}
        anchors={anchors}
        selectedAnchorId={selectedAnchorId}
        onSelectAnchor={onSelectAnchor}
      />
    );
  }
  const sorted = [...anchors].sort(
    (left, right) =>
      left.atMs - right.atMs ||
      left.sequence - right.sequence ||
      left.id.localeCompare(right.id),
  );
  const generatedBands = buildPlanPhaseBands(sorted, rowId);
  return (
    <PhaseBands
      bands={generatedBands}
      viewportWindow={viewportWindow}
      scale={scale}
      rowId={rowId}
      anchors={sorted}
      selectedAnchorId={selectedAnchorId}
      onSelectAnchor={onSelectAnchor}
    />
  );
}

function PhaseBands({
  bands,
  viewportWindow,
  scale,
  rowId,
  anchors,
  selectedAnchorId,
  onSelectAnchor,
}: {
  bands: TimeCanvasPhaseBand[];
  viewportWindow: { startMs: number; endMs: number };
  scale: ReturnType<typeof createTimeScale>;
  rowId: string;
  anchors: TimeCanvasAnchor[];
  selectedAnchorId: string | null;
  onSelectAnchor: (anchorId: string) => void;
}) {
  const visibleBands = bands.filter(
    (band) =>
      band.endMs > band.startMs && rangesIntersect(band, viewportWindow),
  );
  if (visibleBands.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      data-testid={`phase-bands-${rowId}`}
    >
      {visibleBands.map((band) => {
        const rect = intervalToRect(
          Math.max(band.startMs, viewportWindow.startMs),
          Math.min(band.endMs, viewportWindow.endMs),
          scale,
        );
        const endpointAnchor = findPhaseEndpointAnchor(anchors, band.endMs);
        const selected = endpointAnchor?.id === selectedAnchorId;
        return (
          <button
            type="button"
            key={band.id}
            className={cn(
              "pointer-events-auto absolute flex h-5 min-w-px items-center justify-center overflow-hidden rounded border px-1.5 text-center text-[10px] font-medium",
              phaseBandToneClassName(band.tone),
              band.visualState === "TEMPORARY" &&
                "border-dashed border-amber-500 bg-amber-100/80 text-amber-950 dark:bg-amber-950/50 dark:text-amber-100",
              selected && "ring-2 ring-inset ring-primary shadow-sm",
            )}
            style={{ left: rect.left, width: rect.width, top: PLAN_RAIL_TOP }}
            aria-label={`阶段 ${band.label}，${formatRange(band.startMs, band.endMs)}`}
            aria-pressed={selected}
            title={`${band.label} · ${formatRange(band.startMs, band.endMs)}`}
            data-testid={`phase-band-${band.id}`}
            data-phase-selected={selected ? "true" : "false"}
            disabled={!endpointAnchor}
            onClick={(event) => {
              event.stopPropagation();
              if (endpointAnchor) onSelectAnchor(endpointAnchor.id);
            }}
          >
            <span className="truncate">
              {band.visualState === "TEMPORARY" ? `临时 · ${band.label}` : band.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SegmentBlock({
  segment,
  lane,
  scale,
  selected,
  activeFocusKey,
  multiSelected,
  interaction,
  onSelect,
  onObjectFocus,
}: {
  segment: TimeCanvasSegment;
  lane: number;
  scale: ReturnType<typeof createTimeScale>;
  selected: boolean;
  activeFocusKey: string | null;
  multiSelected: boolean;
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
    if (!onSegmentTransform || !directSegmentTransformAllowed(interaction)) return;
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
        interaction?.desktopOnlySegmentTransform ? "sm:touch-none" : "touch-none",
        segment.type === "PLANNED" &&
          "border border-dashed border-sky-500/70 bg-sky-100/90 text-sky-950 dark:bg-sky-950/60 dark:text-sky-50",
        segment.type === "ACTUAL" &&
          "border border-emerald-600 bg-emerald-600 text-white",
        segment.type === "BUSY" &&
          "border border-slate-400 bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_4px,var(--background)_4px,var(--background)_8px)] text-foreground",
        selected && "ring-2 ring-primary ring-offset-1",
        multiSelected && "ring-2 ring-amber-500 ring-offset-1",
        transform && "cursor-grabbing opacity-80",
      )}
      style={{ left: rect.left, width: rect.width, top: 8 + lane * 24 }}
      aria-pressed={selected}
      aria-label={segmentAriaLabel(segment)}
      title={`${segment.title} · ${formatRange(segment.startMs, segment.endMs)}`}
      onClick={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        if (event.shiftKey && interaction?.onSegmentToggleSelection) {
          interaction.onSegmentToggleSelection(segment.id);
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
        if (event.button !== 0 || !directSegmentTransformAllowed(interaction)) return;
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
            "absolute inset-y-0 left-0 w-2 cursor-ew-resize",
            interaction.desktopOnlySegmentTransform && "hidden sm:block",
          )}
          data-resize-handle="start"
          aria-hidden="true"
        />
      )}
      <span className="truncate">{segment.title}</span>
      {segment.permissions.canResize && interaction?.onSegmentTransform && (
        <span
          className={cn(
            "absolute inset-y-0 right-0 w-2 cursor-ew-resize",
            interaction.desktopOnlySegmentTransform && "hidden sm:block",
          )}
          data-resize-handle="end"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function AnchorMarker({
  mode,
  planRow,
  anchor,
  lane,
  offset,
  scale,
  selected,
  activeFocusKey,
  interaction,
  onSelect,
  onObjectFocus,
  onPreviewChange,
}: {
  mode: TimeCanvasProps["mode"];
  planRow: boolean;
  anchor: TimeCanvasAnchor;
  lane: number;
  offset: number;
  scale: ReturnType<typeof createTimeScale>;
  selected: boolean;
  activeFocusKey: string | null;
  interaction: TimeCanvasInteractionOptions | undefined;
  onSelect: (selection: TimeCanvasSelection) => void;
  onObjectFocus: (key: string) => void;
  onPreviewChange: (anchorId: string, atMs: number | null) => void;
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
  const displayedAtMs = previewAtMs ?? anchor.atMs;
  const completed = anchor.completed ?? anchor.status === "COMPLETED";
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
  const announcedStatus =
    anchor.visualState === "TEMPORARY"
      ? "临时"
      : anchor.visualState === "INVALID"
        ? "需修正"
        : anchor.status;

  function requestKeyboardMove(direction: -1 | 1) {
    if (!canMove) return;
    const canvasResult = moveTimePoint({
      atMs: anchor.atMs,
      rawDeltaMs: direction * scale.anchorSnapMs,
      snapMs: scale.anchorSnapMs,
      range: scale,
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
        selected && "bg-primary/10 ring-2 ring-primary",
        completed && "text-emerald-700 dark:text-emerald-300",
        anchor.visualState === "TEMPORARY" && "text-amber-700",
        anchor.visualState === "INVALID" && "text-destructive",
      )}
      style={{ left, top }}
      aria-pressed={selected}
      aria-label={`${anchor.kind === "TERMINATION" ? "终止节点" : "计划节点"} ${anchor.label}，${formatDateTime(displayedAtMs)}，状态 ${announcedStatus}${canMove ? "，按左右方向键可移动" : ""}`}
      title={`${anchor.label} · ${formatDateTime(displayedAtMs)}`}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
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
        onPreviewChange(anchor.id, anchor.atMs);
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
        const canvasResult = moveTimePoint({
          atMs: anchor.atMs,
          rawDeltaMs: rawDelta,
          snapMs: scale.anchorSnapMs,
          range: scale,
        });
        const result = constrainMove(canvasResult, "MOVE");
        setPreviewAtMs(result.atMs);
        previewBlockedMessageRef.current = result.blockedMessage ?? null;
        onPreviewChange(anchor.id, result.atMs);
        if (Math.abs(rawDelta) >= scale.anchorSnapMs) {
          suppressClickRef.current = true;
        }
      }}
      onPointerCancel={() => {
        setMove(null);
        setPreviewAtMs(null);
        previewBlockedMessageRef.current = null;
        onPreviewChange(anchor.id, null);
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
        onPreviewChange(anchor.id, null);
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
      {planRow && (
        <span className="max-w-32 truncate text-[9px] text-muted-foreground">
          {formatCompactAnchorDate(displayedAtMs, false)}
        </span>
      )}
    </button>
  );
}

function TodayLine({
  scale,
  nowMs,
  axis = false,
}: {
  scale: ReturnType<typeof createTimeScale>;
  nowMs: number;
  axis?: boolean;
}) {
  if (!Number.isFinite(nowMs) || nowMs < scale.startMs || nowMs >= scale.endMs) return null;
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-y-0 w-px bg-rose-500",
        axis ? "z-20" : "z-[5]",
      )}
      style={{ left: timeToX(nowMs, scale) }}
      aria-hidden="true"
      data-testid={axis ? "time-canvas-today-axis" : "time-canvas-today-line"}
    />
  );
}

type SelectedEntity =
  | { kind: "ANCHOR"; value: TimeCanvasAnchor }
  | { kind: "SEGMENT"; value: TimeCanvasSegment };

function TimeCanvasInspector({
  entity,
  onClose,
}: {
  entity: SelectedEntity;
  onClose: () => void;
}) {
  return (
    <aside className="border-t border-border bg-card p-4 md:border-l md:border-t-0" aria-label="时间对象详情" data-testid="time-canvas-inspector">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">只读 Inspector</p>
          <h2 className="mt-1 break-words text-base font-semibold">{entityTitle(entity)}</h2>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="关闭时间对象详情" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <InspectorBody entity={entity} />
    </aside>
  );
}

function InspectorBody({ entity }: { entity: SelectedEntity }) {
  if (entity.kind === "ANCHOR") {
    return (
      <dl className="mt-4 grid gap-3 text-sm">
        <Detail label="类型" value={entity.value.kind} />
        <Detail label="状态" value={entity.value.status} />
        <Detail label="计划时间" value={formatDateTime(entity.value.atMs)} />
        <Detail label="权限" value={entity.value.editable ? "可编辑" : "只读；修改需按 Task 生命周期进行"} />
      </dl>
    );
  }
  const segment = entity.value;
  return (
    <dl className="mt-4 grid gap-3 text-sm">
      <Detail label="类型与状态" value={segment.type === "BUSY" ? "其他占用（详情受限）" : `${segment.type} · ${segment.status}`} />
      <Detail label="区间" value={formatRange(segment.startMs, segment.endMs)} />
      {segment.visibility === "FULL" && (
        <>
          <Detail label="优先级" value={segment.priority ?? "未提供"} />
          <Detail label="权限" value={segment.permissions.canEdit ? "可编辑" : "只读"} />
        </>
      )}
    </dl>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words">{value}</dd>
    </div>
  );
}

function resolveSelection(
  model: TimeCanvasProps["model"],
  selection: TimeCanvasSelection,
): SelectedEntity | null {
  if (!selection) return null;
  if (selection.kind === "ANCHOR") {
    const value = model.anchors.find((anchor) => anchor.id === selection.id);
    return value ? { kind: "ANCHOR", value } : null;
  }
  if (selection.kind === "SEGMENT") {
    const value = model.segments.find((segment) => segment.id === selection.id);
    return value ? { kind: "SEGMENT", value } : null;
  }
  return null;
}

type CanvasFocusTarget = {
  key: string;
  rowIndex: number;
  atMs: number;
};

function buildCanvasFocusTargets(
  model: TimeCanvasProps["model"],
  segments: TimeCanvasSegment[],
): CanvasFocusTarget[] {
  const rowIndexById = new Map(
    model.rows.map((row, rowIndex) => [row.id, rowIndex]),
  );
  const targets: CanvasFocusTarget[] = [];

  for (const row of model.rows) {
    const rowIndex = rowIndexById.get(row.id);
    if (rowIndex === undefined) continue;
    const rowSegments = segments.filter(
      (segment) =>
        segment.rowId === row.id && rangesIntersect(segment, model.range),
    );
    const segmentLayout = layoutIntervalLanes(
      rowSegments.map((segment) => ({
        id: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
      })),
    );
    for (const placement of segmentLayout.placements) {
      targets.push({
        key: placement.aggregated
          ? overflowFocusKey(row.id, placement.id)
          : segmentFocusKey(placement.id),
        rowIndex,
        atMs: placement.startMs,
      });
    }
  }

  for (const anchor of model.anchors) {
    const rowIndex = rowIndexById.get(anchor.rowId);
    if (
      rowIndex === undefined ||
      anchor.atMs < model.range.startMs ||
      anchor.atMs >= model.range.endMs
    ) {
      continue;
    }
    targets.push({
      key: anchorFocusKey(anchor.id),
      rowIndex,
      atMs: anchor.atMs,
    });
  }

  return targets.sort(
    (left, right) =>
      left.rowIndex - right.rowIndex ||
      left.atMs - right.atMs ||
      left.key.localeCompare(right.key),
  );
}

function nextFocusTarget(
  targets: CanvasFocusTarget[],
  current: CanvasFocusTarget,
  key: string,
) {
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const rowTargets = targets.filter(
      (target) => target.rowIndex === current.rowIndex,
    );
    const currentIndex = rowTargets.findIndex(
      (target) => target.key === current.key,
    );
    if (currentIndex === -1) return null;
    const direction = key === "ArrowLeft" ? -1 : 1;
    return (
      rowTargets[
        (currentIndex + direction + rowTargets.length) % rowTargets.length
      ] ?? null
    );
  }

  const direction = key === "ArrowUp" ? -1 : 1;
  const rowIndexes = [...new Set(targets.map((target) => target.rowIndex))].sort(
    (left, right) => left - right,
  );
  const currentRowPosition = rowIndexes.indexOf(current.rowIndex);
  const nextRowIndex = rowIndexes[currentRowPosition + direction];
  if (nextRowIndex === undefined) return current;
  return (
    targets
      .filter((target) => target.rowIndex === nextRowIndex)
      .sort(
        (left, right) =>
          Math.abs(left.atMs - current.atMs) -
            Math.abs(right.atMs - current.atMs) ||
          left.atMs - right.atMs ||
          left.key.localeCompare(right.key),
      )[0] ?? current
  );
}

function segmentFocusKey(id: string) {
  return `segment:${id}`;
}

function anchorFocusKey(id: string) {
  return `anchor:${id}`;
}

function overflowFocusKey(rowId: string, placementId: string) {
  return `overflow:${rowId}:${placementId}`;
}

function normalizeBrushRange(
  anchorMs: number,
  currentMs: number,
  scale: ReturnType<typeof createTimeScale>,
) {
  const lower = Math.min(anchorMs, currentMs);
  const upper = Math.max(anchorMs, currentMs);
  const rangeDurationMs = scale.endMs - scale.startMs;
  const minimumDurationMs = Math.min(scale.snapMs, rangeDurationMs);
  if (upper - lower >= minimumDurationMs) {
    return {
      startMs: clampTime(lower, scale.startMs, scale.endMs - minimumDurationMs),
      endMs: clampTime(upper, scale.startMs + minimumDurationMs, scale.endMs),
    };
  }
  const startMs = clampTime(
    lower,
    scale.startMs,
    scale.endMs - minimumDurationMs,
  );
  return { startMs, endMs: startMs + minimumDurationMs };
}

function transformedRange(
  transform: {
    kind: "MOVE" | "RESIZE_START" | "RESIZE_END";
    startMs: number;
    endMs: number;
  },
  deltaMs: number,
  rangeStartMs: number,
  rangeEndMs: number,
  minimumDurationMs: number,
) {
  if (transform.kind === "RESIZE_START") {
    return {
      startMs: clampTime(
        transform.startMs + deltaMs,
        rangeStartMs,
        transform.endMs - minimumDurationMs,
      ),
      endMs: transform.endMs,
    };
  }
  if (transform.kind === "RESIZE_END") {
    return {
      startMs: transform.startMs,
      endMs: clampTime(
        transform.endMs + deltaMs,
        transform.startMs + minimumDurationMs,
        rangeEndMs,
      ),
    };
  }
  const duration = transform.endMs - transform.startMs;
  const startMs = clampTime(
    transform.startMs + deltaMs,
    rangeStartMs,
    rangeEndMs - duration,
  );
  return { startMs, endMs: startMs + duration };
}

function edgeScrollCanvas(
  scroller: HTMLElement,
  clientX: number,
  clientY?: number,
) {
  const bounds = scroller.getBoundingClientRect();
  const edge = 40;
  if (clientX < bounds.left + edge) {
    scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 24);
  } else if (clientX > bounds.right - edge) {
    scroller.scrollLeft += 24;
  }
  if (clientY === undefined) return;
  if (clientY < bounds.top + edge) {
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 24);
  } else if (clientY > bounds.bottom - edge) {
    scroller.scrollTop += 24;
  }
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

function directSegmentTransformAllowed(
  interaction: TimeCanvasInteractionOptions | undefined,
) {
  if (!interaction?.onSegmentTransform) return false;
  return !interaction.desktopOnlySegmentTransform ||
    window.matchMedia("(min-width: 640px)").matches;
}

function responsiveRowHeaderWidth(containerWidth: number) {
  if (containerWidth < 640) {
    return Math.round(Math.max(120, Math.min(140, containerWidth * 0.36)));
  }
  return Math.round(Math.max(200, Math.min(280, containerWidth * 0.24)));
}

function tickPixelDistance(
  ticks: number[],
  scale: ReturnType<typeof createTimeScale>,
) {
  if (ticks.length < 2) return scale.viewportWidthPx;
  return Math.abs(timeToX(ticks[1] ?? ticks[0] ?? 0, scale) - timeToX(ticks[0] ?? 0, scale));
}

function clampTime(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

function groupByRow<T extends { rowId: string }>(items: T[]) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const values = grouped.get(item.rowId) ?? [];
    values.push(item);
    grouped.set(item.rowId, values);
  }
  return grouped;
}

function selectionAnnouncement(entity: SelectedEntity) {
  if (entity.kind === "ANCHOR") {
    return `已选中计划节点 ${entity.value.label}，${formatDateTime(entity.value.atMs)}`;
  }
  return `已选中${entity.value.type === "BUSY" ? "其他占用" : entity.value.title}，${formatRange(entity.value.startMs, entity.value.endMs)}`;
}

function entityTitle(entity: SelectedEntity) {
  if (entity.kind === "ANCHOR") return entity.value.label;
  return entity.value.title;
}

function segmentAriaLabel(segment: TimeCanvasSegment) {
  const type = segment.type === "BUSY" ? "其他占用" : segment.type;
  return `${type} ${segment.title}，${formatRange(segment.startMs, segment.endMs)}`;
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

function phaseBandToneClassName(tone: TimeCanvasPhaseBand["tone"]) {
  if (tone === "BLUE") {
    return "border-blue-500/60 bg-blue-500/15 text-blue-950 dark:text-blue-100";
  }
  if (tone === "VIOLET") {
    return "border-violet-500/60 bg-violet-500/15 text-violet-950 dark:text-violet-100";
  }
  if (tone === "AMBER") {
    return "border-amber-500/60 bg-amber-500/15 text-amber-950 dark:text-amber-100";
  }
  if (tone === "EMERALD") {
    return "border-emerald-500/60 bg-emerald-500/15 text-emerald-950 dark:text-emerald-100";
  }
  if (tone === "ROSE") {
    return "border-rose-500/60 bg-rose-500/15 text-rose-950 dark:text-rose-100";
  }
  return "border-slate-500/60 bg-slate-500/15 text-slate-950 dark:text-slate-100";
}
