import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canViewProcurementOrder,
  procurementListWhere,
  procurementSummaryWhere,
} from "@/lib/procurement-visibility";

export type LiveVersionScope =
  | "progress"
  | "progress-project"
  | "progress-task"
  | "feedback"
  | "procurement"
  | "procurement-dashboard"
  | "procurement-order"
  | "profile"
  | "admin";

export type LiveVersionContext = {
  scope: LiveVersionScope;
  resourceId?: string;
  userOpenId: string;
  isSuperAdmin: boolean;
};

type VersionPart = string | number | Date | null | undefined;

function datePart(value: Date | null | undefined): string {
  return value?.toISOString() ?? "";
}

function newestDate(...values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    if (!latest || value.getTime() > latest.getTime()) return value;
    return latest;
  }, null);
}

function encodePart(name: string, maxValue: VersionPart, count: number): string {
  const value = maxValue instanceof Date ? datePart(maxValue) : (maxValue ?? "");
  return `${name}:${value}:${count}`;
}

function encodeVersion(parts: string[]): string {
  return parts.join("|");
}

async function projectUpdatedAtVersion(
  name: string,
  where?: Prisma.ProjectWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.project.aggregate({ where, _max: { updatedAt: true } }),
    prisma.project.count({ where }),
  ]);
  return encodePart(name, aggregate._max.updatedAt, count);
}

async function purchaseOrderUpdatedAtVersion(
  name: string,
  where?: Prisma.PurchaseOrderWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.purchaseOrder.aggregate({ where, _max: { updatedAt: true } }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return encodePart(name, aggregate._max.updatedAt, count);
}

async function projectStageVersion(
  where?: Prisma.ProjectStageWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.projectStage.aggregate({ where, _max: { updatedAt: true } }),
    prisma.projectStage.count({ where }),
  ]);
  return encodePart("stages", aggregate._max.updatedAt, count);
}

async function taskVersion(where?: Prisma.TaskWhereInput): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.task.aggregate({ where, _max: { updatedAt: true } }),
    prisma.task.count({ where }),
  ]);
  return encodePart("tasks", aggregate._max.updatedAt, count);
}

async function activityVersion(
  where?: Prisma.ProgressActivityLogWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.progressActivityLog.aggregate({ where, _max: { createdAt: true } }),
    prisma.progressActivityLog.count({ where }),
  ]);
  return encodePart("activity", aggregate._max.createdAt, count);
}

async function submissionVersion(
  where?: Prisma.TaskSubmissionWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.taskSubmission.aggregate({ where, _max: { submittedAt: true } }),
    prisma.taskSubmission.count({ where }),
  ]);
  return encodePart("submissions", aggregate._max.submittedAt, count);
}

async function approvalVersion(
  where?: Prisma.ApprovalRecordWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.approvalRecord.aggregate({ where, _max: { createdAt: true } }),
    prisma.approvalRecord.count({ where }),
  ]);
  return encodePart("approvals", aggregate._max.createdAt, count);
}

async function weeklyReportVersion(
  where?: Prisma.WeeklyReportWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.weeklyReport.aggregate({ where, _max: { submittedAt: true } }),
    prisma.weeklyReport.count({ where }),
  ]);
  return encodePart("weekly", aggregate._max.submittedAt, count);
}

async function taskAssigneeVersion(
  where?: Prisma.TaskAssigneeWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.taskAssignee.aggregate({ where, _max: { createdAt: true } }),
    prisma.taskAssignee.count({ where }),
  ]);
  return encodePart("taskAssignees", aggregate._max.createdAt, count);
}

async function projectOwnerVersion(
  where?: Prisma.ProjectOwnerWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.projectOwner.aggregate({ where, _max: { createdAt: true } }),
    prisma.projectOwner.count({ where }),
  ]);
  return encodePart("projectOwners", aggregate._max.createdAt, count);
}

async function userRoleVersion(openId: string): Promise<string> {
  const roles = await prisma.userRole.findMany({
    where: { openId },
    orderBy: [{ role: "asc" }, { team: "asc" }, { techGroup: "asc" }],
    select: { role: true, team: true, techGroup: true },
  });
  return `roles:${JSON.stringify(roles)}`;
}

async function userProfileVersion(openId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { openId },
    select: { name: true, avatar: true, signaturePath: true },
  });
  return `user:${JSON.stringify(user ?? null)}`;
}

