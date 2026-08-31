import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  notFoundError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import { lockTaskSegmentAssociationsTx } from "@/lib/project-management/application/task-segment-association-lock";
import {
  batchCreatePlannedSegmentsInputSchema,
  batchCancelPlannedSegmentsInputSchema,
  batchConfirmPlannedSegmentsInputSchema,
  cancelPlannedSegmentInputSchema,
  confirmPlannedSegmentInputSchema,
  createActualSegmentInputSchema,
  createWorkSegmentInputSchema,
  mergePlannedSegmentsInputSchema,
  movePlannedSegmentsInputSchema,
  partiallyConfirmSegmentInputSchema,
  softDeleteActualSegmentInputSchema,
  updateWorkSegmentInputSchema,
  type MovePlannedSegmentsInput,
} from "@/lib/project-management/validations/segments";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  assertAssociationTaskLocked,
  assertCanManageSegment,
  assertExpectedUpdatedAt,
  assertSegmentAssociationLocatorUnchanged,
  assertSegmentReferenceTx,
  assertSegmentVisible,
  assertUniqueIds,
  loadSegmentForMutationTx,
  loadSegmentsForPreflightTx,
  lockAndLoadSegmentsTx,
  lockSegmentAssociationTasksTx,
  lockWorkSegmentTx,
} from "@/lib/project-management/application/segment-access";
import { recordSegmentChangeTx } from "@/lib/project-management/application/segment-change-recorder";
import {
  createActualFromPlannedTx,
  createActualSegmentTx,
  createRemainingSegmentsAfterPartialConfirmTx,
  createWorkSegmentTx,
} from "@/lib/project-management/application/segment-creation";
import {
  segmentInclude,
  snapshotSegment,
  toWorkSegmentDto,
  type SegmentForMutation,
  type WorkSegmentDto,
} from "@/lib/project-management/application/segment-record";
import {
  assertCoverageInsideSegment,
  assertMergeCompatible,
  assertPlannedEditable,
  assertValidSegmentRange,
  plannedStatusAfterMove,
  plannedStatusForRange,
} from "@/lib/project-management/application/segment-rules";

export { toWorkSegmentDto } from "@/lib/project-management/application/segment-record";
export type { WorkSegmentDto } from "@/lib/project-management/application/segment-record";
export { scanSegmentTransitions } from "@/lib/project-management/application/segment-transition-service";

type PrismaTx = Prisma.TransactionClient;

export type SegmentMutationResult = {
  segment: WorkSegmentDto;
  affectedSegmentIds: string[];
};

export type BatchSegmentMutationResult = {
  segments: WorkSegmentDto[];
  affectedSegmentIds: string[];
};

export async function createWorkSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = createWorkSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockTaskSegmentAssociationsTx(
      tx,
      parsed.taskId ? [parsed.taskId] : [],
    );
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    await assertSegmentReferenceTx(tx, {
      actor: refreshedActor,
      personId: parsed.personId,
      type: parsed.type,
      taskId: parsed.taskId ?? null,
    });
    const created = await createWorkSegmentTx(tx, refreshedActor, parsed);
    return {
      segment: toWorkSegmentDto(created),
      affectedSegmentIds: [created.id],
    };
  });
}

export async function batchCreatePlannedSegments(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<BatchSegmentMutationResult> {
  const parsed = batchCreatePlannedSegmentsInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockTaskSegmentAssociationsTx(
      tx,
      parsed.segments.flatMap((segment) =>
        segment.taskId ? [segment.taskId] : [],
      ),
    );
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    for (const segment of parsed.segments) {
      await assertSegmentReferenceTx(tx, {
        actor: refreshedActor,
        personId: segment.personId,
        type: "PLANNED",
        taskId: segment.taskId ?? null,
      });
    }
    const created: SegmentForMutation[] = [];
    for (const segment of parsed.segments) {
      created.push(
        await createWorkSegmentTx(tx, refreshedActor, {
          ...segment,
          type: "PLANNED",
        }),
      );
    }
    return {
      segments: created.map(toWorkSegmentDto),
      affectedSegmentIds: created.map((segment) => segment.id),
    };
  });
}

