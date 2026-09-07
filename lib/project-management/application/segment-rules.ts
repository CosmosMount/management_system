import { validationError } from "@/lib/project-management/application/errors";

const MAX_SEGMENT_MS = 31 * 24 * 60 * 60 * 1_000;

export function assertValidSegmentRange(startAt: Date, endAt: Date) {
  if (endAt <= startAt) {
    throw validationError("结束时间必须晚于开始时间", {
      endAt: ["结束时间必须晚于开始时间"],
    });
  }
  if (endAt.getTime() - startAt.getTime() > MAX_SEGMENT_MS) {
    throw validationError("单条投入记录最长 31 天", {
      endAt: ["单条投入记录最长 31 天"],
    });
  }
}
