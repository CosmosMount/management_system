import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { stateConflictError } from "@/lib/project-management/application/errors";
import { lockTaskSegmentAssociationsTx } from "@/lib/project-management/application/task-segment-association-lock";
import {
  createWorkSegmentInputSchema,
  softDeleteWorkSegmentInputSchema,
  updateWorkSegmentInputSchema,
} from "@/lib/project-management/validations/segments";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  assertAssociationTaskLocked,
  assertCanManageNewSegment,
  assertCanManageSegment,
  assertExpectedUpdatedAt,
  assertPersonActiveTx,
  assertSegmentAssociationLocatorUnchanged,
  assertSegmentReferenceTx,
  assertSegmentVisible,
  loadSegmentForMutationTx,
  lockSegmentAssociationTasksTx,
  lockWorkSegmentTx,
} from "@/lib/project-management/application/segment-access";
import { recordSegmentChangeTx } from "@/lib/project-management/application/segment-change-recorder";
import {
  segmentInclude,
  snapshotSegment,
  toWorkSegmentDto,
  type WorkSegmentDto,
} from "@/lib/project-management/application/segment-record";
import { assertValidSegmentRange } from "@/lib/project-management/application/segment-rules";

export { toWorkSegmentDto } from "@/lib/project-management/application/segment-record";
export type { WorkSegmentDto } from "@/lib/project-management/application/segment-record";

export type SegmentMutationResult = {
  segment: WorkSegmentDto;
  affectedSegmentIds: string[];
};

export async function createWorkSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = createWorkSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockTaskSegmentAssociationsTx(tx, parsed.taskId ? [parsed.taskId] : []);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    await assertPersonActiveTx(tx, parsed.personId);
    await assertSegmentReferenceTx(tx, {
      actor: refreshedActor,
      personId: parsed.personId,
      taskId: parsed.taskId ?? null,
      requireCreatableTask: true,
    });
    await assertCanManageNewSegment(tx, refreshedActor, parsed);
    const created = await tx.workSegment.create({
      data: {
        personId: parsed.personId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        content: parsed.content,
        taskId: parsed.taskId ?? null,
        createdByAccountId: refreshedActor.accountId,
        updatedByAccountId: refreshedActor.accountId,
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: created.id,
      action: "CREATE",
      before: null,
      after: snapshotSegment(created),
      reason: "新增投入记录",
    });
    return { segment: toWorkSegmentDto(created), affectedSegmentIds: [created.id] };
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
    const nextTaskId = Object.hasOwn(parsed, "taskId")
      ? parsed.taskId ?? null
      : segment.taskId;
    const nextStartAt = parsed.startAt ?? segment.startAt;
    const nextEndAt = parsed.endAt ?? segment.endAt;
    assertValidSegmentRange(nextStartAt, nextEndAt);
    if (Object.hasOwn(parsed, "taskId") && nextTaskId !== segment.taskId) {
      await assertSegmentReferenceTx(tx, {
        actor: refreshedActor,
        personId: segment.personId,
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
        taskId: nextTaskId,
        updatedByAccountId: refreshedActor.accountId,
        updatedAt: new Date(Math.max(Date.now(), segment.updatedAt.getTime() + 1)),
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: updated.id,
      action: "UPDATE",
      before,
      after: snapshotSegment(updated),
      reason: "修改投入记录",
    });
    return {
      segment: toWorkSegmentDto(updated),
      affectedSegmentIds: [updated.id],
    };
  });
}

export async function softDeleteWorkSegment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<SegmentMutationResult> {
  const parsed = softDeleteWorkSegmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const associationLocks = await lockSegmentAssociationTasksTx(tx, {
      segmentIds: [parsed.segmentId],
    });
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const preflight = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentVisible(refreshedActor, preflight);
    assertCanManageSegment(refreshedActor, preflight);
    await lockWorkSegmentTx(tx, parsed.segmentId);
    const segment = await loadSegmentForMutationTx(tx, parsed.segmentId);
    assertSegmentAssociationLocatorUnchanged(preflight, segment);
    assertAssociationTaskLocked(associationLocks, segment);
    assertSegmentVisible(refreshedActor, segment);
    assertCanManageSegment(refreshedActor, segment);
    if (segment.deletedAt) {
      return { segment: toWorkSegmentDto(segment), affectedSegmentIds: [segment.id] };
    }
    assertExpectedUpdatedAt(segment, parsed.expectedUpdatedAt);
    const updated = await tx.workSegment.update({
      where: { id: segment.id },
      data: {
        deletedAt: new Date(),
        updatedByAccountId: refreshedActor.accountId,
        updatedAt: new Date(Math.max(Date.now(), segment.updatedAt.getTime() + 1)),
      },
      include: segmentInclude,
    });
    await recordSegmentChangeTx(tx, {
      actor: refreshedActor,
      segmentId: updated.id,
      action: "DELETE",
      before: snapshotSegment(segment),
      after: snapshotSegment(updated),
      reason: "删除投入记录",
    });
    return { segment: toWorkSegmentDto(updated), affectedSegmentIds: [updated.id] };
  });
}
