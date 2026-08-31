import type { Prisma } from "@prisma/client";
import {
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  assertAssociationTaskLocked,
  assertCanManageNewSegment,
  assertCanManageSegment,
  assertExpectedUpdatedAt,
  assertPersonActiveTx,
  assertSegmentReferenceTx,
  assertSegmentVisible,
  assertUniqueIds,
  lockAndLoadSegmentsTx,
} from "@/lib/project-management/application/segment-access";
import { recordSegmentChangeTx } from "@/lib/project-management/application/segment-change-recorder";
import {
  segmentInclude,
  snapshotSegment,
  type SegmentForMutation,
} from "@/lib/project-management/application/segment-record";
import {
  assertCoverageInsideSegment,
  assertValidSegmentRange,
  plannedStatusForRange,
} from "@/lib/project-management/application/segment-rules";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type {
  CreateActualSegmentInput,
  CreateWorkSegmentInput,
} from "@/lib/project-management/validations/segments";

type PrismaTx = Prisma.TransactionClient;

type PlannedConfirmationActualInput = Pick<
  CreateActualSegmentInput,
  "actualOutput"
> &
  Partial<
    Pick<
      CreateActualSegmentInput,
      | "startAt"
      | "endAt"
      | "content"
      | "priority"
      | "taskId"
    >
  >;

export async function createWorkSegmentTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: CreateWorkSegmentInput,
): Promise<SegmentForMutation> {
  await assertPersonActiveTx(tx, input.personId);
  await assertSegmentReferenceTx(tx, {
    actor,
    personId: input.personId,
    type: input.type,
    taskId: input.taskId ?? null,
    requireCreatableTask: true,
  });
  await assertCanManageNewSegment(tx, actor, input);

  const created = await tx.workSegment.create({
    data: {
      personId: input.personId,
      type: input.type,
      status: input.type === "PLANNED" ? "PLANNED" : "CONFIRMED",
      startAt: input.startAt,
      endAt: input.endAt,
      content: input.content,
      priority: input.priority,
      expectedOutput: input.expectedOutput,
      actualOutput: input.actualOutput,
      taskId: input.taskId ?? null,
      createdByAccountId: actor.accountId,
      updatedByAccountId: actor.accountId,
    },
    include: segmentInclude,
  });
  await recordSegmentChangeTx(tx, {
    actor,
    segmentId: created.id,
    action: "CREATE",
    before: null,
    after: snapshotSegment(created),
    reason: "创建 Work Segment",
  });
  return created;
}

export async function createActualSegmentTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: CreateActualSegmentInput,
  associationLocks: ReadonlySet<string>,
): Promise<SegmentForMutation> {
  await assertPersonActiveTx(tx, input.personId);
  await assertSegmentReferenceTx(tx, {
    actor,
    personId: input.personId,
    type: "ACTUAL",
    taskId: input.taskId ?? null,
    requireCreatableTask: true,
  });
  await assertCanManageNewSegment(tx, actor, input);

  const sources = await lockAndValidateActualSourcesTx(
    tx,
    actor,
    input,
    associationLocks,
  );
  const created = await tx.workSegment.create({
    data: {
      personId: input.personId,
      type: "ACTUAL",
      status: "CONFIRMED",
      startAt: input.startAt,
      endAt: input.endAt,
      content: input.content,
      priority: input.priority,
      expectedOutput: input.expectedOutput,
      actualOutput: input.actualOutput,
      taskId: input.taskId ?? null,
      createdByAccountId: actor.accountId,
      updatedByAccountId: actor.accountId,
    },
    include: segmentInclude,
  });
  if (sources.length > 0) {
    await tx.workSegmentSource.createMany({
      data: sources.map((source) => ({
        plannedSegmentId: source.plannedSegmentId,
        actualSegmentId: created.id,
        coveredStartAt: source.coveredStartAt,
        coveredEndAt: source.coveredEndAt,
        createdByAccountId: actor.accountId,
      })),
      skipDuplicates: true,
    });
  }
  await recordSegmentChangeTx(tx, {
    actor,
    segmentId: created.id,
    action: "CREATE",
    before: null,
    after: {
      ...snapshotSegment(created),
      sourceCount: sources.length,
    },
    reason: "创建 Actual Segment",
  });
  return created;
}

