import { createHash } from "node:crypto";
import {
  Prisma,
  type ResourceConflictKind,
  type ResourceConflictSeverity,
  type ResourceConflictStatus,
  type TaskMemberRole,
} from "@prisma/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { assertProjectAccessActiveTx } from "@/lib/project-management/identity";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountIdsTx,
  recipientsForPersonIdsTx,
  uniqueRecipientsByAccount,
} from "@/lib/project-management/application/notification-utils";
import {
  lockConflictsForRangesTx,
  prepareConflictMutationTx,
  type ConflictMutationRange,
} from "@/lib/project-management/application/conflict-lock-protocol";
import { canFullyHandleConflict } from "@/lib/project-management/application/conflict-permissions";
import {
  ACTIVE_PLANNED_CONFLICT_STATUSES,
  detectResourceConflictsForSegments,
} from "@/lib/project-management/domain/conflict-detection";
import {
  moveConflictSuggestionSegmentsTx,
  type BatchSegmentMutationResult,
} from "@/lib/project-management/application/segment-service";
import {
  notFoundError,
  staleSegmentError,
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

const priorityRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
const CONFLICT_SUGGESTION_PROPOSAL_ID =
  "move-lower-priority-after-conflict";
const CONFLICT_SUGGESTION_TITLE = "将较低优先级计划顺延到冲突结束后";

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
    let conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanAcknowledgeConflict(refreshedActor, conflict);
    await lockConflictSegmentsTx(tx, conflict);
    conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
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
    let conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanResolveConflict(refreshedActor, conflict);
    await lockConflictSegmentsTx(tx, conflict);
    conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
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
    await notifyConflictResolvedTx(tx, updated, refreshedActor);
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
    let conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanResolveConflict(refreshedActor, conflict);
    await lockConflictSegmentsTx(tx, conflict);
    conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
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
    await lockConflictSegmentsTx(tx, conflict);
    const lockedConflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, lockedConflict);
    assertCanResolveConflict(refreshedActor, lockedConflict);
    const suggestion = buildCanonicalConflictSuggestion(lockedConflict);
    if (!suggestion) return { conflictId: conflict.id, suggestions: [] };
    return {
      conflictId: conflict.id,
      suggestions: [
        {
          proposalId: suggestion.proposalId,
          title: suggestion.title,
          moves: suggestion.moves.map((move) => ({
            segmentId: move.segment.id,
            expectedUpdatedAt: move.segment.updatedAt.toISOString(),
            startAt: move.startAt.toISOString(),
            endAt: move.endAt.toISOString(),
          })),
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
    const preparedRanges = await lockConflictWithPersonTx(
      tx,
      parsed.conflictId,
      true,
    );
    const refreshedActor = await refreshActorTx(tx, actor);
    const visibleConflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, visibleConflict);
    assertCanResolveConflict(refreshedActor, visibleConflict);
    if (visibleConflict.status === "RESOLVED") {
      throw stateConflictError("已解决的冲突不能再次应用建议");
    }
    await lockConflictSegmentsTx(tx, visibleConflict);
    const conflict = await loadConflictForMutationTx(tx, parsed.conflictId);
    assertConflictVisible(refreshedActor, conflict);
    assertCanResolveConflict(refreshedActor, conflict);
    if (conflict.status === "RESOLVED") {
      throw stateConflictError("已解决的冲突不能再次应用建议");
    }
    const canonicalSuggestion = buildCanonicalConflictSuggestion(conflict);
    assertCanonicalConflictSuggestion(parsed, canonicalSuggestion);
    if (!canonicalSuggestion) {
      throw stateConflictError("冲突处理建议已变化，请刷新后重试");
    }
    const movedSegments = await moveConflictSuggestionSegmentsTx(
      tx,
      refreshedActor,
      conflict.id,
      {
        moves: canonicalSuggestion.moves.map((move) => ({
          segmentId: move.segment.id,
          expectedUpdatedAt: move.segment.updatedAt,
          startAt: move.startAt,
          endAt: move.endAt,
        })),
        reason: "应用资源冲突处理建议",
      },
    );
    const updated = await markConflictResolvedTx(tx, {
      actor: refreshedActor,
      conflict,
      resolutionNote: "已应用资源冲突处理建议",
      changedSegmentIds: movedSegments.affectedSegmentIds,
      action: "pm.conflict.apply_suggestion",
    });
    await notifyConflictResolvedTx(tx, updated, refreshedActor);
    await rescanConflictsForRangesTx(tx, preparedRanges, { locksHeld: true });
    return {
      conflictId: updated.id,
      status: updated.status,
      movedSegments,
    };
  });
}

