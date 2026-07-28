import type {
  Prisma,
  ProjectManagementNotificationCategory,
  TaskStatus,
} from "@prisma/client";
import {
  createInAppNotificationTx,
  enqueueProjectManagementNotificationTx,
  PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
  type ProjectManagementNotificationPayload,
} from "@/lib/project-management/notifications/events";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export type ProjectManagementNotificationRecipient = {
  accountId: string;
  openId: string | null;
};

export type ProjectManagementNotificationTaskContext = {
  id: string;
  title: string;
  status?: TaskStatus;
  currentPlanVersionId?: string;
};

export async function createProjectManagementEventNotificationsTx(
  tx: Prisma.TransactionClient,
  input: {
    actor?: ProjectManagementActor | null;
    actorName?: string;
    task?: ProjectManagementNotificationTaskContext | null;
    kind: ProjectManagementNotificationPayload["kind"];
    category: ProjectManagementNotificationCategory;
    eventKey: string;
    title: string;
    summary: string;
    entityType: string;
    entityId: string;
    linkPath?: string;
    mandatory: boolean;
    recipients: ProjectManagementNotificationRecipient[];
    context?: Record<string, unknown>;
  },
) {
  const uniqueRecipients = uniqueRecipientsByAccount(input.recipients);
  if (uniqueRecipients.length === 0) return { recipientCount: 0 };

  const actorName =
    input.actorName ??
    (input.actor ? await actorDisplayNameTx(tx, input.actor) : "系统");
  const payload: ProjectManagementNotificationPayload = {
    kind: input.kind,
    payloadVersion: PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
    purpose:
      input.kind === "milestone_review_submitted" ||
      input.kind === "revision_pending_review"
        ? "approval_request"
        : "notification",
    category: input.category,
    title: input.title,
    summary: input.summary,
    actorName,
    taskId: input.task?.id ?? null,
    taskTitle: input.task?.title ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    linkPath: input.linkPath ?? "/progress",
    recipientOpenIds: uniqueRecipients
      .map((recipient) => recipient.openId)
      .filter((openId): openId is string => Boolean(openId)),
    mandatory: input.mandatory,
    context: {
      ...(input.task?.status ? { taskStatus: input.task.status } : {}),
      ...(input.task?.currentPlanVersionId
        ? { currentPlanVersionId: input.task.currentPlanVersionId }
        : {}),
      ...(input.context ?? {}),
    },
  };
  const inAppPayload: ProjectManagementNotificationPayload = {
    ...payload,
    recipientOpenIds: [],
  };

  for (const recipient of uniqueRecipients) {
    await createInAppNotificationTx(tx, {
      eventKey: `${input.eventKey}:inapp:${recipient.accountId}`,
      recipientAccountId: recipient.accountId,
      category: input.category,
      title: input.title,
      summary: input.summary,
      entityType: input.entityType,
      entityId: input.entityId,
      taskId: input.task?.id ?? null,
      linkPath: input.linkPath ?? "/progress",
      payload: jsonValue(inAppPayload),
    });
  }
  await enqueueProjectManagementNotificationTx(tx, {
    eventKey: `${input.eventKey}:feishu`,
    type: input.kind,
    payload,
  });
  return { recipientCount: uniqueRecipients.length };
}

export async function recipientsForPersonIdsTx(
  tx: Prisma.TransactionClient,
  personIds: string[],
): Promise<ProjectManagementNotificationRecipient[]> {
  if (personIds.length === 0) return [];
  const people = await tx.person.findMany({
    where: {
      id: { in: [...new Set(personIds)] },
      status: "ACTIVE",
      account: { status: "ACTIVE" },
    },
    select: {
      account: {
        select: {
          id: true,
          identities: {
            where: { provider: "FEISHU" },
            select: { openId: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
    },
  });
  return people.flatMap((person) => {
    if (!person.account) return [];
    return [
      {
        accountId: person.account.id,
        openId: person.account.identities[0]?.openId ?? null,
      },
    ];
  });
}

export async function recipientsForAccountIdsTx(
  tx: Prisma.TransactionClient,
  accountIds: string[],
): Promise<ProjectManagementNotificationRecipient[]> {
  if (accountIds.length === 0) return [];
  const accounts = await tx.account.findMany({
    where: { id: { in: [...new Set(accountIds)] }, status: "ACTIVE" },
    select: {
      id: true,
      identities: {
        where: { provider: "FEISHU" },
        select: { openId: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  return accounts.map((account) => ({
    accountId: account.id,
    openId: account.identities[0]?.openId ?? null,
  }));
}

export function uniqueRecipientsByAccount(
  recipients: ProjectManagementNotificationRecipient[],
): ProjectManagementNotificationRecipient[] {
  const seen = new Set<string>();
  const unique: ProjectManagementNotificationRecipient[] = [];
  for (const recipient of recipients) {
    if (seen.has(recipient.accountId)) continue;
    seen.add(recipient.accountId);
    unique.push(recipient);
  }
  return unique;
}

async function actorDisplayNameTx(
  tx: Prisma.TransactionClient,
  actor: ProjectManagementActor,
) {
  const person = await tx.person.findUnique({
    where: { id: actor.personId },
    select: { displayName: true },
  });
  return person?.displayName ?? "系统用户";
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
