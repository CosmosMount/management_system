import { createHash } from "node:crypto";
import type {
  Prisma,
  ResourceConflictKind,
  ResourceConflictSeverity,
  ResourceConflictStatus,
  TaskMemberRole,
} from "@prisma/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountIdsTx,
  recipientsForPersonIdsTx,
  uniqueRecipientsByAccount,
} from "@/lib/project-management/application/notification-utils";
import { canFullyHandleConflict } from "@/lib/project-management/application/conflict-permissions";
import {
  movePlannedSegmentsTx,
  type BatchSegmentMutationResult,
} from "@/lib/project-management/application/segment-service";
import {
  notFoundError,
  stateConflictError,
  toProjectManagementServiceError,
  validationError,
  type ProjectManagementErrorCode,
} from "@/lib/project-management/application/errors";
import {
  acknowledgeConflictInputSchema,
  applyConflictSuggestionInputSchema,
  ignoreConflictInputSchema,
  previewConflictSuggestionInputSchema,
  resolveConflictInputSchema,
  scanConflictsForPersonInputSchema,
  scanResourceConflictsInputSchema,
  type ApplyConflictSuggestionInput,
  type ScanConflictsForPersonInput,
  type ScanResourceConflictsInput,
} from "@/lib/project-management/validations/segments";

type PrismaTx = Prisma.TransactionClient;

const activePlannedStatuses = ["PLANNED", "IN_PROGRESS", "PENDING_CONFIRMATION"] as const;
const priorityRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

const conflictSegmentInclude = {
  person: { select: { id: true, displayName: true, accountId: true } },
  task: {
    select: {
      id: true,
      title: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      allowSelfReview: true,
      currentPlanVersionId: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  },
} satisfies Prisma.WorkSegmentInclude;

const conflictInclude = {
  person: { select: { displayName: true } },
  segments: {
    include: {
      segment: { include: conflictSegmentInclude },
    },
  },
} satisfies Prisma.ResourceConflictInclude;

type ConflictSegment = Prisma.WorkSegmentGetPayload<{
  include: typeof conflictSegmentInclude;
}>;
type ConflictForMutation = Prisma.ResourceConflictGetPayload<{
  include: typeof conflictInclude;
}>;
type TaskForAuthorization = NonNullable<ConflictSegment["task"]>;

type DetectedConflict = {
  kind: ResourceConflictKind;
  severity: ResourceConflictSeverity;
  startAt: Date;
  endAt: Date;
  personId: string;
  segmentIds: string[];
  explanation: Prisma.InputJsonObject;
  fingerprint: string;
};

export type ConflictScanResult = {
  personId: string;
  detectedCount: number;
  createdCount: number;
  reopenedCount: number;
  resolvedCount: number;
  unchangedCount: number;
};

export type ConflictScanFailure = {
  personId: string;
  code: ProjectManagementErrorCode;
  message: string;
};

export type ResourceConflictScanResult = {
  scannedPersonCount: number;
  succeededPersonCount: number;
  failedPersonCount: number;
  detectedCount: number;
  createdCount: number;
  reopenedCount: number;
  resolvedCount: number;
  unchangedCount: number;
  results: ConflictScanResult[];
  failures: ConflictScanFailure[];
};

export type ResourceConflictMutationResult = {
  conflictId: string;
  status: ResourceConflictStatus;
};

export type ConflictSuggestionPreview = {
  conflictId: string;
  suggestions: Array<{
    proposalId: string;
    title: string;
    moves: Array<{
      segmentId: string;
      expectedUpdatedAt: string;
      startAt: string;
      endAt: string;
    }>;
  }>;
};

export async function scanConflictsForPerson(
  input: unknown,
): Promise<ConflictScanResult> {
  const parsed = scanConflictsForPersonInputSchema.parse(input);
  return prisma.$transaction((tx) => scanConflictsForPersonTx(tx, parsed));
}

export async function scanResourceConflicts(
  input: unknown,
): Promise<ResourceConflictScanResult> {
  const parsed = scanResourceConflictsInputSchema.parse(input);
  const explicitPersonIds =
    parsed.personIds && parsed.personIds.length > 0
      ? [...new Set(parsed.personIds)].sort()
      : null;
  const personIds = explicitPersonIds
    ? await prisma.$transaction(async (tx) => {
        await assertPersonsScannableTx(tx, explicitPersonIds);
        return explicitPersonIds;
      })
    : (
        await prisma.$transaction((tx) =>
          personIdsWithSegmentsInRangeTx(tx, parsed),
        )
      ).sort();
  const results: ConflictScanResult[] = [];
  const failures: ConflictScanFailure[] = [];
  for (const personId of personIds) {
    try {
      results.push(
        await prisma.$transaction((tx) =>
          scanConflictsForPersonTx(tx, {
            personId,
            startAt: parsed.startAt,
            endAt: parsed.endAt,
          }),
        ),
      );
    } catch (error) {
      const mapped = toProjectManagementServiceError(error);
      const failure = {
        personId,
        code: mapped.code,
        message: mapped.message,
      } satisfies ConflictScanFailure;
      failures.push(failure);
      logger[mapped.code === "INTERNAL_ERROR" ? "error" : "warn"](
        "project_management.resource_conflicts.scan.person_failed",
        {
          module: "project-management",
          action: "scanResourceConflicts",
          personId,
          result: "failure",
          errorCode: failure.code,
          errorMessage: failure.message,
        },
      );
    }
  }
  const result: ResourceConflictScanResult = {
    scannedPersonCount: personIds.length,
    succeededPersonCount: results.length,
    failedPersonCount: failures.length,
    detectedCount: results.reduce((sum, result) => sum + result.detectedCount, 0),
    createdCount: results.reduce((sum, result) => sum + result.createdCount, 0),
    reopenedCount: results.reduce((sum, result) => sum + result.reopenedCount, 0),
    resolvedCount: results.reduce((sum, result) => sum + result.resolvedCount, 0),
    unchangedCount: results.reduce((sum, result) => sum + result.unchangedCount, 0),
    results,
    failures,
  };
  return result;
}

export async function scanResourceConflictsForDefaultWindow(now = new Date()) {
  const startAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
  const endAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000);
  const result = await scanResourceConflicts({ startAt, endAt });
  if (result.failedPersonCount > 0) {
    logger.warn("project_management.resource_conflicts.scan.default_window_partial", {
      module: "cron",
      action: "scanResourceConflictsForDefaultWindow",
      result: "failure",
      scannedPersonCount: result.scannedPersonCount,
      succeededPersonCount: result.succeededPersonCount,
      failedPersonCount: result.failedPersonCount,
      failureCodes: result.failures.map((failure) => failure.code),
    });
  }
  return result;
}

