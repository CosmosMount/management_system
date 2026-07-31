import type {
  ResourceConflictKind,
  ResourceConflictSeverity,
  TaskPriority,
  WorkSegmentRole,
  WorkSegmentStatus,
  WorkSegmentType,
} from "@prisma/client";

export const ACTIVE_PLANNED_CONFLICT_STATUSES = [
  "PLANNED",
  "IN_PROGRESS",
  "PENDING_CONFIRMATION",
] as const satisfies readonly WorkSegmentStatus[];

export type ConflictDetectionSegment = {
  id: string;
  type: WorkSegmentType;
  status: WorkSegmentStatus;
  startAt: Date;
  endAt: Date;
  allocation: number | null;
  priority: TaskPriority;
  role: WorkSegmentRole;
  taskId: string | null;
  associationNeedsReview: boolean;
  deleted: boolean;
};

export type DetectedResourceConflict = {
  kind: ResourceConflictKind;
  severity: ResourceConflictSeverity;
  personId: string;
  startAt: Date;
  endAt: Date;
  /** Stable sorted IDs used by persistence and fingerprinting. */
  segmentIds: string[];
  /** Original detector order used to preserve scanner explanation payloads. */
  evidenceSegmentIds: string[];
  reason: string;
  allocationTotal?: number;
  missingAllocationSegmentIds?: string[];
};

export function detectResourceConflictsForSegments(
  personId: string,
  range: { startAt: Date; endAt: Date },
  segments: ConflictDetectionSegment[],
): DetectedResourceConflict[] {
  const events = new Map<
    number,
    { starts: ConflictDetectionSegment[]; ends: ConflictDetectionSegment[] }
  >();
  for (const segment of segments) {
    addSweepEvent(events, segment.startAt.getTime(), "starts", segment);
    addSweepEvent(events, segment.endAt.getTime(), "ends", segment);
  }
  const points = [...events.keys()].sort((left, right) => left - right);
  const merged: DetectedResourceConflict[] = [];
  const latestByMergeKey = new Map<string, DetectedResourceConflict>();
  const state = createSweepState();

  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined || next === undefined || next <= point) continue;
    const event = events.get(point);
    event?.ends.forEach((segment) => removeSweepSegment(state, segment));
    event?.starts.forEach((segment) => addSweepSegment(state, segment));
    if (next <= range.startAt.getTime() || point >= range.endAt.getTime()) {
      continue;
    }
    for (const detected of detectConflictsInSweepSlice(
      personId,
      new Date(point),
      new Date(next),
      state,
    )) {
      const mergeKey = [
        detected.kind,
        detected.severity,
        detected.segmentIds.join("|"),
      ].join(":");
      const existing = latestByMergeKey.get(mergeKey);
      if (existing && existing.endAt.getTime() === detected.startAt.getTime()) {
        existing.endAt = detected.endAt;
      } else {
        latestByMergeKey.set(mergeKey, detected);
        merged.push(detected);
      }
    }
  }
  return merged;
}

type DetectionSweepState = {
  planned: Map<string, ConflictDetectionSegment>;
  actual: Map<string, ConflictDetectionSegment>;
  plannedWithAllocation: Map<string, ConflictDetectionSegment>;
  missingAllocation: Map<string, ConflictDetectionSegment>;
  highPriority: Map<string, ConflictDetectionSegment>;
  ownerLead: Map<string, ConflictDetectionSegment>;
  ownerLeadTaskCounts: Map<string, number>;
  needsReview: Map<string, ConflictDetectionSegment>;
  actualWithAllocation: Map<string, ConflictDetectionSegment>;
  plannedAllocationTotal: number;
  actualAllocationTotal: number;
};

function createSweepState(): DetectionSweepState {
  return {
    planned: new Map(),
    actual: new Map(),
    plannedWithAllocation: new Map(),
    missingAllocation: new Map(),
    highPriority: new Map(),
    ownerLead: new Map(),
    ownerLeadTaskCounts: new Map(),
    needsReview: new Map(),
    actualWithAllocation: new Map(),
    plannedAllocationTotal: 0,
    actualAllocationTotal: 0,
  };
}

