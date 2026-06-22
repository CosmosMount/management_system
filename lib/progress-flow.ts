import type { ProjectStatus, TaskStatus } from "@prisma/client";
import { projectStatusLabels, taskStatusLabels } from "@/lib/progress-labels";

/** 项目允许的状态迁移（不可跳跃） */
const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ["IN_PROGRESS"],
  IN_PROGRESS: ["NORMAL", "ABNORMAL"],
  NORMAL: ["OUTCOME_GOOD"],
  ABNORMAL: ["UNDER_INTERVENTION"],
  UNDER_INTERVENTION: ["NORMAL", "OUTCOME_GOOD", "OUTCOME_POOR"],
  OUTCOME_GOOD: ["ARCHIVED"],
  OUTCOME_POOR: ["ARCHIVED"],
  ARCHIVED: [],
};

/** 任务允许的状态迁移 */
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ["IN_PROGRESS"],
  IN_PROGRESS: [],
  PENDING_ACCEPTANCE: [],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransitionProject(
  from: ProjectStatus,
  to: ProjectStatus,
): boolean {
  return PROJECT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertProjectTransition(
  from: ProjectStatus,
  to: ProjectStatus,
): void {
  if (!canTransitionProject(from, to)) {
    throw new Error(
      `无法从「${projectStatusLabels[from]}」直接变更为「${projectStatusLabels[to]}」，请按流程逐步推进`,
    );
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(
      `无法从「${taskStatusLabels[from]}」直接变更为「${taskStatusLabels[to]}」，请按流程逐步推进`,
    );
  }
}

export function getNextProjectStatuses(
  current: ProjectStatus,
): { status: ProjectStatus; label: string }[] {
  return (PROJECT_TRANSITIONS[current] ?? []).map((status) => ({
    status,
    label: projectActionLabels[status] ?? projectStatusLabels[status],
  }));
}

const projectActionLabels: Partial<Record<ProjectStatus, string>> = {
  IN_PROGRESS: "启动项目",
  NORMAL: "确认正常",
  ABNORMAL: "标记异常",
  UNDER_INTERVENTION: "负责人介入",
  OUTCOME_GOOD: "确认结果理想",
  OUTCOME_POOR: "确认结果不理想",
  ARCHIVED: "归档项目",
};

/** 项目主流程展示顺序（桌面端步骤条） */
export const projectFlowSteps: ProjectStatus[] = [
  "IN_PROGRESS",
  "NORMAL",
  "OUTCOME_GOOD",
  "ARCHIVED",
];

export const projectBranchSteps: ProjectStatus[] = [
  "ABNORMAL",
  "UNDER_INTERVENTION",
];

export const taskFlowSteps: TaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
  "COMPLETED",
  "ARCHIVED",
];

export function projectStepIndex(status: ProjectStatus): number {
  if (status === "ABNORMAL" || status === "UNDER_INTERVENTION") {
    return 1;
  }
  if (status === "OUTCOME_POOR") {
    return 2;
  }
  const idx = projectFlowSteps.indexOf(status);
  return idx >= 0 ? idx : 0;
}

export function taskStepIndex(status: TaskStatus): number {
  const idx = taskFlowSteps.indexOf(status);
  return idx >= 0 ? idx : 0;
}

export function getProjectStepperDisplay(status: ProjectStatus): {
  steps: { key: string; label: string }[];
  currentIndex: number;
  branchNote: string | null;
} {
  const outcomeLabel =
    status === "OUTCOME_POOR"
      ? projectStatusLabels.OUTCOME_POOR
      : projectStatusLabels.OUTCOME_GOOD;

  const steps = [
    { key: "IN_PROGRESS", label: projectStatusLabels.IN_PROGRESS },
    { key: "NORMAL", label: projectStatusLabels.NORMAL },
    { key: "OUTCOME", label: outcomeLabel },
    { key: "ARCHIVED", label: projectStatusLabels.ARCHIVED },
  ];

  let branchNote: string | null = null;
  if (status === "ABNORMAL") {
    branchNote = `当前处于「${projectStatusLabels.ABNORMAL}」分支，请先标记异常或推进至负责人介入`;
  } else if (status === "UNDER_INTERVENTION") {
    branchNote = `当前处于「${projectStatusLabels.UNDER_INTERVENTION}」，可恢复为正常或确认最终结果`;
  } else if (status === "DRAFT") {
    branchNote = "项目尚未启动，请先启动项目";
  }

  return {
    steps,
    currentIndex: projectStepIndex(status),
    branchNote,
  };
}

export function getTaskStepperDisplay(status: TaskStatus): {
  steps: { key: string; label: string }[];
  currentIndex: number;
} {
  return {
    steps: taskFlowSteps.map((s) => ({
      key: s,
      label: taskStatusLabels[s],
    })),
    currentIndex: taskStepIndex(status),
  };
}