export async function acknowledgeConflict(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ResourceConflictMutationResult> {
  const parsed = acknowledgeConflictInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockConflictWithPersonTx(tx, parsed.conflictId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanAcknowledgeConflict(refreshedActor, conflict);
    if (conflict.status === "ACKNOWLEDGED") {
      return { conflictId: conflict.id, status: conflict.status };
    }
    if (conflict.status !== "OPEN") {
      throw stateConflictError("只有开放中的冲突可以确认已知");
    }
    const updated = await tx.resourceConflict.update({
      where: { id: conflict.id },
      data: {
        status: "ACKNOWLEDGED",
        acknowledgedAt: new Date(),
        resolutionNote: parsed.note,
      },
      select: { id: true, status: true },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.conflict.acknowledge",
      entityType: "ResourceConflict",
      entityId: conflict.id,
      before: jsonValue({ status: conflict.status }),
      after: jsonValue({ status: updated.status }),
      reason: parsed.note,
    });
    return { conflictId: updated.id, status: updated.status };
  });
}

export async function resolveConflict(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ResourceConflictMutationResult> {
  const parsed = resolveConflictInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockConflictWithPersonTx(tx, parsed.conflictId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanResolveConflict(refreshedActor, conflict);
    if (conflict.status === "RESOLVED") {
      return { conflictId: conflict.id, status: conflict.status };
    }
    await assertChangedSegmentsVisibleTx(tx, refreshedActor, parsed.changedSegmentIds);
    const updated = await markConflictResolvedTx(tx, {
      actor: refreshedActor,
      conflict,
      resolutionNote: parsed.resolutionNote,
      changedSegmentIds: parsed.changedSegmentIds,
      action: "pm.conflict.resolve",
    });
    await notifyConflictResolvedTx(tx, updated);
    return { conflictId: updated.id, status: updated.status };
  });
}

export async function ignoreConflict(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ResourceConflictMutationResult> {
  const parsed = ignoreConflictInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockConflictWithPersonTx(tx, parsed.conflictId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanResolveConflict(refreshedActor, conflict);
    if (parsed.ignoredUntil <= new Date()) {
      throw validationError("忽略截止时间必须晚于当前时间", {
        ignoredUntil: ["忽略截止时间必须晚于当前时间"],
      });
    }
    if (conflict.status === "RESOLVED") {
      throw stateConflictError("已解决的冲突不能忽略");
    }
    if (
      conflict.status === "IGNORED" &&
      conflict.ignoredUntil?.getTime() === parsed.ignoredUntil.getTime() &&
      conflict.resolutionNote === parsed.reason
    ) {
      return { conflictId: conflict.id, status: conflict.status };
    }
    const updated = await tx.resourceConflict.update({
      where: { id: conflict.id },
      data: {
        status: "IGNORED",
        ignoredUntil: parsed.ignoredUntil,
        resolvedByAccountId: refreshedActor.accountId,
        resolutionNote: parsed.reason,
        explanation: mergeExplanation(conflict.explanation, {
          ignoredReason: parsed.reason,
          ignoredUntil: parsed.ignoredUntil.toISOString(),
        }),
      },
      select: { id: true, status: true },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.conflict.ignore",
      entityType: "ResourceConflict",
      entityId: conflict.id,
      before: jsonValue({ status: conflict.status }),
      after: jsonValue({
        status: updated.status,
        ignoredUntil: parsed.ignoredUntil.toISOString(),
      }),
      reason: parsed.reason,
    });
    return { conflictId: updated.id, status: updated.status };
  });
}