function addSweepEvent(
  events: Map<
    number,
    { starts: ConflictDetectionSegment[]; ends: ConflictDetectionSegment[] }
  >,
  at: number,
  kind: "starts" | "ends",
  segment: ConflictDetectionSegment,
) {
  const event = events.get(at) ?? { starts: [], ends: [] };
  event[kind].push(segment);
  events.set(at, event);
}

function addSweepSegment(
  state: DetectionSweepState,
  segment: ConflictDetectionSegment,
) {
  if (segment.deleted) return;
  if (
    segment.type === "PLANNED" &&
    isActivePlannedStatus(segment.status)
  ) {
    state.planned.set(segment.id, segment);
    if (segment.allocation === null) {
      state.missingAllocation.set(segment.id, segment);
    } else {
      state.plannedWithAllocation.set(segment.id, segment);
      state.plannedAllocationTotal = addAllocation(
        state.plannedAllocationTotal,
        segment.allocation,
      );
    }
    if (segment.priority === "CRITICAL" || segment.priority === "HIGH") {
      state.highPriority.set(segment.id, segment);
    }
    if (
      (segment.role === "OWNER" || segment.role === "LEAD") &&
      segment.taskId
    ) {
      state.ownerLead.set(segment.id, segment);
      state.ownerLeadTaskCounts.set(
        segment.taskId,
        (state.ownerLeadTaskCounts.get(segment.taskId) ?? 0) + 1,
      );
    }
    if (segment.associationNeedsReview) {
      state.needsReview.set(segment.id, segment);
    }
    return;
  }
  if (segment.type === "ACTUAL" && segment.status === "CONFIRMED") {
    state.actual.set(segment.id, segment);
    if (segment.allocation !== null) {
      state.actualWithAllocation.set(segment.id, segment);
      state.actualAllocationTotal = addAllocation(
        state.actualAllocationTotal,
        segment.allocation,
      );
    }
  }
}

function removeSweepSegment(
  state: DetectionSweepState,
  segment: ConflictDetectionSegment,
) {
  if (state.planned.delete(segment.id)) {
    if (state.missingAllocation.delete(segment.id)) {
      // No aggregate to update.
    } else if (state.plannedWithAllocation.delete(segment.id)) {
      state.plannedAllocationTotal = addAllocation(
        state.plannedAllocationTotal,
        -(segment.allocation ?? 0),
      );
    }
    state.highPriority.delete(segment.id);
    state.needsReview.delete(segment.id);
    if (state.ownerLead.delete(segment.id) && segment.taskId) {
      const remaining = (state.ownerLeadTaskCounts.get(segment.taskId) ?? 1) - 1;
      if (remaining === 0) state.ownerLeadTaskCounts.delete(segment.taskId);
      else state.ownerLeadTaskCounts.set(segment.taskId, remaining);
    }
  }
  if (state.actual.delete(segment.id)) {
    if (state.actualWithAllocation.delete(segment.id)) {
      state.actualAllocationTotal = addAllocation(
        state.actualAllocationTotal,
        -(segment.allocation ?? 0),
      );
    }
  }
}

function addAllocation(total: number, delta: number): number {
  return Math.round((total + delta) * 100) / 100;
}

