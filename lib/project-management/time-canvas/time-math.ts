import type {
  TimeCanvasRange,
  TimeCanvasZoom,
} from "@/lib/project-management/time-canvas/types";

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;
export const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
export const MIN_CANVAS_ISO_TIME_MS = Date.parse("0000-01-01T00:00:00.000Z");
export const MIN_GLOBAL_TIME_MARKER_MS = Date.parse("0001-01-01T00:00:00.000Z");
export const MAX_CANVAS_ISO_TIME_MS = Date.parse("9999-12-31T23:59:59.999Z");
export const MAX_GLOBAL_TIME_MARKER_MS = MAX_CANVAS_ISO_TIME_MS - 1;

export type TimeScale = TimeCanvasRange & {
  viewportWidthPx: number;
  contentWidthPx: number;
  msPerPixel: number;
  snapMs: number;
  segmentSnapMs: number;
  anchorSnapMs: number;
};

export type TimeRect = { left: number; width: number };

export const zoomConfiguration: Record<
  TimeCanvasZoom,
  { pixelsPerDay: number }
> = {
  WEEK: { pixelsPerDay: 40 },
  MONTH: { pixelsPerDay: 12 },
  QUARTER: { pixelsPerDay: 4 },
  YEAR: { pixelsPerDay: 1.5 },
};

export const timeCanvasZoomOrder: TimeCanvasZoom[] = [
  "WEEK",
  "MONTH",
  "QUARTER",
  "YEAR",
];

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
    // Kept for callers that edit Segments. Visual density never changes it.
    snapMs: HOUR_MS / 2,
    segmentSnapMs: HOUR_MS / 2,
    anchorSnapMs: DAY_MS,
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
  const result = moveTimePoints({
    pointsMs: [input.atMs],
    rawDeltaMs: input.rawDeltaMs,
    snapMs: input.snapMs,
    range: input.range,
  });
  return { atMs: result.pointsMs[0]!, deltaMs: result.deltaMs };
}

export function moveTimePoints(input: {
  pointsMs: readonly number[];
  rawDeltaMs: number;
  snapMs: number;
  range: TimeCanvasRange;
}): { pointsMs: number[]; deltaMs: number } {
  assertRange(input.range);
  if (
    input.pointsMs.length === 0 ||
    input.pointsMs.some(
      (atMs) =>
        !Number.isFinite(atMs) ||
        atMs < input.range.startMs ||
        atMs >= input.range.endMs,
    )
  ) {
    throw new Error("时间点组必须位于当前半开区间内");
  }
  const snappedDeltaMs = snapTime(
    input.rawDeltaMs,
    input.snapMs,
    "round",
    0,
  );
  const earliestAtMs = Math.min(...input.pointsMs);
  const latestAtMs = Math.max(...input.pointsMs);
  const minimumDeltaMs =
    Math.ceil((input.range.startMs - earliestAtMs) / input.snapMs) * input.snapMs;
  const maximumDeltaMs =
    Math.floor((input.range.endMs - 1 - latestAtMs) / input.snapMs) * input.snapMs;
  const deltaMs = Math.max(
    minimumDeltaMs,
    Math.min(snappedDeltaMs, maximumDeltaMs),
  );
  return {
    pointsMs: input.pointsMs.map((atMs) => atMs + deltaMs),
    deltaMs,
  };
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
  if (input.zoom === "QUARTER" || input.zoom === "YEAR") {
    const ticks: number[] = [];
    let tick = startOfShanghaiMonth(input.window.startMs);
    while (tick <= input.window.endMs && ticks.length < 1_000) {
      ticks.push(tick);
      tick = addShanghaiCalendarMonths(tick, 1);
    }
    return ticks;
  }
  const step = input.zoom === "WEEK" ? DAY_MS : 7 * DAY_MS;
  const alignedStart = input.zoom === "WEEK"
    ? floorShanghaiDay(input.window.startMs)
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
  if (days <= 42) return "WEEK";
  if (days <= 140) return "MONTH";
  if (days <= 420) return "QUARTER";
  return "YEAR";
}

export function chooseAdaptiveScale(
  range: TimeCanvasRange,
  viewportWidthPx: number,
): TimeCanvasZoom {
  assertRange(range);
  const width = Math.max(1, finite(viewportWidthPx, 1));
  const days = (range.endMs - range.startMs) / DAY_MS;
  return timeCanvasZoomOrder.find(
    (zoom) => days * zoomConfiguration[zoom].pixelsPerDay <= width * 4,
  ) ?? "YEAR";
}

export function contentTimeBounds(
  timestamps: Iterable<number>,
): TimeCanvasRange | null {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of timestamps) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
  return { startMs: minimum, endMs: maximum + 1 };
}

