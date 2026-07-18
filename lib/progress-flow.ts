import type { ProjectStatus, StageStatus, TaskStatus } from "@prisma/client";
import {
  projectStatusLabels,
  stageStatusLabels,
  taskStatusLabels,
} from "@/lib/progress-labels";

/** 项目允许的状态迁移（不可跳跃） */
const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  ESTABLISHING: [],
  ESTABLISHMENT_WITHDRAWN: [],
  ESTABLISHMENT_REJECTED: [],
  NOT_STARTED: ["IN_PROGRESS", "CANCELED"],
  IN_PROGRESS: ["COMPLETED", "CANCELED"],
  COMPLETED: [],
  CANCELED: [],
};

const STAGE_TRANSITIONS: Record<StageStatus, StageStatus[]> = {
  NOT_STARTED: ["IN_PROGRESS"],
  IN_PROGRESS: ["PENDING_ACCEPTANCE"],
  PENDING_ACCEPTANCE: ["COMPLETED", "IN_PROGRESS"],
  COMPLETED: [],
};

/** 任务允许的状态迁移 */
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ["IN_PROGRESS"],
  IN_PROGRESS: [],
  PENDING_ACCEPTANCE: [],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
  PROJECT_CANCELED: [],
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

export function canTransitionStage(
  from: StageStatus,
  to: StageStatus,
): boolean {
  return STAGE_TRANSITIONS[from]?.includes(to) ?? false;
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

export function assertStageTransition(from: StageStatus, to: StageStatus): void {
  if (!canTransitionStage(from, to)) {
    throw new Error(
      `无法从「${stageStatusLabels[from]}」直接变更为「${stageStatusLabels[to]}」，请按流程逐步推进`,
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
  COMPLETED: "完成项目",
  CANCELED: "取消项目",
};

/** 项目主流程展示顺序（桌面端步骤条） */
export const projectFlowSteps: ProjectStatus[] = [
  "ESTABLISHING",
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
];

export const taskFlowSteps: TaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
  "COMPLETED",
  "ARCHIVED",
];

export function projectStepIndex(status: ProjectStatus): number {
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
  const steps = [
    { key: "ESTABLISHING", label: projectStatusLabels.ESTABLISHING },
    { key: "NOT_STARTED", label: projectStatusLabels.NOT_STARTED },
    { key: "IN_PROGRESS", label: projectStatusLabels.IN_PROGRESS },
    { key: "COMPLETED", label: projectStatusLabels.COMPLETED },
  ];

  let branchNote: string | null = null;
  if (status === "ESTABLISHING") {
    branchNote = "项目正在立项审批，通过后才能启动项目";
  } else if (status === "ESTABLISHMENT_REJECTED") {
    branchNote = "项目立项已驳回，可修改后重新提交";
  } else if (status === "ESTABLISHMENT_WITHDRAWN") {
    branchNote = "项目立项已撤回，可修改后重新提交";
  } else if (status === "NOT_STARTED") {
    branchNote = "项目尚未启动，请先启动项目";
  } else if (status === "CANCELED") {
    branchNote = "项目已取消，不能继续推进";
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
  if (status === "PROJECT_CANCELED") {
    return {
      steps: [{ key: "PROJECT_CANCELED", label: taskStatusLabels.PROJECT_CANCELED }],
      currentIndex: 0,
    };
  }

  return {
    steps: taskFlowSteps.map((s) => ({
      key: s,
      label: taskStatusLabels[s],
    })),
    currentIndex: taskStepIndex(status),
  };
}