function detectConflictsInSweepSlice(
  personId: string,
  startAt: Date,
  endAt: Date,
  state: DetectionSweepState,
): DetectedResourceConflict[] {
  const detected: DetectedResourceConflict[] = [];
  if (
    state.plannedWithAllocation.size > 1 &&
    state.plannedAllocationTotal > 100
  ) {
    const plannedWithAllocation = [...state.plannedWithAllocation.values()];
    detected.push(
      detectedConflict({
        kind: "ALLOCATION_OVER_LIMIT",
        severity:
          state.plannedAllocationTotal >= 150 ? "CRITICAL" : "HIGH",
        personId,
        startAt,
        endAt,
        segments: plannedWithAllocation,
        reason: `Planned Allocation 合计 ${state.plannedAllocationTotal}% 超过 100%`,
        allocationTotal: state.plannedAllocationTotal,
      }),
    );
  }

  if (state.planned.size > 1 && state.missingAllocation.size > 0) {
    const planned = [...state.planned.values()];
    detected.push(
      detectedConflict({
        kind: "MISSING_ALLOCATION",
        severity: "MEDIUM",
        personId,
        startAt,
        endAt,
        segments: planned,
        reason:
          "同一时间段存在重叠 Planned Segment，且至少一条未填写 Allocation",
        missingAllocationSegmentIds: [...state.missingAllocation.keys()],
      }),
    );
  }

  if (state.highPriority.size > 1) {
    const highPriority = [...state.highPriority.values()];
    detected.push(
      detectedConflict({
        kind: "HIGH_PRIORITY_OVERLAP",
        severity: highPriority.some(
          (segment) => segment.priority === "CRITICAL",
        )
          ? "CRITICAL"
          : "HIGH",
        personId,
        startAt,
        endAt,
        segments: highPriority,
        reason: "多个高优先级 Planned Segment 时间重叠",
      }),
    );
  }

  if (state.ownerLeadTaskCounts.size > 1) {
    const ownerLeadAcrossTasks = [...state.ownerLead.values()];
    detected.push(
      detectedConflict({
        kind: "LEAD_ROLE_OVERLAP",
        severity: ownerLeadAcrossTasks.some(
          (segment) => segment.role === "OWNER",
        )
          ? "HIGH"
          : "MEDIUM",
        personId,
        startAt,
        endAt,
        segments: ownerLeadAcrossTasks,
        reason: "Owner/Lead 职责跨 Task 高度重叠",
      }),
    );
  }

  if (state.needsReview.size > 0 && state.planned.size > 1) {
    detected.push(
      detectedConflict({
        kind: "REVISION_OVERLAP",
        severity: "MEDIUM",
        personId,
        startAt,
        endAt,
        segments: [...state.planned.values()],
        reason: "Revision 后待重关联 Planned Segment 与其他计划重叠",
      }),
    );
  }

  if (
    state.actualWithAllocation.size > 1 &&
    state.actualAllocationTotal > 100
  ) {
    const actualWithAllocation = [...state.actualWithAllocation.values()];
    detected.push(
      detectedConflict({
        kind: "ACTUAL_OVERLOAD",
        severity: state.actualAllocationTotal >= 150 ? "HIGH" : "MEDIUM",
        personId,
        startAt,
        endAt,
        segments: actualWithAllocation,
        reason: `Actual Allocation 合计 ${state.actualAllocationTotal}% 超过 100%`,
        allocationTotal: state.actualAllocationTotal,
      }),
    );
  }

  return detected;
}

function detectedConflict(input: {
  kind: ResourceConflictKind;
  severity: ResourceConflictSeverity;
  personId: string;
  startAt: Date;
  endAt: Date;
  segments: ConflictDetectionSegment[];
  reason: string;
  allocationTotal?: number;
  missingAllocationSegmentIds?: string[];
}): DetectedResourceConflict {
  return {
    kind: input.kind,
    severity: input.severity,
    personId: input.personId,
    startAt: input.startAt,
    endAt: input.endAt,
    segmentIds: input.segments.map((segment) => segment.id).sort(),
    evidenceSegmentIds: input.segments.map((segment) => segment.id),
    reason: input.reason,
    ...(input.allocationTotal === undefined
      ? {}
      : { allocationTotal: input.allocationTotal }),
    ...(input.missingAllocationSegmentIds === undefined
      ? {}
      : {
          missingAllocationSegmentIds: input.missingAllocationSegmentIds,
        }),
  };
}

function isActivePlannedStatus(
  status: WorkSegmentStatus,
): status is (typeof ACTIVE_PLANNED_CONFLICT_STATUSES)[number] {
  return ACTIVE_PLANNED_CONFLICT_STATUSES.some((value) => value === status);
}