export function padShanghaiCalendarRange(
  bounds: TimeCanvasRange | null,
  months = 2,
  fallbackMs = Date.now(),
): TimeCanvasRange {
  const count = Math.max(0, Math.trunc(months));
  if (!bounds) {
    const month = startOfShanghaiMonth(fallbackMs);
    return clampToSerializableIsoRange({
      startMs: addShanghaiCalendarMonths(month, -count),
      endMs: addShanghaiCalendarMonths(month, count + 1),
    });
  }
  assertRange(bounds);
  return clampToSerializableIsoRange({
    startMs: addShanghaiCalendarMonths(startOfShanghaiMonth(bounds.startMs), -count),
    endMs: addShanghaiCalendarMonths(
      startOfShanghaiMonth(bounds.endMs - 1),
      count + 1,
    ),
  });
}

function clampToSerializableIsoRange(range: TimeCanvasRange): TimeCanvasRange {
  const startMs = Math.max(MIN_CANVAS_ISO_TIME_MS, range.startMs);
  const endMs = Math.min(MAX_CANVAS_ISO_TIME_MS, range.endMs);
  if (startMs >= endMs) throw new Error("时间范围超出可显示边界");
  return { startMs, endMs };
}

export function startOfShanghaiMonth(timeMs: number): number {
  if (!Number.isFinite(timeMs)) throw new Error("时间参数无效");
  const local = new Date(timeMs + SHANGHAI_OFFSET_MS);
  return utcTimestamp(local.getUTCFullYear(), local.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
}

export function startOfShanghaiYear(timeMs: number): number {
  if (!Number.isFinite(timeMs)) throw new Error("时间参数无效");
  const local = new Date(timeMs + SHANGHAI_OFFSET_MS);
  return utcTimestamp(local.getUTCFullYear(), 0, 1) - SHANGHAI_OFFSET_MS;
}

export function addShanghaiCalendarMonths(timeMs: number, months: number): number {
  const local = new Date(timeMs + SHANGHAI_OFFSET_MS);
  return utcTimestamp(
    local.getUTCFullYear(),
    local.getUTCMonth() + Math.trunc(months),
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  ) - SHANGHAI_OFFSET_MS;
}

export function addShanghaiCalendarYears(timeMs: number, years: number): number {
  const local = new Date(timeMs + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear() + Math.trunc(years);
  const month = local.getUTCMonth();
  const day = Math.min(
    local.getUTCDate(),
    new Date(utcTimestamp(year, month + 1, 0)).getUTCDate(),
  );
  return utcTimestamp(
    year,
    month,
    day,
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  ) - SHANGHAI_OFFSET_MS;
}

function utcTimestamp(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0,
) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hours, minutes, seconds, milliseconds);
  return date.getTime();
}

export function clampLogicalRangeToThreeYears(
  fullRange: TimeCanvasRange,
  preferredCenterMs: number,
): { range: TimeCanvasRange; clipped: boolean } {
  assertRange(fullRange);
  const fullMaximumEnd = addShanghaiCalendarYears(fullRange.startMs, 3);
  if (fullRange.endMs <= fullMaximumEnd) return { range: fullRange, clipped: false };
  const target = Math.max(fullRange.startMs, Math.min(preferredCenterMs, fullRange.endMs - 1));
  let startMs = addShanghaiCalendarMonths(startOfShanghaiMonth(target), -18);
  let endMs = addShanghaiCalendarYears(startMs, 3);
  if (startMs < fullRange.startMs) {
    startMs = fullRange.startMs;
    endMs = addShanghaiCalendarYears(startMs, 3);
  }
  if (endMs > fullRange.endMs) {
    endMs = fullRange.endMs;
    startMs = addShanghaiCalendarYears(endMs, -3);
  }
  return { range: { startMs, endMs }, clipped: true };
}

export function viewportCenterTime(
  scale: TimeScale,
  scrollLeftPx: number,
  viewportWidthPx: number,
): number {
  return xToTime(scrollLeftPx + viewportWidthPx / 2, scale);
}

export function scrollLeftForCenter(
  scale: TimeScale,
  centerMs: number,
  viewportWidthPx: number,
): number {
  return Math.max(
    0,
    Math.min(
      timeToX(centerMs, scale) - viewportWidthPx / 2,
      Math.max(0, scale.contentWidthPx - viewportWidthPx),
    ),
  );
}

export function shiftViewportByRatio(input: {
  scale: TimeScale;
  scrollLeftPx: number;
  viewportWidthPx: number;
  direction: -1 | 1;
  ratio?: number;
}): number {
  const maximum = Math.max(0, input.scale.contentWidthPx - input.viewportWidthPx);
  return Math.max(
    0,
    Math.min(
      input.scrollLeftPx + input.direction * input.viewportWidthPx * (input.ratio ?? 0.8),
      maximum,
    ),
  );
}

export function floorShanghaiDay(timeMs: number, stepMs = DAY_MS): number {
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
