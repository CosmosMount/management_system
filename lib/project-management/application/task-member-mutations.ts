import type { Prisma, TaskMemberRole } from "@prisma/client";
import {
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";

type PrismaTx = Prisma.TransactionClient;

export async function assertActivePeopleTx(
  tx: PrismaTx,
  personIds: string[],
  existingPersonIds: string[] = [],
) {
  const existing = new Set(existingPersonIds);
  const uniquePersonIds = [...new Set(personIds)].filter(
    (personId) => !existing.has(personId),
  );
  if (uniquePersonIds.length === 0) return;
  const count = await tx.person.count({
    where: { id: { in: uniquePersonIds }, status: "ACTIVE" },
  });
  if (count !== uniquePersonIds.length) {
    throw validationError("成员不存在或已停用", {
      members: ["成员不存在或已停用"],
    });
  }
}

export function assertExistingMemberStructure(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  const personIds = members.map((member) => member.personId);
  if (new Set(personIds).size !== personIds.length) {
    throw stateConflictError("Task 当前成员数据存在重复成员，请联系管理员处理");
  }
  if (
    members.some(
      (member) => member.role !== "OWNER" && member.role !== "PARTICIPANT",
    )
  ) {
    throw stateConflictError("Task 当前成员仍含历史角色，请联系管理员处理");
  }
}

export function assertExistingActiveMemberInvariant(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  assertExistingMemberStructure(members);
  if (members.every((member) => member.role !== "OWNER")) {
    throw stateConflictError("Task 当前没有负责人，请联系管理员处理");
  }
}

export function assertRequestedMemberStructure(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  const personIds = members.map((member) => member.personId);
  if (new Set(personIds).size !== personIds.length) {
    throw validationError("同一成员只能有一个角色", {
      members: ["同一成员只能有一个角色"],
    });
  }
}

export function assertRequestedActiveMemberInvariant(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  assertRequestedMemberStructure(members);
  if (members.every((member) => member.role !== "OWNER")) {
    throw validationError("至少需要一名负责人", {
      members: ["至少需要一名负责人"],
    });
  }
}

export async function assertTaskSegmentMembersIncludedTx(
  tx: PrismaTx,
  taskId: string,
  requestedMembers: Array<{ personId: string }>,
) {
  const retainedPersonIds = requestedMembers.map((member) => member.personId);
  const orphanedSegment = await tx.workSegment.findFirst({
    where: {
      taskId,
      deletedAt: null,
      personId: { notIn: retainedPersonIds },
    },
    select: { id: true },
  });
  if (orphanedSegment) {
    throw validationError("仍有关联投入的成员不能移出 Task", {
      members: ["请先处理该成员的 Task 关联投入"],
    });
  }
}

export async function applyMemberChangesTx(
  tx: PrismaTx,
  input: {
    taskId: string;
    actorAccountId: string;
    currentMembers: Array<{
      id: string;
      personId: string;
      role: TaskMemberRole;
    }>;
    requestedMembers: Array<{ personId: string; role: TaskMemberRole }>;
  },
) {
  const requestedKeys = new Set(input.requestedMembers.map(memberKey));
  const currentKeys = new Set(input.currentMembers.map(memberKey));
  const removedIds = input.currentMembers
    .filter((member) => !requestedKeys.has(memberKey(member)))
    .map((member) => member.id);
  const added = input.requestedMembers.filter(
    (member) => !currentKeys.has(memberKey(member)),
  );
  if (removedIds.length > 0) {
    await tx.taskMember.updateMany({
      where: { id: { in: removedIds }, taskId: input.taskId, removedAt: null },
      data: { removedAt: new Date() },
    });
  }
  if (added.length > 0) {
    await tx.taskMember.createMany({
      data: added.map((member) => ({
        taskId: input.taskId,
        personId: member.personId,
        role: member.role,
        createdByAccountId: input.actorAccountId,
      })),
    });
  }
}

export function memberSnapshot(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  return members
    .map((member) => ({ personId: member.personId, role: member.role }))
    .sort(
      (left, right) =>
        left.personId.localeCompare(right.personId) ||
        left.role.localeCompare(right.role),
    );
}

export function memberKey(member: { personId: string; role: TaskMemberRole }) {
  return `${member.personId}:${member.role}`;
}
