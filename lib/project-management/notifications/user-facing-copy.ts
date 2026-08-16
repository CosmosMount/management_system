import type { ProjectManagementNotificationPayload } from "@/lib/project-management/notifications/contract";

const LEGACY_FIXED_TEXT: Record<string, string> = {
  "Milestone 今日到期": "里程碑今日到期",
  "Milestone 已逾期": "里程碑已逾期",
  "Milestone 待验收": "里程碑待验收",
  "Milestone 验收结果已更新": "里程碑验收结果已更新",
  "Planned Segment 待确认": "计划投入待确认",
  "Project 已删除": "项目已删除",
  "Project 已结束": "项目已结束",
  "Project 立项待审批": "项目立项待审批",
  "Project 立项已通过": "项目立项已通过",
  "Project 立项已驳回": "项目立项已驳回",
  "Task 已激活": "任务已开始执行",
  "Task 已结束": "任务已结束",
  "Task 所属 Project 已变更": "任务所属项目已变更",
  "Task 成员变更": "任务成员已变更",
  "Task 草稿已删除": "任务草稿已删除",
  "你已被加入 Project": "你已被加入项目",
  "你已被加入 Task": "你已被加入任务",
  "计划修订重新待审批": "计划修订已重新提交审批",
};

const ENTITY_LABELS: Record<string, string> = {
  Account: "账号",
  Comment: "评论",
  MilestoneNode: "里程碑",
  MilestoneReview: "里程碑验收",
  Project: "项目",
  ProjectEstablishmentRequest: "项目立项申请",
  ProjectMember: "项目成员",
  RevisionNode: "计划修订",
  RiskRecord: "风险",
  SystemRoleAssignment: "系统权限",
  Task: "任务",
  TerminationNode: "任务结束结果",
  TerminationReview: "任务结束审批",
  UserRole: "报销权限",
  WorkSegment: "投入记录",
};

const STATUS_LABELS: Record<string, string> = {
  ABANDONED: "已废弃",
  ACTIVE: "进行中",
  APPROVED: "已通过",
  ARCHIVED: "已归档",
  CANCELLED: "已取消",
  CANCELED: "已取消",
  COMPLETED: "已完成",
  CONFIRMED: "已确认",
  CURRENT: "当前版本",
  DELETED: "已删除",
  DRAFT: "草稿",
  EFFECTIVE: "已生效",
  FAILED: "失败结束",
  HISTORICAL: "历史版本",
  IN_PROGRESS: "进行中",
  PENDING: "待处理",
  PENDING_APPROVAL: "待审批",
  PENDING_CONFIRMATION: "待确认",
  PLANNED: "计划中",
  REJECTED: "已驳回",
  RESOLVED: "已解决",
  REVISED: "已修订",
  REVISION_REQUIRED: "需要修改",
  SUCCESS: "成功结束",
  TIMEOUT: "已超时",
};

const CONTEXT_LABELS: Record<string, string> = {
  afterRoles: "变更后角色",
  afterStatus: "变更后状态",
  beforeRoles: "变更前角色",
  beforeStatus: "变更前状态",
  changeKind: "成员变更",
  comment: "审批意见",
  content: "相关内容",
  decision: "审批结果",
  dueAt: "计划完成时间",
  endAt: "计划结束时间",
  ownerNames: "负责人",
  reason: "结束原因",
  resolveNote: "解决说明",
  role: "成员角色",
  round: "审批轮次",
  segmentStatus: "投入状态",
  targetName: "相关账号",
  taskCount: "任务数量",
  taskStatus: "任务状态",
  terminalName: "结束节点",
  requestedOutcome: "拟定结束结果",
  reviewComment: "审批意见",
  summary: "结束总结",
};

export type ProjectManagementContextLine = {
  label: string;
  value: string;
  maxLength: number;
};

type TaskMemberChangeKind = "ADDED" | "REMOVED" | "ROLES_CHANGED";

export const SYSTEM_DEFAULT_NOTIFICATION_SUMMARY = "SYSTEM_DEFAULT";
export const USER_PROVIDED_NOTIFICATION_SUMMARY = "USER_PROVIDED";

export function taskMemberChangeSummary(input: {
  actorName: string;
  taskTitle: string;
  changeKind: TaskMemberChangeKind;
  beforeRoles: readonly string[];
  afterRoles: readonly string[];
}) {
  const roleChange = `${roleListLabel(input.beforeRoles)} → ${roleListLabel(input.afterRoles)}`;
  if (input.changeKind === "ADDED") {
    return `${input.actorName}已将你加入任务「${input.taskTitle}」，成员角色：${roleChange}`;
  }
  if (input.changeKind === "REMOVED") {
    return `${input.actorName}已将你移出任务「${input.taskTitle}」，成员角色：${roleChange}`;
  }
  return `${input.actorName}已调整你在任务「${input.taskTitle}」中的成员角色：${roleChange}`;
}