export async function previewConflictSuggestion(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ConflictSuggestionPreview> {
  const parsed = previewConflictSuggestionInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockConflictWithPersonTx(tx, parsed.conflictId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanResolveConflict(refreshedActor, conflict);
    if (conflict.status === "RESOLVED") {
      return { conflictId: conflict.id, suggestions: [] };
    }
    const plannedSegments = conflict.segments
      .map((entry) => entry.segment)
      .filter(
        (segment) =>
          segment.type === "PLANNED" &&
          isActivePlannedStatus(segment.status) &&
          !segment.deletedAt,
      )
      .sort(compareSegmentsForSuggestion);
    if (plannedSegments.length < 2) {
      return { conflictId: conflict.id, suggestions: [] };
    }
    const keep = plannedSegments[0];
    if (!keep) return { conflictId: conflict.id, suggestions: [] };
    let cursor = new Date(conflict.endAt);
    const moves = plannedSegments.slice(1).map((segment) => {
      const duration = segment.endAt.getTime() - segment.startAt.getTime();
      const startAt = cursor;
      const endAt = new Date(startAt.getTime() + duration);
      cursor = endAt;
      return {
        segmentId: segment.id,
        expectedUpdatedAt: segment.updatedAt.toISOString(),
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      };
    });
    return {
      conflictId: conflict.id,
      suggestions: [
        {
          proposalId: "move-lower-priority-after-conflict",
          title: "将较低优先级计划顺延到冲突结束后",
          moves,
        },
      ],
    };
  });
}

export async function applyConflictSuggestion(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ResourceConflictMutationResult & { movedSegments: BatchSegmentMutationResult }> {
  const parsed = applyConflictSuggestionInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockConflictWithPersonTx(tx, parsed.conflictId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanResolveConflict(refreshedActor, conflict);
    assertProposalOnlyTouchesConflictSegments(conflict, parsed);
    if (conflict.status === "RESOLVED") {
      throw stateConflictError("已解决的冲突不能再次应用建议");
    }
    const movedSegments = await movePlannedSegmentsTx(tx, refreshedActor, {
      moves: parsed.proposal.moves.map((move) => ({
        ...move,
        startAt: move.startAt,
        endAt: move.endAt,
      })),
      reason: "应用资源冲突处理建议",
    });
    const updated = await markConflictResolvedTx(tx, {
      actor: refreshedActor,
      conflict,
      resolutionNote: "已应用资源冲突处理建议",
      changedSegmentIds: movedSegments.affectedSegmentIds,
      action: "pm.conflict.apply_suggestion",
    });
    await notifyConflictResolvedTx(tx, updated);
    return {
      conflictId: updated.id,
      status: updated.status,
      movedSegments,
    };
  });
}

async function scanConflictsForPersonTx(
  tx: PrismaTx,
  input: ScanConflictsForPersonInput,
): Promise<ConflictScanResult> {
  const person = await tx.person.findUnique({
    where: { id: input.personId },
    select: { id: true, status: true },
  });
  if (!person || person.status !== "ACTIVE") {
    throw validationError("人员不存在或已停用", {
      personId: ["人员不存在或已停用"],
    });
  }
  await lockConflictPersonTx(tx, input.personId);
  const segments = await loadSegmentsForScanTx(tx, input);
  const detected = detectConflictsForSegments(input.personId, input, segments);
  const detectedByFingerprint = new Map(
    detected.map((conflict) => [conflict.fingerprint, conflict]),
  );
  let createdCount = 0;
  let reopenedCount = 0;
  let unchangedCount = 0;
  for (const conflict of detected) {
    const result = await upsertDetectedConflictTx(tx, conflict);
    if (result === "created") createdCount += 1;
    else if (result === "reopened") reopenedCount += 1;
    else unchangedCount += 1;
  }
  const resolvedCount = await resolveObsoleteConflictsTx(tx, {
    personId: input.personId,
    startAt: input.startAt,
    endAt: input.endAt,
    activeFingerprints: detectedByFingerprint,
  });
  return {
    personId: input.personId,
    detectedCount: detected.length,
    createdCount,
    reopenedCount,
    resolvedCount,
    unchangedCount,
  };
}

async function personIdsWithSegmentsInRangeTx(
  tx: PrismaTx,
  input: ScanResourceConflictsInput,
) {
  const rows = await tx.workSegment.findMany({
    where: {
      person: { status: "ACTIVE" },
      deletedAt: null,
      startAt: { lt: input.endAt },
      endAt: { gt: input.startAt },
      OR: [
        { type: "PLANNED", status: { in: [...activePlannedStatuses] } },
        { type: "ACTUAL", status: "CONFIRMED" },
      ],
    },
    select: { personId: true },
    distinct: ["personId"],
  });
  return rows.map((row) => row.personId);
}

