import type { Prisma } from "@prisma/client";

export type RecentActivityCategory =
  | "PROJECT"
  | "TASK"
  | "PLAN_NODE"
  | "RISK"
  | "COMMENT"
  | "REVIEW";

export type RecentActivityItemDto = {
  id: string;
  category: RecentActivityCategory;
  title: string;
  summary: string;
  actorName: string;
  createdAt: string;
  targetName: string;
  linkPath: string | null;
};

type ActivityTargetType = "PROJECT" | "TASK";

const ACTION_DEFINITIONS = {
  "pm.project.establishment.submit": ["REVIEW", "提交了 Project 立项申请"],
  "pm.project.establishment.resubmit": ["REVIEW", "重新提交了 Project 立项申请"],
  "pm.project.establishment.approve": ["REVIEW", "通过了 Project 立项申请"],
  "pm.project.establishment.reject": ["REVIEW", "驳回了 Project 立项申请"],
  "pm.project.metadata.update": ["PROJECT", "修改了 Project 信息"],
  "pm.project.avatar.update": ["PROJECT", "修改了 Project 头像"],
  "pm.project.members.update": ["PROJECT", "调整了 Project 成员"],
  "pm.project.member.auto_add": ["PROJECT", "自动补充了 Project 成员"],
  "pm.project.complete": ["PROJECT", "结束了 Project"],
  "pm.project.delete": ["PROJECT", "删除了 Project"],
  "pm.task.create": ["TASK", "创建了 Task 草稿"],
  "pm.task.draft.update": ["TASK", "修改了 Task 草稿"],
  "pm.task.draft_metadata.update": ["TASK", "修改了 Task 草稿信息"],
  "pm.task.draft_members.replace": ["TASK", "调整了 Task 草稿成员"],
  "pm.task.draft_plan.replace": ["PLAN_NODE", "调整了 Task 草稿计划"],
  "pm.task.activate": ["TASK", "激活了 Task"],
  "pm.task.draft.delete": ["TASK", "撤回并删除了 Task 草稿"],
  "pm.task.metadata.update": ["TASK", "修改了 Task 信息"],
  "pm.task.members.replace": ["TASK", "调整了 Task 成员"],
  "pm.task.project.assign": ["TASK", "将 Task 加入 Project"],
  "pm.task.project.move": ["TASK", "移动了 Task 所属 Project"],
  "pm.task.project.remove": ["TASK", "将 Task 移出 Project"],
  "pm.revision.create": ["PLAN_NODE", "创建了 Revision"],
  "pm.revision.resubmit": ["REVIEW", "重新提交了 Revision"],
  "pm.revision.reject": ["REVIEW", "驳回了 Revision"],
  "pm.revision.cancel": ["PLAN_NODE", "取消了 Revision"],
  "pm.revision.apply": ["REVIEW", "通过并应用了 Revision"],
  "pm.milestone.review.submit": ["REVIEW", "提交了 Milestone 验收"],
  "pm.milestone.review": ["REVIEW", "处理了 Milestone 验收"],
  "pm.termination.review.submit": ["REVIEW", "提交了 Task 结束申请"],
  "pm.termination.review": ["REVIEW", "处理了 Task 结束申请"],
  "pm.segment.create": ["TASK", "新增了人员投入"],
  "pm.segment.update": ["TASK", "修改了人员投入"],
  "pm.segment.split": ["TASK", "拆分了人员投入（历史）"],
  "pm.segment.merge": ["TASK", "合并了人员投入（历史）"],
  "pm.segment.confirm": ["TASK", "确认了人员投入（历史）"],
  "pm.segment.cancel": ["TASK", "取消了人员投入（历史）"],
  "pm.segment.delete": ["TASK", "删除了人员投入"],
  "pm.project.risk.create": ["RISK", "提出了 Project 风险"],
  "pm.project.risk.resolve": ["RISK", "解决了 Project 风险"],
  "pm.task.risk.create": ["RISK", "提出了 Task 风险"],
  "pm.task.risk.resolve": ["RISK", "解决了 Task 风险"],
  "pm.project.comment.create": ["COMMENT", "发布了 Project 评论"],
  "pm.project.comment.delete": ["COMMENT", "删除了 Project 评论"],
  "pm.task.comment.create": ["COMMENT", "发布了 Task 评论"],
  "pm.task.comment.delete": ["COMMENT", "删除了 Task 评论"],
} as const satisfies Record<
  string,
  readonly [RecentActivityCategory, string]
