import type { Prisma } from "@prisma/client";
import type { UserRoleRecord } from "@/lib/permissions-client";
import {
  canApproveStage,
  canApproveTask,
  canManageProject,
  canReviewProjectEstablishment,
  canReviewProjectStageBatchDdlChange,
  canReviewProjectStageDueDateChange,
  canReviewTaskDdlChange,
  isAnyTechGroupLead,
  isAssignee,
  isProgressSuperAdmin,
  isProjectManager,
  isTeamLead,
  isTechGroupLead,
} from "@/lib/permissions-progress";
import { progressRoleLabels } from "@/lib/progress-labels";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import {
  formatTaskCreationDraftSummary,
  parseTaskCreationDraft,
} from "@/lib/progress-task-creation-requests";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export const progressApprovalKinds = [
  "PROJECT_ESTABLISHMENT",
  "STAGE_ACCEPTANCE",
  "PROJECT_BATCH_DDL",
  "PROJECT_STAGE_DDL",
  "TASK_CREATION",
  "TASK_DELETION",
  "TASK_DDL",
  "TASK_ACCEPTANCE",
] as const;

export type ProgressApprovalKind = (typeof progressApprovalKinds)[number];

export type ProgressApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "SUPERSEDED";

export type ProgressApprovalReference = {
  kind: ProgressApprovalKind;
  id: string;
};

export type ProgressApprovalListItem = {
  reference: ProgressApprovalReference;
  kind: ProgressApprovalKind;
  kindLabel: string;
  status: ProgressApprovalStatus;
  statusLabel: string;
  projectId: string;
  projectName: string;
  subject: string;
  summary: string;
  submitterOpenId: string;
  submitterName: string;
  submittedAt: string;
  processedAt: string | null;
  href: string;
  canRequestReminder: boolean;
  canWithdraw: boolean;
};

export type ProgressApprovalCandidate = {
  openId: string;
  name: string;
  avatar: string | null;
  identityLabels: string[];
};

export type ProgressApprovalReader = Pick<
  Prisma.TransactionClient,
  | "project"
  | "taskSubmission"
  | "projectDdlChangeRequest"
  | "taskCreationRequest"
  | "taskDeletionRequest"
  | "taskDdlChangeRequest"
  | "user"
  | "userRole"
>;

export const progressApprovalKindLabels: Record<ProgressApprovalKind, string> = {
  PROJECT_ESTABLISHMENT: "项目立项",
  STAGE_ACCEPTANCE: "阶段验收",
  PROJECT_BATCH_DDL: "项目批量 DDL",
  PROJECT_STAGE_DDL: "项目单阶段 DDL",
  TASK_CREATION: "任务创建",
  TASK_DELETION: "任务删除",
  TASK_DDL: "任务 DDL",
  TASK_ACCEPTANCE: "任务验收",
};

export const progressApprovalStatusLabels: Record<ProgressApprovalStatus, string> = {
  PENDING: "待审批",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  WITHDRAWN: "已撤回",
  SUPERSEDED: "已失效",
};

type ApprovalProject = {
  id: string;
  name: string;
  team: string;
  techGroup: string;
  status: string;
  ownerOpenId: string;
  ownerName: string;
  owners: Array<{ openId: string; name: string }>;
  participants: Array<{ openId: string }>;
  allowOwnerSelfApproval: boolean;
};

type ResolvedProgressApproval = {
  reference: ProgressApprovalReference;
  status: ProgressApprovalStatus;
  project: ApprovalProject;
  stage: { id: string; name: string; ownerOpenIds: string[] } | null;
  task: {
    id: string;
    title: string;
    team: string;
    techGroup: string;
    status: string;
    assigneeOpenIds: string[];
    techGroups: string[];
    deletedAt: Date | null;
  } | null;
  submitterOpenId: string;
  submitterName: string;
  submittedAt: Date;
  processedAt: Date | null;
  subject: string;
  summary: string;
  href: string;
};

