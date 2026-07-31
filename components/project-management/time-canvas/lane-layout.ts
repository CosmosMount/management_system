export type IntervalLaneInput = {
  id: string;
  startMs: number;
  endMs: number;
};

export type IntervalLanePlacement = IntervalLaneInput & {
  lane: number;
  aggregated: boolean;
  aggregatedIds: string[];
};

export type IntervalLaneLayout = {
  placements: IntervalLanePlacement[];
  laneCount: number;
  overflowIds: string[];
};

export function layoutIntervalLanes(
  intervals: IntervalLaneInput[],
  maximumVisibleLanes = 4,
): IntervalLaneLayout {
  const visibleLaneLimit = Math.max(1, Math.floor(maximumVisibleLanes));
  const laneEnds: number[] = [];
  const assigned: IntervalLanePlacement[] = [];
  const sorted = [...intervals]
    .filter((interval) => interval.endMs > interval.startMs)
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.endMs - right.endMs ||
        left.id.localeCompare(right.id),
    );

  for (const interval of sorted) {
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= interval.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(interval.endMs);
    } else {
      laneEnds[lane] = interval.endMs;
    }
    assigned.push({ ...interval, lane, aggregated: false, aggregatedIds: [] });
  }

  const hasOverflow = laneEnds.length > visibleLaneLimit;
  const firstOverflowLane = hasOverflow ? visibleLaneLimit - 1 : visibleLaneLimit;
  const placements = assigned.filter((item) => item.lane < firstOverflowLane);
  const overflowIds = assigned
    .filter((item) => item.lane >= firstOverflowLane)
    .map((item) => item.id);
  if (overflowIds.length > 0) {
    const overflowIdSet = new Set(overflowIds);
    const overflowIntervals = sorted.filter((item) => overflowIdSet.has(item.id));
    for (const component of connectedIntervalComponents(overflowIntervals)) {
      const componentIds = component.map((item) => item.id);
      placements.push({
        id: `overflow:${componentIds.join(":")}`,
        startMs: Math.min(...component.map((item) => item.startMs)),
        endMs: Math.max(...component.map((item) => item.endMs)),
        lane: firstOverflowLane,
        aggregated: true,
        aggregatedIds: componentIds,
      });
    }
  }

  placements.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.lane - right.lane ||
      left.id.localeCompare(right.id),
  );

  return {
    placements,
    laneCount: Math.min(Math.max(laneEnds.length, 1), visibleLaneLimit),
    overflowIds,
  };
}

function connectedIntervalComponents(intervals: IntervalLaneInput[]) {
  const components: IntervalLaneInput[][] = [];
  for (const interval of intervals) {
    const current = components.at(-1);
    if (!current) {
      components.push([interval]);
      continue;
    }
    const componentEnd = Math.max(...current.map((item) => item.endMs));
    if (interval.startMs < componentEnd) {
      current.push(interval);
    } else {
      components.push([interval]);
    }
  }
  return components;
}

export function layoutPointLanes(
  points: Array<{ id: string; atMs: number; sequence: number }>,
  minimumGapMs: number,
  maximumVisibleLanes = 4,
): Map<string, number> {
  const laneEnds: number[] = [];
  const result = new Map<string, number>();
  const sorted = [...points].sort(
    (left, right) =>
      left.atMs - right.atMs ||
      left.sequence - right.sequence ||
      left.id.localeCompare(right.id),
  );
  for (const point of sorted) {
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= point.atMs);
    if (lane === -1) lane = laneEnds.length;
    const visibleLane = Math.min(lane, Math.max(1, maximumVisibleLanes) - 1);
    result.set(point.id, visibleLane);
    laneEnds[lane] = point.atMs + Math.max(0, minimumGapMs);
  }
  return result;
}

export function rowHeightForLaneCount(
  laneCount: number,
  options: { base?: number; increment?: number; maximum?: number } = {},
) {
  const base = options.base ?? 48;
  const increment = options.increment ?? 24;
  const maximum = options.maximum ?? 120;
  return Math.min(maximum, base + Math.max(0, laneCount - 1) * increment);
}
