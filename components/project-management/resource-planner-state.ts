import {
  layoutIntervalLanes,
  rowHeightForLaneCount,
} from "@/components/project-management/time-canvas/lane-layout";
import { DAY_MS } from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasModel,
  TimeCanvasRange,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import type { TimeCanvasCachedBlock } from "@/components/project-management/time-canvas/block-cache";
import { TIME_CANVAS_VIEWPORT_STATE_EVENT } from "@/components/project-management/time-canvas/viewport-state-link";
import { removeRetiredResourcePlanSearchParams } from "@/lib/project-management/resource-plan-url";

export type CachedBlock = TimeCanvasCachedBlock<
  TimeCanvasModel["segments"][number]
>;
export type FailedBlock = {
  key: string;
  range: TimeCanvasRange;
  requestRange: TimeCanvasRange;
  message: string;
  kind: "LOAD" | "CAPACITY" | "CONFLICT";
};

export function createInitialBlocks(model: TimeCanvasModel): CachedBlock[] {
  const ranges = model.loadedRanges?.length
    ? model.loadedRanges
    : [model.range];
  return ranges.map((range, index) => ({
    key: blockKey(range),
    range,
    segments: model.segments.filter(
      (segment) => segment.startMs < range.endMs && segment.endMs > range.startMs,
    ),
    touchedAt: index,
    leafBlockCount: model.loadedLeafBlockCounts?.[index] ?? 1,
  }));
}
export function createInitialFailedBlocks(model: TimeCanvasModel): FailedBlock[] {
  return (model.failedRanges ?? []).map((failedRange) => {
    const requestRange = model.loadedRanges?.find(
      (range) =>
        failedRange.startMs >= range.startMs && failedRange.endMs <= range.endMs,
    ) ?? failedRange;
    return {
      key: failedRangeKey(requestRange, failedRange),
      range: failedRange,
      requestRange,
      message: failedRange.message,
      kind: "LOAD",
    };
  });
}
export function failedRangeKey(
  requestRange: { startMs: number; endMs: number },
  failedRange: { startMs: number; endMs: number },
) {
  return `${blockKey(requestRange)}:failed:${blockKey(failedRange)}`;
}

export function blockRangesForViewport(
  logicalRange: { startMs: number; endMs: number },
  viewport: { startMs: number; endMs: number },
) {
  const blockMs = 180 * DAY_MS;
  const firstVisibleIndex = Math.max(
    0,
    Math.floor((Math.max(logicalRange.startMs, viewport.startMs) - logicalRange.startMs) / blockMs),
  );
  const lastVisibleIndex = Math.max(
    firstVisibleIndex,
    Math.floor(
      (Math.min(logicalRange.endMs, viewport.endMs) - 1 - logicalRange.startMs) /
        blockMs,
    ),
  );
  const maximumIndex = Math.max(
    0,
    Math.ceil((logicalRange.endMs - logicalRange.startMs) / blockMs) - 1,
  );
  const ranges = [];
  for (
    let index = Math.max(0, firstVisibleIndex - 1);
    index <= Math.min(maximumIndex, lastVisibleIndex + 1);
    index += 1
  ) {
    const startMs = logicalRange.startMs + index * blockMs;
    ranges.push({
      startMs,
      endMs: Math.min(logicalRange.endMs, startMs + blockMs),
    });
  }
  const viewportCenter = (viewport.startMs + viewport.endMs) / 2;
  return ranges.sort((left, right) => {
    const leftVisible = left.startMs < viewport.endMs && left.endMs > viewport.startMs;
    const rightVisible = right.startMs < viewport.endMs && right.endMs > viewport.startMs;
    if (leftVisible !== rightVisible) return leftVisible ? -1 : 1;
    const leftCenter = (left.startMs + left.endMs) / 2;
    const rightCenter = (right.startMs + right.endMs) / 2;
    return Math.abs(leftCenter - viewportCenter) - Math.abs(rightCenter - viewportCenter) ||
      left.startMs - right.startMs;
  });
}

export function blockKey(range: { startMs: number; endMs: number }) {
  return `${range.startMs}:${range.endMs}`;
}

export function mergeBlockRanges(
  primary: TimeCanvasRange[],
  additional: TimeCanvasRange[],
) {
  const ranges = new Map<string, TimeCanvasRange>();
  for (const range of [...primary, ...additional]) {
    ranges.set(blockKey(range), range);
  }
  return [...ranges.values()];
}

export function plannedRangeFromMutation(data: unknown): TimeCanvasRange | null {
  if (!data || typeof data !== "object" || !("segment" in data)) return null;
  const segment = data.segment;
  if (!segment || typeof segment !== "object") return null;
  const record = segment as Record<string, unknown>;
  if (
    record.type !== "PLANNED" ||
    record.status === "CONFIRMED" ||
    record.status === "CANCELLED" ||
    typeof record.startAt !== "string" ||
    typeof record.endAt !== "string"
  ) {
    return null;
  }
  const startMs = Date.parse(record.startAt);
  const endMs = Date.parse(record.endAt);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? { startMs, endMs }
    : null;
}

export function replaceViewportUrl({
  centerMs,
  zoom,
}: {
  centerMs?: number;
  zoom: TimeCanvasZoom;
}) {
  const url = new URL(window.location.href);
  if (typeof centerMs === "number" && Number.isFinite(centerMs)) {
    url.searchParams.set("center", new Date(centerMs).toISOString());
  }
  url.searchParams.set("scale", zoom.toLowerCase());
  url.searchParams.delete("date");
  url.searchParams.delete("mode");
  url.searchParams.delete("zoom");
  normalizeResourcePlanUrl(url);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}?${url.searchParams.toString()}`,
  );
  window.dispatchEvent(new Event(TIME_CANVAS_VIEWPORT_STATE_EVENT));
}

export function normalizeResourcePlanUrl(url: URL) {
  if (url.pathname === "/progress/resources") {
    removeRetiredResourcePlanSearchParams(url.searchParams);
  }
}

export function viewportCenterFromCurrentUrl() {
  const value = new URL(window.location.href).searchParams.get("center");
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function centerFallsWithinRange(
  centerMs: number | undefined,
  range: TimeCanvasRange,
): centerMs is number {
  return typeof centerMs === "number" &&
    Number.isFinite(centerMs) &&
    centerMs >= range.startMs &&
    centerMs < range.endMs;
}

export function resizeRowsForSegments(
  rows: TimeCanvasModel["rows"],
  segments: TimeCanvasModel["segments"],
) {
  return rows.map((row) => {
    if (row.kind === "PLAN") return row;
    const layout = layoutIntervalLanes(
      segments
        .filter((segment) => segment.rowId === row.id)
        .map((segment) => ({
          id: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
        })),
    );
    return { ...row, height: rowHeightForLaneCount(layout.laneCount) };
  });
}