async function assertPersonsScannableTx(tx: PrismaTx, personIds: string[]) {
  if (personIds.length === 0) return;
  const people = await tx.person.findMany({
    where: { id: { in: personIds } },
    select: { id: true, status: true },
  });
  const activePersonIds = new Set(
    people
      .filter((person) => person.status === "ACTIVE")
      .map((person) => person.id),
  );
  if (activePersonIds.size !== personIds.length) {
    throw validationError("扫描人员不存在或已停用", {
      personIds: ["扫描人员不存在或已停用"],
    });
  }
}

async function loadSegmentsForScanTx(
  tx: PrismaTx,
  input: ScanConflictsForPersonInput,
) {
  return tx.workSegment.findMany({
    where: {
      personId: input.personId,
      deletedAt: null,
      startAt: { lt: input.endAt },
      endAt: { gt: input.startAt },
      OR: [
        { type: "PLANNED", status: { in: [...activePlannedStatuses] } },
        { type: "ACTUAL", status: "CONFIRMED" },
      ],
    },
    include: conflictSegmentInclude,
  });
}

function detectConflictsForSegments(
  personId: string,
  range: { startAt: Date; endAt: Date },
  segments: ConflictSegment[],
): DetectedConflict[] {
  const points = [
    ...new Set(
      segments.flatMap((segment) => [
        segment.startAt.getTime(),
        segment.endAt.getTime(),
      ]),
    ),
  ].sort((left, right) => left - right);
  const mergedConflicts: DetectedConflict[] = [];
  const latestByMergeKey = new Map<string, DetectedConflict>();
  const active = new Map<string, ConflictSegment>();
  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined || next === undefined || next <= point) continue;
    if (next <= range.startAt.getTime() || point >= range.endAt.getTime()) continue;
    for (const segment of segments) {
      if (segment.endAt.getTime() <= point) active.delete(segment.id);
      if (segment.startAt.getTime() <= point && segment.endAt.getTime() > point) {
        active.set(segment.id, segment);
      }
    }
    for (const detected of detectConflictsInSlice(
      personId,
      new Date(point),
      new Date(next),
      [...active.values()],
    )) {
      const mergeKey = [
        detected.kind,
        detected.severity,
        detected.segmentIds.join("|"),
      ].join(":");
      const existing = latestByMergeKey.get(mergeKey);
      if (existing && existing.endAt.getTime() === detected.startAt.getTime()) {
        existing.endAt = detected.endAt;
        existing.fingerprint = fingerprintConflict(existing);
        existing.explanation = {
          ...existing.explanation,
          endAt: existing.endAt.toISOString(),
        };
      } else {
        latestByMergeKey.set(mergeKey, detected);
        mergedConflicts.push(detected);
      }
    }
  }
  return mergedConflicts.map((conflict) => ({
    ...conflict,
    fingerprint: fingerprintConflict(conflict),
  }));
}