export async function scanConflictsForPersonTx(
  tx: PrismaTx,
  input: ScanConflictsForPersonInput,
  options: { locksHeld?: boolean } = {},
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
  if (!options.locksHeld) {
    await prepareConflictMutationTx(tx, [input]);
  }
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

export async function rescanConflictsForRangesTx(
  tx: PrismaTx,
  ranges: ConflictMutationRange[],
  options: { locksHeld?: boolean } = {},
): Promise<ConflictScanResult[]> {
  const preparedRanges = options.locksHeld
    ? ranges
    : await prepareConflictMutationTx(tx, ranges);
  const results: ConflictScanResult[] = [];
  for (const range of preparedRanges) {
    results.push(
      await scanConflictsForPersonTx(tx, range, { locksHeld: true }),
    );
  }
  return results;
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
        {
          type: "PLANNED",
          status: { in: [...ACTIVE_PLANNED_CONFLICT_STATUSES] },
        },
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
        {
          type: "PLANNED",
          status: { in: [...ACTIVE_PLANNED_CONFLICT_STATUSES] },
        },
        { type: "ACTUAL", status: "CONFIRMED" },
      ],
    },
    include: conflictSegmentInclude,
    orderBy: [{ startAt: "asc" }, { endAt: "asc" }, { id: "asc" }],
  });
}

