"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Flag,
  GitBranch,
  Link2Off,
  Lock,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { TimeAgenda } from "@/components/project-management/time-canvas/time-agenda";
import {
  DAY_MS,
  axisTicks,
  chooseFitZoom,
  createTimeScale,
  intervalToRect,
  rangesIntersect,
  snapTime,
  timeToX,
  visibleTimeWindow,
  xToTime,
} from "@/components/project-management/time-canvas/time-math";
import { layoutIntervalLanes, layoutPointLanes } from "@/components/project-management/time-canvas/lane-layout";
import type {
  TimeCanvasAnchor,
  TimeCanvasConflict,
  TimeCanvasDisplayOptions,
  TimeCanvasInteractionOptions,
  TimeCanvasProps,
  TimeCanvasRow,
  TimeCanvasSegment,
  TimeCanvasSelection,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ROW_HEADER_WIDTH = 240;
const AXIS_HEIGHT = 56;
const zoomOrder: TimeCanvasZoom[] = ["HOUR", "DAY", "WEEK", "MONTH"];
const zoomLabels: Record<TimeCanvasZoom, string> = {
  HOUR: "小时",
  DAY: "日",
  WEEK: "周",
  MONTH: "月",
};

export function TimeCanvas({
  mode,
  model,
  initialZoom,
  display: displayInput,
  interaction,
  initialSelection = null,
  emptyMessage = "选择人员或 Task 后查看计划",
  onRangeChange,
  onSelectionChange,
}: TimeCanvasProps) {
  const display: Required<TimeCanvasDisplayOptions> = {
    showActual: displayInput?.showActual ?? true,
    showBusy: displayInput?.showBusy ?? true,
    showConflicts: displayInput?.showConflicts ?? true,
    showInspector: displayInput?.showInspector ?? true,
  };
  const [zoom, setZoom] = useState<TimeCanvasZoom>(
    initialZoom ?? chooseFitZoom(model.range),
  );
  const [selection, setSelection] = useState<TimeCanvasSelection>(initialSelection);
  const mobileAgenda = useMobileAgenda();
  const [scrollState, setScrollState] = useState({ left: 0, width: 900 });
  const [activeFocusKey, setActiveFocusKey] = useState<string | null>(null);
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null);
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
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
  const conflictsByRow = useMemo(
    () =>
      groupByRow(
        display.showConflicts
          ? model.conflicts.filter(
              (conflict): conflict is TimeCanvasConflict & { rowId: string } =>
                conflict.visibility === "VISIBLE" && conflict.rowId !== null,
            )
          : [],
      ),
    [display.showConflicts, model.conflicts],
  );
  const generatedAtMs = Date.parse(model.generatedAt);
  const focusTargets = useMemo(
    () =>
      buildCanvasFocusTargets(
        model,
        filteredSegments,
        display.showConflicts,
      ),
    [display.showConflicts, filteredSegments, model],
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
  const ticks = useMemo(
    () => axisTicks({ window: visibleWindow, zoom }),
    [visibleWindow, zoom],
  );
  const dayStripes = useMemo(
    () => axisTicks({ window: visibleWindow, zoom: "DAY" }),
    [visibleWindow],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the frozen S3 headless virtualizer; row inputs and keys remain explicit and stable.
  const rowVirtualizer = useVirtualizer({
    count: model.rows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => model.rows[index]?.height ?? 48,
    getItemKey: (index) => model.rows[index]?.id ?? index,
    scrollMargin: AXIS_HEIGHT,
    overscan: 6,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualRowSignature = virtualRows
    .map((virtualRow) => `${virtualRow.key}:${virtualRow.start}`)
    .join("|");

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!element) return;
    const updateWidth = () => {
      setScrollState((current) => ({
        ...current,
        width: Math.max(1, element.clientWidth - ROW_HEADER_WIDTH),
      }));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
      setSelection(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );

  const scrollToToday = useCallback(() => {
    const now = Date.now();
    if (now < model.range.startMs || now >= model.range.endMs) {
      if (onRangeChange) {
        const duration = model.range.endMs - model.range.startMs;
        onRangeChange({ startMs: now - duration / 2, endMs: now + duration / 2 });
      }
      return;
    }
    const element = scrollElementRef.current;
    if (!element) return;
    element.scrollTo({
      left: Math.max(0, timeToX(now, scale) - scrollState.width / 2),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [model.range, onRangeChange, scale, scrollState.width]);

  const fitRange = useCallback(() => {
    setZoom(chooseFitZoom(model.range));
    scrollElementRef.current?.scrollTo({ left: 0, behavior: "auto" });
  }, [model.range]);

  const changeRange = useCallback(
    (direction: -1 | 1) => {
      if (!onRangeChange) return;
      const duration = model.range.endMs - model.range.startMs;
      onRangeChange({
        startMs: model.range.startMs + direction * duration,
        endMs: model.range.endMs + direction * duration,
      });
    },
    [model.range, onRangeChange],
  );

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
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitRange();
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
    [fitRange, focusTargets, rowVirtualizer, scale, scrollState.width, scrollToToday],
  );

  const selectedEntity = resolveSelection(model, selection);
  const hiddenConflictObjectCount = model.conflicts
    .filter((conflict) => conflict.visibility === "HIDDEN")
    .reduce((total, conflict) => total + conflict.hiddenSegmentCount, 0);

  return (
    <section
      className="min-w-0 max-w-full"
      aria-label="时间画布"
      data-mode={mode}
      data-testid="time-canvas-root"
      onKeyDown={handleKeyboard}
    >
      <TimeCanvasToolbar
        model={model}
        zoom={zoom}
        hiddenConflictObjectCount={display.showConflicts ? hiddenConflictObjectCount : 0}
        canChangeRange={Boolean(onRangeChange)}
        canGoToday={
          generatedAtMs >= model.range.startMs &&
          generatedAtMs < model.range.endMs
            ? true
            : Boolean(onRangeChange)
        }
        onPrevious={() => changeRange(-1)}
        onNext={() => changeRange(1)}
        onToday={scrollToToday}
        onFit={fitRange}
        onZoomChange={setZoom}
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
          {mobileAgenda ? (
          <div className="p-3">
            <TimeAgenda
              model={model}
              display={display}
              selection={selection}
              onSelect={select}
              emptyMessage={emptyMessage}
            />
          </div>
          ) : (
          <div
            ref={scrollElementRef}
            className="relative max-h-[min(68dvh,44rem)] min-h-72 min-w-0 overflow-auto overscroll-contain"
            data-testid="time-canvas-scroll"
            onScroll={(event) => {
              const element = event.currentTarget;
              if (animationFrameRef.current !== null) return;
              animationFrameRef.current = requestAnimationFrame(() => {
                animationFrameRef.current = null;
                setScrollState({
                  left: element.scrollLeft,
                  width: Math.max(1, element.clientWidth - ROW_HEADER_WIDTH),
                });
              });
            }}
          >
            <div
              className="relative min-w-full"
              style={{ width: ROW_HEADER_WIDTH + scale.contentWidthPx }}
            >
              <TimeAxis
                ticks={ticks}
                scale={scale}
                zoom={zoom}
                timezone={model.timezone}
                nowMs={generatedAtMs}
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
                          width: ROW_HEADER_WIDTH + scale.contentWidthPx,
                          height: virtualRow.size,
                          gridTemplateColumns: `${ROW_HEADER_WIDTH}px ${scale.contentWidthPx}px`,
                          transform: `translateY(${virtualRow.start - AXIS_HEIGHT}px)`,
                        }}
                        data-testid={`timeline-row-${row.id}`}
                      >
                        <RowHeader row={row} />
                        <TimelineRow
                          row={row}
                          scale={scale}
                          visibleWindow={visibleWindow}
                          dayStripes={dayStripes}
                          segments={segmentsByRow.get(row.id) ?? []}
                          anchors={anchorsByRow.get(row.id) ?? []}
                          conflicts={conflictsByRow.get(row.id) ?? []}
                          nowMs={generatedAtMs}
                          selection={selection}
                          activeFocusKey={currentFocusKey}
                          interaction={interaction}
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
          )}
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

function useMobileAgenda() {
  return useSyncExternalStore(subscribeMobileAgenda, mobileAgendaSnapshot, () => false);
}

function subscribeMobileAgenda(callback: () => void) {
  const query = window.matchMedia("(max-width: 767px)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function mobileAgendaSnapshot() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function TimeCanvasToolbar({
  model,
  zoom,
  hiddenConflictObjectCount,
  canChangeRange,
  canGoToday,
  onPrevious,
  onNext,
  onToday,
  onFit,
  onZoomChange,
}: {
  model: TimeCanvasProps["model"];
  zoom: TimeCanvasZoom;
  hiddenConflictObjectCount: number;
  canChangeRange: boolean;
  canGoToday: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onFit: () => void;
  onZoomChange: (zoom: TimeCanvasZoom) => void;
}) {
  const zoomIndex = zoomOrder.indexOf(zoom);
  return (
    <div className="flex min-h-14 min-w-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2" data-testid="time-canvas-toolbar">
      <div className="mr-auto min-w-0">
        <p className="truncate text-sm font-medium">
          {formatDate(model.range.startMs)} – {formatDate(model.range.endMs - 1)}
        </p>
        <p className="text-xs text-muted-foreground">{model.timezone} · 半开区间</p>
      </div>
      <Button type="button" size="icon-sm" variant="outline" onClick={onPrevious} disabled={!canChangeRange} aria-label="上一时间范围">
        <ChevronLeft aria-hidden="true" />
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onToday} disabled={!canGoToday}>
        今天
      </Button>
      <Button type="button" size="icon-sm" variant="outline" onClick={onNext} disabled={!canChangeRange} aria-label="下一时间范围">
        <ChevronRight aria-hidden="true" />
      </Button>
      <div className="flex items-center rounded-lg border border-border" aria-label="缩放控制">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="放大时间轴"
          disabled={zoomIndex === 0}
          onClick={() => onZoomChange(zoomOrder[Math.max(0, zoomIndex - 1)] ?? zoom)}
        >
          <Plus aria-hidden="true" />
        </Button>
        <span className="min-w-10 text-center text-xs">{zoomLabels[zoom]}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="缩小时间轴"
          disabled={zoomIndex === zoomOrder.length - 1}
          onClick={() => onZoomChange(zoomOrder[Math.min(zoomOrder.length - 1, zoomIndex + 1)] ?? zoom)}
        >
          <Minus aria-hidden="true" />
        </Button>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onFit}>
        <RotateCcw aria-hidden="true" />
        适应范围
      </Button>
      {hiddenConflictObjectCount > 0 && (
        <Badge variant="destructive" aria-label={`${hiddenConflictObjectCount} 个受限对象涉及冲突`}>
          <AlertTriangle aria-hidden="true" />
          {hiddenConflictObjectCount} 个受限对象
        </Badge>
      )}
      <div className="hidden items-center gap-2 text-xs text-muted-foreground xl:flex" aria-label="图例">
        <span>░ Planned</span>
        <span>■ Actual</span>
        <span>▧ Busy</span>
        <span>◆ Milestone</span>
        <span>⚑ Termination</span>
      </div>
    </div>
  );
}

function TimeAxis({
  ticks,
  scale,
  zoom,
  timezone,
  nowMs,
}: {
  ticks: number[];
  scale: ReturnType<typeof createTimeScale>;
  zoom: TimeCanvasZoom;
  timezone: string;
  nowMs: number;
}) {
  return (
    <div
      className="sticky top-0 z-30 grid border-b border-border bg-background/95 backdrop-blur"
      style={{
        height: AXIS_HEIGHT,
        gridTemplateColumns: `${ROW_HEADER_WIDTH}px ${scale.contentWidthPx}px`,
      }}
    >
      <div className="sticky left-0 z-40 flex items-center border-r border-border bg-background px-3 text-xs font-medium text-muted-foreground">
        行标题
      </div>
      <div className="relative overflow-hidden" aria-label={`${timezone} ${zoomLabels[zoom]}级时间轴`} role="img">
        {ticks.map((tick) => (
          <div
            key={tick}
            className="absolute inset-y-0 border-l border-border/80"
            style={{ left: timeToX(tick, scale) }}
          >
            <span className="ml-1 whitespace-nowrap text-[11px] text-muted-foreground">
              {formatTick(tick, zoom)}
            </span>
          </div>
        ))}
        <TodayLine scale={scale} nowMs={nowMs} axis />
      </div>
    </div>
  );
}

function RowHeader({ row }: { row: TimeCanvasRow }) {
  return (
    <div className="sticky left-0 z-20 flex min-w-0 flex-col justify-center border-r border-border bg-card px-3">
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
  row,
  scale,
  visibleWindow,
  dayStripes,
  segments,
  anchors,
  conflicts,
  nowMs,
  selection,
  activeFocusKey,
  interaction,
  onSelect,
  onObjectFocus,
}: {
  row: TimeCanvasRow;
  scale: ReturnType<typeof createTimeScale>;
  visibleWindow: { startMs: number; endMs: number };
  dayStripes: number[];
  segments: TimeCanvasSegment[];
  anchors: TimeCanvasAnchor[];
  conflicts: Array<TimeCanvasConflict & { rowId: string }>;
  nowMs: number;
  selection: TimeCanvasSelection;
  activeFocusKey: string | null;
  interaction: TimeCanvasInteractionOptions | undefined;
  onSelect: (selection: TimeCanvasSelection) => void;
  onObjectFocus: (key: string) => void;
}) {
  const [brush, setBrush] = useState<{
    pointerId: number;
    anchorMs: number;
    currentMs: number;
  } | null>(null);
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
    (anchor) => anchor.atMs >= visibleWindow.startMs && anchor.atMs < visibleWindow.endMs,
  );
  const anchorLanes = layoutPointLanes(
    visibleAnchors.map((anchor) => ({
      id: anchor.id,
      atMs: anchor.atMs,
      sequence: anchor.sequence,
    })),
    scale.msPerPixel * 96,
  );

  const brushRange = brush
    ? normalizeBrushRange(brush.anchorMs, brush.currentMs, scale)
    : null;
  const canBrush =
    Boolean(interaction?.enableBrushCreate && interaction.onBrushCreate) &&
    row.editable &&
    row.kind === "PERSON";

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
      )}
      data-canvas-row={row.id}
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
        setBrush({ pointerId: event.pointerId, anchorMs: atMs, currentMs: atMs });
      }}
      onPointerMove={(event) => {
        if (!brush || brush.pointerId !== event.pointerId) return;
        // React clears currentTarget after the handler returns; capture the
        // coordinate before entering the deferred state updater.
        const currentMs = pointerTime(event);
        setBrush((current) =>
          current ? { ...current, currentMs } : null,
        );
      }}
      onPointerCancel={() => setBrush(null)}
      onPointerUp={(event) => {
        if (!brush || brush.pointerId !== event.pointerId) return;
        const range = normalizeBrushRange(
          brush.anchorMs,
          pointerTime(event),
          scale,
        );
        setBrush(null);
        interaction?.onBrushCreate?.({
          rowId: row.id,
          rowKind: row.kind,
          sourceId: row.sourceId,
          ...range,
        });
      }}
    >
      <TimeGrid dayStripes={dayStripes} scale={scale} />
      {brushRange && (
        <span
          className="pointer-events-none absolute inset-y-1 z-40 rounded border-2 border-primary bg-primary/15"
          style={intervalToRect(brushRange.startMs, brushRange.endMs, scale)}
          aria-hidden="true"
          data-testid="time-canvas-brush-preview"
        />
      )}
      {row.kind === "PLAN" && (
        <PlanRail anchors={anchors} visibleWindow={visibleWindow} scale={scale} rowId={row.id} />
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
          anchor={anchor}
          lane={anchorLanes.get(anchor.id) ?? 0}
          offset={index % 10}
          scale={scale}
          selected={selection?.kind === "ANCHOR" && selection.id === anchor.id}
          activeFocusKey={activeFocusKey}
          onSelect={onSelect}
          onObjectFocus={onObjectFocus}
        />
      ))}

      {conflicts
        .filter(
          (conflict) =>
            conflict.startMs !== null &&
            conflict.endMs !== null &&
            rangesIntersect(
              { startMs: conflict.startMs, endMs: conflict.endMs },
              visibleWindow,
            ),
        )
        .map((conflict) => (
          <ConflictOverlay
            key={conflict.id}
            conflict={conflict}
            scale={scale}
            selected={selection?.kind === "CONFLICT" && selection.id === conflict.id}
            activeFocusKey={activeFocusKey}
            onSelect={onSelect}
            onObjectFocus={onObjectFocus}
          />
        ))}
      <TodayLine scale={scale} nowMs={nowMs} />
    </div>
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
  visibleWindow,
  scale,
  rowId,
}: {
  anchors: TimeCanvasAnchor[];
  visibleWindow: { startMs: number; endMs: number };
  scale: ReturnType<typeof createTimeScale>;
  rowId: string;
}) {
  const sorted = [...anchors].sort(
    (left, right) =>
      left.atMs - right.atMs ||
      left.sequence - right.sequence ||
      left.id.localeCompare(right.id),
  );
  const spans = sorted
    .slice(0, -1)
    .map((anchor, index) => ({
      id: `${anchor.id}:${sorted[index + 1]?.id ?? "end"}`,
      startMs: anchor.atMs,
      endMs: sorted[index + 1]?.atMs ?? anchor.atMs,
      completed: anchor.status === "COMPLETED",
    }))
    .filter(
      (span) =>
        span.endMs > span.startMs && rangesIntersect(span, visibleWindow),
    );
  if (spans.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      aria-hidden="true"
      data-testid={`plan-rail-${rowId}`}
    >
      {spans.map((span) => {
        const rect = intervalToRect(span.startMs, span.endMs, scale);
        return (
          <span
            key={span.id}
            className={cn(
              "absolute top-9 h-2 rounded-full border border-primary/50 bg-primary/15",
              span.completed && "border-emerald-600/70 bg-emerald-500/25",
            )}
            style={{ left: rect.left, width: rect.width }}
          />
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
    if (!interaction?.onSegmentTransform) return;
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
    interaction.onSegmentTransform({
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
        "absolute z-10 flex h-5 min-w-px touch-none items-center gap-1 overflow-hidden rounded px-1 text-left text-[10px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        segment.type === "PLANNED" &&
          "border border-dashed border-sky-500/70 bg-sky-100/90 text-sky-950 dark:bg-sky-950/60 dark:text-sky-50",
        segment.type === "ACTUAL" &&
          "border border-emerald-600 bg-emerald-600 text-white",
        segment.type === "BUSY" &&
          "border border-slate-400 bg-[repeating-linear-gradient(135deg,var(--muted),var(--muted)_4px,var(--background)_4px,var(--background)_8px)] text-foreground",
        selected && "ring-2 ring-primary ring-offset-1",
        multiSelected && "ring-2 ring-amber-500 ring-offset-1",
        segment.conflictIds.length > 0 && "border-t-4 border-t-destructive",
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
      onKeyDown={(event) => {
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
          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
          data-resize-handle="start"
          aria-hidden="true"
        />
      )}
      {segment.associationNeedsReview && <Link2Off className="size-3 shrink-0" aria-hidden="true" />}
      <span className="truncate">{segment.title}</span>
      {segment.allocation !== null && <span className="ml-auto shrink-0">{segment.allocation}%</span>}
      {segment.permissions.canResize && interaction?.onSegmentTransform && (
        <span
          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize"
          data-resize-handle="end"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function AnchorMarker({
  anchor,
  lane,
  offset,
  scale,
  selected,
  activeFocusKey,
  onSelect,
  onObjectFocus,
}: {
  anchor: TimeCanvasAnchor;
  lane: number;
  offset: number;
  scale: ReturnType<typeof createTimeScale>;
  selected: boolean;
  activeFocusKey: string | null;
  onSelect: (selection: TimeCanvasSelection) => void;
  onObjectFocus: (key: string) => void;
}) {
  const left = timeToX(anchor.atMs, scale) + offset * 2;
  const top = 8 + lane * 22;
  const Icon = anchor.kind === "TERMINATION" ? Flag : anchor.kind === "REVISION" ? GitBranch : anchor.status === "COMPLETED" ? Check : Circle;
  const focusKey = anchorFocusKey(anchor.id);
  return (
    <button
      type="button"
      className={cn(
        "absolute z-20 flex max-w-40 -translate-x-1/2 flex-col items-center rounded px-1 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-primary/10 ring-2 ring-primary",
      )}
      style={{ left, top }}
      aria-pressed={selected}
      aria-label={`${anchor.kind === "TERMINATION" ? "终止节点" : "计划节点"} ${anchor.label}，${formatDateTime(anchor.atMs)}，状态 ${anchor.status}`}
      title={`${anchor.label} · ${formatDateTime(anchor.atMs)}`}
      onClick={() => onSelect(selected ? null : { kind: "ANCHOR", id: anchor.id })}
      onFocus={() => onObjectFocus(focusKey)}
      tabIndex={activeFocusKey === focusKey ? 0 : -1}
      data-canvas-object
      data-canvas-object-key={focusKey}
      data-testid={`milestone-marker-${anchor.id}`}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          anchor.status === "ACTIVE" && "fill-primary text-primary",
          anchor.kind === "TERMINATION" && "text-destructive",
        )}
        aria-hidden="true"
      />
      <span className="mt-0.5 max-w-32 truncate">{anchor.label}</span>
    </button>
  );
}

function ConflictOverlay({
  conflict,
  scale,
  selected,
  activeFocusKey,
  onSelect,
  onObjectFocus,
}: {
  conflict: TimeCanvasConflict & { rowId: string };
  scale: ReturnType<typeof createTimeScale>;
  selected: boolean;
  activeFocusKey: string | null;
  onSelect: (selection: TimeCanvasSelection) => void;
  onObjectFocus: (key: string) => void;
}) {
  if (conflict.startMs === null || conflict.endMs === null) return null;
  const rect = intervalToRect(conflict.startMs, conflict.endMs, scale);
  const focusKey = conflictFocusKey(conflict.id);
  return (
    <button
      type="button"
      className={cn(
        "absolute top-0 z-30 flex h-4 items-center justify-end overflow-hidden border-t-2 border-destructive bg-destructive/10 px-0.5 text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-destructive",
      )}
      style={{ left: rect.left, width: Math.max(16, rect.width) }}
      aria-pressed={selected}
      aria-label={`资源冲突，严重度 ${conflict.severity}，${formatRange(conflict.startMs, conflict.endMs)}`}
      onClick={() => onSelect(selected ? null : { kind: "CONFLICT", id: conflict.id })}
      onFocus={() => onObjectFocus(focusKey)}
      tabIndex={activeFocusKey === focusKey ? 0 : -1}
      data-canvas-object
      data-canvas-object-key={focusKey}
      data-testid={`conflict-overlay-${conflict.id}`}
    >
      <AlertTriangle className="size-3" aria-hidden="true" />
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
      className="pointer-events-none absolute inset-y-0 z-40 w-px bg-rose-500"
      style={{ left: timeToX(nowMs, scale) }}
      aria-hidden="true"
      data-testid={axis ? "time-canvas-today-axis" : undefined}
    />
  );
}

type SelectedEntity =
  | { kind: "ANCHOR"; value: TimeCanvasAnchor }
  | { kind: "SEGMENT"; value: TimeCanvasSegment }
  | { kind: "CONFLICT"; value: TimeCanvasConflict };

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
  if (entity.kind === "CONFLICT") {
    return (
      <dl className="mt-4 grid gap-3 text-sm">
        <Detail label="严重度" value={entity.value.severity} />
        <Detail label="状态" value={entity.value.status ?? "详情受限"} />
        <Detail label="规则" value={entity.value.reason ?? "隐藏冲突摘要"} />
        {entity.value.startMs !== null && entity.value.endMs !== null && (
          <Detail label="区间" value={formatRange(entity.value.startMs, entity.value.endMs)} />
        )}
      </dl>
    );
  }
  const segment = entity.value;
  return (
    <dl className="mt-4 grid gap-3 text-sm">
      <Detail label="类型与状态" value={segment.type === "BUSY" ? "其他占用（详情受限）" : `${segment.type} · ${segment.status}`} />
      <Detail label="区间" value={formatRange(segment.startMs, segment.endMs)} />
      <Detail label="投入比例" value={segment.allocation === null ? "未提供" : `${segment.allocation}%`} />
      {segment.visibility === "FULL" && (
        <>
          <Detail label="优先级" value={segment.priority ?? "未提供"} />
          <Detail label="关联" value={segment.associationNeedsReview ? "需要重新确认关联" : "关联有效"} />
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
  const value = model.conflicts.find((conflict) => conflict.id === selection.id);
  return value ? { kind: "CONFLICT", value } : null;
}

type CanvasFocusTarget = {
  key: string;
  rowIndex: number;
  atMs: number;
};

function buildCanvasFocusTargets(
  model: TimeCanvasProps["model"],
  segments: TimeCanvasSegment[],
  showConflicts: boolean,
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

  if (showConflicts) {
    for (const conflict of model.conflicts) {
      if (
        conflict.visibility !== "VISIBLE" ||
        conflict.rowId === null ||
        conflict.startMs === null ||
        conflict.endMs === null ||
        !rangesIntersect(
          { startMs: conflict.startMs, endMs: conflict.endMs },
          model.range,
        )
      ) {
        continue;
      }
      const rowIndex = rowIndexById.get(conflict.rowId);
      if (rowIndex === undefined) continue;
      targets.push({
        key: conflictFocusKey(conflict.id),
        rowIndex,
        atMs: conflict.startMs,
      });
    }
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

function conflictFocusKey(id: string) {
  return `conflict:${id}`;
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

function edgeScrollCanvas(scroller: HTMLElement, clientX: number) {
  const bounds = scroller.getBoundingClientRect();
  const edge = 40;
  if (clientX < bounds.left + edge) {
    scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 24);
  } else if (clientX > bounds.right - edge) {
    scroller.scrollLeft += 24;
  }
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
  if (entity.kind === "CONFLICT") {
    return `已选中资源冲突，严重度 ${entity.value.severity}`;
  }
  return `已选中${entity.value.type === "BUSY" ? "其他占用" : entity.value.title}，${formatRange(entity.value.startMs, entity.value.endMs)}`;
}

function entityTitle(entity: SelectedEntity) {
  if (entity.kind === "ANCHOR") return entity.value.label;
  if (entity.kind === "CONFLICT") return "资源冲突";
  return entity.value.title;
}

function segmentAriaLabel(segment: TimeCanvasSegment) {
  const type = segment.type === "BUSY" ? "其他占用" : segment.type;
  const allocation = segment.allocation === null ? "未提供投入比例" : `投入 ${segment.allocation}%`;
  const association = segment.associationNeedsReview ? "，关联需要复核" : "";
  const conflict = segment.conflictIds.length > 0 ? "，存在冲突" : "";
  return `${type} ${segment.title}，${formatRange(segment.startMs, segment.endMs)}，${allocation}${association}${conflict}`;
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const hourFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatDate(timeMs: number) {
  return dateFormatter.format(new Date(timeMs));
}

function formatDateTime(timeMs: number) {
  return dateTimeFormatter.format(new Date(timeMs));
}

function formatRange(startMs: number, endMs: number) {
  return `${formatDateTime(startMs)} – ${formatDateTime(endMs)}`;
}

function formatTick(timeMs: number, zoom: TimeCanvasZoom) {
  return zoom === "HOUR" ? hourFormatter.format(new Date(timeMs)) : formatDate(timeMs);
}

function isShanghaiWeekend(timeMs: number) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(new Date(timeMs));
  return weekday === "Sat" || weekday === "Sun";
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
