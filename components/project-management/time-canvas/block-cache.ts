export const TIME_CANVAS_CACHE_OBJECT_LIMIT = 20_000;
export const TIME_CANVAS_CACHE_LEAF_BLOCK_LIMIT = 16;

export type TimeCanvasCachedBlock<T extends { id: string }> = {
  key: string;
  range: { startMs: number; endMs: number };
  segments: T[];
  touchedAt: number;
  leafBlockCount: number;
};

export type TimeCanvasCacheResult<T extends { id: string }> = {
  blocks: Array<TimeCanvasCachedBlock<T>>;
  objectCount: number;
  leafBlockCount: number;
  candidateAccepted: boolean;
};

export function mergeTimeCanvasVersionedSegments<
  T extends { id: string; versionToken?: string | null },
>(blocks: Array<TimeCanvasCachedBlock<T>>) {
  const byId = new Map<string, { segment: T; blockKey: string }>();
  const conflictBlockKeys = new Set<string>();
  for (const block of blocks) {
    for (const segment of block.segments) {
      const current = byId.get(segment.id);
      if (!current) {
        byId.set(segment.id, { segment, blockKey: block.key });
        continue;
      }
      const currentVersion = current.segment.versionToken ?? "";
      const nextVersion = segment.versionToken ?? "";
      if (nextVersion > currentVersion) {
        byId.set(segment.id, { segment, blockKey: block.key });
        continue;
      }
      if (
        nextVersion === currentVersion &&
        JSON.stringify(segment) !== JSON.stringify(current.segment)
      ) {
        conflictBlockKeys.add(current.blockKey);
        conflictBlockKeys.add(block.key);
      }
    }
  }
  return {
    segments: [...byId.values()].map((value) => value.segment),
    conflictBlockKeys: [...conflictBlockKeys].sort(),
  };
}

export function pruneTimeCanvasBlockCache<T extends { id: string }>({
  blocks,
  viewport,
  pinnedIds,
  candidateKey,
}: {
  blocks: Array<TimeCanvasCachedBlock<T>>;
  viewport: { startMs: number; endMs: number };
  pinnedIds: Iterable<string>;
  candidateKey: string;
}): TimeCanvasCacheResult<T> {
  const uniqueBlocks = [...new Map(blocks.map((block) => [block.key, block])).values()];
  const viewportCenter = (viewport.startMs + viewport.endMs) / 2;
  const ids = new Set(pinnedIds);
  const distanceFromViewport = (block: TimeCanvasCachedBlock<T>) => {
    if (rangesIntersect(block.range, viewport)) return 0;
    if (block.range.endMs <= viewport.startMs) {
      return viewport.startMs - block.range.endMs;
    }
    return block.range.startMs - viewport.endMs;
  };
  const byDistanceThenRecency = (
    left: TimeCanvasCachedBlock<T>,
    right: TimeCanvasCachedBlock<T>,
  ) =>
    distanceFromViewport(left) - distanceFromViewport(right) ||
    right.touchedAt - left.touchedAt ||
    left.key.localeCompare(right.key);

  const visible = uniqueBlocks
    .filter((block) => rangesIntersect(block.range, viewport))
    .sort((left, right) => {
      const leftCenter = (left.range.startMs + left.range.endMs) / 2;
      const rightCenter = (right.range.startMs + right.range.endMs) / 2;
      return Math.abs(leftCenter - viewportCenter) - Math.abs(rightCenter - viewportCenter) ||
        byDistanceThenRecency(left, right);
    });
  const before = uniqueBlocks
    .filter((block) => block.range.endMs <= viewport.startMs)
    .sort(byDistanceThenRecency)[0];
  const after = uniqueBlocks
    .filter((block) => block.range.startMs >= viewport.endMs)
    .sort(byDistanceThenRecency)[0];
  const pinned = uniqueBlocks
    .filter((block) => block.segments.some((segment) => ids.has(segment.id)))
    .sort(byDistanceThenRecency)[0];
  const remaining = [...uniqueBlocks].sort(byDistanceThenRecency);
  const prioritized = uniqueByKey([
    ...visible,
    ...(before ? [before] : []),
    ...(after ? [after] : []),
    ...(pinned ? [pinned] : []),
    ...remaining,
  ]);

  const kept: Array<TimeCanvasCachedBlock<T>> = [];
  let objectCount = 0;
  let leafBlockCount = 0;
  for (const block of prioritized) {
    const nextObjectCount = objectCount + block.segments.length;
    const nextLeafBlockCount = leafBlockCount + Math.max(0, block.leafBlockCount);
    if (
      nextObjectCount > TIME_CANVAS_CACHE_OBJECT_LIMIT ||
      nextLeafBlockCount > TIME_CANVAS_CACHE_LEAF_BLOCK_LIMIT
    ) {
      continue;
    }
    kept.push(block);
    objectCount = nextObjectCount;
    leafBlockCount = nextLeafBlockCount;
  }

  return {
    blocks: kept,
    objectCount,
    leafBlockCount,
    candidateAccepted: kept.some((block) => block.key === candidateKey),
  };
}

function rangesIntersect(
  first: { startMs: number; endMs: number },
  second: { startMs: number; endMs: number },
) {
  return first.startMs < second.endMs && first.endMs > second.startMs;
}

function uniqueByKey<T extends { key: string }>(items: T[]) {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    result.push(item);
  }
  return result;
}