export function normalizeProjectManagementNotificationText(
  value: string,
  options: {
    field: "title" | "summary";
    kind?: ProjectManagementNotificationPayload["kind"];
    taskTitle?: string | null;
    projectName?: string | null;
    actorName?: string | null;
    context?: Record<string, unknown>;
  },
) {
  if (options.field === "title") {
    const fixedText = LEGACY_FIXED_TEXT[value];
    if (fixedText) return fixedText;
    const collaborationSuffix =
      options.kind === "risk_created"
        ? "新增风险"
        : options.kind === "risk_resolved"
          ? "风险已解决"
          : options.kind === "comment_created"
            ? "新增评论"
            : null;
    if (collaborationSuffix) {
      if (
        options.projectName !== null &&
        options.projectName !== undefined &&
        value === `Project「${options.projectName}」${collaborationSuffix}`
      ) {
        return `项目「${options.projectName}」${collaborationSuffix}`;
      }
      if (
        options.taskTitle !== null &&
        options.taskTitle !== undefined &&
        value === `Task「${options.taskTitle}」${collaborationSuffix}`
      ) {
        return `任务「${options.taskTitle}」${collaborationSuffix}`;
      }
      const projectMatch = value.match(
        new RegExp(`^Project「([\\s\\S]*)」${collaborationSuffix}$`),
      );
      if (projectMatch) return `项目「${projectMatch[1]}」${collaborationSuffix}`;
      const taskMatch = value.match(
        new RegExp(`^Task「([\\s\\S]*)」${collaborationSuffix}$`),
      );
      if (taskMatch) return `任务「${taskMatch[1]}」${collaborationSuffix}`;
    }
    return value;
  }

  // Multi-field legacy templates are rebuilt only after their payload fields
  // identify the exact boundaries. Single-field templates can safely strip
  // fixed prefixes and suffixes without interpreting the captured content.
  switch (options.kind) {
    case "task_assigned": {
      const created = value.match(/^Task「([\s\S]*)」已创建为草稿$/);
      if (created) return `任务「${created[1]}」已创建为草稿`;
      const memberChange = legacyTaskMemberChangeSummary(value, options);
      if (memberChange) {
        return memberChange;
      }
      return value;
    }
    case "task_activated": {
      if (options.taskTitle !== null && options.taskTitle !== undefined) {
        const prefix = `Task「${options.taskTitle}」已开始执行，当前节点：`;
        if (value.startsWith(prefix) && value.length > prefix.length) {
          const nodeName = value.slice(prefix.length);
          return `任务「${options.taskTitle}」已开始执行，当前节点：${nodeName === "Terminal" ? "结束节点" : nodeName}`;
        }
      }
      const started = value.match(/^Task「([\s\S]*)」已开始执行$/);
      return started ? `任务「${started[1]}」已开始执行` : value;
    }
    case "task_deleted": {
      const match = value.match(/^Task 草稿「([\s\S]*)」已删除$/);
      return match ? `任务草稿「${match[1]}」已删除` : value;
    }
    case "milestone_review_submitted": {
      const match = value.match(/^Task「([\s\S]*)」有 Milestone 待验收$/);
      return match ? `任务「${match[1]}」有里程碑等待验收` : value;
    }
    case "milestone_review_result":
      return options.context?.summarySource === SYSTEM_DEFAULT_NOTIFICATION_SUMMARY
        ? legacyMilestoneReviewResult(value)
        : value;
    case "revision_pending_review": {
      const created = value.match(
        /^Task「([\s\S]*)」有新的计划修订待审批$/,
      );
      if (created) return `任务「${created[1]}」有新的计划修订等待审批`;
      const resubmitted = value.match(
        /^Task「([\s\S]*)」的计划修订已修改并重新送审$/,
      );
      return resubmitted
        ? `任务「${resubmitted[1]}」的计划修订已修改并重新送审`
        : value;
    }
    case "revision_applied": {
      const match = value.match(
        /^Task「([\s\S]*)」的 Current Plan 已切换$/,
      );
      return match ? `任务「${match[1]}」的当前计划已切换` : value;
    }
    case "task_terminated":
      return normalizeLegacyTerminationSummary(value, options.taskTitle);
    case "project_establishment_submitted": {
      const round = contextInteger(options.context, "round");
      const taskCount = contextInteger(options.context, "taskCount");
      if (options.projectName === null || options.projectName === undefined || !round || !taskCount) {
        return value;
      }
      const ownerNames = textBetween(
        value,
        `Project「${options.projectName}」第 ${round} 轮立项申请等待审批；负责人：`,
        `；申请纳入 ${taskCount} 个 Task`,
      );
      return ownerNames === null
        ? value
        : `项目「${options.projectName}」第 ${round} 轮立项申请等待审批；负责人：${ownerNames}；申请纳入 ${taskCount} 个任务`;
    }
    case "project_establishment_result": {
      const taskCount = contextInteger(options.context, "taskCount");
      if (
        options.projectName === null ||
        options.projectName === undefined ||
        !taskCount
      ) {
        return value;
      }
      const resultDetails = textBetween(
        value,
        `${options.projectName}：`,
        `；本轮 ${taskCount} 个 Task`,
      );
      return resultDetails === null
        ? value
        : `项目「${options.projectName}」：${resultDetails}；本轮 ${taskCount} 个任务`;
    }
    case "project_member_added": {
      const explicit = value.match(
        /^你已作为(负责人|参与人)加入 Project「([\s\S]*)」$/,
      );
      if (explicit) return `你已作为${explicit[1]}加入项目「${explicit[2]}」`;
      const automatic = value.match(
        /^由于你参与关联 Task，已自动加入 Project「([\s\S]*)」$/,
      );
      return automatic
        ? `由于你参与关联任务，已自动加入项目「${automatic[1]}」`
        : value;
    }
    case "project_task_changed": {
      if (
        options.taskTitle !== null &&
        options.taskTitle !== undefined &&
        options.projectName !== null &&
        options.projectName !== undefined
      ) {
        if (
          value ===
          `Task「${options.taskTitle}」已移动 Project「${options.projectName}」`
        ) {
          return `任务「${options.taskTitle}」已移动到项目「${options.projectName}」`;
        }
        if (
          value ===
          `Task「${options.taskTitle}」已加入 Project「${options.projectName}」`
        ) {
          return `任务「${options.taskTitle}」已加入项目「${options.projectName}」`;
        }
      }
      const removed = value.match(/^Task「([\s\S]*)」已移出 Project$/);
      return removed ? `任务「${removed[1]}」已移出项目` : value;
    }
    case "project_completed": {
      const taskCount = contextInteger(options.context, "taskCount");
      if (
        options.projectName === null ||
        options.projectName === undefined ||
        !taskCount
      ) {
        return value;
      }
      const ownerNames = textBetween(
        value,
        `Project「${options.projectName}」已结束；负责人：`,
        `；关联 ${taskCount} 个 Task`,
      );
      return ownerNames === null
        ? value
        : `项目「${options.projectName}」已结束；负责人：${ownerNames}；关联 ${taskCount} 个任务`;
    }
    case "project_deleted": {
      const taskCount = contextInteger(options.context, "taskCount");
      if (
        options.projectName === null ||
        options.projectName === undefined ||
        !taskCount
      ) {
        return value;
      }
      const ownerNames = textBetween(
        value,
        `Project「${options.projectName}」已删除，关联 Task 已保留并移出 Project；负责人：`,
        `；关联 ${taskCount} 个 Task`,
      );
      return ownerNames === null
        ? value
        : `项目「${options.projectName}」已删除，关联任务已保留并移出项目；负责人：${ownerNames}；关联 ${taskCount} 个任务`;
    }
    default:
      return value;
  }
}

