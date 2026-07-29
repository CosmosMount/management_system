const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const dateTimeLocalPattern =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/;

export function shanghaiDateTimeLocalToIso(value: string): string {
  const trimmed = value.trim();
  const match = dateTimeLocalPattern.exec(trimmed);
  if (!match) return trimmed;

  const [, year, month, day, hour, minute, second = "00", millisecond = "0"] =
    match;
  if (!isValidCalendarDate(Number(year), Number(month), Number(day))) {
    return trimmed;
  }

  const parsed = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond.padEnd(3, "0").slice(0, 3)}+08:00`,
  );
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}

export function isoToShanghaiDateTimeLocal(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}T${part(parts, "hour")}:${part(parts, "minute")}`;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((item) => item.type === type)?.value ?? "00";
}

function isValidCalendarDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
