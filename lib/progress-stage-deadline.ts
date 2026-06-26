import type { StageStatus } from "@prisma/client";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = "Asia/Shanghai";

export const DEFAULT_STAGE_DUE_SOON_DAYS = 3;

export type ProjectStageDeadlineState =
  | "overdue"
  | "today"
  | "dueSoon"
  | "normal"
  | "none";

export type StageDeadlineInput = {
  id: string;
  name: string;
  sortOrder: number;
  status: StageStatus;
  dueAt: Date | string | null;
  ownerName: string;
  ownerOpenId?: string;
};

export type ProjectStageDeadlineInfo = {
  state: ProjectStageDeadlineState;
  label: string;
  daysDelta: number;
  dueAt: Date | null;
  stage: StageDeadlineInput | null;
};

export function getCurrentProjectStage<T extends StageDeadlineInput>(
  stages: T[],
): T | null {
  return (
    [...stages]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .find((stage) =>
        ["IN_PROGRESS", "PENDING_ACCEPTANCE"].includes(stage.status),
      ) ?? null
  );
}

export function getStageDeadlineState<T extends StageDeadlineInput>(
  stage: T | null,
  now = new Date(),
  dueSoonDays = DEFAULT_STAGE_DUE_SOON_DAYS,
): ProjectStageDeadlineInfo {
  if (!stage) {
    return {
      state: "none",
      label: "无当前阶段",
      daysDelta: 0,
      dueAt: null,
      stage: null,
    };
  }

  if (!stage.dueAt) {
    return {
      state: "none",
      label: "未设置 DDL",
      daysDelta: 0,
      dueAt: null,
      stage,
    };
  }

  const dueAt = typeof stage.dueAt === "string" ? new Date(stage.dueAt) : stage.dueAt;
  if (Number.isNaN(dueAt.getTime())) {
    return {
      state: "none",
      label: "DDL 无效",
      daysDelta: 0,
      dueAt: null,
      stage,
    };
  }

  const daysUntilDue = localDayNumber(dueAt) - localDayNumber(now);
  if (dueAt.getTime() < now.getTime()) {
    const overdueDays = Math.max(0, Math.abs(daysUntilDue));
    return {
      state: "overdue",
      label: overdueDays > 0 ? `已超期 ${overdueDays} 天` : "今日已超期",
      daysDelta: overdueDays,
      dueAt,
      stage,
    };
  }

  if (daysUntilDue === 0) {
    return {
      state: "today",
      label: "今天截止",
      daysDelta: 0,
      dueAt,
      stage,
    };
  }

  if (daysUntilDue <= dueSoonDays) {
    return {
      state: "dueSoon",
      label: `剩 ${daysUntilDue} 天`,
      daysDelta: daysUntilDue,
      dueAt,
      stage,
    };
  }

  return {
    state: "normal",
    label: formatDueDate(dueAt),
    daysDelta: daysUntilDue,
    dueAt,
    stage,
  };
}

export function getProjectStageDeadlineState<T extends StageDeadlineInput>(
  project: { stages: T[] },
  now = new Date(),
  dueSoonDays = DEFAULT_STAGE_DUE_SOON_DAYS,
): ProjectStageDeadlineInfo {
  return getStageDeadlineState(
    getCurrentProjectStage(project.stages),
    now,
    dueSoonDays,
  );
}

export function getProjectStageDeadlineSortRank(
  state: ProjectStageDeadlineState,
): number {
  switch (state) {
    case "overdue":
      return 0;
    case "today":
      return 1;
    case "dueSoon":
      return 2;
    case "normal":
      return 3;
    case "none":
      return 4;
  }
}

export function compareProjectStageDeadlines(
  a: ProjectStageDeadlineInfo,
  b: ProjectStageDeadlineInfo,
): number {
  const rankDiff =
    getProjectStageDeadlineSortRank(a.state) -
    getProjectStageDeadlineSortRank(b.state);
  if (rankDiff !== 0) return rankDiff;

  if (a.state === "overdue" && b.state === "overdue") {
    return b.daysDelta - a.daysDelta;
  }

  if (a.dueAt && b.dueAt) {
    const dueDiff = a.dueAt.getTime() - b.dueAt.getTime();
    if (dueDiff !== 0) return dueDiff;
  }

  return (a.stage?.sortOrder ?? 0) - (b.stage?.sortOrder ?? 0);
}

function formatDueDate(date: Date): string {
  return `${date.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
    timeZone: TIME_ZONE,
  })} 截止`;
}

function localDayNumber(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return Math.floor(
    Date.UTC(
      Number(byType.get("year")),
      Number(byType.get("month")) - 1,
      Number(byType.get("day")),
    ) / ONE_DAY_MS,
  );
}