const projectInclude = {
  owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  participants: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.ProjectInclude;

const taskInclude = {
  project: { include: projectInclude },
  stage: {
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  },
  assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.TaskInclude;

const stageSubmissionInclude = {
  approvals: true,
  stage: { include: { owners: true, project: { include: projectInclude } } },
} satisfies Prisma.TaskSubmissionInclude;

const taskSubmissionInclude = {
  approvals: true,
  task: {
    include: {
      ...taskInclude,
      submissions: {
        where: { type: "DELIVERY" as const },
        select: { id: true },
        orderBy: { submittedAt: "desc" as const },
        take: 1,
      },
    },
  },
} satisfies Prisma.TaskSubmissionInclude;

const projectDdlInclude = {
  project: { include: projectInclude },
  stage: { include: { owners: true } },
} satisfies Prisma.ProjectDdlChangeRequestInclude;

const taskCreationInclude = {
  project: { include: projectInclude },
  createdTask: true,
} satisfies Prisma.TaskCreationRequestInclude;

const taskRequestInclude = {
  task: { include: taskInclude },
} satisfies Prisma.TaskDeletionRequestInclude & Prisma.TaskDdlChangeRequestInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;
type StageRow = Prisma.ProjectStageGetPayload<{ include: { owners: true } }>;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
type StageSubmissionRow = Prisma.TaskSubmissionGetPayload<{
  include: typeof stageSubmissionInclude;
}>;
type TaskSubmissionRow = Prisma.TaskSubmissionGetPayload<{
  include: typeof taskSubmissionInclude;
}>;
type ProjectDdlRow = Prisma.ProjectDdlChangeRequestGetPayload<{
  include: typeof projectDdlInclude;
}>;
type TaskCreationRow = Prisma.TaskCreationRequestGetPayload<{
  include: typeof taskCreationInclude;
}>;
type TaskDeletionRow = Prisma.TaskDeletionRequestGetPayload<{
  include: typeof taskRequestInclude;
}>;
type TaskDdlRow = Prisma.TaskDdlChangeRequestGetPayload<{
  include: typeof taskRequestInclude;
}>;

export function isProgressApprovalKind(value: string): value is ProgressApprovalKind {
  return (progressApprovalKinds as readonly string[]).includes(value);
}

export async function getMyProgressApprovalSubmissions({
  userOpenId,
  roles,
}: {
  userOpenId: string;
  roles: UserRoleRecord[];
}): Promise<ProgressApprovalListItem[]> {
  if (!userOpenId) return [];

  const [projects, stageSubmissions, taskSubmissions, projectDdl, taskCreation, taskDeletion, taskDdl] =
    await Promise.all([
      prisma.project.findMany({
        where: { requesterOpenId: userOpenId, submittedAt: { not: null } },
        include: projectInclude,
        orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
      }),
      prisma.taskSubmission.findMany({
        where: { submittedBy: userOpenId, type: "STAGE" },
        include: stageSubmissionInclude,
        orderBy: { submittedAt: "desc" },
      }),
      prisma.taskSubmission.findMany({
        where: { submittedBy: userOpenId, type: "DELIVERY" },
        include: taskSubmissionInclude,
        orderBy: { submittedAt: "desc" },
      }),
      prisma.projectDdlChangeRequest.findMany({
        where: { requesterOpenId: userOpenId },
        include: projectDdlInclude,
      }),
      prisma.taskCreationRequest.findMany({
        where: { requesterOpenId: userOpenId },
        include: taskCreationInclude,
      }),
      prisma.taskDeletionRequest.findMany({
        where: { requesterOpenId: userOpenId },
        include: taskRequestInclude,
      }),
      prisma.taskDdlChangeRequest.findMany({
        where: { requesterOpenId: userOpenId },
        include: taskRequestInclude,
      }),
    ]);

  const resolved: ResolvedProgressApproval[] = [];

  for (const project of projects) {
    resolved.push(resolveProjectEstablishment(project));
  }
  for (const submission of stageSubmissions) {
    if (!submission.stage) continue;
    resolved.push(resolveStageSubmission(submission));
  }
  for (const submission of taskSubmissions) {
    if (!submission.task) continue;
    resolved.push(resolveTaskSubmission(submission));
  }
  for (const request of projectDdl) resolved.push(resolveProjectDdl(request));
  for (const request of taskCreation) resolved.push(resolveTaskCreation(request));
  for (const request of taskDeletion) resolved.push(resolveTaskDeletion(request));
  for (const request of taskDdl) resolved.push(resolveTaskDdl(request));

  return resolved
    .map((approval) => toListItem(approval, roles, userOpenId))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export async function resolveProgressApproval(
  reference: ProgressApprovalReference,
  db: ProgressApprovalReader = prisma,
): Promise<ResolvedProgressApproval | null> {
  switch (reference.kind) {
    case "PROJECT_ESTABLISHMENT": {
      const row = await db.project.findUnique({
        where: { id: reference.id },
        include: projectInclude,
      });
      return row?.submittedAt ? resolveProjectEstablishment(row) : null;
    }
    case "STAGE_ACCEPTANCE": {
      const row = await db.taskSubmission.findFirst({
        where: { id: reference.id, type: "STAGE" },
        include: stageSubmissionInclude,
      });
      return row?.stage ? resolveStageSubmission(row) : null;
    }
    case "TASK_ACCEPTANCE": {
      const row = await db.taskSubmission.findFirst({
        where: { id: reference.id, type: "DELIVERY" },
        include: taskSubmissionInclude,
      });
      return row?.task ? resolveTaskSubmission(row) : null;
    }
    case "PROJECT_BATCH_DDL":
    case "PROJECT_STAGE_DDL": {
      const row = await db.projectDdlChangeRequest.findUnique({
        where: { id: reference.id },
        include: projectDdlInclude,
      });
      if (!row) return null;
      const resolved = resolveProjectDdl(row);
      return resolved.reference.kind === reference.kind ? resolved : null;
    }
    case "TASK_CREATION": {
      const row = await db.taskCreationRequest.findUnique({
        where: { id: reference.id },
        include: taskCreationInclude,
      });
      return row ? resolveTaskCreation(row) : null;
    }
    case "TASK_DELETION": {
      const row = await db.taskDeletionRequest.findUnique({
        where: { id: reference.id },
        include: taskRequestInclude,
      });
      return row ? resolveTaskDeletion(row) : null;
    }
    case "TASK_DDL": {
      const row = await db.taskDdlChangeRequest.findUnique({
        where: { id: reference.id },
        include: taskRequestInclude,
      });
      return row ? resolveTaskDdl(row) : null;
    }
  }
}

export function canRequestProgressApprovalReminder({
  approval,
  roles,
  userOpenId,
}: {
  approval: ResolvedProgressApproval;
  roles: UserRoleRecord[];
  userOpenId?: string;
}): boolean {
  if (!userOpenId || approval.status !== "PENDING") return false;
  if (approval.submitterOpenId === userOpenId) return true;
  const ownerOpenIds = getProjectOwnerOpenIds(approval.project);
  if (isAssignee(userOpenId, ownerOpenIds)) return true;
  if (isAssignee(userOpenId, approval.project.participants.map((item) => item.openId))) return true;
  if (approval.stage && isAssignee(userOpenId, approval.stage.ownerOpenIds)) return true;
  if (approval.task && isAssignee(userOpenId, approval.task.assigneeOpenIds)) return true;
  if (isProgressSuperAdmin(roles) || isProjectManager(roles)) return true;
  if (isTaskScopedApproval(approval) && approval.task) {
    if (isTeamLead(roles, approval.task.team)) return true;
    if (isTechGroupLead(roles, approval.task.techGroup)) return true;
    if (
      approval.reference.kind === "TASK_DDL" &&
      isAnyTechGroupLead(roles, approval.task.techGroups)
    ) return true;
    return false;
  }
  if (isTeamLead(roles, approval.project.team)) return true;
  if (isTechGroupLead(roles, approval.project.techGroup)) return true;
  return false;
}

export async function getProgressApprovalCandidates(
  approval: ResolvedProgressApproval,
  db: ProgressApprovalReader = prisma,
): Promise<ProgressApprovalCandidate[]> {
  if (approval.status !== "PENDING") return [];
  const [users, roleRows] = await Promise.all([
    db.user.findMany({ select: { openId: true, name: true, avatar: true } }),
    db.userRole.findMany({ select: { openId: true, role: true, team: true, techGroup: true } }),
  ]);
  const rolesByOpenId = new Map<string, UserRoleRecord[]>();
  for (const row of roleRows) {
    const list = rolesByOpenId.get(row.openId) ?? [];
    list.push({ role: row.role, team: row.team, techGroup: row.techGroup });
    rolesByOpenId.set(row.openId, list);
  }

  return users
    .filter((user) =>
      canUserApproveProgressApproval(approval, rolesByOpenId.get(user.openId) ?? [], user.openId),
    )
    .map((user) => ({
      openId: user.openId,
      name: user.name,
      avatar: user.avatar,
      identityLabels: getCandidateIdentityLabels(
        approval,
        rolesByOpenId.get(user.openId) ?? [],
        user.openId,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function canUserApproveProgressApproval(
  approval: ResolvedProgressApproval,
  roles: UserRoleRecord[],
  userOpenId: string,
): boolean {
  const scope = { team: approval.project.team, techGroup: approval.project.techGroup };
  const ownerOpenIds = getProjectOwnerOpenIds(approval.project);
  switch (approval.reference.kind) {
    case "PROJECT_ESTABLISHMENT":
      return canReviewProjectEstablishment(roles, scope);
    case "STAGE_ACCEPTANCE":
      return canApproveStage(
        roles,
        scope,
        ownerOpenIds,
        approval.submitterOpenId,
        approval.project.allowOwnerSelfApproval,
        userOpenId,
      );
    case "PROJECT_BATCH_DDL":
      return canReviewProjectStageBatchDdlChange({
        roles,
        scope,
        requesterOpenId: approval.submitterOpenId,
        userOpenId,
      });
    case "PROJECT_STAGE_DDL":
      return canReviewProjectStageDueDateChange({
        roles,
        ownerOpenIds,
        requesterOpenId: approval.submitterOpenId,
        userOpenId,
      });
    case "TASK_CREATION":
      return canManageProject(roles, scope, ownerOpenIds, userOpenId);
    case "TASK_DELETION":
      return canManageProject(
        roles,
        approval.task
          ? { team: approval.task.team, techGroup: approval.task.techGroup }
          : scope,
        ownerOpenIds,
        userOpenId,
      );
    case "TASK_DDL":
      return canReviewTaskDdlChange({
        roles,
        scope: approval.task
          ? { team: approval.task.team, techGroup: approval.task.techGroup }
          : scope,
        projectOwnerOpenIds: ownerOpenIds,
        taskTechGroups: approval.task?.techGroups ?? [],
        userOpenId,
      });
    case "TASK_ACCEPTANCE":
      return canApproveTask(
        roles,
        approval.task
          ? { team: approval.task.team, techGroup: approval.task.techGroup }
          : scope,
      );
  }
}

function toListItem(
  approval: ResolvedProgressApproval,
  roles: UserRoleRecord[],
  userOpenId: string,
): ProgressApprovalListItem {
  return {
    reference: approval.reference,
    kind: approval.reference.kind,
    kindLabel: progressApprovalKindLabels[approval.reference.kind],
    status: approval.status,
    statusLabel: progressApprovalStatusLabels[approval.status],
    projectId: approval.project.id,
    projectName: approval.project.name,
    subject: approval.subject,
    summary: approval.summary,
    submitterOpenId: approval.submitterOpenId,
    submitterName: approval.submitterName || "未知提交人",
    submittedAt: approval.submittedAt.toISOString(),
    processedAt: approval.processedAt?.toISOString() ?? null,
    href: approval.href,
    canRequestReminder: canRequestProgressApprovalReminder({ approval, roles, userOpenId }),
    canWithdraw:
      approval.status === "PENDING" && approval.submitterOpenId === userOpenId,
  };
}

function resolveProjectEstablishment(project: ProjectRow): ResolvedProgressApproval {
  const status: ProgressApprovalStatus =
    project.status === "ESTABLISHING"
      ? "PENDING"
      : project.status === "ESTABLISHMENT_WITHDRAWN"
        ? "WITHDRAWN"
        : project.status === "ESTABLISHMENT_REJECTED"
          ? "REJECTED"
          : "APPROVED";
  return {
    reference: { kind: "PROJECT_ESTABLISHMENT", id: project.id },
    status,
    project: normalizeProject(project),
    stage: null,
    task: null,
    submitterOpenId: project.requesterOpenId,
    submitterName: project.requesterName,
    submittedAt: project.submittedAt ?? project.createdAt,
    processedAt: project.establishmentWithdrawnAt ?? project.reviewedAt,
    subject: project.name,
    summary: project.description || "项目立项申请",
    href: routes.progress.project(project.id),
  };
}

function resolveStageSubmission(submission: StageSubmissionRow): ResolvedProgressApproval {
  const stage = submission.stage;
  if (!stage) throw new Error("阶段验收提交缺少阶段信息");
  const approval = submission.approvals[0];
  const isCurrent = stage.currentSubmissionId === submission.id;
  const status = approval
    ? mapDecision(approval.decision)
    : submission.withdrawnAt
      ? "WITHDRAWN"
      : isCurrent &&
          stage.status === "PENDING_ACCEPTANCE" &&
          isProjectApprovalActive(stage.project.status)
        ? "PENDING"
        : "SUPERSEDED";
  return {
    reference: { kind: "STAGE_ACCEPTANCE", id: submission.id },
    status,
    project: normalizeProject(stage.project),
    stage: normalizeStage(stage),
    task: null,
    submitterOpenId: submission.submittedBy,
    submitterName: submission.submitterName,
    submittedAt: submission.submittedAt,
    processedAt: submission.withdrawnAt ?? approval?.createdAt ?? null,
    subject: stage.name,
    summary: submission.note || "阶段成果验收",
    href: routes.progress.projectStage(stage.project.id, stage.id),
  };
}

function resolveTaskSubmission(submission: TaskSubmissionRow): ResolvedProgressApproval {
  const task = submission.task;
  if (!task) throw new Error("任务验收提交缺少任务信息");
  const approval = submission.approvals[0];
  const isLatest = task.submissions[0]?.id === submission.id;
  const status = approval
    ? mapDecision(approval.decision)
    : submission.withdrawnAt
      ? "WITHDRAWN"
      : isLatest &&
          task.status === "PENDING_ACCEPTANCE" &&
          !task.deletedAt &&
          isProjectApprovalActive(task.project.status)
        ? "PENDING"
        : "SUPERSEDED";
  return {
    reference: { kind: "TASK_ACCEPTANCE", id: submission.id },
    status,
    project: normalizeProject(task.project),
    stage: task.stage ? normalizeStage(task.stage) : null,
    task: normalizeTask(task),
    submitterOpenId: submission.submittedBy,
    submitterName: submission.submitterName,
    submittedAt: submission.submittedAt,
    processedAt: submission.withdrawnAt ?? approval?.createdAt ?? null,
    subject: task.title,
    summary: submission.note || "任务成果验收",
    href: task.deletedAt
      ? routes.progress.project(task.project.id)
      : routes.progress.task(task.id),
  };
}

function resolveProjectDdl(request: ProjectDdlRow): ResolvedProgressApproval {
  const kind: ProgressApprovalKind =
    request.type === "CASCADE_EXTENSION" ? "PROJECT_BATCH_DDL" : "PROJECT_STAGE_DDL";
  return {
    reference: { kind, id: request.id },
    status:
      request.status === "PENDING" && !isProjectApprovalActive(request.project.status)
        ? "SUPERSEDED"
        : mapRequestStatus(request.status),
    project: normalizeProject(request.project),
    stage: normalizeStage(request.stage),
    task: null,
    submitterOpenId: request.requesterOpenId,
    submitterName: request.requesterName,
    submittedAt: request.createdAt,
    processedAt: request.withdrawnAt ?? request.reviewedAt,
    subject: request.stage.name,
    summary: request.reason || `${progressApprovalKindLabels[kind]}申请`,
    href: routes.progress.projectStage(request.project.id, request.stage.id),
  };
}

function resolveTaskCreation(request: TaskCreationRow): ResolvedProgressApproval {
  const draft = parseTaskCreationDraft(request.draftPayload);
  const taskId = request.createdTaskId ?? request.createdTask?.id;
  return {
    reference: { kind: "TASK_CREATION", id: request.id },
    status:
      request.status === "PENDING" && !isProjectApprovalActive(request.project.status)
        ? "SUPERSEDED"
        : mapRequestStatus(request.status),
    project: normalizeProject(request.project),
    stage: null,
    task: null,
    submitterOpenId: request.requesterOpenId,
    submitterName: request.requesterName,
    submittedAt: request.createdAt,
    processedAt: request.withdrawnAt ?? request.reviewedAt,
    subject: draft?.title ?? "任务创建申请",
    summary: formatTaskCreationDraftSummary(draft),
    href: taskId ? routes.progress.task(taskId) : routes.progress.project(request.project.id),
  };
}

function resolveTaskDeletion(request: TaskDeletionRow): ResolvedProgressApproval {
  return {
    reference: { kind: "TASK_DELETION", id: request.id },
    status:
      request.status === "PENDING" && !isTaskDeletionApprovalActive(request.task)
        ? "SUPERSEDED"
        : mapRequestStatus(request.status),
    project: normalizeProject(request.task.project),
    stage: request.task.stage ? normalizeStage(request.task.stage) : null,
    task: normalizeTask(request.task),
    submitterOpenId: request.requesterOpenId,
    submitterName: request.requesterName,
    submittedAt: request.createdAt,
    processedAt: request.withdrawnAt ?? request.reviewedAt,
    subject: request.task.title,
    summary: request.reason || "任务删除申请",
    href: request.task.deletedAt
      ? routes.progress.project(request.task.project.id)
      : routes.progress.task(request.task.id),
  };
}

function resolveTaskDdl(request: TaskDdlRow): ResolvedProgressApproval {
  return {
    reference: { kind: "TASK_DDL", id: request.id },
    status:
      request.status === "PENDING" && !isTaskApprovalActive(request.task)
        ? "SUPERSEDED"
        : mapRequestStatus(request.status),
    project: normalizeProject(request.task.project),
    stage: request.task.stage ? normalizeStage(request.task.stage) : null,
    task: normalizeTask(request.task),
    submitterOpenId: request.requesterOpenId,
    submitterName: request.requesterName,
    submittedAt: request.createdAt,
    processedAt: request.withdrawnAt ?? request.reviewedAt,
    subject: request.task.title,
    summary: request.reason || "任务 DDL 修改申请",
    href: request.task.deletedAt
      ? routes.progress.project(request.task.project.id)
      : routes.progress.task(request.task.id),
  };
}

function normalizeProject(project: ProjectRow): ApprovalProject {
  return {
    id: project.id,
    name: project.name,
    team: project.team,
    techGroup: project.techGroup,
    status: project.status,
    ownerOpenId: project.ownerOpenId,
    ownerName: project.ownerName,
    owners: project.owners ?? [],
    participants: project.participants ?? [],
    allowOwnerSelfApproval: project.allowOwnerSelfApproval,
  };
}

function normalizeStage(stage: StageRow): NonNullable<ResolvedProgressApproval["stage"]> {
  const ownerOpenIds = (stage.owners ?? []).map((item: { openId: string }) => item.openId);
  if (ownerOpenIds.length === 0 && stage.ownerOpenId) ownerOpenIds.push(stage.ownerOpenId);
  return { id: stage.id, name: stage.name, ownerOpenIds };
}

function normalizeTask(task: TaskRow): NonNullable<ResolvedProgressApproval["task"]> {
  const assigneeOpenIds = (task.assignees ?? []).map((item: { openId: string }) => item.openId);
  if (assigneeOpenIds.length === 0 && task.assigneeOpenId) assigneeOpenIds.push(task.assigneeOpenId);
  return {
    id: task.id,
    title: task.title,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    assigneeOpenIds,
    techGroups: getTaskTechGroups(task),
    deletedAt: task.deletedAt,
  };
}

function mapDecision(decision: string): ProgressApprovalStatus {
  return decision === "APPROVED" ? "APPROVED" : "REJECTED";
}

function mapRequestStatus(status: string): ProgressApprovalStatus {
  if (status === "PENDING") return "PENDING";
  if (status === "WITHDRAWN") return "WITHDRAWN";
  return status === "APPROVED" ? "APPROVED" : "REJECTED";
}

function isProjectApprovalActive(status: string): boolean {
  return status === "NOT_STARTED" || status === "IN_PROGRESS";
}

function isTaskApprovalActive(task: TaskRow): boolean {
  return (
    !task.deletedAt &&
    isProjectApprovalActive(task.project.status) &&
    !["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"].includes(task.status)
  );
}

function isTaskDeletionApprovalActive(task: TaskRow): boolean {
  return (
    !task.deletedAt &&
    task.project.status === "IN_PROGRESS" &&
    task.status !== "PROJECT_CANCELED"
  );
}

function isTaskScopedApproval(approval: ResolvedProgressApproval): boolean {
  return ["TASK_DELETION", "TASK_DDL", "TASK_ACCEPTANCE"].includes(
    approval.reference.kind,
  );
}

function getCandidateIdentityLabels(
  approval: ResolvedProgressApproval,
  roles: UserRoleRecord[],
  openId: string,
): string[] {
  const labels: string[] = [];
  if (getProjectOwnerOpenIds(approval.project).includes(openId)) labels.push("项目负责人");
  if (approval.project.participants.some((item) => item.openId === openId)) labels.push("项目参与人");
  if (approval.stage?.ownerOpenIds.includes(openId)) labels.push("阶段负责人");
  if (approval.task?.assigneeOpenIds.includes(openId)) labels.push("任务负责人");
  for (const role of roles) {
    if (!roleAppliesToApproval(role, approval)) continue;
    labels.push(progressRoleLabels[role.role]);
  }
  return [...new Set(labels)];
}

function roleAppliesToApproval(
  role: UserRoleRecord,
  approval: ResolvedProgressApproval,
): boolean {
  if (role.role === "SUPER_ADMIN" || role.role === "PROJECT_MANAGER") return true;
  if (role.role === "TEAM_ADMIN") {
    return role.team ===
      (isTaskScopedApproval(approval) && approval.task
        ? approval.task.team
        : approval.project.team);
  }
  if (role.role === "TECH_GROUP_ADMIN") {
    const groups =
      isTaskScopedApproval(approval) && approval.task
        ? approval.task.techGroups
        : [approval.project.techGroup];
    return groups.includes(role.techGroup);
  }
  return false;
}

export type { ResolvedProgressApproval };