>;

export const RECENT_ACTIVITY_ACTIONS = Object.freeze(
  Object.keys(ACTION_DEFINITIONS),
);

export function actionsForActivityFilter(
  targetType: ActivityTargetType,
  category: RecentActivityCategory | "ALL",
) {
  return RECENT_ACTIVITY_ACTIONS.filter((action) => {
    const definition =
      ACTION_DEFINITIONS[action as keyof typeof ACTION_DEFINITIONS];
    if (targetType === "TASK" && definition[0] === "PROJECT") return false;
    if (category === "ALL") return true;
    if (targetType === "PROJECT" && category === "TASK") {
      return definition[0] === "TASK" || definition[0] === "PLAN_NODE";
    }
    if (definition[0] !== category) return false;
    return true;
  });
}

export function formatRecentActivityAuditEvent(row: {
  id: string;
  action: string;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string;
  createdAt: Date;
  projectId: string | null;
  taskId: string | null;
  project: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
  actorPerson: { displayName: string } | null;
  entityName?: string | null;
}): RecentActivityItemDto | null {
  const definition =
    ACTION_DEFINITIONS[row.action as keyof typeof ACTION_DEFINITIONS];
  if (!definition) return null;
  const targetName =
    row.entityName ??
    row.task?.title ??
    row.project?.name ??
    entityLabel(definition[0]);
  return {
    id: row.id,
    category: definition[0],
    title: definition[1],
    summary: activitySummary(row.action, row.before, row.after, row.reason),
    actorName: row.actorPerson?.displayName ?? "系统",
    createdAt: row.createdAt.toISOString(),
    targetName,
    linkPath: row.taskId
      ? `/progress/tasks/${row.taskId}`
      : row.projectId
        ? `/progress/projects/${row.projectId}`
        : null,
  };
}

function activitySummary(
  action: string,
  before: Prisma.JsonValue | null,
  after: Prisma.JsonValue | null,
  reason: string,
) {
  const beforeRecord = jsonRecord(before);
  const afterRecord = jsonRecord(after);
  const beforeMetadata = jsonRecord(beforeRecord.metadata);
  const afterMetadata = jsonRecord(afterRecord.metadata);
  const beforePlan = jsonRecord(beforeRecord.plan);
  const afterPlan = jsonRecord(afterRecord.plan);
  const parts: string[] = [];
  addChangedText(
    parts,
    "名称",
    beforeRecord.name ?? beforeRecord.title ?? beforeMetadata.title,
    afterRecord.name ?? afterRecord.title ?? afterMetadata.title,
  );
  addChangedText(
    parts,
    "状态",
    beforeRecord.status ?? beforeRecord.taskStatus,
    afterRecord.status ?? afterRecord.taskStatus,
    statusLabel,
  );
  addChangedText(
    parts,
    "优先级",
    beforeRecord.priority ?? beforeMetadata.priority,
    afterRecord.priority ?? afterMetadata.priority,
    priorityLabel,
  );
  addChangedText(parts, "验收结果", beforeRecord.result, afterRecord.result, reviewResultLabel);
  addChangedText(parts, "结束结果", beforeRecord.outcome, afterRecord.outcome, terminationLabel);
  addCountChange(parts, "成员", beforeRecord.members, afterRecord.members);
  addNumberChange(
    parts,
    "计划节点",
    beforeRecord.nodeCount ?? beforePlan.nodeCount,
    afterRecord.nodeCount ?? afterPlan.nodeCount,
  );
  addPlanChangeSummary(
    parts,
    afterRecord.planChanges ?? afterRecord.changes,
  );
  const content = textValue(afterRecord.content) ?? textValue(beforeRecord.preview);
  const resolveNote = textValue(afterRecord.resolveNote);
  if (content) parts.push(`内容：${boundedText(content, 160)}`);
  if (resolveNote) parts.push(`解决说明：${boundedText(resolveNote, 160)}`);
  if (reason.trim()) parts.push(`说明：${boundedText(reason, 160)}`);
  if (parts.length === 0 && action.includes("plan")) parts.push("计划内容已更新");
  return parts.join("；") || "已记录该业务变更";
}

function jsonRecord(
  value: Prisma.JsonValue | null | undefined,
): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