function detectConflictsForSegments(
  personId: string,
  range: { startAt: Date; endAt: Date },
  segments: ConflictSegment[],
): DetectedConflict[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return detectResourceConflictsForSegments(
    personId,
    range,
    segments.map((segment) => ({
      id: segment.id,
      type: segment.type,
      status: segment.status,
      startAt: segment.startAt,
      endAt: segment.endAt,
      allocation:
        segment.allocation === null ? null : Number(segment.allocation.toString()),
      priority: segment.priority,
      role: segment.role,
      taskId: segment.taskId,
      associationNeedsReview: segment.associationNeedsReview,
      deleted: segment.deletedAt !== null,
    })),
  ).map((detected) => {
    const evidence = detected.evidenceSegmentIds.flatMap((segmentId) => {
      const segment = byId.get(segmentId);
      return segment ? [segment] : [];
    });
    const extra = {
      ...(detected.allocationTotal === undefined
        ? {}
        : { allocationTotal: detected.allocationTotal }),
      ...(detected.missingAllocationSegmentIds === undefined
        ? {}
        : {
            missingAllocationSegmentIds:
              detected.missingAllocationSegmentIds,
          }),
    };
    const conflict: DetectedConflict = {
      kind: detected.kind,
      severity: detected.severity,
      personId: detected.personId,
      startAt: detected.startAt,
      endAt: detected.endAt,
      segmentIds: detected.segmentIds,
      explanation: jsonObject({
        kind: detected.kind,
        reason: detected.reason,
        startAt: detected.startAt.toISOString(),
        endAt: detected.endAt.toISOString(),
        segmentIds: detected.segmentIds,
        segments: evidence.map((segment) => ({
          id: segment.id,
          content: segment.content,
          type: segment.type,
          status: segment.status,
          allocation:
            segment.allocation === null
              ? 0
              : Number(segment.allocation.toString()),
          priority: segment.priority,
          role: segment.role,
          taskId: segment.taskId,
        })),
        ...extra,
      }),
      fingerprint: "",
    };
    conflict.fingerprint = fingerprintConflict(conflict);
    return conflict;
  });
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
  actor?: ProjectManagementActor,
) {
  const recipients = await recipientsForPersonIdsTx(tx, [conflict.personId]);
  await createProjectManagementEventNotificationsTx(tx, {
    actor,
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
      role: {
        in: ["GROUP_LEADER"],
      },
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

function assertCanonicalConflictSuggestion(
  input: ApplyConflictSuggestionInput,
  canonical: ReturnType<typeof buildCanonicalConflictSuggestion>,
) {
  if (
    !canonical ||
    input.proposal.proposalId !== canonical.proposalId ||
    input.proposal.moves.length !== canonical.moves.length
  ) {
    throw stateConflictError("冲突处理建议已变化，请刷新后重试");
  }
  for (const [index, canonicalMove] of canonical.moves.entries()) {
    const submittedMove = input.proposal.moves[index];
    if (!submittedMove || submittedMove.segmentId !== canonicalMove.segment.id) {
      throw stateConflictError("冲突处理建议已变化，请刷新后重试");
    }
    if (
      submittedMove.expectedUpdatedAt.getTime() !==
      canonicalMove.segment.updatedAt.getTime()
    ) {
      throw staleSegmentError(canonicalMove.segment);
    }
    if (
      submittedMove.startAt.getTime() !== canonicalMove.startAt.getTime() ||
      submittedMove.endAt.getTime() !== canonicalMove.endAt.getTime()
    ) {
      throw stateConflictError("冲突处理建议已变化，请刷新后重试");
    }
  }
}

function buildCanonicalConflictSuggestion(conflict: ConflictForMutation) {
  const plannedSegments = conflict.segments
    .map((entry) => entry.segment)
    .filter(
      (segment) =>
        segment.type === "PLANNED" &&
        isActivePlannedStatus(segment.status) &&
        !segment.deletedAt,
    )
    .sort(compareSegmentsForSuggestion);
  if (plannedSegments.length < 2) return null;

  let cursor = new Date(conflict.endAt);
  return {
    proposalId: CONFLICT_SUGGESTION_PROPOSAL_ID,
    title: CONFLICT_SUGGESTION_TITLE,
    moves: plannedSegments.slice(1).map((segment) => {
      const duration = segment.endAt.getTime() - segment.startAt.getTime();
      const startAt = cursor;
      const endAt = new Date(startAt.getTime() + duration);
      cursor = endAt;
      return { segment, startAt, endAt };
    }),
  };
}

async function refreshActorTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
): Promise<ProjectManagementActor> {
  await assertProjectAccessActiveTx(tx, actor.accountId);
  const roles = await tx.systemRoleAssignment.findMany({
    where: { accountId: actor.accountId, revokedAt: null },
    select: { role: true, team: true, techGroup: true },
  });
  return { ...actor, systemRoles: roles };
}

async function lockConflictWithPersonTx(
  tx: PrismaTx,
  conflictId: string,
  includeSuggestionMoveRanges = false,
): Promise<ConflictMutationRange[]> {
  const conflict = await tx.resourceConflict.findUnique({
    where: { id: conflictId },
    select: {
      personId: true,
      startAt: true,
      endAt: true,
      segments: {
        select: {
          segment: { select: { startAt: true, endAt: true } },
        },
      },
    },
  });
  if (!conflict) throw notFoundError();
  const ranges: ConflictMutationRange[] = [
    {
      personId: conflict.personId,
      startAt: conflict.startAt,
      endAt: conflict.endAt,
    },
  ];
  if (includeSuggestionMoveRanges) {
    const projectedEndAt = new Date(
      conflict.endAt.getTime() +
        conflict.segments.reduce(
          (total, entry) =>
            total +
            (entry.segment.endAt.getTime() - entry.segment.startAt.getTime()),
          0,
        ),
    );
    for (const entry of conflict.segments) {
      ranges.push({
        personId: conflict.personId,
        startAt:
          entry.segment.startAt < conflict.startAt
            ? entry.segment.startAt
            : conflict.startAt,
        endAt: new Date(
          Math.max(
            entry.segment.endAt.getTime(),
            projectedEndAt.getTime(),
          ),
        ),
      });
    }
  }
  const prepared = await prepareConflictMutationTx(tx, ranges);
  await lockConflictsForRangesTx(tx, prepared, [conflictId]);
  return prepared;
}

async function lockConflictSegmentsTx(
  tx: PrismaTx,
  conflict: ConflictForMutation,
) {
  const segmentIds = [...new Set(conflict.segments.map((entry) => entry.segmentId))]
    .sort();
  if (segmentIds.length === 0) return;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "WorkSegment"
    WHERE "id" IN (${Prisma.join(segmentIds)})
    ORDER BY "id" ASC
    FOR UPDATE
  `;
  if (rows.length !== segmentIds.length) {
    throw stateConflictError("冲突关联的投入记录已变化，请刷新后重试");
  }
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
  const startDiff = left.startAt.getTime() - right.startAt.getTime();
  if (startDiff !== 0) return startDiff;
  return left.id.localeCompare(right.id);
}

function roleRank(role: string) {
  if (role === "OWNER") return 3;
  if (role === "LEAD") return 2;
  return 1;
}

function isActivePlannedStatus(
  status: string,
): status is (typeof ACTIVE_PLANNED_CONFLICT_STATUSES)[number] {
  return ACTIVE_PLANNED_CONFLICT_STATUSES.some((value) => value === status);
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