function detectConflictsInSlice(
  personId: string,
  startAt: Date,
  endAt: Date,
  activeSegments: ConflictSegment[],
): DetectedConflict[] {
  const detected: Omit<DetectedConflict, "fingerprint">[] = [];
  const planned = activeSegments.filter(
    (segment) =>
      segment.type === "PLANNED" &&
      isActivePlannedStatus(segment.status) &&
      !segment.deletedAt,
  );
  const actual = activeSegments.filter(
    (segment) =>
      segment.type === "ACTUAL" &&
      segment.status === "CONFIRMED" &&
      !segment.deletedAt,
  );
  const plannedWithAllocation = planned.filter((segment) => segment.allocation != null);
  const plannedAllocationTotal = plannedWithAllocation.reduce(
    (sum, segment) => sum + decimalToNumber(segment.allocation),
    0,
  );
  if (plannedWithAllocation.length > 1 && plannedAllocationTotal > 100) {
    detected.push(
      detectedConflict({
        kind: "ALLOCATION_OVER_LIMIT",
        severity: plannedAllocationTotal >= 150 ? "CRITICAL" : "HIGH",
        personId,
        startAt,
        endAt,
        segments: plannedWithAllocation,
        reason: `Planned Allocation 合计 ${plannedAllocationTotal}% 超过 100%`,
        extra: { allocationTotal: plannedAllocationTotal },
      }),
    );
  }

  const missingAllocation = planned.filter((segment) => segment.allocation == null);
  if (planned.length > 1 && missingAllocation.length > 0) {
    detected.push(
      detectedConflict({
        kind: "MISSING_ALLOCATION",
        severity: "MEDIUM",
        personId,
        startAt,
        endAt,
        segments: planned,
        reason: "同一时间段存在重叠 Planned Segment，且至少一条未填写 Allocation",
        extra: { missingAllocationSegmentIds: missingAllocation.map((segment) => segment.id) },
      }),
    );
  }

  const highPriority = planned.filter(
    (segment) => segment.priority === "CRITICAL" || segment.priority === "HIGH",
  );
  if (highPriority.length > 1) {
    detected.push(
      detectedConflict({
        kind: "HIGH_PRIORITY_OVERLAP",
        severity: highPriority.some((segment) => segment.priority === "CRITICAL")
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

  const ownerLeadAcrossTasks = planned.filter(
    (segment) =>
      (segment.role === "OWNER" || segment.role === "LEAD") && Boolean(segment.taskId),
  );
  if (new Set(ownerLeadAcrossTasks.map((segment) => segment.taskId)).size > 1) {
    detected.push(
      detectedConflict({
        kind: "LEAD_ROLE_OVERLAP",
        severity: ownerLeadAcrossTasks.some((segment) => segment.role === "OWNER")
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

  const needsReview = planned.filter((segment) => segment.associationNeedsReview);
  if (needsReview.length > 0 && planned.length > 1) {
    detected.push(
      detectedConflict({
        kind: "REVISION_OVERLAP",
        severity: "MEDIUM",
        personId,
        startAt,
        endAt,
        segments: planned,
        reason: "Revision 后待重关联 Planned Segment 与其他计划重叠",
      }),
    );
  }

  const actualWithAllocation = actual.filter((segment) => segment.allocation != null);
  const actualAllocationTotal = actualWithAllocation.reduce(
    (sum, segment) => sum + decimalToNumber(segment.allocation),
    0,
  );
  if (actualWithAllocation.length > 1 && actualAllocationTotal > 100) {
    detected.push(
      detectedConflict({
        kind: "ACTUAL_OVERLOAD",
        severity: actualAllocationTotal >= 150 ? "HIGH" : "MEDIUM",
        personId,
        startAt,
        endAt,
        segments: actualWithAllocation,
        reason: `Actual Allocation 合计 ${actualAllocationTotal}% 超过 100%`,
        extra: { allocationTotal: actualAllocationTotal },
      }),
    );
  }

  return detected.map((conflict) => ({
    ...conflict,
    fingerprint: fingerprintConflict(conflict),
  }));
}

function detectedConflict(input: {
  kind: ResourceConflictKind;
  severity: ResourceConflictSeverity;
  personId: string;
  startAt: Date;
  endAt: Date;
  segments: ConflictSegment[];
  reason: string;
  extra?: Record<string, unknown>;
}): Omit<DetectedConflict, "fingerprint"> {
  const segmentIds = input.segments.map((segment) => segment.id).sort();
  return {
    kind: input.kind,
    severity: input.severity,
    personId: input.personId,
    startAt: input.startAt,
    endAt: input.endAt,
    segmentIds,
    explanation: jsonObject({
      kind: input.kind,
      reason: input.reason,
      startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(),
      segmentIds,
      segments: input.segments.map((segment) => ({
        id: segment.id,
        content: segment.content,
        type: segment.type,
        status: segment.status,
        allocation: decimalToNumber(segment.allocation),
        priority: segment.priority,
        role: segment.role,
        taskId: segment.taskId,
      })),
      ...(input.extra ?? {}),
    }),
  };
}

async function upsertDetectedConflictTx(
  tx: PrismaTx,
  detected: DetectedConflict,
): Promise<"created" | "reopened" | "unchanged"> {
  let existing = await tx.resourceConflict.findUnique({
    where: { fingerprint: detected.fingerprint },
    include: { segments: true },
  });
  if (!existing) {
    const created = await tx.resourceConflict.create({
      data: {
        personId: detected.personId,
        kind: detected.kind,
        startAt: detected.startAt,
        endAt: detected.endAt,
        severity: detected.severity,
        status: "OPEN",
        fingerprint: detected.fingerprint,
        explanation: detected.explanation,
        segments: {
          create: detected.segmentIds.map((segmentId) => ({ segmentId })),
        },
      },
      include: conflictInclude,
    });
    await createDomainAuditEventTx(tx, {
      action: "pm.conflict.scan",
      entityType: "ResourceConflict",
      entityId: created.id,
      after: jsonValue({
        status: "OPEN",
        kind: detected.kind,
        severity: detected.severity,
        segmentIds: detected.segmentIds,
      }),
      reason: "扫描发现资源冲突",
      source: "CRON",
    });
    await notifyConflictOpenedTx(tx, created);
    return "created";
  }
  await lockConflictTx(tx, existing.id);
  existing = await tx.resourceConflict.findUniqueOrThrow({
    where: { id: existing.id },
    include: { segments: true },
  });

  const ignoredStillActive =
    existing.status === "IGNORED" &&
    existing.ignoredUntil != null &&
    existing.ignoredUntil > new Date();
  const manuallyResolved =
    existing.status === "RESOLVED" &&
    !(await wasAutomaticallyResolvedTx(tx, existing));
  if (ignoredStillActive || manuallyResolved) return "unchanged";
  const shouldReopen =
    existing.status === "RESOLVED" ||
    existing.status === "IGNORED";
  const nextStatus = shouldReopen ? "OPEN" : existing.status;
  const detectedAt = new Date();
  await tx.resourceConflict.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      startAt: detected.startAt,
      endAt: detected.endAt,
      severity: detected.severity,
      explanation: detected.explanation,
      detectedAt,
      ...(nextStatus === "OPEN"
        ? {
            resolvedAt: null,
            acknowledgedAt: null,
            ignoredUntil: null,
            resolvedByAccountId: null,
            resolutionNote: "",
          }
        : {}),
    },
  });
  await tx.conflictSegment.deleteMany({ where: { conflictId: existing.id } });
  await tx.conflictSegment.createMany({
    data: detected.segmentIds.map((segmentId) => ({
      conflictId: existing.id,
      segmentId,
    })),
    skipDuplicates: true,
  });
  if (shouldReopen) {
    const reopened = await loadConflictForMutationTx(tx, existing.id);
    await createDomainAuditEventTx(tx, {
      action: "pm.conflict.scan",
      entityType: "ResourceConflict",
      entityId: existing.id,
      before: jsonValue({ status: existing.status }),
      after: jsonValue({ status: nextStatus, severity: detected.severity }),
      reason: "扫描重新打开资源冲突",
      source: "CRON",
    });
    await notifyConflictOpenedTx(tx, reopened, {
      eventKey: `pm:conflict:opened:${reopened.fingerprint}:reopened:${detectedAt.toISOString()}`,
    });
    return "reopened";
  }
  return "unchanged";
}

async function wasAutomaticallyResolvedTx(
  tx: PrismaTx,
  conflict: Pick<ConflictForMutation, "id" | "resolvedAt">,
) {
  if (!conflict.resolvedAt) return false;
  const resolutionAudits = await tx.domainAuditEvent.findMany({
    where: {
      entityType: "ResourceConflict",
      entityId: conflict.id,
      action: { in: ["pm.conflict.resolve", "pm.conflict.apply_suggestion"] },
      createdAt: { gte: conflict.resolvedAt },
    },
    orderBy: { createdAt: "asc" },
    take: 2,
    select: { action: true, source: true, createdAt: true },
  });
  if (resolutionAudits.length !== 1) return false;
  const resolutionAudit = resolutionAudits[0];
  return (
    resolutionAudit?.action === "pm.conflict.resolve" &&
    resolutionAudit.source === "CRON"
  );
}

async function resolveObsoleteConflictsTx(
  tx: PrismaTx,
  input: {
    personId: string;
    startAt: Date;
    endAt: Date;
    activeFingerprints: Map<string, DetectedConflict>;
  },
) {
  const openConflicts = await tx.resourceConflict.findMany({
    where: {
      personId: input.personId,
      status: { in: ["OPEN", "ACKNOWLEDGED", "IGNORED"] },
      startAt: { lt: input.endAt },
      endAt: { gt: input.startAt },
    },
    include: conflictInclude,
  });
  let resolvedCount = 0;
  for (const conflict of openConflicts) {
    if (input.activeFingerprints.has(conflict.fingerprint)) continue;
    if (
      conflict.status === "IGNORED" &&
      conflict.ignoredUntil != null &&
      conflict.ignoredUntil > new Date()
    ) {
      continue;
    }
    const resolutionAudit = await createDomainAuditEventTx(tx, {
      action: "pm.conflict.resolve",
      entityType: "ResourceConflict",
      entityId: conflict.id,
      before: jsonValue({ status: conflict.status }),
      after: jsonValue({ status: "RESOLVED" }),
      reason: "扫描确认冲突已解除",
      source: "CRON",
    });
    const updated = await tx.resourceConflict.update({
      where: { id: conflict.id },
      data: {
        status: "RESOLVED",
        // Keep the provenance lower bound on the audit row's database clock.
        resolvedAt: resolutionAudit.createdAt,
        resolvedByAccountId: null,
        resolutionNote: "扫描确认冲突已解除",
      },
      include: conflictInclude,
    });
    await notifyConflictResolvedTx(tx, updated);
    resolvedCount += 1;
  }
  return resolvedCount;
}

async function markConflictResolvedTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    conflict: ConflictForMutation;
    resolutionNote: string;
    changedSegmentIds: string[];
    action: string;
  },
) {
  const updated = await tx.resourceConflict.update({
    where: { id: input.conflict.id },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolvedByAccountId: input.actor.accountId,
      resolutionNote: input.resolutionNote,
      explanation: mergeExplanation(input.conflict.explanation, {
        resolutionNote: input.resolutionNote,
        changedSegmentIds: input.changedSegmentIds,
      }),
    },
    include: conflictInclude,
  });
  await createDomainAuditEventTx(tx, {
    actorAccountId: input.actor.accountId,
    actorPersonId: input.actor.personId,
    action: input.action,
    entityType: "ResourceConflict",
    entityId: input.conflict.id,
    before: jsonValue({ status: input.conflict.status }),
    after: jsonValue({
      status: "RESOLVED",
      changedSegmentIds: input.changedSegmentIds,
    }),
    reason: input.resolutionNote,
  });
  return updated;
}

async function notifyConflictOpenedTx(
  tx: PrismaTx,
  conflict: ConflictForMutation,
  options: { eventKey?: string } = {},
) {
  const recipients = await conflictRecipientsTx(tx, conflict);
  await createProjectManagementEventNotificationsTx(tx, {
    actorName: "系统",
    task: primaryTaskContext(conflict),
    kind: "resource_conflict_opened",
    category: "RESOURCE_CONFLICT",
    eventKey: options.eventKey ?? `pm:conflict:opened:${conflict.fingerprint}`,
    title: "发现资源冲突",
    summary: conflictSummary(conflict),
    entityType: "ResourceConflict",
    entityId: conflict.id,
    linkPath: "/progress/resources/conflicts",
    mandatory: conflict.severity === "HIGH" || conflict.severity === "CRITICAL",
    recipients,
    context: {
      conflictKind: conflict.kind,
      severity: conflict.severity,
      startAt: conflict.startAt.toISOString(),
      endAt: conflict.endAt.toISOString(),
    },
  });
}

async function notifyConflictResolvedTx(
  tx: PrismaTx,
  conflict: ConflictForMutation,
) {
  const recipients = await recipientsForPersonIdsTx(tx, [conflict.personId]);
  await createProjectManagementEventNotificationsTx(tx, {
    actorName: "系统",
    task: primaryTaskContext(conflict),
    kind: "resource_conflict_resolved",
    category: "RESOURCE_CONFLICT",
    eventKey: `pm:conflict:resolved:${conflict.id}:${conflict.updatedAt.toISOString()}`,
    title: "资源冲突已解决",
    summary: conflictSummary(conflict),
    entityType: "ResourceConflict",
    entityId: conflict.id,
    linkPath: "/progress/resources/conflicts",
    mandatory: false,
    recipients,
    context: {
      conflictKind: conflict.kind,
      severity: conflict.severity,
      status: conflict.status,
    },
  });
}

async function conflictRecipientsTx(
  tx: PrismaTx,
  conflict: ConflictForMutation,
) {
  const personRecipients = await recipientsForPersonIdsTx(tx, [conflict.personId]);
  const taskById = new Map<string, TaskForAuthorization>();
  for (const entry of conflict.segments) {
    if (entry.segment.task) taskById.set(entry.segment.task.id, entry.segment.task);
  }
  const tasks = [...taskById.values()];
  const ownerPersonIds = tasks.flatMap((task) =>
    task.members
      .filter((member) => member.role === "OWNER")
      .map((member) => member.personId),
  );
  const ownerRecipients = await recipientsForPersonIdsTx(tx, ownerPersonIds);
  const managerAccountIds = await managerAccountIdsForTasksTx(tx, tasks);
  const managerRecipients = await recipientsForAccountIdsTx(tx, managerAccountIds);
  return uniqueRecipientsByAccount([
    ...personRecipients,
    ...ownerRecipients,
    ...managerRecipients,
  ]);
}

async function managerAccountIdsForTasksTx(
  tx: PrismaTx,
  tasks: TaskForAuthorization[],
) {
  if (tasks.length === 0) return [];
  const scopeFilters = tasks.flatMap((task) => [
    { team: task.team, techGroup: task.techGroup },
    { team: task.team, techGroup: "" },
    { team: "", techGroup: task.techGroup },
  ]);
  const roles = await tx.systemRoleAssignment.findMany({
    where: {
      revokedAt: null,
      role: { in: ["RESOURCE_MANAGER", "TEAM_ADMINISTRATOR"] },
      OR: scopeFilters,
    },
    select: { accountId: true },
  });
  return roles.map((role) => role.accountId);
}

function primaryTaskContext(conflict: ConflictForMutation) {
  const task = conflict.segments.map((entry) => entry.segment.task).find(Boolean);
  return task
    ? {
        id: task.id,
        title: task.title,
        status: task.status,
        currentPlanVersionId: task.currentPlanVersionId,
      }
    : null;
}

async function assertChangedSegmentsVisibleTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  segmentIds: string[],
) {
  if (segmentIds.length === 0) return;
  const rows = await tx.workSegment.findMany({
    where: { id: { in: [...new Set(segmentIds)] } },
    include: conflictSegmentInclude,
  });
  if (rows.length !== new Set(segmentIds).size) throw notFoundError();
  for (const segment of rows) {
    assertSegmentVisible(actor, segment);
  }
}

function assertProposalOnlyTouchesConflictSegments(
  conflict: ConflictForMutation,
  input: ApplyConflictSuggestionInput,
) {
  const conflictSegmentIds = new Set(
    conflict.segments.map((entry) => entry.segmentId),
  );
  for (const move of input.proposal.moves) {
    if (!conflictSegmentIds.has(move.segmentId)) {
      throw validationError("冲突建议只能调整该冲突涉及的 Segment", {
        proposal: ["冲突建议只能调整该冲突涉及的 Segment"],
      });
    }
  }
}

async function refreshActorTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
): Promise<ProjectManagementActor> {
  const roles = await tx.systemRoleAssignment.findMany({
    where: { accountId: actor.accountId, revokedAt: null },
    select: { role: true, team: true, techGroup: true },
  });
  return { ...actor, systemRoles: roles };
}