function legacyMilestoneReviewResult(value: string) {
  if (value === "验收结果：APPROVED") return "验收结果：已通过";
  if (value === "验收结果：REJECTED") return "验收结果：已驳回";
  if (value === "验收结果：REVISION_REQUIRED") {
    return "验收结果：需要修改";
  }
  return value;
}

function legacyTaskMemberChangeSummary(
  value: string,
  options: {
    actorName?: string | null;
    taskTitle?: string | null;
    context?: Record<string, unknown>;
  },
) {
  if (!options.actorName || !options.taskTitle) return null;
  const changeKind = taskMemberChangeKind(options.context?.changeKind);
  const beforeRoles = contextRoleArray(options.context?.beforeRoles);
  const afterRoles = contextRoleArray(options.context?.afterRoles);
  if (!changeKind || !beforeRoles || !afterRoles) return null;

  const actionLabel =
    changeKind === "ADDED"
      ? "加入"
      : changeKind === "REMOVED"
        ? "移出"
        : "调整角色";
  const roleChange = `${roleListLabel(beforeRoles)} → ${roleListLabel(afterRoles)}`;
  const legacySuffix = `中的成员关系${actionLabel}：${roleChange}`;
  const legacyEnglish = `${options.actorName}已将你在 Task「${options.taskTitle}」${legacySuffix}`;
  const legacyChinese = `${options.actorName}已将你在任务「${options.taskTitle}」${legacySuffix}`;
  if (value !== legacyEnglish && value !== legacyChinese) return null;

  return taskMemberChangeSummary({
    actorName: options.actorName,
    taskTitle: options.taskTitle,
    changeKind,
    beforeRoles,
    afterRoles,
  });
}

