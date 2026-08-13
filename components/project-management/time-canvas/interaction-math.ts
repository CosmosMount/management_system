import { layoutIntervalLanes } from "@/components/project-management/time-canvas/lane-layout";
import {
  createTimeScale,
  rangesIntersect,
} from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasProps,
  TimeCanvasSegment,
} from "@/components/project-management/time-canvas/types";

export function clampTime(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

type CanvasFocusTarget = {
  key: string;
  rowIndex: number;
  atMs: number;
};

export function buildCanvasFocusTargets(
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

export function nextFocusTarget(
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

export function segmentFocusKey(id: string) {
  return `segment:${id}`;
}

export function anchorFocusKey(id: string) {
  return `anchor:${id}`;
}

export function overflowFocusKey(rowId: string, placementId: string) {
  return `overflow:${rowId}:${placementId}`;
}

export function normalizeBrushRange(
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

export function transformedRange(
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