async function lockConflictTx(tx: PrismaTx, conflictId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ResourceConflict" WHERE "id" = ${conflictId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFoundError();
}

async function lockConflictWithPersonTx(tx: PrismaTx, conflictId: string) {
  const conflict = await tx.resourceConflict.findUnique({
    where: { id: conflictId },
    select: { personId: true },
  });
  if (!conflict) throw notFoundError();
  await lockConflictPersonTx(tx, conflict.personId);
  await lockConflictTx(tx, conflictId);
}

async function lockConflictPersonTx(tx: PrismaTx, personId: string) {
  const digest = createHash("sha256")
    .update(`pm:resource-conflict:person:${personId}`)
    .digest();
  const namespaceKey = digest.readInt32BE(0);
  const personKey = digest.readInt32BE(4);
  await tx.$queryRaw<Array<{ locked: string }>>`
    SELECT pg_advisory_xact_lock(${namespaceKey}, ${personKey})::text AS "locked"
  `;
}

async function loadConflictForMutationTx(tx: PrismaTx, conflictId: string) {
  const conflict = await tx.resourceConflict.findUnique({
    where: { id: conflictId },
    include: conflictInclude,
  });
  if (!conflict) throw notFoundError();
  return conflict;
}

function assertConflictVisible(
  actor: ProjectManagementActor,
  conflict: ConflictForMutation,
) {
  if (conflict.personId === actor.personId) return;
  if (conflict.segments.some((entry) => segmentVisible(actor, entry.segment))) {
    return;
  }
  throw notFoundError();
}

