import { queryLimitExceededError } from "@/lib/project-management/application/errors";
import { DAY_MS, floorShanghaiDay } from "@/lib/project-management/time-canvas/time-math";
import { MAX_TIME_CANVAS_VISIBLE_SEGMENTS } from "@/lib/project-management/validations/time-canvas";

export async function loadBoundedAdaptiveLeaves<T>({
  ranges,
  loadRange,
}: {
  ranges: Array<{ startMs: number; endMs: number }>;
  loadRange: (range: { startMs: number; endMs: number }) => Promise<T[]>;
}) {
  const pending = [...ranges];
  const leaves: T[][] = [];
  const failedRanges: Array<{
    startMs: number;
    endMs: number;
    message: string;
  }> = [];
  let objectCount = 0;
  let queryCount = 0;
  while (pending.length > 0) {
    const range = pending.shift()!;
    if (queryCount >= 31) {
      throw queryLimitExceededError("时间对象过于密集，自动细分查询超过安全预算");
    }
    queryCount += 1;
    const values = await loadRange(range);
    if (values.length <= MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
      if (leaves.length + failedRanges.length >= 16) {
        throw queryLimitExceededError("时间对象过于密集，自动细分后超过 16 个数据块");
      }
      objectCount += values.length;
      if (objectCount > 20_000) {
        throw queryLimitExceededError("时间画布对象超过 20000 条缓存预算，请缩小筛选范围");
      }
      leaves.push(values);
      continue;
    }
    if (range.endMs - range.startMs <= DAY_MS) {
      if (leaves.length + failedRanges.length >= 16) {
        throw queryLimitExceededError("时间对象过于密集，自动细分后超过 16 个数据块");
      }
      failedRanges.push({
        ...range,
        message: "单个上海自然日内的时间对象超过 5000 条，请缩小筛选范围",
      });
      continue;
    }
    if (leaves.length + failedRanges.length + pending.length + 2 > 16) {
      throw queryLimitExceededError("时间对象过于密集，自动细分后超过 16 个数据块");
    }
    const middle = floorShanghaiDay((range.startMs + range.endMs) / 2);
    const split =
      middle > range.startMs && middle < range.endMs
        ? middle
        : Math.min(range.endMs, range.startMs + DAY_MS);
    pending.unshift(
      { startMs: range.startMs, endMs: split },
      { startMs: split, endMs: range.endMs },
    );
  }
  return {
    leaves,
    failedRanges: failedRanges.sort((left, right) => left.startMs - right.startMs),
    queryCount,
  };
}
