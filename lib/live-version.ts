import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canViewProcurementOrder,
  procurementListWhere,
  procurementSummaryWhere,
} from "@/lib/procurement-visibility";
import {
  progressProjectMineWhere,
  progressProjectReadableWhere,
  progressTaskMineWhere,
  progressTaskReadableWhere,
} from "@/lib/permissions-progress";

export type LiveVersionScope =
  | "progress"
  | "progress-list"
  | "progress-board"
  | "progress-archive"
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
  mine?: boolean;
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

async function taskDeletionRequestVersion(
  where?: Prisma.TaskDeletionRequestWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.taskDeletionRequest.aggregate({ where, _max: { updatedAt: true } }),
    prisma.taskDeletionRequest.count({ where }),
  ]);
  return encodePart("taskDeletionRequests", aggregate._max.updatedAt, count);
}

async function taskCreationRequestVersion(
  where?: Prisma.TaskCreationRequestWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.taskCreationRequest.aggregate({ where, _max: { updatedAt: true } }),
    prisma.taskCreationRequest.count({ where }),
  ]);
  return encodePart("taskCreationRequests", aggregate._max.updatedAt, count);
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

async function visibleProjectTaskCountVersion({
  projectIds,
  roles,
  userOpenId,
  mine,
}: {
  projectIds: string[];
  roles: Awaited<ReturnType<typeof getProgressUserRoles>>;
  userOpenId: string;
  mine?: boolean;
}): Promise<string> {
  if (projectIds.length === 0) return encodePart("projectTaskCount", "", 0);

  const countParts: string[] = [];
  const grouped = await prisma.task.groupBy({
    by: ["projectId"],
    where: {
      AND: [
        progressTaskReadableWhere(roles, userOpenId),
        mine ? progressTaskMineWhere(userOpenId) : {},
        { projectId: { in: projectIds } },
      ],
    },
    _count: { _all: true },
  });
  const groupedCounts = new Map(
    grouped.map((row) => [row.projectId, row._count._all]),
  );
  for (const projectId of projectIds) {
    countParts.push(`${projectId}:${groupedCounts.get(projectId) ?? 0}`);
  }

  countParts.sort();
  return `projectTaskCount:${countParts.join(",")}`;
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

async function projectParticipantVersion(
  where?: Prisma.ProjectParticipantWhereInput,
): Promise<string> {
  const [aggregate, count] = await Promise.all([
    prisma.projectParticipant.aggregate({ where, _max: { createdAt: true } }),
    prisma.projectParticipant.count({ where }),
  ]);
  return encodePart("projectParticipants", aggregate._max.createdAt, count);
}

async function projectIdList(where: Prisma.ProjectWhereInput): Promise<string[]> {
  const rows = await prisma.project.findMany({
    where,
    select: { id: true },
  });
  return rows.map((row) => row.id);
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

async function getProgressUserRoles(userOpenId: string) {
  return prisma.userRole.findMany({
    where: { openId: userOpenId },
    select: { role: true, team: true, techGroup: true },
  });
}

async function getProgressListVersion({
  userOpenId,
  mine,
}: Pick<LiveVersionContext, "userOpenId" | "mine">): Promise<string> {
  const roles = await getProgressUserRoles(userOpenId);
  const projectWhere: Prisma.ProjectWhereInput = {
    AND: [
      progressProjectReadableWhere(roles, userOpenId),
      mine ? progressProjectMineWhere(userOpenId) : {},
      { status: { notIn: ["COMPLETED", "CANCELED"] } },
    ],
  };
  const projectIds = await projectIdList(projectWhere);
  const parts = await Promise.all([
    projectUpdatedAtVersion("projects", projectWhere),
    visibleProjectTaskCountVersion({ projectIds, roles, userOpenId, mine }),
    projectParticipantVersion(
      projectIds.length > 0 ? { projectId: { in: projectIds } } : { id: "__none__" },
    ),
    taskCreationRequestVersion(
      projectIds.length > 0 ? { projectId: { in: projectIds } } : { id: "__none__" },
    ),
  ]);
  return encodeVersion(parts);
}

async function getProgressBoardVersion({
  userOpenId,
  mine,
}: Pick<LiveVersionContext, "userOpenId" | "mine">): Promise<string> {
  const roles = await getProgressUserRoles(userOpenId);
  const taskWhere: Prisma.TaskWhereInput = {
    AND: [
      progressTaskReadableWhere(roles, userOpenId),
      mine ? progressTaskMineWhere(userOpenId) : {},
      { status: { not: "ARCHIVED" } },
    ],
  };
  const taskRows = await prisma.task.findMany({
    where: taskWhere,
    select: { id: true, projectId: true, stageId: true },
  });
  const taskIds = taskRows.map((task) => task.id);
  const projectIds = [...new Set(taskRows.map((task) => task.projectId))];
  const stageIds = [
    ...new Set(
      taskRows
        .map((task) => task.stageId)
        .filter((stageId): stageId is string => !!stageId),
    ),
  ];
  const parts = await Promise.all([
    taskVersion(taskWhere),
    taskAssigneeVersion(
      taskIds.length > 0 ? { taskId: { in: taskIds } } : { id: "__none__" },
    ),
    projectUpdatedAtVersion(
      "taskProjects",
      projectIds.length > 0 ? { id: { in: projectIds } } : { id: "__none__" },
    ),
    projectStageVersion(
      stageIds.length > 0 ? { id: { in: stageIds } } : { id: "__none__" },
    ),
    projectParticipantVersion(
      projectIds.length > 0 ? { projectId: { in: projectIds } } : { id: "__none__" },
    ),
    taskCreationRequestVersion(
      projectIds.length > 0 ? { projectId: { in: projectIds } } : { id: "__none__" },
    ),
  ]);
  return encodeVersion(parts);
}

async function getProgressArchiveVersion({
  userOpenId,
  mine,
}: Pick<LiveVersionContext, "userOpenId" | "mine">): Promise<string> {
  const roles = await getProgressUserRoles(userOpenId);
  const projectWhere: Prisma.ProjectWhereInput = {
    AND: [
      progressProjectReadableWhere(roles, userOpenId),
      mine ? progressProjectMineWhere(userOpenId) : {},
      { status: { in: ["COMPLETED", "CANCELED"] } },
    ],
  };
  const taskWhere: Prisma.TaskWhereInput = {
    AND: [
      progressTaskReadableWhere(roles, userOpenId),
      mine ? progressTaskMineWhere(userOpenId) : {},
      { status: "ARCHIVED" },
    ],
  };
  const archivedTaskRows = await prisma.task.findMany({
    where: taskWhere,
    select: { id: true, projectId: true },
  });
  const taskIds = archivedTaskRows.map((task) => task.id);
  const archivedTaskProjectIds = [
    ...new Set(archivedTaskRows.map((task) => task.projectId)),
  ];
  const parts = await Promise.all([
    projectUpdatedAtVersion("archivedProjects", projectWhere),
    taskVersion(taskWhere),
    taskAssigneeVersion(
      taskIds.length > 0 ? { taskId: { in: taskIds } } : { id: "__none__" },
    ),
    projectUpdatedAtVersion(
      "archivedTaskProjects",
      archivedTaskProjectIds.length > 0
        ? { id: { in: archivedTaskProjectIds } }
        : { id: "__none__" },
    ),
    projectParticipantVersion(
      archivedTaskProjectIds.length > 0
        ? { projectId: { in: archivedTaskProjectIds } }
        : { id: "__none__" },
    ),
  ]);
  return encodeVersion(parts);
}

async function getProgressProjectVersion(
  projectId: string,
  { userOpenId }: Pick<LiveVersionContext, "userOpenId">,
): Promise<string> {
  const roles = await getProgressUserRoles(userOpenId);
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      AND: progressProjectReadableWhere(roles, userOpenId),
    },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { select: { id: true, ownerOpenId: true } },
      tasks: {
        where: { deletedAt: null },
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!project) return `missing:progress-project:${projectId}`;

  const visibleTaskIdList = project.tasks.map((task) => task.id);
  const visibleStageIdList = project.stages.map((stage) => stage.id);
  const submissionWhere: Prisma.TaskSubmissionWhereInput = {
    OR: [
      { projectId },
      ...(visibleTaskIdList.length > 0
        ? [{ taskId: { in: visibleTaskIdList } }]
        : []),
      ...(visibleStageIdList.length > 0
        ? [{ stageId: { in: visibleStageIdList } }]
        : []),
    ],
  };
  const effectiveSubmissionWhere =
    submissionWhere.OR?.length ? submissionWhere : { id: "__none__" };
  const submissionIds = await prisma.taskSubmission.findMany({
    where: effectiveSubmissionWhere,
    select: { id: true },
  });
  const submissionIdList = submissionIds.map((submission) => submission.id);
  const approvalWhere: Prisma.ApprovalRecordWhereInput =
    submissionIdList.length > 0
      ? { submissionId: { in: submissionIdList } }
      : { id: "__none__" };
  const activityWhere: Prisma.ProgressActivityLogWhereInput = { projectId };

  const parts = await Promise.all([
    projectUpdatedAtVersion("projects", { id: projectId }),
    projectStageVersion(
      visibleStageIdList.length > 0
        ? { id: { in: visibleStageIdList } }
        : { id: "__none__" },
    ),
    taskVersion(
      visibleTaskIdList.length > 0
        ? { id: { in: visibleTaskIdList } }
        : { id: "__none__" },
    ),
    activityVersion(activityWhere),
    submissionVersion(effectiveSubmissionWhere),
    approvalVersion(approvalWhere),
    weeklyReportVersion(
      visibleTaskIdList.length > 0
        ? { taskId: { in: visibleTaskIdList } }
        : { id: "__none__" },
    ),
    taskAssigneeVersion(
      visibleTaskIdList.length > 0
        ? { taskId: { in: visibleTaskIdList } }
        : { id: "__none__" },
    ),
    taskDeletionRequestVersion(
      visibleTaskIdList.length > 0
        ? { taskId: { in: visibleTaskIdList } }
        : { id: "__none__" },
    ),
    projectOwnerVersion({ projectId }),
    projectParticipantVersion({ projectId }),
    taskCreationRequestVersion({ projectId }),
    approvalChecklistVersion(
      submissionIdList.length > 0
        ? { approval: { submissionId: { in: submissionIdList } } }
        : { id: "__none__" },
    ),
  ]);
  return encodeVersion(parts);
}

async function getProgressTaskVersion(
  taskId: string,
  { userOpenId }: Pick<LiveVersionContext, "userOpenId">,
): Promise<string> {
  const roles = await getProgressUserRoles(userOpenId);
  const task = await prisma.task.findFirst({
    where: {
      id: taskId,
      AND: progressTaskReadableWhere(roles, userOpenId),
    },
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
    taskDeletionRequestVersion({ taskId }),
    taskCreationRequestVersion({ createdTaskId: taskId }),
    projectParticipantVersion({ projectId: task.projectId }),
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
  const [aggregate, count] = await Promise.all([
    prisma.purchaseItem.aggregate({ where, _max: { updatedAt: true } }),
    prisma.purchaseItem.count({ where }),
  ]);
  return encodePart("items", aggregate._max.updatedAt, count);
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
    deletedAt: null,
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
  const [
    users,
    roles,
    templateAggregate,
    templateCount,
    reminderAggregate,
    reminderCount,
    outboxAggregate,
    outboxCount,
  ] = await Promise.all([
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
    prisma.progressReminderRule.aggregate({
      _max: { updatedAt: true },
    }),
    prisma.progressReminderRule.count(),
    prisma.notificationOutbox.aggregate({
      where: { channel: "progress", type: "progress_reminder" },
      _max: { updatedAt: true },
    }),
    prisma.notificationOutbox.count({
      where: { channel: "progress", type: "progress_reminder" },
    }),
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
    encodePart("reminders", reminderAggregate._max.updatedAt, reminderCount),
    encodePart("reminderOutbox", outboxAggregate._max.updatedAt, outboxCount),
  ]);
}

export async function getLiveVersion(
  context: LiveVersionContext,
): Promise<string> {
  const userVersion = await userRoleVersion(context.userOpenId);
  const withUserVersion = (version: string) =>
    encodeVersion([version, userVersion]);

  if (context.scope === "progress") {
    return withUserVersion(await getProgressListVersion(context));
  }
  if (context.scope === "progress-list") {
    return withUserVersion(await getProgressListVersion(context));
  }
  if (context.scope === "progress-board") {
    return withUserVersion(await getProgressBoardVersion(context));
  }
  if (context.scope === "progress-archive") {
    return withUserVersion(await getProgressArchiveVersion(context));
  }
  if (context.scope === "progress-project") {
    if (!context.resourceId) return "missing:progress-project";
    return withUserVersion(
      await getProgressProjectVersion(context.resourceId, context),
    );
  }
  if (context.scope === "progress-task") {
    if (!context.resourceId) return "missing:progress-task";
    return withUserVersion(
      await getProgressTaskVersion(context.resourceId, context),
    );
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
    "progress-list",
    "progress-board",
    "progress-archive",
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
