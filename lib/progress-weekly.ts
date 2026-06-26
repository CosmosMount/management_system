const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_UTC_OFFSET_HOURS = 8;

export type WeeklyReportDueState =
  | {
      state: "submitted";
      label: "本周周报已提交";
      daysDelta: 0;
      dueAt: Date;
    }
  | {
      state: "future" | "today" | "overdue";
      label: string;
      daysDelta: number;
      dueAt: Date;
    };

export function getWeekStart(date = new Date()): Date {
  const parts = shanghaiDateParts(date);
  const diff = 1 - parts.weekday;
  return shanghaiLocalDateToUtc(parts.year, parts.month, parts.day + diff);
}

export function getWeeklyReportDueState({
  now = new Date(),
  weekday,
  submitted,
}: {
  now?: Date;
  weekday: number;
  submitted: boolean;
}): WeeklyReportDueState {
  const dueWeekday = normalizeWeekday(weekday);
  const dueAt = new Date(
    getWeekStart(now).getTime() +
      (dueWeekday - 1) * ONE_DAY_MS +
      ONE_DAY_MS -
      1,
  );

  if (submitted) {
    return { state: "submitted", label: "本周周报已提交", daysDelta: 0, dueAt };
  }

  const daysDelta = localDayNumber(dueAt) - localDayNumber(now);
  if (daysDelta > 0) {
    return {
      state: "future",
      label: `本周周报还有 ${daysDelta} 天截止`,
      daysDelta,
      dueAt,
    };
  }
  if (daysDelta === 0) {
    return { state: "today", label: "本周周报今天截止", daysDelta: 0, dueAt };
  }
  return {
    state: "overdue",
    label: `本周周报已逾期 ${Math.abs(daysDelta)} 天`,
    daysDelta,
    dueAt,
  };
}

function normalizeWeekday(weekday: number): number {
  if (!Number.isFinite(weekday)) return 5;
  return Math.min(7, Math.max(1, Math.round(weekday)));
}

function localDayNumber(date: Date): number {
  const parts = shanghaiDateParts(date);
  return Math.floor(
    Date.UTC(parts.year, parts.month - 1, parts.day) / ONE_DAY_MS,
  );
}

function shanghaiDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayText = byType.get("weekday") ?? "Mon";
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
    weekday:
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
        weekdayText,
      ) + 1,
  };
}

function shanghaiLocalDateToUtc(
  year: number,
  month: number,
  day: number,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, -SHANGHAI_UTC_OFFSET_HOURS, 0, 0, 0),
  );
}