export async function createActualSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = createActualSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: parsed.sources.map((source) => source.plannedSegmentId),
      prospectiveTaskIds: parsed.taskId ? [parsed.taskId] : [],
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    await assertSegmentReferenceTx(tx, {
      actor: refreshedActor,
      personId: parsed.personId,
      type: "ACTUAL",
      taskId: parsed.taskId ?? null,
    });
    const created = await createActualSegmentTx(
      tx,
      refreshedActor,
      parsed,
      associationLocks,
    );
    return {
      segment: toWorkSegmentDto(created),
      affectedSegmentIds: [created.id],
    };
  });
}

export async function updateWorkSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = updateWorkSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: [parsed.segmentId],
      prospectiveTaskIds: parsed.taskId ? [parsed.taskId] : [],
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflightSegment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentVisible(refreshedActor, preflightSegment);
    assertCanManageSegment(refreshedActor, preflightSegment);
    const preflightTaskId = Object.hasOwn(parsed, "taskId")
      ? parsed.taskId ?? null
      : preflightSegment.taskId;
    if (Object.hasOwn(parsed, "taskId")) {
      await assertSegmentReferenceTx(tx, {
        actor: refreshedActor,
        personId: preflightSegment.personId,
        type: preflightSegment.type,
        taskId: preflightTaskId,
      });
    }
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentAssociationLocatorUnchanged(preflightSegment, segment);
    assertAssociationTaskLocked(associationLocks, segment);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    if (segment.deletedAt) throw stateConflictError("该投入记录已删除");
    if (segment.status === "CANCELLED") {
      throw stateConflictError("已取消的投入记录不能修改");
    }
    if (segment.type === "PLANNED" && segment.status === "CONFIRMED") {
      throw stateConflictError("已确认的 Planned Segment 不能修改");
    }

    const nextTaskId = Object.hasOwn(parsed, "taskId")
      ? parsed.taskId ?? null
      : segment.taskId;
    const nextStartAt = parsed.startAt ?? segment.startAt;
    const nextEndAt = parsed.endAt ?? segment.endAt;
    assertValidSegmentRange(nextStartAt, nextEndAt);
    if (Object.hasOwn(parsed, "taskId")) {
      await assertSegmentReferenceTx(tx, {
        actor: refreshedActor,
        personId: segment.personId,
        type: segment.type,
        taskId: nextTaskId,
        requireCreatableTask: true,
      });
    }
    const before = snapshotSegment(segment);
    const updated = await tx.workSegment.update({
      where: { id: segment.id },
      data: {
        startAt: nextStartAt,
        endAt: nextEndAt,
        content: parsed.content ?? segment.content,
        priority: parsed.priority ?? segment.priority,
        expectedOutput:
          parsed.expectedOutput !== undefined
            ? parsed.expectedOutput
            : segment.expectedOutput,
        actualOutput:
          parsed.actualOutput !== undefined
            ? parsed.actualOutput
            : segment.actualOutput,
        taskId: nextTaskId,
        updatedByAccountId: refreshedActor.accountId,
      },
      include: segmentInclude,
    });
    const reloaded = await loadSegmentForMutationTx(tx, updated.id);
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: updated.id,
      action: "UPDATE",
      before,
      after: snapshotSegment(reloaded),
      reason: parsed.reason,
    });
    return {
      segment: toWorkSegmentDto(reloaded),
      affectedSegmentIds: [reloaded.id],
    };
  });
}

export async function movePlannedSegments(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<BatchSegmentMutationResult> {
  const parsed = movePlannedSegmentsInputSchema.parse(input);
  return prisma.$transaction((tx) => movePlannedSegmentsTx(tx, actor, parsed));
}

export async function movePlannedSegmentsTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: MovePlannedSegmentsInput,
): Promise<BatchSegmentMutationResult> {
  assertUniqueIds(
    input.moves.map((move) => move.segmentId),
    "不能重复移动同一条投入记录",
  );
  const associationLocks = await lockSegmentAssociationTasksTx(tx, {
    segmentIds: input.moves.map((move) => move.segmentId),
  });
  const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
  return movePlannedSegmentsWithAuthorizationTx(
    tx,
    refreshedActor,
    input,
    associationLocks,
    (segment) => {
      assertCanManageSegment(refreshedActor, segment);
    },
  );
}

async function movePlannedSegmentsWithAuthorizationTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: MovePlannedSegmentsInput,
  associationLocks: ReadonlySet<string>,
  assertCanMove: (segment: SegmentForMutation) => void,
): Promise<BatchSegmentMutationResult> {
  const segments = await lockAndLoadSegmentsTx(
    tx,
    input.moves.map((move) => move.segmentId),
  );
  const moveById = new Map(input.moves.map((move) => [move.segmentId, move]));
  const updatedSegments: SegmentForMutation[] = [];
  for (const segment of segments) {
    const move = moveById.get(segment.id);
    if (!move) throw validationError("移动记录不存在");
    assertAssociationTaskLocked(associationLocks, segment);
    assertSegmentVisible(actor, segment);
    assertCanMove(segment);
    assertExpectedUpdatedAt(segment, move.expectedUpdatedAt);
    assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以移动");
    assertValidSegmentRange(move.startAt, move.endAt);
    const before = snapshotSegment(segment);
    const updated = await tx.workSegment.update({
      where: { id: segment.id },
      data: {
        startAt: move.startAt,
        endAt: move.endAt,
        status: plannedStatusAfterMove(segment, move.startAt, move.endAt),
        updatedByAccountId: actor.accountId,
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor,
      segmentId: updated.id,
      action: "UPDATE",
      before,
      after: snapshotSegment(updated),
      reason: input.reason,
    });
    updatedSegments.push(updated);
  }
  return {
    segments: updatedSegments.map(toWorkSegmentDto),
    affectedSegmentIds: updatedSegments.map((segment) => segment.id),
  };
}

export async function mergePlannedSegments(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = mergePlannedSegmentsInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    assertUniqueIds(
      parsed.segments.map((segment) => segment.segmentId),
      "不能重复合并同一条投入记录",
    );
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: parsed.segments.map((segment) => segment.segmentId),
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflightSegments = await loadSegmentsForPreflightTx(
      tx,
      parsed.segments.map((segment) => segment.segmentId),
    );
    for (const segment of preflightSegments) {
      assertSegmentVisible(refreshedActor, segment);
      assertCanManageSegment(refreshedActor, segment);
    }
    const segments = await lockAndLoadSegmentsTx(
      tx,
      parsed.segments.map((segment) => segment.segmentId),
    );
    const preflightById = new Map(
      preflightSegments.map((segment) => [segment.id, segment] as const),
    );
    const expectedById = new Map(
      parsed.segments.map((segment) => [
        segment.segmentId,
        segment.expectedUpdatedAt,
      ]),
    );
    for (const segment of segments) {
      const preflightSegment = preflightById.get(segment.id);
      if (!preflightSegment) throw notFoundError();
      assertSegmentAssociationLocatorUnchanged(preflightSegment, segment);
      assertAssociationTaskLocked(associationLocks, segment);
      assertSegmentVisible(refreshedActor, segment);
      assertCanManageSegment(refreshedActor, segment);
      assertExpectedUpdatedAt(segment, expectedById.get(segment.id));
      assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以合并");
    }
    const sorted = [...segments].sort(
      (left, right) => left.startAt.getTime() - right.startAt.getTime(),
    );
    assertMergeCompatible(sorted);
    const first = sorted[0];
    if (!first) throw validationError("至少选择两条 Planned Segment");
    const startAt = sorted[0]?.startAt ?? first.startAt;
    const endAt = sorted.reduce(
      (latest, segment) => (segment.endAt > latest ? segment.endAt : latest),
      first.endAt,
    );
    assertValidSegmentRange(startAt, endAt);
    const merged = await tx.workSegment.create({
      data: {
        personId: first.personId,
        type: "PLANNED",
        status: plannedStatusForRange(startAt, endAt),
        startAt,
        endAt,
        content: first.content,
        priority: first.priority,
        expectedOutput: first.expectedOutput,
        actualOutput: "",
        taskId: first.taskId,
        createdByAccountId: refreshedActor.accountId,
        updatedByAccountId: refreshedActor.accountId,
      },
      include: segmentInclude,
    });
    for (const segment of sorted) {
      const before = snapshotSegment(segment);
      const cancelled = await tx.workSegment.update({
        where: { id: segment.id },
        data: {
          status: "CANCELLED",
          updatedByAccountId: refreshedActor.accountId,
        },
        include: segmentInclude,
      });
      await recordSegmentChangeTx(tx, {
        actor: refreshedActor,
        segmentId: segment.id,
        action: "MERGE",
        before,
        after: {
          ...snapshotSegment(cancelled),
          mergedIntoSegmentId: merged.id,
        },
        reason: parsed.reason,
      });
    }
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: merged.id,
      action: "MERGE",
      before: null,
      after: {
        ...snapshotSegment(merged),
        mergedFromSegmentIds: sorted.map((segment) => segment.id),
      },
      reason: parsed.reason,
    });
    return {
      segment: toWorkSegmentDto(merged),
      affectedSegmentIds: [...sorted.map((segment) => segment.id), merged.id],
    };
  });
}

