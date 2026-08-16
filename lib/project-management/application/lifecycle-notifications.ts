import type {
  MilestoneReviewResult,
  Prisma,
  ProjectManagementNotificationCategory,
  TerminationOutcome,
  TerminationReviewResult,
} from "@prisma/client";
import {
  ACTIVE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED,
  activeGlobalApprovalAdministratorAccountIdsTx,
  lockGlobalApprovalAdministratorSetTx,
} from "@/lib/project-management/approval-administrators";
import {
  DEFAULT_FEISHU_IDENTITY_WHERE,
  FEISHU_OPEN_IDENTITY_ORDER,
  FEISHU_OPEN_IDENTITY_SELECT,
  firstNonEmptyFeishuOpenId,
} from "@/lib/project-management/application/feishu-identity";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountsOrPeopleTx,
  recipientsForTaskMembersTx,
} from "@/lib/project-management/application/notification-utils";
import { stateConflictError } from "@/lib/project-management/application/errors";
import type {
  LifecycleNotificationRecipient,
  LifecycleTaskForAuthorization,
} from "@/lib/project-management/application/lifecycle-records";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type { ProjectManagementNotificationPayload } from "@/lib/project-management/notifications/events";
import {
  SYSTEM_DEFAULT_NOTIFICATION_SUMMARY,
  USER_PROVIDED_NOTIFICATION_SUMMARY,
} from "@/lib/project-management/notifications/user-facing-copy";

type PrismaTx = Prisma.TransactionClient;

export async function notifyTaskMembersTx(
  tx: PrismaTx,
  input: NotificationInput,
) {
  const recipients = await recipientsForTaskMembersTx(tx, {
    taskId: input.task.id,
    roles: ["OWNER", "PARTICIPANT"],
  });
  await createLifecycleNotificationsTx(tx, { ...input, recipients });
}

export async function notifyGlobalAdministratorsTx(
  tx: PrismaTx,
  input: NotificationInput & {
    kind:
      | "milestone_review_submitted"
      | "revision_pending_review"
      | "termination_review_submitted";
  },
) {
  const recipients = await globalAdministratorRecipientsTx(tx);
  await createLifecycleNotificationsTx(tx, { ...input, recipients });
}

export async function notifyRevisionResultTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: LifecycleTaskForAuthorization;
    revisionNodeId: string;
    title: string;
    summary: string;
    eventKey: string;
    recipients: LifecycleNotificationRecipient[];
  },
) {
  await createLifecycleNotificationsTx(tx, {
    actor: input.actor,
    task: input.task,
    kind: "revision_result",
    category: "REVISION",
    eventKey: input.eventKey,
    title: input.title,
    summary: input.summary,
    entityType: "RevisionNode",
    entityId: input.revisionNodeId,
    mandatory: true,
    recipients: input.recipients,
  });
}

export async function notifyMilestoneReviewResultTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: LifecycleTaskForAuthorization;
    reviewId: string;
    result: MilestoneReviewResult;
    summary: string;
    systemGeneratedSummary: boolean;
    recipients: LifecycleNotificationRecipient[];
  },
) {
  await createLifecycleNotificationsTx(tx, {
    actor: input.actor,
    task: input.task,
    kind: "milestone_review_result",
    category: "REVIEW",
    eventKey: `pm:milestone:review_result:${input.reviewId}:${input.result}`,
    title: "里程碑验收结果已更新",
    summary: input.summary,
    entityType: "MilestoneReview",
    entityId: input.reviewId,
    mandatory: true,
    recipients: input.recipients,
    context: {
      summarySource: input.systemGeneratedSummary
        ? SYSTEM_DEFAULT_NOTIFICATION_SUMMARY
        : USER_PROVIDED_NOTIFICATION_SUMMARY,
    },
  });
}

export async function notifyTerminationReviewResultTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: LifecycleTaskForAuthorization;
    reviewId: string;
    terminationNodeId: string;
    result: TerminationReviewResult;
    outcome: TerminationOutcome;
    terminalName: string;
    reason: string;
    terminationSummary: string;
    reviewComment: string;
    summary: string;
    recipients: LifecycleNotificationRecipient[];
  },
) {
  await createLifecycleNotificationsTx(tx, {
    actor: input.actor,
    task: input.task,
    kind: "termination_review_result",
    category: "REVIEW",
    eventKey: `pm:termination:review_result:${input.reviewId}:${input.result}`,
    title:
      input.result === "REJECTED"
        ? "任务结束申请已驳回"
        : "任务结束申请需要修订",
    summary: input.summary,
    entityType: "TerminationReview",
    entityId: input.reviewId,
    linkPath: `/progress/tasks/${input.task.id}?focus=${input.terminationNodeId}`,
    mandatory: true,
    recipients: input.recipients,
    context: {
      terminalName: input.terminalName,
      requestedOutcome: input.outcome,
      decision: input.result,
      reason: input.reason,
      summary: input.terminationSummary,
      reviewComment: input.reviewComment,
    },
  });
}

export async function createLifecycleNotificationsTx(
  tx: PrismaTx,
  input: NotificationInput & { recipients: LifecycleNotificationRecipient[] },
) {
  await createProjectManagementEventNotificationsTx(tx, {
    actor: input.actor,
    task: {
      id: input.task.id,
      title: input.task.title,
      status: input.task.status,
      currentPlanVersionId: input.task.currentPlanVersionId,
    },
    kind: input.kind,
    category: input.category,
    eventKey: input.eventKey,
    title: input.title,
    summary: input.summary,
    entityType: input.entityType,
    entityId: input.entityId,
    linkPath: input.linkPath ?? "/progress",
    mandatory: input.mandatory,
    recipients: input.recipients,
    context: input.context,
  });
}

export async function revisionCreatorAndOwnersTx(
  tx: PrismaTx,
  task: LifecycleTaskForAuthorization,
  revision: { node: { createdByAccountId: string } },
): Promise<LifecycleNotificationRecipient[]> {
  return recipientsForAccountsOrPeopleTx(tx, {
    accountIds: [revision.node.createdByAccountId],
    personIds: task.members
      .filter((member) => member.role === "OWNER")
      .map((member) => member.personId),
  });
}

export async function reviewSubmitterAndOwnersTx(
  tx: PrismaTx,
  task: LifecycleTaskForAuthorization,
  review: { submittedByAccountId: string | null },
): Promise<LifecycleNotificationRecipient[]> {
  return recipientsForAccountsOrPeopleTx(tx, {
    accountIds: review.submittedByAccountId ? [review.submittedByAccountId] : [],
    personIds: task.members
      .filter((member) => member.role === "OWNER")
      .map((member) => member.personId),
  });
}

async function globalAdministratorRecipientsTx(
  tx: PrismaTx,
): Promise<LifecycleNotificationRecipient[]> {
  await lockGlobalApprovalAdministratorSetTx(tx);
  const accountIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
  if (accountIds.length === 0) {
    throw stateConflictError(ACTIVE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED);
  }
  const accounts = await tx.account.findMany({
    where: { id: { in: accountIds } },
    select: {
      id: true,
      identities: {
        where: DEFAULT_FEISHU_IDENTITY_WHERE,
        select: FEISHU_OPEN_IDENTITY_SELECT,
        orderBy: FEISHU_OPEN_IDENTITY_ORDER,
      },
    },
    orderBy: { id: "asc" },
  });
  const recipients = accounts.map((account) => ({
    accountId: account.id,
    openId: firstNonEmptyFeishuOpenId(account.identities),
  }));
  if (!recipients.some((recipient) => recipient.openId)) {
    throw stateConflictError(
      "当前没有具备有效飞书身份的活跃全局管理员，无法提交审批",
    );
  }
  return recipients;
}

type NotificationInput = {
  actor: ProjectManagementActor;
  task: LifecycleTaskForAuthorization;
  kind: ProjectManagementNotificationPayload["kind"];
  category: ProjectManagementNotificationCategory;
  eventKey: string;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  linkPath?: string;
  mandatory: boolean;
  context?: Record<string, unknown>;
};
