import type { TimeCanvasRange } from "./types";
import { clampLogicalRangeToThreeYears, floorShanghaiDay, padShanghaiCalendarRange } from "./time-math";

export function resolveContentNavigationWindow({
  contentRange,
  businessContentRange,
  preferredCenterMs,
  includePreferredCenterInFullRange = false,
  now = Date.now(),
}: {
  contentRange: TimeCanvasRange | null;
  businessContentRange: TimeCanvasRange | null;
  preferredCenterMs?: number;
  includePreferredCenterInFullRange?: boolean;
  now?: number;
}) {
  const requestedCenterMs = preferredCenterMs !== undefined && Number.isFinite(preferredCenterMs) ? preferredCenterMs : null;
  const seedStart = floorShanghaiDay(requestedCenterMs ?? now);
  const contentNavigationRange = padShanghaiCalendarRange(contentRange, 2, seedStart);
  const businessNavigationRange = businessContentRange ? padShanghaiCalendarRange(businessContentRange, 2, seedStart) : null;
  const todayNavigationRange = padShanghaiCalendarRange(null, 2, now);
  const preferredCenterNavigationRange = includePreferredCenterInFullRange && requestedCenterMs !== null
    ? padShanghaiCalendarRange(null, 2, requestedCenterMs) : null;
  const fullRange = {
    startMs: Math.min(contentNavigationRange.startMs, todayNavigationRange.startMs, preferredCenterNavigationRange?.startMs ?? Number.POSITIVE_INFINITY),
    endMs: Math.max(contentNavigationRange.endMs, todayNavigationRange.endMs, preferredCenterNavigationRange?.endMs ?? Number.NEGATIVE_INFINITY),
  };
  const fallbackCenterMs = businessNavigationRange && now >= businessNavigationRange.startMs && now < businessNavigationRange.endMs
    ? now : (businessContentRange?.startMs ?? contentRange?.startMs ?? (contentNavigationRange.startMs + contentNavigationRange.endMs) / 2);
  const resolvedCenterMs = requestedCenterMs !== null && requestedCenterMs >= fullRange.startMs && requestedCenterMs < fullRange.endMs
    ? requestedCenterMs : fallbackCenterMs;
  const logical = clampLogicalRangeToThreeYears(fullRange, resolvedCenterMs);
  return { fullRange, resolvedCenterMs, range: logical.range, rangeClipped: logical.clipped };
}
