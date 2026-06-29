import type {
  ProjectStatus,
  StageStatus,
  TaskStatus,
  Urgency,
  Importance,
  UserRoleType,
} from "@prisma/client";

export const stageStatusLabels: Record<StageStatus, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  PENDING_ACCEPTANCE: "待审批",
  COMPLETED: "已完成",
};

export const projectStatusLabels: Record<ProjectStatus, string> = {
  ESTABLISHING: "立项中",
  ESTABLISHMENT_REJECTED: "立项已驳回",
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  CANCELED: "已取消",
};

export const taskStatusLabels: Record<TaskStatus, string> = {
  TODO: "待办",
  IN_PROGRESS: "进行中",
  PENDING_ACCEPTANCE: "待验收",
  COMPLETED: "已完成",
  ARCHIVED: "已归档",
  PROJECT_CANCELED: "项目已取消",
};

export const urgencyLabels: Record<Urgency, string> = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

export const importanceLabels: Record<Importance, string> = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

export const progressRoleLabels: Record<UserRoleType, string> = {
  SUPER_ADMIN: "超级管理员",
  TEAM_ADMIN: "车组组长",
  TECH_GROUP_ADMIN: "技术组组长",
  TEACHER: "指导老师",
  FINANCE: "报销员",
  PROJECT_MANAGER: "项管",
};

/** 项目状态线性推进顺序（不含分支状态） */
export const projectStatusFlow: ProjectStatus[] = [
  "ESTABLISHING",
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
];

export const kanbanColumns: TaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
  "COMPLETED",
];