async function checklistItemVersion(
  where?: Prisma.TaskAcceptanceChecklistItemWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.taskAcceptanceChecklistItem.aggregate({
      where,
      _max: { createdAt: true },
    }),
    prisma.taskAcceptanceChecklistItem.count({ where }),
  ]);
  return encodePart("checklistItems", aggregate._max.createdAt, count);
}

async function checklistTemplateVersion(): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.acceptanceChecklistTemplate.aggregate({
      _max: { updatedAt: true },
    }),
    prisma.acceptanceChecklistTemplate.count(),
  ]);
  return encodePart("checklistTemplates", aggregate._max.updatedAt, count);
}

async function approvalChecklistVersion(
  where?: Prisma.ApprovalChecklistConfirmationWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.approvalChecklistConfirmation.aggregate({
      where,
      _max: { createdAt: true },
    }),
    prisma.approvalChecklistConfirmation.count({ where }),
  ]);
  return encodePart("approvalChecklist", aggregate._max.createdAt, count);
}

async function getProgressVersion(): Promise<string> {
  const parts = await Promise.all([
    projectUpdatedAtVersion("projects"),
    projectStageVersion(),
    taskVersion(),
    activityVersion(),
    submissionVersion(),
    approvalVersion(),
    weeklyReportVersion(),
    taskAssigneeVersion(),
    projectOwnerVersion(),
    checklistItemVersion(),
    checklistTemplateVersion(),
    approvalChecklistVersion(),
  ]);
  return encodeVersion(parts);
}

async function getProgressProjectVersion(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) return `missing:progress-project:${projectId}`;

  const [taskIds, stageIds] = await Promise.all([
    prisma.task.findMany({
      where: { projectId },
      select: { id: true },
    }),
    prisma.projectStage.findMany({
      where: { projectId },
      select: { id: true },
    }),
  ]);
  const taskIdList = taskIds.map((task) => task.id);
  const stageIdList = stageIds.map((stage) => stage.id);
  const submissionWhere: Prisma.TaskSubmissionWhereInput = {
    OR: [
      { projectId },
      ...(taskIdList.length > 0 ? [{ taskId: { in: taskIdList } }] : []),
      ...(stageIdList.length > 0 ? [{ stageId: { in: stageIdList } }] : []),
    ],
  };
  const submissionIds = await prisma.taskSubmission.findMany({
    where: submissionWhere,
    select: { id: true },
  });
  const submissionIdList = submissionIds.map((submission) => submission.id);
  const approvalWhere: Prisma.ApprovalRecordWhereInput =
    submissionIdList.length > 0
      ? { submissionId: { in: submissionIdList } }
      : { id: "__none__" };

  const parts = await Promise.all([
    projectUpdatedAtVersion("projects", { id: projectId }),
    projectStageVersion({ projectId }),
    taskVersion({ projectId }),
    activityVersion({
      OR: [
        { projectId },
        ...(taskIdList.length > 0 ? [{ taskId: { in: taskIdList } }] : []),
      ],
    }),
    submissionVersion(submissionWhere),
    approvalVersion(approvalWhere),
    weeklyReportVersion(
      taskIdList.length > 0 ? { taskId: { in: taskIdList } } : { id: "__none__" },
    ),
    taskAssigneeVersion(
      taskIdList.length > 0 ? { taskId: { in: taskIdList } } : { id: "__none__" },
    ),
    projectOwnerVersion({ projectId }),
    checklistItemVersion(
      taskIdList.length > 0 ? { taskId: { in: taskIdList } } : { id: "__none__" },
    ),
    checklistTemplateVersion(),
    approvalChecklistVersion(
      submissionIdList.length > 0
        ? { approval: { submissionId: { in: submissionIdList } } }
        : { id: "__none__" },
    ),
  ]);
  return encodeVersion(parts);
}

