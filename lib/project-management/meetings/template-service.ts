import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { notFoundError, ProjectManagementServiceError, stateConflictError } from "@/lib/project-management/application/errors";
import { canManageMeetings } from "./permissions";
import { validatePeople } from "./service";
import { validateMeetingDisplay } from "./display";
import { meetingTimelineDisplaySchema } from "./validation";
import { createMeetingTemplateSchema, deleteMeetingTemplateSchema, listMeetingTemplatesSchema, meetingTemplateIdSchema, updateMeetingTemplateSchema, type MeetingContent } from "./template-validation";

const templateInclude = {
  participants: { select: { person: { select: { id: true, displayName: true, avatar: true, status: true, accountId: true } } }, orderBy: { personId: "asc" as const } },
} satisfies Prisma.MeetingTemplateInclude;
type TemplateRecord = Prisma.MeetingTemplateGetPayload<{ include: typeof templateInclude }>;

async function authorize(tx: Prisma.TransactionClient, actor: ProjectManagementActor) {
  const current = await refreshProjectManagementActorTx(tx, actor);
  if (!canManageMeetings(current)) throw new ProjectManagementServiceError("FORBIDDEN", "只有全局超级管理员可以查看、使用或管理会议模板");
  return current;
}

function serializeTemplate(record: TemplateRecord) {
  return {
    id: record.id, name: record.name, description: record.description, topic: record.topic, minutes: record.minutes,
    personIds: record.participants.map(({ person }) => person.id),
    participants: record.participants.map(({ person }) => ({
      id: person.id, displayName: person.displayName, avatar: person.avatar, status: person.status,
      accountBinding: person.accountId ? "BOUND" as const : "UNBOUND" as const,
    })),
    timelineDisplay: meetingTimelineDisplaySchema.parse(record.timelineDisplay), version: record.version,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  };
}
export type MeetingTemplateDto = ReturnType<typeof serializeTemplate>;

async function validateContent(tx: Prisma.TransactionClient, actor: ProjectManagementActor, content: MeetingContent) {
  const errors: Record<string, string[]> = {};
  for (const validate of [() => validatePeople(tx, content.personIds), () => validateMeetingDisplay(tx, actor, content.timelineDisplay)]) {
    try { await validate(); } catch (error) {
      if (!(error instanceof ProjectManagementServiceError) || error.code !== "VALIDATION_ERROR") throw error;
      Object.assign(errors, error.fieldErrors);
    }
  }
  return errors;
}

export async function listMeetingTemplates(actor: ProjectManagementActor, input: unknown = {}) {
  const { cursor } = listMeetingTemplatesSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await authorize(tx, actor);
    const records = await tx.meetingTemplate.findMany({
      where: { deletedAt: null, ...(cursor ? { OR: [
        { updatedAt: { lt: new Date(cursor.updatedAt) } },
        { updatedAt: new Date(cursor.updatedAt), id: { lt: cursor.id } },
      ] } : {}) },
      include: templateInclude, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 11,
    });
    return {
      items: records.slice(0, 10).map((record) => {
        const template = serializeTemplate(record);
        return {
          id: template.id, name: template.name, description: template.description, version: template.version,
          participantNames: template.participants.map((person) => `${person.displayName}${person.status === "ACTIVE" ? "" : "（已停用）"}`),
          projectCount: template.timelineDisplay.projectIds.length, taskCount: template.timelineDisplay.taskIds.length,
          hasMinutes: Boolean(template.minutes),
        };
      }),
      nextCursor: records.length > 10 ? { id: records[9].id, updatedAt: records[9].updatedAt.toISOString() } : null,
    };
  });
}
export type MeetingTemplateList = Awaited<ReturnType<typeof listMeetingTemplates>>;

export async function getMeetingTemplate(actor: ProjectManagementActor, input: unknown) {
  const { templateId } = meetingTemplateIdSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const current = await authorize(tx, actor);
    const record = await tx.meetingTemplate.findFirst({ where: { id: templateId, deletedAt: null }, include: templateInclude });
    if (!record) throw notFoundError();
    const template = serializeTemplate(record);
    return { template, fieldErrors: await validateContent(tx, current, template) };
  });
}
export type MeetingTemplateSelection = Awaited<ReturnType<typeof getMeetingTemplate>>;