export async function createActualFromPlannedTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    planned: SegmentForMutation;
    coveredStartAt: Date;
    coveredEndAt: Date;
    actualInput: PlannedConfirmationActualInput;
    reason: string;
    confirmOriginal: "CONFIRMED" | "CANCELLED";
  },
): Promise<SegmentForMutation> {
  const actualStartAt = input.actualInput.startAt ?? input.coveredStartAt;
  const actualEndAt = input.actualInput.endAt ?? input.coveredEndAt;
  assertValidSegmentRange(actualStartAt, actualEndAt);
  const actualTaskId =
    Object.hasOwn(input.actualInput, "taskId")
      ? input.actualInput.taskId ?? null
      : input.planned.taskId;
  await assertSegmentReferenceTx(tx, {
    actor: input.actor,
    personId: input.planned.personId,
    type: "ACTUAL",
    taskId: actualTaskId,
  });
  const actual = await tx.workSegment.create({
    data: {
      personId: input.planned.personId,
      type: "ACTUAL",
      status: "CONFIRMED",
      startAt: actualStartAt,
      endAt: actualEndAt,
      content: input.actualInput.content ?? input.planned.content,
      priority: input.actualInput.priority ?? input.planned.priority,
      expectedOutput: input.planned.expectedOutput,
      actualOutput: input.actualInput.actualOutput,
      taskId: actualTaskId,
      createdByAccountId: input.actor.accountId,
      updatedByAccountId: input.actor.accountId,
    },
    include: segmentInclude,
  });
  await tx.workSegmentSource.create({
    data: {
      plannedSegmentId: input.planned.id,
      actualSegmentId: actual.id,
      coveredStartAt: input.coveredStartAt,
      coveredEndAt: input.coveredEndAt,
      createdByAccountId: input.actor.accountId,
    },
  });
  const before = snapshotSegment(input.planned);
  const updatedPlanned = await tx.workSegment.update({
    where: { id: input.planned.id },
    data: {
      status: input.confirmOriginal,
      updatedByAccountId: input.actor.accountId,
    },
    include: segmentInclude,
  });
  await recordSegmentChangeTx(tx, {
    actor: input.actor,
    segmentId: updatedPlanned.id,
    action: "CONFIRM",
    before,
    after: {
      ...snapshotSegment(updatedPlanned),
      actualSegmentId: actual.id,
      coveredStartAt: input.coveredStartAt.toISOString(),
      coveredEndAt: input.coveredEndAt.toISOString(),
    },
    reason: input.reason || "确认计划投入",
  });
  await recordSegmentChangeTx(tx, {
    actor: input.actor,
    segmentId: actual.id,
    action: "CONFIRM",
    before: null,
    after: {
      ...snapshotSegment(actual),
      plannedSegmentId: input.planned.id,
      coveredStartAt: input.coveredStartAt.toISOString(),
      coveredEndAt: input.coveredEndAt.toISOString(),
    },
    reason: input.reason || "由计划投入确认生成实际投入",
  });
  return actual;
}

export async function createRemainingSegmentsAfterPartialConfirmTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    planned: SegmentForMutation;
    coveredStartAt: Date;
    coveredEndAt: Date;
    reason: string;
  },
) {
  const ranges = [
    { startAt: input.planned.startAt, endAt: input.coveredStartAt },
    { startAt: input.coveredEndAt, endAt: input.planned.endAt },
  ].filter((range) => range.endAt > range.startAt);
  const remaining: SegmentForMutation[] = [];
  for (const range of ranges) {
    const child = await tx.workSegment.create({
      data: {
        personId: input.planned.personId,
        type: "PLANNED",
        status: plannedStatusForRange(range.startAt, range.endAt),
        startAt: range.startAt,
        endAt: range.endAt,
        content: input.planned.content,
        priority: input.planned.priority,
        expectedOutput: input.planned.expectedOutput,
        actualOutput: "",
        taskId: input.planned.taskId,
        sourceSplitFromId: input.planned.id,
        createdByAccountId: input.actor.accountId,
        updatedByAccountId: input.actor.accountId,
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor: input.actor,
      segmentId: child.id,
      action: "SPLIT",
      before: null,
      after: {
        ...snapshotSegment(child),
        sourcePartialConfirmSegmentId: input.planned.id,
      },
      reason: input.reason,
    });
    remaining.push(child);
  }
  return remaining;
}

async function lockAndValidateActualSourcesTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: CreateActualSegmentInput,
  associationLocks: ReadonlySet<string>,
) {
  if (input.sources.length === 0) return [];
  assertUniqueIds(
    input.sources.map((source) => source.plannedSegmentId),
    "不能重复选择同一个来源 Planned Segment",
  );
  const sourceById = new Map(
    input.sources.map((source) => [source.plannedSegmentId, source]),
  );
  const plannedSegments = await lockAndLoadSegmentsTx(
    tx,
    input.sources.map((source) => source.plannedSegmentId),
  );
  const validated = [];
  for (const planned of plannedSegments) {
    const source = sourceById.get(planned.id);
    if (!source) throw validationError("来源 Planned Segment 不存在");
    assertAssociationTaskLocked(associationLocks, planned);
    assertSegmentVisible(actor, planned);
    assertCanManageSegment(actor, planned);
    if (source.expectedUpdatedAt) {
      assertExpectedUpdatedAt(planned, source.expectedUpdatedAt);
    }
    if (planned.type !== "PLANNED" || planned.deletedAt) {
      throw stateConflictError("来源必须是有效的 Planned Segment");
    }
    if (planned.personId !== input.personId) {
      throw validationError("Actual 与来源 Planned 必须属于同一人员", {
        sources: ["Actual 与来源 Planned 必须属于同一人员"],
      });
    }
    assertCoverageInsideSegment(
      planned,
      source.coveredStartAt,
      source.coveredEndAt,
    );
    validated.push({
      plannedSegmentId: planned.id,
      coveredStartAt: source.coveredStartAt,
      coveredEndAt: source.coveredEndAt,
    });
  }
  return validated;
}