export async function cancelPlannedSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = cancelPlannedSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: [parsed.segmentId],
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflightSegment = await loadSegmentForMutationTx(
      tx,
      parsed.segmentId,
    );
    assertSegmentVisible(refreshedActor, preflightSegment);
    assertCanManageSegment(refreshedActor, preflightSegment);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentAssociationLocatorUnchanged(preflightSegment, segment);
    assertAssociationTaskLocked(associationLocks, segment);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以取消");
    const before = snapshotSegment(segment);
    const updated = await tx.workSegment.update({
      where: { id: segment.id },
      data: {
        status: "CANCELLED",
        updatedByAccountId: refreshedActor.accountId,
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: updated.id,
      action: "CANCEL",
      before,
      after: snapshotSegment(updated),
      reason: parsed.reason,
    });
    return {
      segment: toWorkSegmentDto(updated),
      affectedSegmentIds: [updated.id],
    };
  });
}

export async function batchCancelPlannedSegments(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<BatchSegmentMutationResult> {
  const parsed = batchCancelPlannedSegmentsInputSchema.parse(input);
  assertUniqueIds(
    parsed.segments.map((segment) => segment.segmentId),
    "不能重复取消同一条投入记录",
  );
  return prisma.$transaction(async (tx) => {
    const segmentIds = parsed.segments.map((segment) => segment.segmentId);
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds,
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflightSegments = await loadSegmentsForPreflightTx(tx, segmentIds);
    for (const segment of preflightSegments) {
      assertSegmentVisible(refreshedActor, segment);
      assertCanManageSegment(refreshedActor, segment);
    }
    const segments = await lockAndLoadSegmentsTx(tx, segmentIds);
    const expectedById = new Map(
      parsed.segments.map((segment) => [
        segment.segmentId,
        segment.expectedUpdatedAt,
      ]),
    );

    // Validate the complete set before the first write so a stale or forbidden
    // middle item rolls the entire request back without partial audit history.
    for (const segment of segments) {
      const preflightSegment = preflightSegments.find(
        (candidate) => candidate.id === segment.id,
      );
      if (!preflightSegment) throw notFoundError();
      assertSegmentAssociationLocatorUnchanged(preflightSegment, segment);
      assertAssociationTaskLocked(associationLocks, segment);
      assertSegmentVisible(refreshedActor, segment);
      assertCanManageSegment(refreshedActor, segment);
      assertExpectedUpdatedAt(segment, expectedById.get(segment.id));
      assertPlannedEditable(
        segment,
        "只有未确认且未取消的 Planned Segment 可以批量取消",
      );
    }

    const cancelled: SegmentForMutation[] = [];
    for (const segment of segments) {
      const before = snapshotSegment(segment);
      const updated = await tx.workSegment.update({
        where: { id: segment.id },
        data: {
          status: "CANCELLED",
          updatedByAccountId: refreshedActor.accountId,
        },
        include: segmentInclude,
      });
      await recordSegmentChangeTx(tx, {
        actor: refreshedActor,
        segmentId: updated.id,
        action: "CANCEL",
        before,
        after: snapshotSegment(updated),
        reason: parsed.reason,
      });
      cancelled.push(updated);
    }
    return {
      segments: cancelled.map(toWorkSegmentDto),
      affectedSegmentIds: cancelled.map((segment) => segment.id),
    };
  });
}

export async function confirmPlannedSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult & { actualSegment: WorkSegmentDto; createdActual: boolean }> {
  const parsed = confirmPlannedSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: [parsed.segmentId],
      prospectiveTaskIds: parsed.actual.taskId ? [parsed.actual.taskId] : [],
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflightSegment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentVisible(refreshedActor, preflightSegment);
    assertCanManageSegment(refreshedActor, preflightSegment);
    if (Object.hasOwn(parsed.actual, "taskId")) {
      await assertSegmentReferenceTx(tx, {
        actor: refreshedActor,
        personId: preflightSegment.personId,
        type: "ACTUAL",
        taskId: parsed.actual.taskId ?? null,
      });
    }
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentAssociationLocatorUnchanged(preflightSegment, segment);
    assertAssociationTaskLocked(associationLocks, segment);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);

    if (segment.status === "CONFIRMED") {
      const existing = await tx.workSegmentSource.findFirst({
        where: {
          plannedSegmentId: segment.id,
          coveredStartAt: segment.startAt,
          coveredEndAt: segment.endAt,
          actualSegment: { deletedAt: null },
        },
        select: { actualSegmentId: true },
        orderBy: { createdAt: "asc" },
      });
      if (existing) {
        const actual = await loadSegmentForMutationTx(tx, existing.actualSegmentId);
        return {
          segment: toWorkSegmentDto(segment),
          actualSegment: toWorkSegmentDto(actual),
          createdActual: false,
          affectedSegmentIds: [segment.id, actual.id],
        };
      }
    }

    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以确认");
    const actual = await createActualFromPlannedTx(tx, {
      actor: refreshedActor,
      planned: segment,
      coveredStartAt: segment.startAt,
      coveredEndAt: segment.endAt,
      actualInput: parsed.actual,
      reason: parsed.reason,
      confirmOriginal: "CONFIRMED",
    });
    const confirmed = await loadSegmentForMutationTx(tx, segment.id);
    return {
      segment: toWorkSegmentDto(confirmed),
      actualSegment: toWorkSegmentDto(actual),
      createdActual: true,
      affectedSegmentIds: [confirmed.id, actual.id],
    };
  });
}