async function getProgressTaskVersion(taskId: string): Promise<string> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true },
  });
  if (!task) return `missing:progress-task:${taskId}`;

  const submissionIds = await prisma.taskSubmission.findMany({
    where: { taskId },
    select: { id: true },
  });
  const submissionIdList = submissionIds.map((submission) => submission.id);
  const approvalWhere: Prisma.ApprovalRecordWhereInput =
    submissionIdList.length > 0
      ? { submissionId: { in: submissionIdList } }
      : { id: "__none__" };

  const parts = await Promise.all([
    projectUpdatedAtVersion("project", { id: task.projectId }),
    projectStageVersion({ projectId: task.projectId }),
    taskVersion({ id: taskId }),
    activityVersion({ taskId }),
    submissionVersion({ taskId }),
    approvalVersion(approvalWhere),
    weeklyReportVersion({ taskId }),
    taskAssigneeVersion({ taskId }),
    checklistItemVersion({ taskId }),
    checklistTemplateVersion(),
    approvalChecklistVersion(
      submissionIdList.length > 0
        ? { approval: { submissionId: { in: submissionIdList } } }
        : { id: "__none__" },
    ),
  ]);
  return encodeVersion(parts);
}

async function getFeedbackVersion({
  userOpenId,
  isSuperAdmin,
}: Pick<LiveVersionContext, "userOpenId" | "isSuperAdmin">): Promise<string> {
  const feedbackWhere: Prisma.FeedbackWhereInput = isSuperAdmin
    ? {}
    : { submitterOpenId: userOpenId };
  const messageWhere: Prisma.FeedbackMessageWhereInput = isSuperAdmin
    ? {}
    : { feedback: { submitterOpenId: userOpenId } };
  const attachmentWhere: Prisma.FeedbackAttachmentWhereInput = isSuperAdmin
    ? {}
    : { message: { feedback: { submitterOpenId: userOpenId } } };

  const [
    feedbackUpdated,
    feedbackMessageCreated,
    feedbackAttachmentCreated,
    feedbackCount,
    messageCount,
    attachmentCount,
  ] = await Promise.all([
    prisma.feedback.aggregate({
      where: feedbackWhere,
      _max: { updatedAt: true, lastMessageAt: true },
    }),
    prisma.feedbackMessage.aggregate({
      where: messageWhere,
      _max: { createdAt: true },
    }),
    prisma.feedbackAttachment.aggregate({
      where: attachmentWhere,
      _max: { createdAt: true },
    }),
    prisma.feedback.count({ where: feedbackWhere }),
    prisma.feedbackMessage.count({ where: messageWhere }),
    prisma.feedbackAttachment.count({ where: attachmentWhere }),
  ]);

  return encodeVersion([
    encodePart(
      "feedback",
      newestDate(
        feedbackUpdated._max.updatedAt,
        feedbackUpdated._max.lastMessageAt,
      ),
      feedbackCount,
    ),
    encodePart("messages", feedbackMessageCreated._max.createdAt, messageCount),
    encodePart(
      "attachments",
      feedbackAttachmentCreated._max.createdAt,
      attachmentCount,
    ),
  ]);
}

async function purchaseItemVersion(
  where?: Prisma.PurchaseItemWhereInput,
): Promise<string> {
  const count = await prisma.purchaseItem.count({ where });
  return encodePart("items", "", count);
}

async function getProcurementVersion(userOpenId: string): Promise<string> {
  const orderWhere = procurementListWhere(userOpenId, {
    includeRejected: true,
  });
  const itemWhere: Prisma.PurchaseItemWhereInput = { order: orderWhere };
  const parts = await Promise.all([
    purchaseOrderUpdatedAtVersion("orders", orderWhere),
    purchaseItemVersion(itemWhere),
  ]);
  return encodeVersion(parts);
}

async function getProcurementDashboardVersion(): Promise<string> {
  const orderWhere = procurementSummaryWhere();
  const itemWhere: Prisma.PurchaseItemWhereInput = { order: orderWhere };
  const parts = await Promise.all([
    purchaseOrderUpdatedAtVersion("orders", orderWhere),
    purchaseItemVersion(itemWhere),
  ]);
  return encodeVersion(parts);
}

async function getProcurementOrderVersion({
  orderId,
  userOpenId,
  isSuperAdmin,
}: {
  orderId: string;
  userOpenId: string;
  isSuperAdmin: boolean;
}): Promise<string> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      initiator: { select: { openId: true } },
      _count: { select: { items: true } },
    },
  });
  if (
    !order ||
    !canViewProcurementOrder(
      order.status,
      userOpenId,
      order.initiator.openId,
      isSuperAdmin,
    )
  ) {
    return `missing:procurement-order:${orderId}`;
  }

  return encodeVersion([
    encodePart("order", order.updatedAt, 1),
    encodePart("statusEntered", order.statusEnteredAt, 1),
    encodePart("rejected", order.rejectedAt, order.rejectionReason ? 1 : 0),
    encodePart("items", "", order._count.items),
  ]);
}

