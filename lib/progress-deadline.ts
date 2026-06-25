import type { TaskStatus } from "@prisma/client";

export type TaskDeadlineState =
  | "overdue"
  | "today"
  | "dueSoon"
  | "normal"
  | "completed";

type DeadlineTask = {
  dueAt: Date | string;
  status: TaskStatus;
  isOverdue?: boolean;
};

export type TaskDeadlineInfo = {
  state: TaskDeadlineState;
  label: string;
  daysDelta: number;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function getTaskDeadlineState(
  task: DeadlineTask,
  now: Date,
  dueSoonDays: number,
): TaskDeadlineInfo {
  if (
    task.status === "COMPLETED" ||
    task.status === "ARCHIVED" ||
    task.status === "PROJECT_CANCELED"
  ) {
    return {
      state: "completed",
      label: task.status === "PROJECT_CANCELED" ? "项目已取消" : "已完成",
      daysDelta: 0,
    };
  }

  const dueAt = typeof task.dueAt === "string" ? new Date(task.dueAt) : task.dueAt;
  if (Number.isNaN(dueAt.getTime())) {
    return {
      state: "normal",
      label: "未设置截止",
      daysDelta: 0,
    };
  }

  const todayStart = startOfLocalDay(now);
  const dueDayStart = startOfLocalDay(dueAt);
  const dayDiff = Math.round(
    (dueDayStart.getTime() - todayStart.getTime()) / ONE_DAY_MS,
  );

  if (dueAt.getTime() < now.getTime()) {
    const overdueDays = Math.max(0, -dayDiff);
    return {
      state: "overdue",
      label: overdueDays > 0 ? `已超 ${overdueDays} 天` : "今日已超时",
      daysDelta: overdueDays,
    };
  }

  if (dayDiff === 0) {
    return {
      state: "today",
      label: "今天截止",
      daysDelta: 0,
    };
  }

  const dueSoonAt = new Date(
    now.getTime() + Math.max(0, dueSoonDays) * ONE_DAY_MS,
  );
  if (dueAt.getTime() <= dueSoonAt.getTime()) {
    const remainingDays = Math.max(
      1,
      Math.ceil((dueAt.getTime() - now.getTime()) / ONE_DAY_MS),
    );
    return {
      state: "dueSoon",
      label: `剩 ${remainingDays} 天`,
      daysDelta: remainingDays,
    };
  }

  return {
    state: "normal",
    label: `${dueAt.toLocaleDateString("zh-CN", {
      month: "numeric",
      day: "numeric",
    })} 截止`,
    daysDelta: dayDiff,
  };
}

export function getTaskDeadlineSortRank(state: TaskDeadlineState): number {
  switch (state) {
    case "overdue":
      return 0;
    case "today":
      return 1;
    case "dueSoon":
      return 2;
    case "normal":
      return 3;
    case "completed":
      return 4;
  }
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