export async function batchConfirmPlannedSegments(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<
  BatchSegmentMutationResult & { actualSegments: WorkSegmentDto[] }
> {
  const parsed = batchConfirmPlannedSegmentsInputSchema.parse(input);
  assertUniqueIds(
    parsed.segments.map((segment) => segment.segmentId),
    "不能重复确认同一条投入记录",
  );
  return prisma.$transaction(async (tx) => {
    const segmentIds = parsed.segments.map((segment) => segment.segmentId);
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds,
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflightSegments = await loadSegmentsForPreflightTx(tx, segmentIds);
    for (const segment of preflightSegments) {
      assertSegmentVisible(refreshedActor, segment);
      assertCanManageSegment(refreshedActor, segment);
    }
    const segments = await lockAndLoadSegmentsTx(tx, segmentIds);
    const preflightById = new Map(
      preflightSegments.map((segment) => [segment.id, segment] as const),
    );
    const expectedById = new Map(
      parsed.segments.map((segment) => [
        segment.segmentId,
        segment.expectedUpdatedAt,
      ]),
    );
    const actualOutputById = new Map(
      parsed.segments.map((segment) => [
        segment.segmentId,
        segment.actualOutput,
      ]),
    );

    // Confirm only after the whole set has passed visibility, permission,
    // association, version and state checks. The surrounding transaction then
    // guarantees Actual/source/change/audit creation is all-or-nothing.
    for (const segment of segments) {
      const preflightSegment = preflightById.get(segment.id);
      if (!preflightSegment) throw notFoundError();
      assertSegmentAssociationLocatorUnchanged(preflightSegment, segment);
      assertAssociationTaskLocked(associationLocks, segment);
      assertSegmentVisible(refreshedActor, segment);
      assertCanManageSegment(refreshedActor, segment);
      assertExpectedUpdatedAt(segment, expectedById.get(segment.id));
      assertPlannedEditable(
        segment,
        "只有未确认且未取消的 Planned Segment 可以批量确认",
      );
    }

    const actualSegments: SegmentForMutation[] = [];
    for (const planned of segments) {
      const actualOutput = actualOutputById.get(planned.id);
      if (actualOutput === undefined) {
        throw validationError("确认列表缺少实际输出", {
          segments: ["确认列表缺少实际输出"],
        });
      }
      actualSegments.push(
        await createActualFromPlannedTx(tx, {
          actor: refreshedActor,
          planned,
          coveredStartAt: planned.startAt,
          coveredEndAt: planned.endAt,
          actualInput: { actualOutput },
          reason: parsed.reason,
          confirmOriginal: "CONFIRMED",
        }),
      );
    }
    const confirmed = await lockAndLoadSegmentsTx(tx, segmentIds);
    return {
      segments: confirmed.map(toWorkSegmentDto),
      actualSegments: actualSegments.map(toWorkSegmentDto),
      affectedSegmentIds: [
        ...confirmed.map((segment) => segment.id),
        ...actualSegments.map((segment) => segment.id),
      ],
    };
  });
}

export async function partiallyConfirmSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<
  SegmentMutationResult & {
    actualSegment: WorkSegmentDto;
    remainingSegments: WorkSegmentDto[];
  }
> {
  const parsed = partiallyConfirmSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: [parsed.segmentId],
      prospectiveTaskIds: [],
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflightSegment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentVisible(refreshedActor, preflightSegment);
    assertCanManageSegment(refreshedActor, preflightSegment);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentAssociationLocatorUnchanged(preflightSegment, segment);
    assertAssociationTaskLocked(associationLocks, segment);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以部分确认");
    assertCoverageInsideSegment(segment, parsed.coveredStartAt, parsed.coveredEndAt);
    if (parsed.coveredStartAt.getTime() !== segment.startAt.getTime()) {
      throw validationError("部分确认必须从当前计划开始时间起算", {
        coveredStartAt: ["部分确认必须从当前计划开始时间起算"],
      });
    }
    if (
      parsed.coveredStartAt.getTime() === segment.startAt.getTime() &&
      parsed.coveredEndAt.getTime() === segment.endAt.getTime()
    ) {
      throw validationError("完整确认请使用 Full Confirm", {
        coveredEndAt: ["完整确认请使用 Full Confirm"],
      });
    }

    const actual = await createActualFromPlannedTx(tx, {
      actor: refreshedActor,
      planned: segment,
      coveredStartAt: parsed.coveredStartAt,
      coveredEndAt: parsed.coveredEndAt,
      actualInput: parsed.actual,
      reason: parsed.reason,
      confirmOriginal: "CANCELLED",
    });
    const remaining = await createRemainingSegmentsAfterPartialConfirmTx(tx, {
      actor: refreshedActor,
      planned: segment,
      coveredStartAt: parsed.coveredStartAt,
      coveredEndAt: parsed.coveredEndAt,
      reason: parsed.reason || "部分确认后保留剩余计划",
    });
    const original = await loadSegmentForMutationTx(tx, segment.id);
    return {
      segment: toWorkSegmentDto(original),
      actualSegment: toWorkSegmentDto(actual),
      remainingSegments: remaining.map(toWorkSegmentDto),
      affectedSegmentIds: [
        original.id,
        actual.id,
        ...remaining.map((segment) => segment.id),
      ],
    };
  });
}

export async function softDeleteActualSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = softDeleteActualSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: [parsed.segmentId],
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertAssociationTaskLocked(associationLocks, segment);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    if (segment.type !== "ACTUAL") {
      throw stateConflictError("只有 Actual Segment 可以逻辑删除");
    }
    if (segment.deletedAt) {
      return {
        segment: toWorkSegmentDto(segment),
        affectedSegmentIds: [segment.id],
      };
    }
    const before = snapshotSegment(segment);
    const updated = await tx.workSegment.update({
      where: { id: segment.id },
      data: {
        status: "CANCELLED",
        deletedAt: new Date(),
        updatedByAccountId: refreshedActor.accountId,
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: updated.id,
      action: "DELETE",
      before,
      after: snapshotSegment(updated),
      reason: parsed.reason,
    });
    return {
      segment: toWorkSegmentDto(updated),
      affectedSegmentIds: [updated.id],
    };
  });
}
