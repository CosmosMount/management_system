import type React from "react";
import { DAY_MS } from "@/components/project-management/time-canvas/time-math";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import type { TimeCanvasRange } from "@/components/project-management/time-canvas/types";
import { Label } from "@/components/ui/label";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import { cn } from "@/lib/utils";

export type CreateDraft = {
  rowId: string;
  personId: string;
  startMs: number;
  endMs: number;
};
export type SegmentChange = {
  key: string;
  action: string;
  actorName: string;
  reason: string;
  createdAt: string;
  differences: Array<{
    label: string;
    before: string;
    after: string;
  }>;
};

export function Field({ label, htmlFor, className, children }: { label: string; htmlFor: string; className?: string; children: React.ReactNode }) {
  return <div className={cn("grid gap-1.5", className)}><Label htmlFor={htmlFor}>{label}</Label>{children}</div>;
}

export function toLocal(timeMs: number) {
  return isoToShanghaiDateTimeLocal(new Date(timeMs).toISOString());
}

export function parseShanghaiLocalMs(value: string) {
  const parsed = Date.parse(shanghaiDateTimeLocalToIso(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateSegmentRangeInputs(startValue: string, endValue: string):
  | { ok: true; startMs: number; endMs: number }
  | { ok: false; message: string } {
  const startMs = parseShanghaiLocalMs(startValue);
  const endMs = parseShanghaiLocalMs(endValue);
  if (startMs === null || endMs === null) {
    return { ok: false, message: "请填写有效的开始和结束时间。" };
  }
  if (endMs <= startMs) {
    return { ok: false, message: "结束时间必须晚于开始时间。" };
  }
  if (endMs - startMs > 31 * DAY_MS) {
    return { ok: false, message: "单条投入最长 31 天，请缩短待创建区间。" };
  }
  return { ok: true, startMs, endMs };
}

export function formatPlannerRange(startMs: number, endMs: number) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${formatter.format(new Date(startMs))} – ${formatter.format(new Date(endMs))}`;
}

export function explicitRangeForDraft(range: TimeCanvasRange, draft: CreateDraft) {
  const startDayMs = Date.parse(`${formatShanghaiDate(draft.startMs)}T00:00:00.000+08:00`);
  const endDayMs = Date.parse(`${formatShanghaiDate(draft.endMs)}T00:00:00.000+08:00`);
  const draftEndExclusive = draft.endMs > endDayMs ? endDayMs + DAY_MS : endDayMs;
  return {
    startMs: Math.min(range.startMs, startDayMs),
    endMs: Math.max(range.endMs, draftEndExclusive),
  };
}

export function supportedFieldErrors(
  fieldErrors: Record<string, string[]> | undefined,
  supportedPaths: string[],
) {
  const supported = new Set(supportedPaths);
  return Object.fromEntries(
    Object.entries(fieldErrors ?? {})
      .filter(([path]) => supported.has(path))
      .map(([path, messages]) => [path, messages.filter(Boolean)] as const)
      .filter(([, messages]) => messages.length > 0),
  );
}

export const selectClass = "h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";
