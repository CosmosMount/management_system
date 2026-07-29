import {
  Prisma,
  type TaskPriority,
  type WorkSegment,
  type WorkSegmentChangeAction,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
  isSystemAdministrator,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import {
  notFoundError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  batchCreatePlannedSegmentsInputSchema,
  cancelPlannedSegmentInputSchema,
  confirmPlannedSegmentInputSchema,
  createActualSegmentInputSchema,
  createWorkSegmentInputSchema,
  mergePlannedSegmentsInputSchema,
  movePlannedSegmentsInputSchema,
  partiallyConfirmSegmentInputSchema,
  relinkPlannedSegmentInputSchema,
  softDeleteActualSegmentInputSchema,
  splitPlannedSegmentInputSchema,
  updateWorkSegmentInputSchema,
  type CreateActualSegmentInput,
  type CreateWorkSegmentInput,
  type MovePlannedSegmentsInput,
} from "@/lib/project-management/validations/segments";

type PrismaTx = Prisma.TransactionClient;

const MAX_SEGMENT_MS = 31 * 24 * 60 * 60 * 1_000;

const segmentInclude = {
  person: {
    select: {
      id: true,
      displayName: true,
      status: true,
      accountId: true,
    },
  },
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
  node: {
    select: { id: true, taskId: true, type: true, status: true },
  },
  tags: { select: { tagId: true } },
} satisfies Prisma.WorkSegmentInclude;

type SegmentForMutation = Prisma.WorkSegmentGetPayload<{
  include: typeof segmentInclude;
}>;

type TaskForAuthorization = NonNullable<SegmentForMutation["task"]>;

export type WorkSegmentDto = {
  id: string;
  personId: string;
  type: WorkSegment["type"];
  status: WorkSegment["status"];
  startAt: string;
  endAt: string;
  content: string;
  allocation: number | null;
  role: WorkSegment["role"];
  customRole: string;
  priority: TaskPriority;
  expectedOutput: string;
  actualOutput: string;
  completionPercent: number | null;
  taskId: string | null;
  nodeId: string | null;
  associationNeedsReview: boolean;
  sourceSplitFromId: string | null;
  deletedAt: string | null;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
};

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
    const refreshedActor = await refreshActorTx(tx, actor);
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
    const refreshedActor = await refreshActorTx(tx, actor);
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
    const refreshedActor = await refreshActorTx(tx, actor);
    const created = await createActualSegmentTx(tx, refreshedActor, parsed);
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
    const refreshedActor = await refreshActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
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

    const nextTaskId =
      Object.hasOwn(parsed, "taskId") ? parsed.taskId ?? null : segment.taskId;
    const nextNodeId =
      Object.hasOwn(parsed, "nodeId") ? parsed.nodeId ?? null : segment.nodeId;
    const nextStartAt = parsed.startAt ?? segment.startAt;
    const nextEndAt = parsed.endAt ?? segment.endAt;
    const nextRole = parsed.role ?? segment.role;
    const nextCustomRole =
      parsed.customRole !== undefined ? parsed.customRole : segment.customRole ?? "";
    const nextCompletionPercent =
      parsed.completionPercent !== undefined
        ? parsed.completionPercent
        : decimalToNumber(segment.completionPercent);

    assertValidSegmentRange(nextStartAt, nextEndAt);
    if (segment.type === "PLANNED" && nextCompletionPercent != null) {
      throw validationError("Planned Segment 不能填写完成比例", {
        completionPercent: ["Planned Segment 不能填写完成比例"],
      });
    }
    if (nextRole === "CUSTOM" && !nextCustomRole.trim()) {
      throw validationError("自定义职责不能为空", {
        customRole: ["自定义职责不能为空"],
      });
    }

    await assertSegmentReferenceTx(tx, {
      actor: refreshedActor,
      personId: segment.personId,
      type: segment.type,
      taskId: nextTaskId,
      nodeId: nextNodeId,
    });
    const tagIds = parsed.tagIds ?? tagIdsOf(segment);
    await assertTagsActiveTx(tx, tagIds);

    const before = snapshotSegment(segment);
    const updated = await tx.workSegment.update({
      where: { id: segment.id },
      data: {
        startAt: nextStartAt,
        endAt: nextEndAt,
        content: parsed.content ?? segment.content,
        allocation:
          parsed.allocation !== undefined
            ? decimalOrNull(parsed.allocation)
            : segment.allocation,
        role: nextRole,
        customRole: nextCustomRole.trim() || null,
        priority: parsed.priority ?? segment.priority,
        expectedOutput:
          parsed.expectedOutput !== undefined
            ? parsed.expectedOutput
            : segment.expectedOutput,
        actualOutput:
          parsed.actualOutput !== undefined
            ? parsed.actualOutput
            : segment.actualOutput,
        completionPercent:
          segment.type === "ACTUAL" ? decimalOrNull(nextCompletionPercent) : null,
        taskId: nextTaskId,
        nodeId: nextNodeId,
        updatedByAccountId: refreshedActor.accountId,
      },
      include: segmentInclude,
    });
    await replaceSegmentTagsTx(tx, updated.id, tagIds);
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
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    return movePlannedSegmentsTx(tx, refreshedActor, parsed);
  });
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
  const segments = await lockAndLoadSegmentsTx(
    tx,
    input.moves.map((move) => move.segmentId),
  );
  const moveById = new Map(input.moves.map((move) => [move.segmentId, move]));
  const updatedSegments: SegmentForMutation[] = [];
  for (const segment of segments) {
    const move = moveById.get(segment.id);
    if (!move) throw validationError("移动记录不存在");
    assertSegmentVisible(actor, segment);
    assertCanManageSegment(actor, segment);
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

export async function splitPlannedSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<BatchSegmentMutationResult> {
  const parsed = splitPlannedSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以拆分");
    const originalTagIds = tagIdsOf(segment);
    const parts = [...parsed.parts].sort(
      (left, right) => left.startAt.getTime() - right.startAt.getTime(),
    );
    assertSplitCoverage(segment, parts);

    const before = snapshotSegment(segment);
    const children: SegmentForMutation[] = [];
    for (const part of parts) {
      const childTagIds = part.tagIds ?? originalTagIds;
      const childTaskId =
        Object.hasOwn(part, "taskId") ? part.taskId ?? null : segment.taskId;
      const childNodeId =
        Object.hasOwn(part, "nodeId") ? part.nodeId ?? null : segment.nodeId;
      await assertSegmentReferenceTx(tx, {
        actor: refreshedActor,
        personId: segment.personId,
        type: "PLANNED",
        taskId: childTaskId,
        nodeId: childNodeId,
      });
      await assertTagsActiveTx(tx, childTagIds);
      const child = await tx.workSegment.create({
        data: {
          personId: segment.personId,
          type: "PLANNED",
          status: plannedStatusForRange(part.startAt, part.endAt),
          startAt: part.startAt,
          endAt: part.endAt,
          content: part.content ?? segment.content,
          allocation:
            part.allocation !== undefined
              ? decimalOrNull(part.allocation)
              : segment.allocation,
          role: part.role ?? segment.role,
          customRole:
            (part.customRole !== undefined
              ? part.customRole
              : segment.customRole ?? "") || null,
          priority: part.priority ?? segment.priority,
          expectedOutput: part.expectedOutput ?? segment.expectedOutput,
          actualOutput: "",
          completionPercent: null,
          taskId: childTaskId,
          nodeId: childNodeId,
          sourceSplitFromId: segment.id,
          createdByAccountId: refreshedActor.accountId,
          updatedByAccountId: refreshedActor.accountId,
          tags: {
            create: childTagIds.map((tagId) => ({ tagId })),
          },
        },
        include: segmentInclude,
      });
      await recordSegmentChangeTx(tx, {
        actor: refreshedActor,
        segmentId: child.id,
        action: "SPLIT",
        before: null,
        after: snapshotSegment(child),
        reason: parsed.reason,
      });
      children.push(child);
    }
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
      action: "SPLIT",
      before,
      after: {
        ...snapshotSegment(cancelled),
        splitChildIds: children.map((child) => child.id),
      },
      reason: parsed.reason,
    });
    return {
      segments: children.map(toWorkSegmentDto),
      affectedSegmentIds: [segment.id, ...children.map((child) => child.id)],
    };
  });
}

