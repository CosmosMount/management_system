import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { notFoundError, ProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { canManageMeetings } from "./permissions";
import { createMeetingSchema, listMeetingsSchema, meetingIdSchema, meetingPeopleFilterSchema, meetingTimelineDisplaySchema, parseMeetingListCursor, updateMeetingSchema } from "./validation";
import { validateMeetingDisplay } from "./display";
import { projectReadableWhere, taskReadableWhere } from "@/lib/project-management/authorization";

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
    timelineDisplay: meetingTimelineDisplaySchema.parse(record.timelineDisplay),
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

export async function getMeetingFilterPeople(input: unknown) {
  const parsed = meetingPeopleFilterSchema.parse(input);
  const where: Prisma.PersonWhereInput = {
    OR: [{ status: "ACTIVE" }, { meetingRecordParticipants: { some: {} } }],
    displayName: { contains: parsed.query, mode: "insensitive" },
    ...(parsed.ids ? { id: { in: parsed.ids } } : {}),
  };
  const cursor = parsed.cursor ? await prisma.person.findFirst({ where: { AND: [where, { id: parsed.cursor }] }, select: { id: true, displayName: true } }) : null;
  if (parsed.cursor && !cursor) throw notFoundError();
  const rows = await prisma.person.findMany({
    where: { AND: [where, ...(cursor ? [{ OR: [{ displayName: { gt: cursor.displayName } }, { displayName: cursor.displayName, id: { gt: cursor.id } }] }] : [])] },
    select: { id: true, displayName: true, status: true },
    orderBy: [{ displayName: "asc" }, { id: "asc" }], take: 51,
  });
  return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null };
}

