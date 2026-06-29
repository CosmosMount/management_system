import type {
  ProjectDdlChangeRequestType,
  ProjectStatus,
} from "@prisma/client";
import type { UserRoleRecord } from "@/lib/permissions-client";
import {
  canApproveStage,
  canApproveTask,
  canManageProject,
  canReviewProjectEstablishment,
  canReviewProjectStageBatchDdlChange,
  canReviewProjectStageDueDateChange,
  canReviewTaskDdlChange,
} from "@/lib/permissions-progress";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import {
  formatTaskCreationDraftSummary,
  parseTaskCreationDraft,
} from "@/lib/progress-task-creation-requests";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export type ProgressApprovalCategoryKey =
  | "project-establishment"
  | "project-stage"
  | "project-ddl"
  | "task-request"
  | "task-ddl"
  | "task-acceptance";

export type ProgressApprovalItem = {
  id: string;
  categoryKey: ProgressApprovalCategoryKey;
  badge: string;
  title: string;
  projectName: string;
  subject: string;
  requester: string;
  submittedAt: string;
  href: string;
  detail: string;
  meta: string[];
};

export type ProgressApprovalCategory = {
  key: ProgressApprovalCategoryKey;
  label: string;
  description: string;
  items: ProgressApprovalItem[];
};

export type ProgressApprovalBoard = {
  totalCount: number;
  categories: ProgressApprovalCategory[];
};

const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = ["NOT_STARTED", "IN_PROGRESS"];

const CATEGORY_META: Array<
  Omit<ProgressApprovalCategory, "items">
> = [
  {
    key: "project-establishment",
    label: "立项审批",
    description: "等待通过或驳回的项目立项",
  },
  {
    key: "project-stage",
    label: "项目阶段审批",
    description: "阶段提交后的验收审批",
  },
  {
    key: "project-ddl",
    label: "项目 DDL 审批",
    description: "阶段 DDL 修改与批量提前/延期",
  },
  {
    key: "task-request",
    label: "任务申请审批",
    description: "任务创建与删除申请",
  },
  {
    key: "task-ddl",
    label: "任务 DDL 审批",
    description: "任务最晚完成时间修改申请",
  },
  {
    key: "task-acceptance",
    label: "任务验收审批",
    description: "任务交付后的验收审批",
  },
];