export async function mergePlannedSegments(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = mergePlannedSegmentsInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    assertUniqueIds(
      parsed.segments.map((segment) => segment.segmentId),
      "不能重复合并同一条投入记录",
    );
    const segments = await lockAndLoadSegmentsTx(
      tx,
      parsed.segments.map((segment) => segment.segmentId),
    );
    const expectedById = new Map(
      parsed.segments.map((segment) => [
        segment.segmentId,
        segment.expectedUpdatedAt,
      ]),
    );
    for (const segment of segments) {
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
    const tagIds = tagIdsOf(first);
    const merged = await tx.workSegment.create({
      data: {
        personId: first.personId,
        type: "PLANNED",
        status: plannedStatusForRange(startAt, endAt),
        startAt,
        endAt,
        content: first.content,
        allocation: first.allocation,
        role: first.role,
        customRole: first.customRole,
        priority: first.priority,
        expectedOutput: first.expectedOutput,
        actualOutput: "",
        completionPercent: null,
        taskId: first.taskId,
        nodeId: first.nodeId,
        createdByAccountId: refreshedActor.accountId,
        updatedByAccountId: refreshedActor.accountId,
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
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
    const refreshedActor = await refreshActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
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

export async function confirmPlannedSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult & { actualSegment: WorkSegmentDto; createdActual: boolean }> {
  const parsed = confirmPlannedSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
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
    const refreshedActor = await refreshActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以部分确认");
    assertCoverageInsideSegment(segment, parsed.coveredStartAt, parsed.coveredEndAt);
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

export async function relinkPlannedSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = relinkPlannedSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    assertPlannedEditable(segment, "只有未确认且未取消的 Planned Segment 可以重关联");
    if (!segment.associationNeedsReview) {
      throw stateConflictError("该 Planned Segment 不需要重新确认关联");
    }

    const nextTaskId =
      parsed.taskId === null
        ? null
        : parsed.taskId !== undefined
          ? parsed.taskId
          : segment.taskId;
    const nextNodeId =
      parsed.nodeId === null
        ? null
        : parsed.nodeId !== undefined
          ? parsed.nodeId
          : segment.nodeId;
    if (nextNodeId && !nextTaskId) {
      throw validationError("关联节点时必须同时关联 Task", {
        taskId: ["关联节点时必须同时关联 Task"],
      });
    }
    await assertSegmentReferenceTx(tx, {
      actor: refreshedActor,
      personId: segment.personId,
      type: "PLANNED",
      taskId: nextTaskId,
      nodeId: nextNodeId,
    });
    const before = snapshotSegment(segment);
    const updated = await tx.workSegment.update({
      where: { id: segment.id },
      data: {
        taskId: nextTaskId,
        nodeId: nextNodeId,
        associationNeedsReview: false,
        updatedByAccountId: refreshedActor.accountId,
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: updated.id,
      action: "RELINK",
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

export async function softDeleteActualSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = softDeleteActualSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
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

export async function scanSegmentTransitions(now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const toPending = await tx.workSegment.findMany({
      where: {
        type: "PLANNED",
        status: { in: ["PLANNED", "IN_PROGRESS"] },
        endAt: { lte: now },
        deletedAt: null,
      },
      include: segmentInclude,
      orderBy: { id: "asc" },
      take: 500,
    });
    let pendingConfirmationCount = 0;
    for (const segment of toPending) {
      const transition = await tx.workSegment.updateMany({
        where: {
          id: segment.id,
          type: "PLANNED",
          status: { in: ["PLANNED", "IN_PROGRESS"] },
          endAt: { lte: now },
          deletedAt: null,
          updatedAt: segment.updatedAt,
        },
        data: { status: "PENDING_CONFIRMATION" },
      });
      if (transition.count !== 1) continue;
      const before = snapshotSegment(segment);
      const updated = await loadSegmentForMutationTx(tx, segment.id);
      await recordSystemSegmentChangeTx(tx, {
        segmentId: updated.id,
        action: "UPDATE",
        before,
        after: snapshotSegment(updated),
        reason: "Planned Segment 已到期，等待确认",
      });
      await notifySegmentConfirmationDueTx(tx, updated);
      pendingConfirmationCount += 1;
    }

    const toInProgress = await tx.workSegment.findMany({
      where: {
        type: "PLANNED",
        status: "PLANNED",
        startAt: { lte: now },
        endAt: { gt: now },
        deletedAt: null,
      },
      include: segmentInclude,
      orderBy: { id: "asc" },
      take: 500,
    });
    let inProgressCount = 0;
    for (const segment of toInProgress) {
      const transition = await tx.workSegment.updateMany({
        where: {
          id: segment.id,
          type: "PLANNED",
          status: "PLANNED",
          startAt: { lte: now },
          endAt: { gt: now },
          deletedAt: null,
          updatedAt: segment.updatedAt,
        },
        data: { status: "IN_PROGRESS" },
      });
      if (transition.count !== 1) continue;
      const before = snapshotSegment(segment);
      const updated = await loadSegmentForMutationTx(tx, segment.id);
      await recordSystemSegmentChangeTx(tx, {
        segmentId: updated.id,
        action: "UPDATE",
        before,
        after: snapshotSegment(updated),
        reason: "Planned Segment 已开始",
      });
      inProgressCount += 1;
    }
    return {
      pendingConfirmationCount,
      inProgressCount,
    };
  });
}

async function createWorkSegmentTx(
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
    nodeId: input.nodeId ?? null,
  });
  await assertTagsActiveTx(tx, input.tagIds);
  await assertCanManageNewSegment(tx, actor, input);

  const created = await tx.workSegment.create({
    data: {
      personId: input.personId,
      type: input.type,
      status: input.type === "PLANNED" ? "PLANNED" : "CONFIRMED",
      startAt: input.startAt,
      endAt: input.endAt,
      content: input.content,
      allocation: decimalOrNull(input.allocation),
      role: input.role,
      customRole: input.customRole.trim() || null,
      priority: input.priority,
      expectedOutput: input.expectedOutput,
      actualOutput: input.actualOutput,
      completionPercent:
        input.type === "ACTUAL" ? decimalOrNull(input.completionPercent) : null,
      taskId: input.taskId ?? null,
      nodeId: input.nodeId ?? null,
      createdByAccountId: actor.accountId,
      updatedByAccountId: actor.accountId,
      tags: { create: input.tagIds.map((tagId) => ({ tagId })) },
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

async function createActualSegmentTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: CreateActualSegmentInput,
): Promise<SegmentForMutation> {
  await assertPersonActiveTx(tx, input.personId);
  await assertSegmentReferenceTx(tx, {
    actor,
    personId: input.personId,
    type: "ACTUAL",
    taskId: input.taskId ?? null,
    nodeId: input.nodeId ?? null,
  });
  await assertTagsActiveTx(tx, input.tagIds);
  await assertCanManageNewSegment(tx, actor, input);

  const sources = await lockAndValidateActualSourcesTx(tx, actor, input);
  const created = await tx.workSegment.create({
    data: {
      personId: input.personId,
      type: "ACTUAL",
      status: "CONFIRMED",
      startAt: input.startAt,
      endAt: input.endAt,
      content: input.content,
      allocation: decimalOrNull(input.allocation),
      role: input.role,
      customRole: input.customRole.trim() || null,
      priority: input.priority,
      expectedOutput: input.expectedOutput,
      actualOutput: input.actualOutput,
      completionPercent: decimalOrNull(input.completionPercent),
      taskId: input.taskId ?? null,
      nodeId: input.nodeId ?? null,
      createdByAccountId: actor.accountId,
      updatedByAccountId: actor.accountId,
      tags: { create: input.tagIds.map((tagId) => ({ tagId })) },
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

async function assertCanManageNewSegment(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: Pick<CreateWorkSegmentInput, "personId" | "taskId">,
) {
  const task = input.taskId
    ? await loadTaskForAuthorizationTx(tx, input.taskId)
    : null;
  const action =
    input.personId === actor.personId ? "segment.manage_self" : "segment.manage_others";
  assertAuthorized({
    actor,
    action,
    resource: {
      type: "segment",
      personId: input.personId,
      task: task ? taskResource(task) : null,
    },
  });
  if (task && action === "segment.manage_self") {
    assertTaskVisible(actor, task);
  }
}

async function assertSegmentReferenceTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    personId: string;
    type: WorkSegment["type"];
    taskId?: string | null;
    nodeId?: string | null;
  },
) {
  if (input.nodeId && !input.taskId) {
    throw validationError("关联节点时必须同时关联 Task", {
      taskId: ["关联节点时必须同时关联 Task"],
    });
  }
  if (!input.taskId) return;
  const task = await loadTaskForAuthorizationTx(tx, input.taskId);
  assertActorCanReferenceTaskForSegment(input.actor, {
    personId: input.personId,
    task,
  });
  if (!input.nodeId) return;
  const node = await tx.taskNode.findUnique({
    where: { id: input.nodeId },
    select: { id: true, taskId: true, status: true },
  });
  if (!node || node.taskId !== input.taskId) {
    throw validationError("关联节点不属于该 Task", {
      nodeId: ["关联节点不属于该 Task"],
    });
  }
  if (input.type === "PLANNED") {
    if (node.status === "REVISED" || node.status === "CANCELLED") {
      throw stateConflictError("Planned Segment 不能关联已失效节点");
    }
    const inCurrentPlan = await tx.planVersionNode.findFirst({
      where: {
        planVersionId: task.currentPlanVersionId,
        nodeId: node.id,
      },
      select: { id: true },
    });
    if (!inCurrentPlan) {
      throw stateConflictError("Planned Segment 只能关联 Current Plan 节点");
    }
  }
}

async function lockAndValidateActualSourcesTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: CreateActualSegmentInput,
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
    assertCoverageInsideSegment(planned, source.coveredStartAt, source.coveredEndAt);
    validated.push({
      plannedSegmentId: planned.id,
      coveredStartAt: source.coveredStartAt,
      coveredEndAt: source.coveredEndAt,
    });
  }
  return validated;
}

async function createActualFromPlannedTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    planned: SegmentForMutation;
    coveredStartAt: Date;
    coveredEndAt: Date;
    actualInput: Partial<CreateActualSegmentInput>;
    reason: string;
    confirmOriginal: "CONFIRMED" | "CANCELLED";
  },
): Promise<SegmentForMutation> {
  const tagIds = input.actualInput.tagIds ?? tagIdsOf(input.planned);
  await assertTagsActiveTx(tx, tagIds);
  const actualStartAt = input.actualInput.startAt ?? input.coveredStartAt;
  const actualEndAt = input.actualInput.endAt ?? input.coveredEndAt;
  assertValidSegmentRange(actualStartAt, actualEndAt);
  const actualTaskId =
    Object.hasOwn(input.actualInput, "taskId")
      ? input.actualInput.taskId ?? null
      : input.planned.taskId;
  const actualNodeId =
    Object.hasOwn(input.actualInput, "nodeId")
      ? input.actualInput.nodeId ?? null
      : input.planned.nodeId;
  await assertSegmentReferenceTx(tx, {
    actor: input.actor,
    personId: input.planned.personId,
    type: "ACTUAL",
    taskId: actualTaskId,
    nodeId: actualNodeId,
  });
  const actual = await tx.workSegment.create({
    data: {
      personId: input.planned.personId,
      type: "ACTUAL",
      status: "CONFIRMED",
      startAt: actualStartAt,
      endAt: actualEndAt,
      content: input.actualInput.content ?? input.planned.content,
      allocation:
        input.actualInput.allocation !== undefined
          ? decimalOrNull(input.actualInput.allocation)
          : input.planned.allocation,
      role: input.actualInput.role ?? input.planned.role,
      customRole:
        (input.actualInput.customRole !== undefined
          ? input.actualInput.customRole
          : input.planned.customRole ?? "") || null,
      priority: input.actualInput.priority ?? input.planned.priority,
      expectedOutput:
        input.actualInput.expectedOutput ?? input.planned.expectedOutput,
      actualOutput: input.actualInput.actualOutput ?? "",
      completionPercent: decimalOrNull(input.actualInput.completionPercent),
      taskId: actualTaskId,
      nodeId: actualNodeId,
      createdByAccountId: input.actor.accountId,
      updatedByAccountId: input.actor.accountId,
      tags: { create: tagIds.map((tagId) => ({ tagId })) },
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
    reason: input.reason || "确认 Planned Segment",
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
    reason: input.reason || "由 Planned Segment 确认生成",
  });
  return actual;
}

async function createRemainingSegmentsAfterPartialConfirmTx(
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
  const tagIds = tagIdsOf(input.planned);
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
        allocation: input.planned.allocation,
        role: input.planned.role,
        customRole: input.planned.customRole,
        priority: input.planned.priority,
        expectedOutput: input.planned.expectedOutput,
        actualOutput: "",
        completionPercent: null,
        taskId: input.planned.taskId,
        nodeId: input.planned.nodeId,
        sourceSplitFromId: input.planned.id,
        createdByAccountId: input.actor.accountId,
        updatedByAccountId: input.actor.accountId,
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
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

async function notifySegmentConfirmationDueTx(
  tx: PrismaTx,
  segment: SegmentForMutation,
) {
  const recipients = await recipientsForPersonIdsTx(tx, [segment.personId]);
  await createProjectManagementEventNotificationsTx(tx, {
    actorName: "系统",
    task: segment.task
      ? {
          id: segment.task.id,
          title: segment.task.title,
          status: segment.task.status,
          currentPlanVersionId: segment.task.currentPlanVersionId,
        }
      : null,
    kind: "segment_confirmation_due",
    category: "WORK_SEGMENT",
    eventKey: `pm:segment:confirmation_due:${segment.id}:${segment.endAt.toISOString()}`,
    title: "Planned Segment 待确认",
    summary: `计划投入「${segment.content}」已到结束时间，请确认实际投入`,
    entityType: "WorkSegment",
    entityId: segment.id,
    linkPath: "/progress",
    mandatory: false,
    recipients,
    context: {
      segmentId: segment.id,
      segmentStatus: segment.status,
      endAt: segment.endAt.toISOString(),
    },
  });
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

async function loadTaskForAuthorizationTx(
  tx: PrismaTx,
  taskId: string,
): Promise<TaskForAuthorization> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
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
  });
  if (!task) throw notFoundError();
  return task;
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
    members: task.members,
  };
}

function assertTaskVisible(actor: ProjectManagementActor, task: TaskForAuthorization) {
  const decision = authorize({
    actor,
    action: "task.view",
    resource: taskResource(task),
  });
  if (!decision.allowed) throw notFoundError();
}

function assertActorCanReferenceTaskForSegment(
  actor: ProjectManagementActor,
  input: { personId: string; task: TaskForAuthorization },
) {
  if (input.personId === actor.personId) {
    assertTaskVisible(actor, input.task);
    return;
  }
  if (
    authorize({
      actor,
      action: "segment.manage_others",
      resource: {
        type: "segment",
        personId: input.personId,
        task: taskResource(input.task),
      },
    }).allowed
  ) {
    return;
  }
  if (isSystemAdministrator(actor)) return;
  throw notFoundError();
}

function assertSegmentVisible(
  actor: ProjectManagementActor,
  segment: SegmentForMutation,
) {
  const decision = authorize({
    actor,
    action: "segment.view",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskResource(segment.task) : null,
    },
  });
  if (!decision.allowed) throw notFoundError();
}

function assertCanManageSegment(
  actor: ProjectManagementActor,
  segment: SegmentForMutation,
) {
  assertAuthorized({
    actor,
    action:
      segment.personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskResource(segment.task) : null,
    },
  });
}

async function lockWorkSegmentTx(tx: PrismaTx, segmentId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "WorkSegment" WHERE "id" = ${segmentId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFoundError();
}

async function lockAndLoadSegmentsTx(tx: PrismaTx, segmentIds: string[]) {
  const uniqueIds = [...new Set(segmentIds)].sort();
  if (uniqueIds.length === 0) return [];
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "WorkSegment"
    WHERE "id" IN (${Prisma.join(uniqueIds)})
    ORDER BY "id" ASC
    FOR UPDATE
  `;
  const segments = await tx.workSegment.findMany({
    where: { id: { in: uniqueIds } },
    include: segmentInclude,
  });
  if (segments.length !== uniqueIds.length) throw notFoundError();
  return segments.sort((left, right) => uniqueIds.indexOf(left.id) - uniqueIds.indexOf(right.id));
}

async function loadSegmentForMutationTx(
  tx: PrismaTx,
  segmentId: string,
): Promise<SegmentForMutation> {
  const segment = await tx.workSegment.findUnique({
    where: { id: segmentId },
    include: segmentInclude,
  });
  if (!segment) throw notFoundError();
  return segment;
}

async function assertPersonActiveTx(tx: PrismaTx, personId: string) {
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  if (!person || person.status !== "ACTIVE") {
    throw validationError("人员不存在或已停用", {
      personId: ["人员不存在或已停用"],
    });
  }
}

async function assertTagsActiveTx(tx: PrismaTx, tagIds: string[]) {
  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length === 0) return;
  const tagCount = await tx.tag.count({
    where: { id: { in: uniqueTagIds }, archivedAt: null },
  });
  if (tagCount !== uniqueTagIds.length) {
    throw validationError("Tag 不存在或已归档", {
      tagIds: ["Tag 不存在或已归档"],
    });
  }
}

async function replaceSegmentTagsTx(
  tx: PrismaTx,
  segmentId: string,
  tagIds: string[],
) {
  await tx.segmentTag.deleteMany({ where: { segmentId } });
  if (tagIds.length === 0) return;
  await tx.segmentTag.createMany({
    data: [...new Set(tagIds)].map((tagId) => ({ segmentId, tagId })),
    skipDuplicates: true,
  });
}

async function recordSegmentChangeTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    segmentId: string;
    action: WorkSegmentChangeAction;
    before: Prisma.InputJsonValue | null;
    after: Prisma.InputJsonValue | null;
    reason: string;
  },
) {
  await tx.workSegmentChange.create({
    data: {
      segmentId: input.segmentId,
      action: input.action,
      before: input.before ?? Prisma.JsonNull,
      after: input.after ?? Prisma.JsonNull,
      reason: input.reason,
      actorAccountId: input.actor.accountId,
    },
  });
  await createDomainAuditEventTx(tx, {
    actorAccountId: input.actor.accountId,
    actorPersonId: input.actor.personId,
    action: `pm.segment.${input.action.toLowerCase()}`,
    entityType: "WorkSegment",
    entityId: input.segmentId,
    taskId: extractTaskId(input.after) ?? extractTaskId(input.before),
    before: input.before,
    after: input.after,
    reason: input.reason,
  });
}

async function recordSystemSegmentChangeTx(
  tx: PrismaTx,
  input: {
    segmentId: string;
    action: WorkSegmentChangeAction;
    before: Prisma.InputJsonValue | null;
    after: Prisma.InputJsonValue | null;
    reason: string;
  },
) {
  await tx.workSegmentChange.create({
    data: {
      segmentId: input.segmentId,
      action: input.action,
      before: input.before ?? Prisma.JsonNull,
      after: input.after ?? Prisma.JsonNull,
      reason: input.reason,
      actorAccountId: null,
    },
  });
  await createDomainAuditEventTx(tx, {
    action: `pm.segment.${input.action.toLowerCase()}`,
    entityType: "WorkSegment",
    entityId: input.segmentId,
    taskId: extractTaskId(input.after) ?? extractTaskId(input.before),
    before: input.before,
    after: input.after,
    reason: input.reason,
    source: "CRON",
  });
}

function extractTaskId(value: Prisma.InputJsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const taskId = (value as Record<string, unknown>).taskId;
  return typeof taskId === "string" ? taskId : null;
}

function assertExpectedUpdatedAt(
  segment: Pick<WorkSegment, "updatedAt">,
  expectedUpdatedAt: Date | undefined,
) {
  if (!expectedUpdatedAt || segment.updatedAt.getTime() === expectedUpdatedAt.getTime()) {
    return;
  }
  throw stateConflictError("投入记录已被他人修改，请刷新后重试");
}

function assertPlannedEditable(segment: SegmentForMutation, message: string) {
  if (
    segment.type !== "PLANNED" ||
    segment.deletedAt ||
    segment.status === "CONFIRMED" ||
    segment.status === "CANCELLED"
  ) {
    throw stateConflictError(message);
  }
}

function assertValidSegmentRange(startAt: Date, endAt: Date) {
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

function assertCoverageInsideSegment(
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

function assertSplitCoverage(
  segment: SegmentForMutation,
  parts: Array<{ startAt: Date; endAt: Date }>,
) {
  if (parts[0]?.startAt.getTime() !== segment.startAt.getTime()) {
    throw validationError("拆分后的时间范围必须完整覆盖原计划", {
      parts: ["拆分后的时间范围必须完整覆盖原计划"],
    });
  }
  if (parts[parts.length - 1]?.endAt.getTime() !== segment.endAt.getTime()) {
    throw validationError("拆分后的时间范围必须完整覆盖原计划", {
      parts: ["拆分后的时间范围必须完整覆盖原计划"],
    });
  }
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    assertValidSegmentRange(part.startAt, part.endAt);
    const next = parts[index + 1];
    if (next && part.endAt.getTime() !== next.startAt.getTime()) {
      throw validationError("拆分后的时间范围必须连续且不重叠", {
        parts: ["拆分后的时间范围必须连续且不重叠"],
      });
    }
  }
}

function assertMergeCompatible(segments: SegmentForMutation[]) {
  const first = segments[0];
  if (!first) throw validationError("至少选择两条 Planned Segment");
  let currentEnd = first.endAt;
  const firstTagKey = tagIdsOf(first).join("|");
  for (const segment of segments) {
    if (
      segment.personId !== first.personId ||
      segment.type !== first.type ||
      segment.content !== first.content ||
      decimalKey(segment.allocation) !== decimalKey(first.allocation) ||
      segment.role !== first.role ||
      (segment.customRole ?? "") !== (first.customRole ?? "") ||
      segment.priority !== first.priority ||
      segment.taskId !== first.taskId ||
      segment.nodeId !== first.nodeId ||
      segment.expectedOutput !== first.expectedOutput ||
      tagIdsOf(segment).join("|") !== firstTagKey
    ) {
      throw validationError("只能合并同人同语义且 Tag 一致的 Planned Segment", {
        segments: ["只能合并同人同语义且 Tag 一致的 Planned Segment"],
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

function assertUniqueIds(ids: string[], message: string) {
  if (new Set(ids).size === ids.length) return;
  throw validationError(message);
}

function plannedStatusForRange(startAt: Date, endAt: Date): WorkSegment["status"] {
  const now = new Date();
  if (endAt <= now) return "PENDING_CONFIRMATION";
  if (startAt <= now && endAt > now) return "IN_PROGRESS";
  return "PLANNED";
}

function plannedStatusAfterMove(
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

function tagIdsOf(segment: Pick<SegmentForMutation, "tags">) {
  return segment.tags.map((tag) => tag.tagId).sort();
}

function decimalOrNull(value: number | Prisma.Decimal | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Prisma.Decimal(value);
}

function decimalToNumber(value: Prisma.Decimal | null) {
  return value == null ? null : Number(value.toString());
}

function decimalKey(value: Prisma.Decimal | null) {
  return value == null ? "" : value.toString();
}

function snapshotSegment(segment: SegmentForMutation): Prisma.InputJsonObject {
  return {
    id: segment.id,
    personId: segment.personId,
    type: segment.type,
    status: segment.status,
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    allocation: decimalToNumber(segment.allocation),
    role: segment.role,
    customRole: segment.customRole ?? "",
    priority: segment.priority,
    expectedOutput: segment.expectedOutput,
    actualOutput: segment.actualOutput,
    completionPercent: decimalToNumber(segment.completionPercent),
    taskId: segment.taskId,
    nodeId: segment.nodeId,
    associationNeedsReview: segment.associationNeedsReview,
    sourceSplitFromId: segment.sourceSplitFromId,
    deletedAt: segment.deletedAt?.toISOString() ?? null,
    tagIds: tagIdsOf(segment),
    updatedAt: segment.updatedAt.toISOString(),
  };
}

export function toWorkSegmentDto(segment: SegmentForMutation): WorkSegmentDto {
  return {
    id: segment.id,
    personId: segment.personId,
    type: segment.type,
    status: segment.status,
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    allocation: decimalToNumber(segment.allocation),
    role: segment.role,
    customRole: segment.customRole ?? "",
    priority: segment.priority,
    expectedOutput: segment.expectedOutput,
    actualOutput: segment.actualOutput,
    completionPercent: decimalToNumber(segment.completionPercent),
    taskId: segment.taskId,
    nodeId: segment.nodeId,
    associationNeedsReview: segment.associationNeedsReview,
    sourceSplitFromId: segment.sourceSplitFromId,
    deletedAt: segment.deletedAt?.toISOString() ?? null,
    tagIds: tagIdsOf(segment),
    createdAt: segment.createdAt.toISOString(),
    updatedAt: segment.updatedAt.toISOString(),
  };
}
