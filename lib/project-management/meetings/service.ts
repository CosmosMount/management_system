import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { notFoundError, ProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { canManageMeetings } from "./permissions";
import { createMeetingSchema, listMeetingsSchema, meetingIdSchema, updateMeetingSchema } from "./validation";

const meetingInclude = {
  participants: {
    select: { person: { select: { id: true, displayName: true, avatar: true, status: true, accountId: true } } },
    orderBy: { personId: "asc" as const },
  },
} satisfies Prisma.MeetingRecordInclude;

type Meeting = Prisma.MeetingRecordGetPayload<{ include: typeof meetingInclude }>;

export function assertCanManageMeetings(actor: ProjectManagementActor) {
  if (!canManageMeetings(actor)) {
    throw new ProjectManagementServiceError("FORBIDDEN", "只有全局超级管理员可以创建或修改会议");
  }
}

function serializePerson(person: Meeting["participants"][number]["person"]) {
  return {
    id: person.id, displayName: person.displayName, avatar: person.avatar, status: person.status,
    accountBinding: person.accountId ? "BOUND" as const : "UNBOUND" as const,
  };
}

function serializeMeeting(record: Meeting) {
  return {
    id: record.id,
    topic: record.topic,
    rangeStart: record.rangeStart.toISOString(),
    rangeEnd: record.rangeEnd.toISOString(),
    minutes: record.minutes,
    version: record.version,
    participants: record.participants.map(({ person }) => serializePerson(person)),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export type MeetingDto = ReturnType<typeof serializeMeeting>;

export async function getMeeting(input: unknown): Promise<MeetingDto> {
  const { meetingId } = meetingIdSchema.parse(input);
  const record = await prisma.meetingRecord.findUnique({ where: { id: meetingId }, include: meetingInclude });
  if (!record) throw notFoundError();
  return serializeMeeting(record);
}

export async function listMeetings(input: unknown) {
  const parsed = listMeetingsSchema.parse(input);
  const cursor = parsed.cursor
    ? await prisma.meetingRecord.findUnique({ where: { id: parsed.cursor }, select: { id: true, createdAt: true } })
    : null;
  if (parsed.cursor && !cursor) throw notFoundError();
  const records = await prisma.meetingRecord.findMany({
    where: {
      topic: { contains: parsed.query, mode: "insensitive" },
      ...(cursor ? { OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ] } : {}),
    },
    select: {
      id: true, topic: true, rangeStart: true, rangeEnd: true, createdAt: true, updatedAt: true,
      participants: meetingInclude.participants,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 26,
  });
  return {
    items: records.slice(0, 25).map((record) => ({
      ...record,
      rangeStart: record.rangeStart.toISOString(), rangeEnd: record.rangeEnd.toISOString(),
      createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
      participants: record.participants.map(({ person }) => serializePerson(person)),
    })),
    nextCursor: records.length > 25 ? records[24].id : null,
  };
}

async function validatePeople(tx: Prisma.TransactionClient, personIds: string[], previousIds: string[] = []) {
  const count = await tx.person.count({ where: {
    id: { in: personIds },
    OR: [{ status: "ACTIVE" }, { id: { in: previousIds } }],
  } });
  if (count !== personIds.length) {
    throw new ProjectManagementServiceError("VALIDATION_ERROR", "参与人不存在或已停用，请重新选择", {
      personIds: ["参与人不存在或已停用，请重新选择"],
    });
  }
}

export async function createMeeting(actor: ProjectManagementActor, input: unknown): Promise<MeetingDto> {
  const parsed = createMeetingSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    assertCanManageMeetings(await refreshProjectManagementActorTx(tx, actor));
    const existing = await tx.meetingRecord.findUnique({ where: { id: parsed.requestId }, include: meetingInclude });
    if (existing) {
      if (existing.createdByAccountId === actor.accountId && existing.version === 0 &&
        existing.topic === parsed.topic && existing.minutes === parsed.minutes &&
        existing.rangeStart.getTime() === parsed.rangeStart.getTime() && existing.rangeEnd.getTime() === parsed.rangeEnd.getTime() &&
        JSON.stringify(existing.participants.map(({ person }) => person.id).sort()) === JSON.stringify([...parsed.personIds].sort())) {
        return serializeMeeting(existing);
      }
      throw new ProjectManagementServiceError("DUPLICATE_OPERATION", "该创建请求已经处理，请从会议列表查看结果");
    }
    await validatePeople(tx, parsed.personIds);
    const record = await tx.meetingRecord.create({
      data: {
        id: parsed.requestId,
        topic: parsed.topic, rangeStart: parsed.rangeStart, rangeEnd: parsed.rangeEnd, minutes: parsed.minutes,
        createdByAccountId: actor.accountId,
        participants: { create: parsed.personIds.map((personId) => ({ personId })) },
      },
      include: meetingInclude,
    });
    const result = serializeMeeting(record);
    await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId, actorPersonId: actor.personId,
      action: "meeting.create", entityType: "MeetingRecord", entityId: record.id, after: result,
    });
    return result;
  });
}

export async function updateMeeting(actor: ProjectManagementActor, input: unknown): Promise<MeetingDto> {
  const parsed = updateMeetingSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    assertCanManageMeetings(await refreshProjectManagementActorTx(tx, actor));
    const before = await tx.meetingRecord.findUnique({ where: { id: parsed.meetingId }, include: meetingInclude });
    if (!before) throw notFoundError();
    await validatePeople(tx, parsed.personIds, before.participants.map(({ person }) => person.id));
    const changed = await tx.meetingRecord.updateMany({
      where: { id: parsed.meetingId, version: parsed.expectedVersion },
      data: {
        topic: parsed.topic, rangeStart: parsed.rangeStart, rangeEnd: parsed.rangeEnd,
        minutes: parsed.minutes, version: { increment: 1 },
      },
    });
    if (!changed.count) throw new ProjectManagementServiceError("STATE_CONFLICT", "会议已被其他管理员修改，请刷新后重新编辑");
    await tx.meetingRecordParticipant.deleteMany({ where: { meetingId: parsed.meetingId } });
    await tx.meetingRecordParticipant.createMany({ data: parsed.personIds.map((personId) => ({ meetingId: parsed.meetingId, personId })) });
    const record = await tx.meetingRecord.findUniqueOrThrow({ where: { id: parsed.meetingId }, include: meetingInclude });
    const result = serializeMeeting(record);
    await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId, actorPersonId: actor.personId,
      action: "meeting.update", entityType: "MeetingRecord", entityId: record.id,
      before: serializeMeeting(before), after: result,
    });
    return result;
  });
}