function taskMemberChangeKind(value: unknown): TaskMemberChangeKind | null {
  return value === "ADDED" || value === "REMOVED" || value === "ROLES_CHANGED"
    ? value
    : null;
}

function contextRoleArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((role) => typeof role !== "string")) {
    return null;
  }
  return value;
}

function normalizeLegacyTerminationSummary(
  value: string,
  taskTitle?: string | null,
) {
  if (taskTitle !== null && taskTitle !== undefined) {
    const prefix = `Task「${taskTitle}」已结束（`;
    if (value.startsWith(prefix)) {
      const ending = value.slice(prefix.length).match(
        /^([\s\S]*)）：(SUCCESS|FAILED|CANCELLED|TIMEOUT)$/,
      );
      if (ending) {
        const nodeName = ending[1] === "Terminal" ? "结束节点" : ending[1];
        return `任务「${taskTitle}」已结束（${nodeName}）：${terminationOutcomeLabel(ending[2])}`;
      }
    }
  }
  const withoutTask = value.match(
    /^任务已结束（([\s\S]*)）：(SUCCESS|FAILED|CANCELLED|TIMEOUT)$/,
  );
  if (!withoutTask) return value;
  const nodeName = withoutTask[1] === "Terminal" ? "结束节点" : withoutTask[1];
  return `任务已结束（${nodeName}）：${terminationOutcomeLabel(withoutTask[2])}`;
}

function contextInteger(
  context: Record<string, unknown> | undefined,
  key: string,
) {
  const value = context?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : null;
}

function textBetween(value: string, prefix: string, suffix: string) {
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  if (value.length < prefix.length + suffix.length) return null;
  return value.slice(prefix.length, value.length - suffix.length);
}

export function projectManagementEntityLabel(entityType: string) {
  return ENTITY_LABELS[entityType] ?? "相关事项";
}

export function projectManagementStatusLabel(value: string) {
  return STATUS_LABELS[value] ?? "状态已更新";
}

export function milestoneReviewResultLabel(value: string) {
  return STATUS_LABELS[value] ?? "验收结果已更新";
}

export function terminationOutcomeLabel(value: string) {
  return STATUS_LABELS[value] ?? "任务已结束";
}

export function terminationReviewResultLabel(value: string) {
  return STATUS_LABELS[value] ?? "结束审批结果已更新";
}

export function projectManagementContextLines(
  context: Record<string, unknown>,
): ProjectManagementContextLine[] {
  return Object.entries(context)
    .flatMap(([key, value]) => {
      const label = CONTEXT_LABELS[key];
      if (!label || value === null || value === undefined || value === "") {
        return [];
      }
      return [
        {
          label,
          value: contextValue(key, value),
          maxLength: key === "content" ? 2_000 : key === "resolveNote" ? 500 : 120,
        },
      ];
    })
    .slice(0, 6);
}

function contextValue(key: string, value: unknown) {
  if (key === "beforeRoles" || key === "afterRoles") {
    if (!Array.isArray(value) || value.length === 0) return "无";
    return value.map((item) => roleLabel(String(item))).join("、");
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join("、") || "无";
  }
  if (
    key === "beforeStatus" ||
    key === "afterStatus" ||
    key === "taskStatus" ||
    key === "segmentStatus" ||
    key === "requestedOutcome"
  ) {
    return projectManagementStatusLabel(String(value));
  }
  if (key === "decision") {
    return value === "APPROVED"
      ? "通过"
      : value === "REJECTED"
        ? "驳回"
        : value === "REVISION_REQUIRED"
          ? "要求修订"
          : "审批结果已更新";
  }
  if (key === "role") return roleLabel(String(value));
  if (key === "changeKind") {
    return value === "ADDED"
      ? "加入任务"
      : value === "REMOVED"
        ? "移出任务"
        : value === "ROLES_CHANGED"
          ? "调整角色"
          : "成员关系已更新";
  }
  if (key === "dueAt" || key === "endAt") return formatDateTime(String(value));
  return String(value);
}

function roleLabel(value: string) {
  if (value === "OWNER") return "负责人";
  if (value === "PARTICIPANT") return "参与人";
  return "成员";
}

function roleListLabel(roles: readonly string[]) {
  if (roles.length === 0) return "无";
  return roles.map(roleLabel).join("、");
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