function addChangedText(
  parts: string[],
  label: string,
  before: Prisma.JsonValue | undefined,
  after: Prisma.JsonValue | undefined,
  formatter: (value: string) => string = (value) => value,
) {
  const beforeText = textValue(before);
  const afterText = textValue(after);
  if (!afterText || beforeText === afterText) return;
  parts.push(
    beforeText
      ? `${label}：${boundedText(formatter(beforeText), 80)} → ${boundedText(formatter(afterText), 80)}`
      : `${label}：${boundedText(formatter(afterText), 80)}`,
  );
}

function addCountChange(
  parts: string[],
  label: string,
  before: Prisma.JsonValue | undefined,
  after: Prisma.JsonValue | undefined,
) {
  const beforeCount = Array.isArray(before) ? before.length : null;
  const afterCount = Array.isArray(after) ? after.length : null;
  if (afterCount === null || beforeCount === afterCount) return;
  parts.push(`${label}数量：${beforeCount ?? 0} → ${afterCount}`);
}

function addNumberChange(
  parts: string[],
  label: string,
  before: Prisma.JsonValue | undefined,
  after: Prisma.JsonValue | undefined,
) {
  const beforeNumber = typeof before === "number" ? before : null;
  const afterNumber = typeof after === "number" ? after : null;
  if (afterNumber === null || beforeNumber === afterNumber) return;
  parts.push(`${label}数量：${beforeNumber ?? 0} → ${afterNumber}`);
}

function addPlanChangeSummary(
  parts: string[],
  value: Prisma.JsonValue | undefined,
) {
  const changes = jsonRecord(value);
  const added = planChangeCount(changes, "addedTotal", "added");
  const removed = planChangeCount(changes, "removedTotal", "removed");
  const changed =
    planChangeCount(changes, "changedTotal", "changed") ??
    nestedNumber(changes.fieldChanges, "nodeCount");
  const reordered = planChangeCount(changes, "reorderedTotal", "reordered");
  const summaries = [
    added ? `新增 ${added}` : null,
    removed ? `移除 ${removed}` : null,
    changed ? `修改 ${changed}` : null,
    reordered ? `调整顺序 ${reordered}` : null,
  ].filter((summary): summary is string => Boolean(summary));
  if (summaries.length > 0) parts.push(`计划节点：${summaries.join("、")}`);
}

function planChangeCount(
  changes: Record<string, Prisma.JsonValue>,
  directKey: string,
  nestedKey: string,
) {
  const direct = changes[directKey];
  if (typeof direct === "number") return direct;
  return nestedNumber(changes[nestedKey], "totalCount");
}

function nestedNumber(value: Prisma.JsonValue | undefined, key: string) {
  const record = jsonRecord(value);
  return typeof record[key] === "number" ? record[key] : null;
}

function textValue(value: Prisma.JsonValue | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedText(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function entityLabel(category: RecentActivityCategory) {
  const labels: Record<RecentActivityCategory, string> = {
    PROJECT: "Project",
    TASK: "Task",
    PLAN_NODE: "计划节点",
    RISK: "风险",
    COMMENT: "评论",
    REVIEW: "审批",
  };
  return labels[category];
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    PENDING_APPROVAL: "立项审批中",
    ACTIVE: "进行中",
    COMPLETED: "已完成",
    FAILED: "失败结束",
    CANCELLED: "已取消",
    TIMEOUT: "已超时",
    ARCHIVED: "已归档",
    RESOLVED: "已解决",
    EFFECTIVE: "已生效",
    REJECTED: "已驳回",
    REVISED: "已修订",
    PLANNED: "计划中",
    IN_PROGRESS: "进行中",
    PENDING_CONFIRMATION: "待确认",
    CONFIRMED: "已确认",
  };
  return labels[value] ?? "其他状态";
}

function priorityLabel(value: string) {
  return ({ CRITICAL: "紧急", HIGH: "高", MEDIUM: "中", LOW: "低" } as Record<string, string>)[value] ?? "其他优先级";
}

function reviewResultLabel(value: string) {
  return ({ APPROVED: "通过", REJECTED: "驳回", REVISION_REQUIRED: "需要修订", PENDING: "待处理" } as Record<string, string>)[value] ?? "其他验收结果";
}

function terminationLabel(value: string) {
  return ({ SUCCESS: "成功", FAILED: "失败", CANCELLED: "取消", TIMEOUT: "超时" } as Record<string, string>)[value] ?? "其他结束结果";
}
