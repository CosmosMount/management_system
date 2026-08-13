import type { WorkSegment } from "@prisma/client";
import {
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import type { SegmentForMutation } from "@/lib/project-management/application/segment-record";

const MAX_SEGMENT_MS = 31 * 24 * 60 * 60 * 1_000;

export function assertPlannedEditable(
  segment: SegmentForMutation,
  message: string,
) {
  if (
    segment.type !== "PLANNED" ||
    segment.deletedAt ||
    segment.status === "CONFIRMED" ||
    segment.status === "CANCELLED"
  ) {
    throw stateConflictError(message);
  }
}

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

export function assertCoverageInsideSegment(
  segment: Pick<WorkSegment, "startAt" | "endAt">,
  coveredStartAt: Date,
  coveredEndAt: Date,
) {
  if (
    coveredEndAt <= coveredStartAt ||
    coveredStartAt < segment.startAt ||
    coveredEndAt > segment.endAt
  ) {
    throw validationError("来源覆盖范围不能超出 Planned Segment", {
      sources: ["来源覆盖范围不能超出 Planned Segment"],
    });
  }
}

export function assertMergeCompatible(segments: SegmentForMutation[]) {
  const first = segments[0];
  if (!first) throw validationError("至少选择两条 Planned Segment");
  let currentEnd = first.endAt;
  for (const segment of segments) {
    if (
      segment.personId !== first.personId ||
      segment.type !== first.type ||
      segment.content !== first.content ||
      segment.priority !== first.priority ||
      segment.taskId !== first.taskId ||
      segment.expectedOutput !== first.expectedOutput
    ) {
      throw validationError("只能合并同人同语义的 Planned Segment", {
        segments: ["只能合并同人同语义的 Planned Segment"],
      });
    }
    if (segment !== first && segment.startAt > currentEnd) {
      throw validationError("只能合并时间相邻或重叠的 Planned Segment", {
        segments: ["只能合并时间相邻或重叠的 Planned Segment"],
      });
    }
    if (segment.endAt > currentEnd) currentEnd = segment.endAt;
  }
}

export function plannedStatusForRange(
  startAt: Date,
  endAt: Date,
  now = new Date(),
): WorkSegment["status"] {
  if (endAt <= now) return "PENDING_CONFIRMATION";
  if (startAt <= now && endAt > now) return "IN_PROGRESS";
  return "PLANNED";
}

export function plannedStatusAfterMove(
  segment: SegmentForMutation,
  startAt: Date,
  endAt: Date,
): WorkSegment["status"] {
  if (
    segment.status === "PLANNED" ||
    segment.status === "IN_PROGRESS" ||
    segment.status === "PENDING_CONFIRMATION"
  ) {
    return plannedStatusForRange(startAt, endAt);
  }
  return segment.status;
}