async function getProfileVersion(userOpenId: string): Promise<string> {
  const orderWhere: Prisma.PurchaseOrderWhereInput = {
    initiator: { openId: userOpenId },
  };
  const projectWhere: Prisma.ProjectWhereInput = {
    OR: [
      { ownerOpenId: userOpenId },
      { owners: { some: { openId: userOpenId } } },
    ],
  };
  const taskWhere: Prisma.TaskWhereInput = {
    OR: [
      { assigneeOpenId: userOpenId },
      { assignees: { some: { openId: userOpenId } } },
    ],
  };

  const parts = await Promise.all([
    userProfileVersion(userOpenId),
    purchaseOrderUpdatedAtVersion("orders", orderWhere),
    projectUpdatedAtVersion("projects", projectWhere),
    taskVersion(taskWhere),
    projectOwnerVersion({ openId: userOpenId }),
    taskAssigneeVersion({ openId: userOpenId }),
  ]);
  return encodeVersion(parts);
}

async function getAdminVersion(): Promise<string> {
  const [users, roles, templateAggregate, templateCount] = await Promise.all([
    prisma.user.findMany({
      orderBy: { openId: "asc" },
      select: {
        openId: true,
        name: true,
        avatar: true,
        signaturePath: true,
        createdAt: true,
      },
    }),
    prisma.userRole.findMany({
      orderBy: [
        { openId: "asc" },
        { role: "asc" },
        { team: "asc" },
        { techGroup: "asc" },
      ],
      select: { openId: true, role: true, team: true, techGroup: true },
    }),
    prisma.acceptanceChecklistTemplate.aggregate({
      _max: { updatedAt: true },
    }),
    prisma.acceptanceChecklistTemplate.count(),
  ]);

  return encodeVersion([
    `users:${JSON.stringify(
      users.map((user) => ({
        ...user,
        createdAt: user.createdAt.toISOString(),
      })),
    )}`,
    `roles:${JSON.stringify(roles)}`,
    encodePart(
      "templates",
      templateAggregate._max.updatedAt,
      templateCount,
    ),
  ]);
}

export async function getLiveVersion(
  context: LiveVersionContext,
): Promise<string> {
  const userVersion = await userRoleVersion(context.userOpenId);
  const withUserVersion = (version: string) =>
    encodeVersion([version, userVersion]);

  if (context.scope === "progress") {
    return withUserVersion(await getProgressVersion());
  }
  if (context.scope === "progress-project") {
    if (!context.resourceId) return "missing:progress-project";
    return withUserVersion(await getProgressProjectVersion(context.resourceId));
  }
  if (context.scope === "progress-task") {
    if (!context.resourceId) return "missing:progress-task";
    return withUserVersion(await getProgressTaskVersion(context.resourceId));
  }
  if (context.scope === "feedback") {
    return withUserVersion(await getFeedbackVersion(context));
  }
  if (context.scope === "procurement") {
    return withUserVersion(await getProcurementVersion(context.userOpenId));
  }
  if (context.scope === "procurement-dashboard") {
    return withUserVersion(await getProcurementDashboardVersion());
  }
  if (context.scope === "procurement-order") {
    if (!context.resourceId) return "missing:procurement-order";
    return withUserVersion(
      await getProcurementOrderVersion({
        orderId: context.resourceId,
        userOpenId: context.userOpenId,
        isSuperAdmin: context.isSuperAdmin,
      }),
    );
  }
  if (context.scope === "profile") {
    return withUserVersion(await getProfileVersion(context.userOpenId));
  }
  if (context.scope === "admin") {
    if (!context.isSuperAdmin) return withUserVersion("admin:forbidden");
    return withUserVersion(await getAdminVersion());
  }

  return "unknown";
}

export function isLiveVersionScope(value: string): value is LiveVersionScope {
  return [
    "progress",
    "progress-project",
    "progress-task",
    "feedback",
    "procurement",
    "procurement-dashboard",
    "procurement-order",
    "profile",
    "admin",
  ].includes(value);
}
