"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  axisTicks,
  createTimeScale,
  scrollLeftForCenter,
  timeToX,
  viewportCenterTime,
  visibleTimeWindow,
} from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasDisplayOptions,
  TimeCanvasProps,
  TimeCanvasSelection,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { cn } from "@/lib/utils";
import {
  formatCanvasDateTime as formatDateTime,
  formatCanvasRange as formatRange,
} from "@/components/project-management/time-canvas/time-format";
import {
  anchorFocusKey,
  buildCanvasFocusTargets,
  nextFocusTarget,
  segmentFocusKey,
} from "@/components/project-management/time-canvas/interaction-math";
import {
  type SelectedEntity,
  resolveSelection,
  TimeCanvasInspector,
} from "@/components/project-management/time-canvas/time-canvas-inspector";
import {
  RowHeader,
  TimeAxis,
  TimeCanvasBottomScrollbar,
  TimeCanvasToolbar,
} from "@/components/project-management/time-canvas/time-canvas-chrome";
import {
  AdminGlobalMarkerStage,
  GlobalMarkerOverlay,
} from "@/components/project-management/time-canvas/time-canvas-global-markers";
import {
  ADMIN_MARKER_STAGE_HEIGHT,
  AXIS_HEIGHT,
} from "@/components/project-management/time-canvas/time-canvas-layout";
import { TimelineRow } from "@/components/project-management/time-canvas/time-canvas-row";

const DEFAULT_ZOOM: TimeCanvasZoom = "WEEK";

export function TimeCanvas({
  mode,
  model,
  presentation = "FULL",
  initialZoom,
  initialCenterMs,
  initialCenterRevision = 0,
  display: displayInput,
  interaction,
  selection: controlledSelection,
  initialSelection = null,
  focusRequest = null,
  emptyMessage = "选择人员或 Task 后查看计划",
  onRangeChange,
  navigationRange,
  onRequestCenter,
  onViewportChange,
  onZoomChange,
  onSelectionChange,
}: TimeCanvasProps) {
  const display: Required<TimeCanvasDisplayOptions> = {
    showBusy: displayInput?.showBusy ?? true,
    showInspector: displayInput?.showInspector ?? true,
  };
  const [zoom, setZoom] = useState<TimeCanvasZoom>(initialZoom ?? DEFAULT_ZOOM);
  const [internalSelection, setInternalSelection] =
    useState<TimeCanvasSelection>(initialSelection);
  const appliedInitialSelectionKeyRef = useRef<string | null>(null);
  const appliedFocusRequestKeyRef = useRef<string | null>(null);
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
  const externalCenterRef = useRef({
    centerMs: initialCenterMs,
    revision: initialCenterRevision,
  });
  const externalZoomRef = useRef(initialZoom);
  const scaleLayoutKeyRef = useRef("");
  const filteredSegments = useMemo(
    () =>
      model.segments.filter(
        (segment) => display.showBusy || segment.type !== "BUSY",
      ),
    [display.showBusy, model.segments],
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
  const globalMarkers = model.globalMarkers ?? [];
  const showAdminMarkerStage = mode === "ADMIN_TIME_MARKERS";
  const markerOnlyCanvas =
    mode === "ADMIN_TIME_MARKERS" && model.rows.length === 0;
  const canvasChromeHeight =
    AXIS_HEIGHT + (showAdminMarkerStage ? ADMIN_MARKER_STAGE_HEIGHT : 0);
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
    scrollMargin: canvasChromeHeight,
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
    if (!focusRequest) return;
    const key = focusRequest.selection.kind === "SEGMENT"
      ? segmentFocusKey(focusRequest.selection.id)
      : anchorFocusKey(focusRequest.selection.id);
    const requestKey = `${focusRequest.revision}:${key}`;
    if (appliedFocusRequestKeyRef.current === requestKey) return;
    const target = focusTargets.find((item) => item.key === key);
    if (!target) return;
    appliedFocusRequestKeyRef.current = requestKey;
    viewportCenterRef.current = target.atMs;
    setActiveFocusKey(key);
    setPendingFocusKey(key);
    rowVirtualizer.scrollToIndex(target.rowIndex, { align: "center" });
    const element = scrollElementRef.current;
    if (element) {
      element.scrollLeft = scrollLeftForCenter(scale, target.atMs, scrollState.width);
    }
  }, [focusRequest, focusTargets, rowVirtualizer, scale, scrollState.width]);

  useEffect(() => {
    if (
      Object.is(externalCenterRef.current.centerMs, initialCenterMs) &&
      externalCenterRef.current.revision === initialCenterRevision
    ) {
      return;
    }
    externalCenterRef.current = {
      centerMs: initialCenterMs,
      revision: initialCenterRevision,
    };
    viewportCenterRef.current = Number.isFinite(initialCenterMs)
      ? (initialCenterMs ?? null)
      : null;
  }, [initialCenterMs, initialCenterRevision]);

  useEffect(() => {
    if (externalZoomRef.current === initialZoom) return;
    externalZoomRef.current = initialZoom;
    const nextZoom = initialZoom ?? DEFAULT_ZOOM;
    setZoom(nextZoom);
  }, [initialZoom]);

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
    const layoutKey = `${model.range.startMs}:${model.range.endMs}:${zoom}:${scrollState.width}:${initialCenterMs ?? "auto"}:${initialCenterRevision}`;
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
    initialCenterRevision,
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
      data-viewport-start-ms={viewportWindow.startMs}
      data-viewport-end-ms={viewportWindow.endMs}
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
            className={cn(
              "relative max-h-[min(68dvh,44rem)] min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain",
              markerOnlyCanvas ? "min-h-0" : "min-h-72",
            )}
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
                leadingLabel={mode === "ADMIN_TIME_MARKERS" ? "日期" : "任务 / 人员"}
              />

              {showAdminMarkerStage && (
                <AdminGlobalMarkerStage
                  markers={globalMarkers}
                  scale={scale}
                  visibleWindow={visibleWindow}
                  dayStripes={dayStripes}
                  nowMs={liveNowMs}
                  rowHeaderWidth={rowHeaderWidth}
                  interaction={interaction}
                />
              )}

              {markerOnlyCanvas ? null : model.rows.length === 0 ? (
                <div className="relative min-h-64">
                  <div
                    className="sticky left-0 flex min-h-64 w-[calc(100vw-2rem)] max-w-full items-center justify-center p-8 text-center text-sm text-muted-foreground"
                    data-testid="time-canvas-empty"
                  >
                    {emptyMessage}
                  </div>
                  <GlobalMarkerOverlay
                    markers={globalMarkers}
                    scale={scale}
                    visibleWindow={visibleWindow}
                    rowHeaderWidth={rowHeaderWidth}
                  />
                </div>
              ) : (
                <div
                  className="relative"
                  style={{ height: rowVirtualizer.getTotalSize() }}
                  data-testid="time-canvas-rows"
                >
                  <GlobalMarkerOverlay
                    markers={globalMarkers}
                    scale={scale}
                    visibleWindow={visibleWindow}
                    rowHeaderWidth={rowHeaderWidth}
                  />
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
                          transform: `translateY(${virtualRow.start - canvasChromeHeight}px)`,
                        }}
                        data-testid={`timeline-row-${row.id}`}
                      >
                        <RowHeader
                          row={row}
                          onNavigate={interaction?.onRowNavigation}
                        />
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

function responsiveRowHeaderWidth(containerWidth: number) {
  if (containerWidth < 640) {
    return Math.round(Math.max(120, Math.min(140, containerWidth * 0.36)));
  }
  return Math.round(Math.max(200, Math.min(280, containerWidth * 0.24)));
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
