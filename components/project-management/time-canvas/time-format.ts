import type { TimeCanvasZoom } from "@/components/project-management/time-canvas/types";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const compactDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const hourFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatCanvasDate(timeMs: number) {
  return dateFormatter.format(new Date(timeMs));
}

export function formatCanvasDateTime(timeMs: number) {
  return dateTimeFormatter.format(new Date(timeMs));
}

export function formatCompactAnchorDate(timeMs: number, includeTime: boolean) {
  const value = includeTime
    ? compactDateTimeFormatter.format(new Date(timeMs))
    : formatCanvasDate(timeMs).slice(5);
  return value.replaceAll("/", "-");
}

export function formatCanvasRange(startMs: number, endMs: number) {
  return `${formatCanvasDateTime(startMs)} – ${formatCanvasDateTime(endMs)}`;
}

export function formatCanvasTick(timeMs: number, zoom: TimeCanvasZoom) {
  return zoom === "HOUR"
    ? hourFormatter.format(new Date(timeMs))
    : formatCanvasDate(timeMs);
}

export function isShanghaiWeekend(timeMs: number) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(new Date(timeMs));
  return weekday === "Sat" || weekday === "Sun";
}