export async function listMeetings(input: unknown, actor?: ProjectManagementActor) {
  const parsed = listMeetingsSchema.parse(input);
  if ((parsed.mine || parsed.projectId || parsed.taskId) && !actor) {
    throw new ProjectManagementServiceError("FORBIDDEN", "请登录后筛选会议");
  }
  if (parsed.personId && !await prisma.person.findUnique({ where: { id: parsed.personId }, select: { id: true } })) throw notFoundError();
  if (actor && parsed.projectId && parsed.projectId !== "none" && !await prisma.project.findFirst({ where: { AND: [{ id: parsed.projectId }, projectReadableWhere(actor)] }, select: { id: true } })) throw notFoundError();
  if (actor && parsed.taskId && parsed.taskId !== "none" && !await prisma.task.findFirst({ where: { AND: [{ id: parsed.taskId }, taskReadableWhere(actor)] }, select: { id: true } })) throw notFoundError();
  const filterKey = JSON.stringify({ ...parsed, cursor: undefined, accountId: parsed.mine ? actor?.accountId : undefined });
  const savedCursor = parsed.cursor ? parseMeetingListCursor(parsed.cursor) : null;
  if (savedCursor && savedCursor.filterKey !== filterKey) {
    throw new ProjectManagementServiceError("VALIDATION_ERROR", "筛选条件已变化，请重新筛选");
  }
  const asOf = savedCursor ? new Date(savedCursor.asOf) : new Date();
  const conditions: Prisma.MeetingRecordWhereInput[] = [
    { topic: { contains: parsed.query, mode: "insensitive" } },
  ];
  if (parsed.personId) conditions.push({ participants: { some: { personId: parsed.personId } } });
  if (parsed.mine && actor) conditions.push({ createdByAccountId: actor.accountId });
  for (const [key, value] of [["projectIds", parsed.projectId], ["taskIds", parsed.taskId]] as const) {
    if (value) conditions.push({ timelineDisplay: { path: [key], ...(value === "none" ? { equals: [] } : { array_contains: [value] }) } });
  }
  if (["7", "30", "90"].includes(parsed.period)) {
    conditions.push({ rangeStart: { gte: new Date(asOf.getTime() - Number(parsed.period) * 86_400_000), lte: asOf } });
  } else if (parsed.period === "custom") {
    if (parsed.dateFrom) conditions.push({ rangeEnd: { gt: new Date(`${parsed.dateFrom}T00:00:00+08:00`) } });
    if (parsed.dateTo) conditions.push({ rangeStart: { lt: new Date(new Date(`${parsed.dateTo}T00:00:00+08:00`).getTime() + 86_400_000) } });
  }
  const where: Prisma.MeetingRecordWhereInput = { AND: conditions };
  const legacyCursor = parsed.cursor && !savedCursor
    ? await prisma.meetingRecord.findFirst({ where: { AND: [where, { id: parsed.cursor }] }, select: { id: true, createdAt: true, updatedAt: true, rangeStart: true } })
    : null;
  if (parsed.cursor && !savedCursor && !legacyCursor) throw notFoundError();
  const cursor = savedCursor ? { id: savedCursor.id, at: new Date(savedCursor.at) } : legacyCursor ? { id: legacyCursor.id, at: legacyCursor[parsed.sort] } : null;
  const records = await prisma.meetingRecord.findMany({
    where: {
      ...where,
      ...(cursor ? { id: { not: cursor.id }, OR: [
        { [parsed.sort]: { lt: cursor.at } },
        { [parsed.sort]: cursor.at, id: { lt: cursor.id } },
      ] } : {}),
    },
    select: {
      id: true, topic: true, rangeStart: true, rangeEnd: true, createdAt: true, updatedAt: true,
      participants: meetingInclude.participants,
    },
    orderBy: [{ [parsed.sort]: "desc" }, { id: "desc" }],
    take: 26,
  });
  return {
    items: records.slice(0, 25).map((record) => ({
      ...record,
      rangeStart: record.rangeStart.toISOString(), rangeEnd: record.rangeEnd.toISOString(),
      createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
      participants: record.participants.map(({ person }) => serializePerson(person)),
    })),
    nextCursor: records.length > 25 ? JSON.stringify({ version: 1, id: records[24].id, at: records[24][parsed.sort].toISOString(), asOf: asOf.toISOString(), filterKey }) : null,
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
  const timelineDisplay = parsed.timelineDisplay ?? { projectIds: [], taskIds: [] };
  return prisma.$transaction(async (tx) => {
    assertCanManageMeetings(await refreshProjectManagementActorTx(tx, actor));
    const existing = await tx.meetingRecord.findUnique({ where: { id: parsed.requestId }, include: meetingInclude });
    if (existing) {
      if (existing.createdByAccountId === actor.accountId && existing.version === 0 &&
        existing.topic === parsed.topic && existing.minutes === parsed.minutes &&
        JSON.stringify(meetingTimelineDisplaySchema.parse(existing.timelineDisplay)) === JSON.stringify(timelineDisplay) &&
        existing.rangeStart.getTime() === parsed.rangeStart.getTime() && existing.rangeEnd.getTime() === parsed.rangeEnd.getTime() &&
        JSON.stringify(existing.participants.map(({ person }) => person.id).sort()) === JSON.stringify([...parsed.personIds].sort())) {
        return serializeMeeting(existing);
      }
      throw new ProjectManagementServiceError("DUPLICATE_OPERATION", "该创建请求已经处理，请从会议列表查看结果");
    }
    await validatePeople(tx, parsed.personIds);
    await validateMeetingDisplay(tx, actor, timelineDisplay);
    const record = await tx.meetingRecord.create({
      data: {
        id: parsed.requestId,
        topic: parsed.topic, rangeStart: parsed.rangeStart, rangeEnd: parsed.rangeEnd, minutes: parsed.minutes,
        createdByAccountId: actor.accountId,
        timelineDisplay,
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
    const previousDisplay = meetingTimelineDisplaySchema.parse(before.timelineDisplay);
    const timelineDisplay = parsed.timelineDisplay ?? previousDisplay;
    await validatePeople(tx, parsed.personIds, before.participants.map(({ person }) => person.id));
    await validateMeetingDisplay(tx, actor, timelineDisplay, previousDisplay);
    const changed = await tx.meetingRecord.updateMany({
      where: { id: parsed.meetingId, version: parsed.expectedVersion },
      data: {
        topic: parsed.topic, rangeStart: parsed.rangeStart, rangeEnd: parsed.rangeEnd,
        minutes: parsed.minutes, timelineDisplay, version: { increment: 1 },
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