export async function createMeetingTemplate(actor: ProjectManagementActor, input: unknown) {
  const parsed = createMeetingTemplateSchema.parse(input);
  const content = { ...parsed, timelineDisplay: parsed.timelineDisplay ?? { projectIds: [], taskIds: [] } };
  return prisma.$transaction(async (tx) => {
    const current = await authorize(tx, actor);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`meeting-template:${parsed.requestId}`}, 0))`;
    const existing = await tx.meetingTemplate.findUnique({ where: { id: parsed.requestId }, include: templateInclude });
    if (existing) {
      const prior = serializeTemplate(existing);
      if (!existing.deletedAt && existing.createdByAccountId === current.accountId && existing.version === 0 &&
        prior.name === content.name && prior.description === content.description && prior.topic === content.topic && prior.minutes === content.minutes &&
        JSON.stringify(prior.timelineDisplay) === JSON.stringify(content.timelineDisplay) &&
        JSON.stringify([...prior.personIds].sort()) === JSON.stringify([...content.personIds].sort())) return prior;
      throw new ProjectManagementServiceError("DUPLICATE_OPERATION", "该创建请求已经处理，请从模板列表查看结果");
    }
    const errors = await validateContent(tx, current, content);
    if (Object.keys(errors).length) throw new ProjectManagementServiceError("VALIDATION_ERROR", "模板中存在不可用对象，请重新选择", errors);
    const record = await tx.meetingTemplate.create({ data: {
      id: parsed.requestId, name: content.name, description: content.description, topic: content.topic, minutes: content.minutes,
      timelineDisplay: content.timelineDisplay, createdByAccountId: current.accountId,
      participants: { create: content.personIds.map((personId) => ({ personId })) },
    }, include: templateInclude });
    const result = serializeTemplate(record);
    await createDomainAuditEventTx(tx, { actorAccountId: current.accountId, actorPersonId: current.personId,
      action: "meeting_template.create", entityType: "MeetingTemplate", entityId: record.id, after: result });
    return result;
  });
}

export async function updateMeetingTemplate(actor: ProjectManagementActor, input: unknown) {
  const parsed = updateMeetingTemplateSchema.parse(input);
  const content = { ...parsed, timelineDisplay: parsed.timelineDisplay ?? { projectIds: [], taskIds: [] } };
  return prisma.$transaction(async (tx) => {
    const current = await authorize(tx, actor);
    const before = await tx.meetingTemplate.findFirst({ where: { id: parsed.templateId, deletedAt: null }, include: templateInclude });
    if (!before) throw notFoundError();
    const errors = await validateContent(tx, current, content);
    if (Object.keys(errors).length) throw new ProjectManagementServiceError("VALIDATION_ERROR", "模板中存在不可用对象，请重新选择", errors);
    const changed = await tx.meetingTemplate.updateMany({ where: { id: parsed.templateId, deletedAt: null, version: parsed.expectedVersion }, data: {
      name: content.name, description: content.description, topic: content.topic, minutes: content.minutes,
      timelineDisplay: content.timelineDisplay, version: { increment: 1 },
    } });
    if (!changed.count) throw stateConflictError("模板已被其他管理员修改或删除，请重新打开后编辑");
    await tx.meetingTemplateParticipant.deleteMany({ where: { templateId: parsed.templateId } });
    await tx.meetingTemplateParticipant.createMany({ data: content.personIds.map((personId) => ({ templateId: parsed.templateId, personId })) });
    const result = serializeTemplate(await tx.meetingTemplate.findUniqueOrThrow({ where: { id: parsed.templateId }, include: templateInclude }));
    await createDomainAuditEventTx(tx, { actorAccountId: current.accountId, actorPersonId: current.personId,
      action: "meeting_template.update", entityType: "MeetingTemplate", entityId: parsed.templateId, before: serializeTemplate(before), after: result });
    return result;
  });
}

export async function deleteMeetingTemplate(actor: ProjectManagementActor, input: unknown) {
  const parsed = deleteMeetingTemplateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const current = await authorize(tx, actor);
    const before = await tx.meetingTemplate.findFirst({ where: { id: parsed.templateId, deletedAt: null }, include: templateInclude });
    if (!before) throw notFoundError();
    const deletedAt = new Date();
    const changed = await tx.meetingTemplate.updateMany({ where: { id: parsed.templateId, deletedAt: null, version: parsed.expectedVersion }, data: { deletedAt, version: { increment: 1 } } });
    if (!changed.count) throw stateConflictError("模板已被其他管理员修改或删除，请刷新后重试");
    await createDomainAuditEventTx(tx, { actorAccountId: current.accountId, actorPersonId: current.personId,
      action: "meeting_template.delete", entityType: "MeetingTemplate", entityId: parsed.templateId,
      before: serializeTemplate(before), after: { deletedAt: deletedAt.toISOString(), version: parsed.expectedVersion + 1 } });
    return { id: parsed.templateId };
  });
}