function assertCanAcknowledgeConflict(
  actor: ProjectManagementActor,
  conflict: ConflictForMutation,
) {
  if (conflict.personId === actor.personId) return;
  assertCanResolveConflict(actor, conflict);
}

function assertCanResolveConflict(
  actor: ProjectManagementActor,
  conflict: ConflictForMutation,
) {
  if (canFullyHandleConflict(actor, conflict)) return;
  if (conflict.segments.some((entry) => !entry.segment.task)) {
    throw stateConflictError("包含无 Task 关联 Segment 的冲突只能由系统管理员处理");
  }
  if (conflict.segments.length === 0) {
    throw stateConflictError("无 Task 关联的冲突只能由系统管理员处理");
  }
  throw stateConflictError("你没有处理该资源冲突的权限");
}

function segmentVisible(actor: ProjectManagementActor, segment: ConflictSegment) {
  return authorize({
    actor,
    action: "segment.view",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskResource(segment.task) : null,
    },
  }).allowed;
}

function assertSegmentVisible(actor: ProjectManagementActor, segment: ConflictSegment) {
  if (!segmentVisible(actor, segment)) throw notFoundError();
}

function taskResource(task: TaskForAuthorization): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    allowSelfReview: task.allowSelfReview,
    members: task.members.map((member) => ({
      personId: member.personId,
      role: member.role as TaskMemberRole,
      removedAt: member.removedAt,
    })),
  };
}

