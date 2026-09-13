import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { formatDateTime } from "@/lib/project-management/labels";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { refreshProjectManagementActorTx } from "./actor-refresh";
import { createProjectManagementEventNotificationsTx, recipientsForPersonIdsTx } from "./notification-utils";
import { notFoundError, ProjectManagementServiceError, stateConflictError } from "./errors";
import { meetingUrgeInputSchema, meetingUrgeQuerySchema } from "@/lib/project-management/validations/meeting-urge";

async function loadMeeting(tx: Prisma.TransactionClient, actor: ProjectManagementActor, meetingId: string) {
  const meeting = await tx.meetingRecord.findUnique({ where: { id: meetingId }, include: {
    participants: { select: { person: { select: { id: true, displayName: true, status: true, accountId: true } } }, orderBy: { personId: "asc" } },
  } });
  if (!meeting) throw notFoundError();
  if (!actor.isActive || !meeting.participants.some(({ person }) => person.id === actor.personId)) {
    throw new ProjectManagementServiceError("FORBIDDEN", "只有在职会议参会者可以发送投入填写提醒");
  }
  return meeting;
}

export async function listMeetingMissingPeople(actor: ProjectManagementActor, input: unknown) {
  const { meetingId } = meetingUrgeQuerySchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const meeting = await loadMeeting(tx, refreshedActor, meetingId);
    const filled = await tx.workSegment.findMany({ where: {
      personId: { in: meeting.participants.map(({ person }) => person.id) }, deletedAt: null,
      startAt: { lt: meeting.rangeEnd }, endAt: { gt: meeting.rangeStart },
    }, select: { personId: true }, distinct: ["personId"] });
    const filledIds = new Set(filled.map((row) => row.personId));
    return {
      meetingId: meeting.id, topic: meeting.topic, version: meeting.version,
      rangeStart: meeting.rangeStart.toISOString(), rangeEnd: meeting.rangeEnd.toISOString(),
      participants: meeting.participants.map(({ person }) => ({
        id: person.id, displayName: person.displayName, missing: !filledIds.has(person.id),
        eligible: person.status === "ACTIVE" && Boolean(person.accountId),
      })),
    };
  });
}

export async function urgeMeetingWorkSegments(actor: ProjectManagementActor, input: unknown) {
  const parsed = meetingUrgeInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "MeetingRecord" WHERE "id" = ${parsed.meetingId} FOR UPDATE`;
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const meeting = await loadMeeting(tx, refreshedActor, parsed.meetingId);
    const recipientIds = [...new Set(parsed.recipientPersonIds)].sort();
    const signature = JSON.stringify({ recipientIds, version: parsed.expectedVersion });
    const previous = await tx.domainAuditEvent.findFirst({ where: {
      actorAccountId: actor.accountId, entityType: "MeetingRecord", entityId: meeting.id,
      action: "pm.meeting.work_segment_reminder", requestId: parsed.requestId,
    } });
    if (previous) {
      if (previous.reason !== signature) throw stateConflictError("该请求已提交，请重新打开弹窗发起提醒");
      return { recipientCount: recipientIds.length };
    }
    if (meeting.version !== parsed.expectedVersion) throw stateConflictError("会议已更新，请重新打开弹窗确认参会人员和时间范围");
    const eligibleIds = new Set(meeting.participants.filter(({ person }) => person.status === "ACTIVE" && person.accountId).map(({ person }) => person.id));
    if (recipientIds.some((id) => !eligibleIds.has(id))) throw new ProjectManagementServiceError("FORBIDDEN", "只能提醒本会议已绑定账号的在职参会人员");
    const recipients = await recipientsForPersonIdsTx(tx, recipientIds);
    if (recipients.length !== recipientIds.length) throw stateConflictError("收件人状态已变化，请重新打开弹窗");
    const audit = await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId, actorPersonId: actor.personId, action: "pm.meeting.work_segment_reminder",
      entityType: "MeetingRecord", entityId: meeting.id, requestId: parsed.requestId, reason: signature,
      after: { recipientPersonIds: recipientIds, recipientAccountIds: recipients.map((recipient) => recipient.accountId),
        topic: meeting.topic, rangeStart: meeting.rangeStart.toISOString(), rangeEnd: meeting.rangeEnd.toISOString() },
    });
    await createProjectManagementEventNotificationsTx(tx, {
      actor: refreshedActor, kind: "meeting_work_segment_reminder", category: "TASK",
      eventKey: `pm:meeting:work-segment-reminder:${audit.id}`, title: "会议投入填写提醒",
      summary: `会议：${meeting.topic}\n工作区间：${formatDateTime(meeting.rangeStart)} 至 ${formatDateTime(meeting.rangeEnd)}（北京时间）\n请提前填写该区间内自己的工作投入，方便会议总结。`,
      entityType: "MeetingRecord", entityId: meeting.id, linkPath: routes.progress.meetingDetail(meeting.id),
      mandatory: true, recipients,
      context: { meetingTopic: meeting.topic, rangeStart: meeting.rangeStart.toISOString(), rangeEnd: meeting.rangeEnd.toISOString() },
    });
    return { recipientCount: recipients.length };
  });
}
