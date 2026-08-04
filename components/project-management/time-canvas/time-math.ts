import type {
  TimeCanvasRange,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;
export const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

export type TimeScale = TimeCanvasRange & {
  viewportWidthPx: number;
  contentWidthPx: number;
  msPerPixel: number;
  snapMs: number;
};

export type TimeRect = { left: number; width: number };

export const zoomConfiguration: Record<
  TimeCanvasZoom,
  { pixelsPerDay: number; snapMs: number; tickMs: number }
> = {
  HOUR: { pixelsPerDay: 24 * 72, snapMs: HOUR_MS / 2, tickMs: HOUR_MS },
  DAY: { pixelsPerDay: 96, snapMs: DAY_MS, tickMs: DAY_MS },
  WEEK: { pixelsPerDay: 28, snapMs: DAY_MS, tickMs: 7 * DAY_MS },
  MONTH: { pixelsPerDay: 8, snapMs: 7 * DAY_MS, tickMs: 7 * DAY_MS },
};

export function createTimeScale(input: {
  range: TimeCanvasRange;
  viewportWidthPx: number;
  zoom: TimeCanvasZoom;
}): TimeScale {
  assertRange(input.range);
  const viewportWidthPx = Math.max(1, finite(input.viewportWidthPx, 1));
  const durationMs = input.range.endMs - input.range.startMs;
  const configuredWidth =
    (durationMs / DAY_MS) * zoomConfiguration[input.zoom].pixelsPerDay;
  const contentWidthPx = Math.max(viewportWidthPx, configuredWidth, 1);
  return {
    ...input.range,
    viewportWidthPx,
    contentWidthPx,
    msPerPixel: durationMs / contentWidthPx,
    snapMs: zoomConfiguration[input.zoom].snapMs,
  };
}

export function timeToX(timeMs: number, scale: TimeScale): number {
  return (timeMs - scale.startMs) / scale.msPerPixel;
}

export function xToTime(x: number, scale: TimeScale): number {
  return scale.startMs + x * scale.msPerPixel;
}

export function snapTime(
  timeMs: number,
  snapMs: number,
  mode: "round" | "floor" | "ceil" = "round",
  originMs = -SHANGHAI_OFFSET_MS,
): number {
  if (
    !Number.isFinite(timeMs) ||
    !Number.isFinite(snapMs) ||
    !Number.isFinite(originMs) ||
    snapMs <= 0
  ) {
    throw new Error("时间吸附参数无效");
  }
  return Math[mode]((timeMs - originMs) / snapMs) * snapMs + originMs;
}

export function moveTimePoint(input: {
  atMs: number;
  rawDeltaMs: number;
  snapMs: number;
  range: TimeCanvasRange;
}): { atMs: number; deltaMs: number } {
  assertRange(input.range);
  if (
    !Number.isFinite(input.atMs) ||
    input.atMs < input.range.startMs ||
    input.atMs >= input.range.endMs
  ) {
    throw new Error("时间点必须位于当前半开区间内");
  }
  const snappedDeltaMs = snapTime(
    input.rawDeltaMs,
    input.snapMs,
    "round",
    0,
  );
  const minimumDeltaMs =
    Math.ceil((input.range.startMs - input.atMs) / input.snapMs) * input.snapMs;
  const maximumDeltaMs =
    Math.floor((input.range.endMs - 1 - input.atMs) / input.snapMs) * input.snapMs;
  const deltaMs = Math.max(
    minimumDeltaMs,
    Math.min(snappedDeltaMs, maximumDeltaMs),
  );
  return { atMs: input.atMs + deltaMs, deltaMs };
}

export function snapTimeInRange(
  timeMs: number,
  snapMs: number,
  range: TimeCanvasRange,
): number | null {
  assertRange(range);
  const rounded = snapTime(timeMs, snapMs);
  if (rounded >= range.startMs && rounded < range.endMs) return rounded;
  const boundary = rounded < range.startMs
    ? snapTime(range.startMs, snapMs, "ceil")
    : snapTime(range.endMs - 1, snapMs, "floor");
  return boundary >= range.startMs && boundary < range.endMs ? boundary : null;
}

export function intervalToRect(
  startMs: number,
  endMs: number,
  scale: TimeScale,
): TimeRect {
  const clippedStart = Math.max(scale.startMs, Math.min(startMs, scale.endMs));
  const clippedEnd = Math.max(scale.startMs, Math.min(endMs, scale.endMs));
  const left = timeToX(clippedStart, scale);
  const width = Math.max(1, timeToX(clippedEnd, scale) - left);
  return { left, width };
}

export function rangesIntersect(
  first: TimeCanvasRange,
  second: TimeCanvasRange,
): boolean {
  return first.startMs < second.endMs && first.endMs > second.startMs;
}

export function fitTimeRange(
  timestamps: number[],
  fallback: TimeCanvasRange,
  options: { paddingRatio?: number; minimumDurationMs?: number } = {},
): TimeCanvasRange {
  assertRange(fallback);
  const values = timestamps.filter(Number.isFinite);
  if (values.length === 0) return fallback;
  const minimumDurationMs = options.minimumDurationMs ?? DAY_MS;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const rawDuration = Math.max(maximum - minimum, minimumDurationMs);
  const padding = Math.max(
    HOUR_MS,
    rawDuration * (options.paddingRatio ?? 0.1),
  );
  const center = (minimum + maximum) / 2;
  const halfDuration = rawDuration / 2 + padding;
  return { startMs: center - halfDuration, endMs: center + halfDuration };
}

export function visibleTimeWindow(input: {
  scale: TimeScale;
  scrollLeftPx: number;
  viewportWidthPx: number;
  overscanPx?: number;
}): TimeCanvasRange {
  const overscanPx = Math.max(0, input.overscanPx ?? input.viewportWidthPx / 2);
  const maximumScrollLeft = Math.max(
    0,
    input.scale.contentWidthPx - input.viewportWidthPx,
  );
  const scrollLeftPx = Math.max(
    0,
    Math.min(input.scrollLeftPx, maximumScrollLeft),
  );
  const left = Math.max(0, scrollLeftPx - overscanPx);
  const right = Math.min(
    input.scale.contentWidthPx,
    scrollLeftPx + input.viewportWidthPx + overscanPx,
  );
  return {
    startMs: Math.max(input.scale.startMs, xToTime(left, input.scale)),
    endMs: Math.min(input.scale.endMs, xToTime(right, input.scale)),
  };
}

export function axisTicks(input: {
  window: TimeCanvasRange;
  zoom: TimeCanvasZoom;
}): number[] {
  assertRange(input.window);
  const step = zoomConfiguration[input.zoom].tickMs;
  const alignedStart =
    input.zoom === "HOUR"
      ? Math.floor(input.window.startMs / step) * step
      : input.zoom === "DAY"
        ? floorShanghaiDay(input.window.startMs, DAY_MS)
        : floorShanghaiWeek(input.window.startMs);
  const ticks: number[] = [];
  for (
    let tick = alignedStart;
    tick <= input.window.endMs + step && ticks.length < 1_000;
    tick += step
  ) {
    if (tick >= input.window.startMs - step) ticks.push(tick);
  }
  return ticks;
}

export function chooseFitZoom(range: TimeCanvasRange): TimeCanvasZoom {
  assertRange(range);
  const days = (range.endMs - range.startMs) / DAY_MS;
  if (days <= 3) return "HOUR";
  if (days <= 21) return "DAY";
  if (days <= 84) return "WEEK";
  return "MONTH";
}

function floorShanghaiDay(timeMs: number, stepMs: number): number {
  const dayIndex = Math.floor((timeMs + SHANGHAI_OFFSET_MS) / stepMs);
  return dayIndex * stepMs - SHANGHAI_OFFSET_MS;
}

function floorShanghaiWeek(timeMs: number): number {
  const localDayIndex = Math.floor((timeMs + SHANGHAI_OFFSET_MS) / DAY_MS);
  // 1970-01-01 was Thursday, so local day index 4 is the first Monday.
  const daysSinceMonday = ((localDayIndex - 4) % 7 + 7) % 7;
  return (localDayIndex - daysSinceMonday) * DAY_MS - SHANGHAI_OFFSET_MS;
}

function assertRange(range: TimeCanvasRange) {
  if (
    !Number.isFinite(range.startMs) ||
    !Number.isFinite(range.endMs) ||
    range.endMs <= range.startMs
  ) {
    throw new Error("时间范围必须为非空半开区间 [start, end)");
  }
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}
