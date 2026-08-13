import type {
  ProjectManagementNotificationCategory,
  TaskMemberRole,
  TaskNodeStatus,
  TaskNodeType,
  TaskPriority,
  TaskStatus,
  WorkSegmentStatus,
  WorkSegmentType,
} from "@prisma/client";

export const taskStatusLabels: Record<TaskStatus, string> = {
  DRAFT: "草稿",
  ACTIVE: "进行中",
  COMPLETED: "已完成",
  FAILED: "失败结束",
  CANCELLED: "已取消",
  TIMEOUT: "已超时",
  ARCHIVED: "已归档",
};

export const taskPriorityLabels: Record<TaskPriority, string> = {
  CRITICAL: "紧急",
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

export const taskMemberRoleLabels: Record<TaskMemberRole, string> = {
  OWNER: "负责人",
  PARTICIPANT: "参与人",
};

export const taskNodeTypeLabels: Record<TaskNodeType, string> = {
  MILESTONE: "Milestone",
  REVISION: "Revision",
  TERMINATION: "结束确认",
};

export const taskNodeStatusLabels: Record<TaskNodeStatus, string> = {
  PENDING: "待开始",
  ACTIVE: "当前",
  COMPLETED: "已完成",
  REVISED: "已修订",
  CANCELLED: "已取消",
};

export const workSegmentTypeLabels: Record<WorkSegmentType, string> = {
  PLANNED: "计划",
  ACTUAL: "实际",
};

export const workSegmentStatusLabels: Record<WorkSegmentStatus, string> = {
  PLANNED: "计划中",
  IN_PROGRESS: "进行中",
  PENDING_CONFIRMATION: "待确认",
  CONFIRMED: "已确认",
  CANCELLED: "已取消",
};

export const notificationCategoryLabels: Record<
  ProjectManagementNotificationCategory,
  string
> = {
  PROJECT: "Project",
  TASK: "Task",
  MILESTONE: "Milestone",
  REVIEW: "验收",
  REVISION: "修订",
  WORK_SEGMENT: "人员投入",
  ACCOUNT_SECURITY: "账号安全",
};

export function formatDateTime(value: string | Date | null | undefined) {
  if (!value) return "未设置";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export function formatDate(value: string | Date | null | undefined) {
  if (!value) return "未设置";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(date);
}