function compareSegmentsForSuggestion(left: ConflictSegment, right: ConflictSegment) {
  const priorityDiff = priorityRank[right.priority] - priorityRank[left.priority];
  if (priorityDiff !== 0) return priorityDiff;
  const roleDiff = roleRank(right.role) - roleRank(left.role);
  if (roleDiff !== 0) return roleDiff;
  return left.startAt.getTime() - right.startAt.getTime();
}

function roleRank(role: string) {
  if (role === "OWNER") return 3;
  if (role === "LEAD") return 2;
  return 1;
}

function isActivePlannedStatus(status: string): status is (typeof activePlannedStatuses)[number] {
  return activePlannedStatuses.some((value) => value === status);
}

function fingerprintConflict(
  conflict: Pick<
    DetectedConflict,
    "kind" | "personId" | "startAt" | "endAt" | "segmentIds"
  >,
) {
  const basis = [
    "v1",
    conflict.kind,
    conflict.personId,
    conflict.startAt.toISOString(),
    conflict.endAt.toISOString(),
    [...conflict.segmentIds].sort().join(","),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex");
}

function conflictSummary(conflict: ConflictForMutation) {
  return `${conflict.kind} / ${conflict.severity}，${conflict.startAt.toISOString()} 至 ${conflict.endAt.toISOString()}`;
}

function decimalToNumber(value: Prisma.Decimal | null) {
  return value == null ? 0 : Number(value.toString());
}

function mergeExplanation(
  current: Prisma.JsonValue,
  patch: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base =
    current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return jsonValue({ ...base, ...patch });
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