export async function getProgressApprovalBoard({
  roles,
  userOpenId,
}: {
  roles: UserRoleRecord[];
  userOpenId?: string;
}): Promise<ProgressApprovalBoard> {
  if (!userOpenId) return emptyBoard();

  const [
    establishmentProjects,
    stageSubmissions,
    projectDdlRequests,
    taskCreationRequests,
    taskDeletionRequests,
    taskDdlRequests,
    pendingAcceptanceTasks,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { status: "ESTABLISHING" },
      include: {
        owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        _count: { select: { stages: true } },
      },
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
    }),
    prisma.taskSubmission.findMany({
      where: {
        type: "STAGE",
        stage: {
          status: "PENDING_ACCEPTANCE",
          project: { status: { in: ACTIVE_PROJECT_STATUSES } },
        },
      },
      include: {
        approvals: { select: { id: true } },
        stage: {
          include: {
            project: {
              include: {
                owners: {
                  orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                },
              },
            },
          },
        },
      },
      orderBy: { submittedAt: "desc" },
    }),
    prisma.projectDdlChangeRequest.findMany({
      where: {
        status: "PENDING",
        project: { status: { in: ACTIVE_PROJECT_STATUSES } },
      },
      include: {
        stage: { select: { id: true, name: true, sortOrder: true } },
        project: {
          include: {
            owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.taskCreationRequest.findMany({
      where: {
        status: "PENDING",
        project: { status: { in: ACTIVE_PROJECT_STATUSES } },
      },
      include: {
        project: {
          include: {
            owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.taskDeletionRequest.findMany({
      where: {
        status: "PENDING",
        task: {
          deletedAt: null,
          status: { not: "PROJECT_CANCELED" },
          project: { status: "IN_PROGRESS" },
        },
      },
      include: {
        task: {
          include: {
            project: {
              include: {
                owners: {
                  orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                },
              },
            },
            stage: { select: { name: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.taskDdlChangeRequest.findMany({
      where: {
        status: "PENDING",
        task: {
          deletedAt: null,
          status: { notIn: ["COMPLETED", "ARCHIVED", "PROJECT_CANCELED"] },
          project: { status: { in: ACTIVE_PROJECT_STATUSES } },
        },
      },
      include: {
        task: {
          include: {
            project: {
              include: {
                owners: {
                  orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                },
              },
            },
            assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
            techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.task.findMany({
      where: {
        status: "PENDING_ACCEPTANCE",
        deletedAt: null,
        project: { status: { in: ACTIVE_PROJECT_STATUSES } },
      },
      include: {
        project: true,
        stage: { select: { name: true } },
        submissions: {
          where: { type: "DELIVERY" },
          orderBy: { submittedAt: "desc" },
          take: 1,
          include: { approvals: { select: { id: true } } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
  ]);

  const items: ProgressApprovalItem[] = [];

  for (const project of establishmentProjects) {
    if (!canReviewProjectEstablishment(roles, project)) continue;
    items.push({
      id: `project-establishment:${project.id}`,
      categoryKey: "project-establishment",
      badge: "立项",
      title: project.name,
      projectName: project.name,
      subject: "项目立项",
      requester: project.requesterName || "未知申请人",
      submittedAt: (project.submittedAt ?? project.createdAt).toISOString(),
      href: routes.progress.project(project.id),
      detail: `车组/技术组：${formatScope(project.team, project.techGroup)}`,
      meta: [
        `负责人：${formatNames(project.owners.map((owner) => owner.name))}`,
        `参与人：${formatNames(project.participants.map((item) => item.name))}`,
        `阶段：${project._count.stages} 个`,
      ],
    });
  }

  for (const submission of stageSubmissions) {
    const stage = submission.stage;
    if (
      !stage ||
      stage.currentSubmissionId !== submission.id ||
      submission.approvals.length > 0
    ) {
      continue;
    }
    const project = stage.project;
    if (
      !canApproveStage(
        roles,
        { team: project.team, techGroup: project.techGroup },
        getProjectOwnerOpenIds(project),
        submission.submittedBy,
        project.allowOwnerSelfApproval,
        userOpenId,
      )
    ) {
      continue;
    }
    items.push({
      id: `stage-submission:${submission.id}`,
      categoryKey: "project-stage",
      badge: "阶段验收",
      title: stage.name,
      projectName: project.name,
      subject: stage.name,
      requester: submission.submitterName || "未知提交人",
      submittedAt: submission.submittedAt.toISOString(),
      href: routes.progress.projectStage(project.id, stage.id),
      detail: submission.note || "阶段提交等待审批",
      meta: [
        `项目：${project.name}`,
        `交付文档：${submission.feishuDocUrl ? "已填写" : "未填写"}`,
      ],
    });
  }

  for (const request of projectDdlRequests) {
    const project = request.project;
    const canReview =
      request.type === "CASCADE_EXTENSION"
        ? canReviewProjectStageBatchDdlChange({
            roles,
            scope: { team: project.team, techGroup: project.techGroup },
            requesterOpenId: request.requesterOpenId,
            userOpenId,
          })
        : canReviewProjectStageDueDateChange({
            roles,
            ownerOpenIds: getProjectOwnerOpenIds(project),
            requesterOpenId: request.requesterOpenId,
            userOpenId,
          });
    if (!canReview) continue;
    items.push({
      id: `project-ddl:${request.id}`,
      categoryKey: "project-ddl",
      badge: formatProjectDdlBadge(request.type, request.durationDays),
      title: request.stage.name,
      projectName: project.name,
      subject: request.stage.name,
      requester: request.requesterName || "未知申请人",
      submittedAt: request.createdAt.toISOString(),
      href: routes.progress.projectStage(project.id, request.stageId),
      detail: request.reason,
      meta: [
        `项目：${project.name}`,
        `原 DDL：${formatOptionalDate(request.oldDueAt)}`,
        `申请 DDL：${formatOptionalDate(request.newDueAt)}`,
      ],
    });
  }

  for (const request of taskCreationRequests) {
    const project = request.project;
    if (
      !canManageProject(
        roles,
        { team: project.team, techGroup: project.techGroup },
        getProjectOwnerOpenIds(project),
        userOpenId,
      )
    ) {
      continue;
    }
    const draft = parseTaskCreationDraft(request.draftPayload);
    items.push({
      id: `task-creation:${request.id}`,
      categoryKey: "task-request",
      badge: "创建任务",
      title: draft?.title ?? "任务创建申请",
      projectName: project.name,
      subject: draft?.title ?? "任务创建申请",
      requester: request.requesterName || "未知申请人",
      submittedAt: request.createdAt.toISOString(),
      href: routes.progress.project(project.id),
      detail: draft ? formatTaskCreationDraftSummary(draft) : "申请内容无法解析",
      meta: [
        `项目：${project.name}`,
        draft?.stageName ? `阶段：${draft.stageName}` : "阶段：未指定",
      ],
    });
  }

  for (const request of taskDeletionRequests) {
    const task = request.task;
    const project = task.project;
    if (
      !canManageProject(
        roles,
        { team: task.team, techGroup: task.techGroup },
        getProjectOwnerOpenIds(project),
        userOpenId,
      )
    ) {
      continue;
    }
    items.push({
      id: `task-deletion:${request.id}`,
      categoryKey: "task-request",
      badge: "删除任务",
      title: task.title,
      projectName: project.name,
      subject: task.title,
      requester: request.requesterName || "未知申请人",
      submittedAt: request.createdAt.toISOString(),
      href: routes.progress.task(task.id),
      detail: request.reason,
      meta: [
        `项目：${project.name}`,
        `阶段：${task.stage?.name ?? "无阶段"}`,
      ],
    });
  }

  for (const request of taskDdlRequests) {
    const task = request.task;
    const project = task.project;
    if (
      !canReviewTaskDdlChange({
        roles,
        scope: { team: task.team, techGroup: task.techGroup },
        projectOwnerOpenIds: getProjectOwnerOpenIds(project),
        taskTechGroups: getTaskTechGroups(task),
        userOpenId,
      })
    ) {
      continue;
    }
    items.push({
      id: `task-ddl:${request.id}`,
      categoryKey: "task-ddl",
      badge: "任务 DDL",
      title: task.title,
      projectName: project.name,
      subject: task.title,
      requester: request.requesterName || "未知申请人",
      submittedAt: request.createdAt.toISOString(),
      href: routes.progress.task(task.id),
      detail: request.reason,
      meta: [
        `项目：${project.name}`,
        `原 DDL：${formatOptionalDate(request.oldDueAt)}`,
        `申请 DDL：${formatOptionalDate(request.newDueAt)}`,
      ],
    });
  }

  for (const task of pendingAcceptanceTasks) {
    const submission = task.submissions[0];
    if (!submission || submission.approvals.length > 0) continue;
    if (
      !canApproveTask(roles, {
        team: task.team,
        techGroup: task.techGroup,
      })
    ) {
      continue;
    }
    items.push({
      id: `task-acceptance:${submission.id}`,
      categoryKey: "task-acceptance",
      badge: "任务验收",
      title: task.title,
      projectName: task.project.name,
      subject: task.title,
      requester: submission.submitterName || "未知提交人",
      submittedAt: submission.submittedAt.toISOString(),
      href: routes.progress.task(task.id),
      detail: submission.note || "任务交付等待验收",
      meta: [
        `项目：${task.project.name}`,
        `阶段：${task.stage?.name ?? "无阶段"}`,
        `交付文档：${submission.feishuDocUrl ? "已填写" : "未填写"}`,
      ],
    });
  }

  const itemsByCategory = new Map<ProgressApprovalCategoryKey, ProgressApprovalItem[]>();
  for (const item of items) {
    const list = itemsByCategory.get(item.categoryKey) ?? [];
    list.push(item);
    itemsByCategory.set(item.categoryKey, list);
  }

  const categories = CATEGORY_META.map((meta) => ({
    ...meta,
    items: (itemsByCategory.get(meta.key) ?? []).sort(compareApprovalItems),
  }));

  return {
    totalCount: items.length,
    categories,
  };
}

function emptyBoard(): ProgressApprovalBoard {
  return {
    totalCount: 0,
    categories: CATEGORY_META.map((meta) => ({ ...meta, items: [] })),
  };
}

function compareApprovalItems(a: ProgressApprovalItem, b: ProgressApprovalItem) {
  return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
}

function formatProjectDdlBadge(
  type: ProjectDdlChangeRequestType,
  durationDays: number | null,
): string {
  if (type === "SINGLE_STAGE_ADJUSTMENT") return "阶段 DDL";
  if (!durationDays) return "批量 DDL";
  return durationDays > 0
    ? `批量延期 ${durationDays} 天`
    : `批量提前 ${Math.abs(durationDays)} 天`;
}

function formatScope(team: string, techGroup: string): string {
  return `${team || "未设置车组"} / ${techGroup || "未设置技术组"}`;
}

function formatNames(names: string[]): string {
  const filtered = names.filter(Boolean);
  return filtered.length > 0 ? filtered.join("、") : "未设置";
}

function formatOptionalDate(value: Date | null): string {
  if (!value) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}
