import { DAY_MS } from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasRange,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_MS = 366 * DAY_MS;
const MAX_FILTER_IDS = 50;

export type TimeCanvasUrlState = {
  range: TimeCanvasRange;
  zoom: TimeCanvasZoom;
  groupBy: "PERSON" | "TASK";
  personIds: string[];
  taskIds: string[];
  tagIds: string[];
  types: Array<"PLANNED" | "ACTUAL">;
  statuses: Array<
    "PLANNED" | "IN_PROGRESS" | "PENDING_CONFIRMATION" | "CONFIRMED" | "CANCELLED"
  >;
  focusId: string | null;
  issues: string[];
};

export function parseTimeCanvasUrlState(
  searchParams: URLSearchParams,
  fallbackRange: TimeCanvasRange,
): TimeCanvasUrlState {
  const issues: string[] = [];
  const from = parseShanghaiDate(searchParams.get("from") ?? searchParams.get("start"));
  const to = parseShanghaiDate(searchParams.get("to") ?? searchParams.get("end"));
  let range = fallbackRange;
  if (from !== null || to !== null) {
    if (from === null || to === null || to <= from || to - from > MAX_RANGE_MS) {
      issues.push("日期范围无效，已恢复默认范围");
    } else {
      range = { startMs: from, endMs: to };
    }
  }

  const requestedScale = searchParams.get("scale")?.toUpperCase();
  const requestedLegacyZoom = searchParams.get("zoom")?.toUpperCase();
  const requestedZoom = requestedScale ?? requestedLegacyZoom;
  const normalizedZoom = requestedScale
    ? normalizeZoom(requestedScale)
    : normalizeLegacyZoom(requestedLegacyZoom);
  const zoom = normalizedZoom ?? "WEEK";
  if (requestedZoom && !normalizedZoom) {
    issues.push("缩放档位无效，已恢复周视图");
  }

  const requestedGroup = searchParams.get("group")?.toUpperCase();
  const groupBy = requestedGroup === "TASK" ? "TASK" : "PERSON";
  if (requestedGroup && requestedGroup !== "PERSON" && requestedGroup !== "TASK") {
    issues.push("分组方式无效，已按人员分组");
  }

  const personIds = parseIds(readList(searchParams, "people"), "人员", issues);
  const legacyPersonId = searchParams.get("personId");
  if (personIds.length === 0 && legacyPersonId && UUID_PATTERN.test(legacyPersonId)) {
    personIds.push(legacyPersonId);
  }
  const taskIds = parseIds(readList(searchParams, "tasks"), "Task", issues);
  const legacyTaskId = searchParams.get("taskId");
  if (taskIds.length === 0 && legacyTaskId && UUID_PATTERN.test(legacyTaskId)) {
    taskIds.push(legacyTaskId);
  }
  const tagIds = parseIds(readList(searchParams, "tags"), "Tag", issues);
  const types = parseTypes(readList(searchParams, "types"), issues);
  const statuses = parseStatuses(readList(searchParams, "statuses"), issues);
  const focus =
    searchParams.get("focus") ??
    readList(searchParams, "focusSegmentIds").split(",")[0] ??
    null;
  const focusId = focus && UUID_PATTERN.test(focus) ? focus : null;
  if (focus && !focusId) issues.push("聚焦对象无效，已忽略");

  return {
    range,
    zoom,
    groupBy,
    personIds,
    taskIds,
    tagIds,
    types,
    statuses,
    focusId,
    issues,
  };
}

export function serializeTimeCanvasUrlState(
  state: Omit<TimeCanvasUrlState, "issues">,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("from", formatShanghaiDate(state.range.startMs));
  params.set("to", formatShanghaiDate(state.range.endMs));
  params.set("scale", state.zoom.toLowerCase());
  params.set("group", state.groupBy.toLowerCase());
  setList(params, "people", state.personIds);
  setList(params, "tasks", state.taskIds);
  setList(params, "tags", state.tagIds);
  if (state.types.length > 0) {
    params.set("types", state.types.map((type) => type.toLowerCase()).join(","));
  }
  if (state.statuses.length > 0) {
    params.set(
      "statuses",
      state.statuses.map((status) => status.toLowerCase()).join(","),
    );
  }
  if (state.focusId) params.set("focus", state.focusId);
  return params;
}

export function formatShanghaiDate(timeMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timeMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function parseShanghaiDate(value: string | null): number | null {
  if (!value || !DATE_PATTERN.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000+08:00`);
  if (!Number.isFinite(parsed)) return null;
  return formatShanghaiDate(parsed) === value ? parsed : null;
}

function parseIds(value: string | null, label: string, issues: string[]) {
  if (!value) return [];
  const parts = value.split(",").filter(Boolean);
  const ids = [...new Set(parts.filter((part) => UUID_PATTERN.test(part)))];
  if (ids.length !== parts.length) issues.push(`${label}筛选含无效或重复值，已忽略`);
  if (ids.length > MAX_FILTER_IDS) {
    issues.push(`${label}筛选最多保留 50 个`);
    return ids.slice(0, MAX_FILTER_IDS);
  }
  return ids;
}

function parseTypes(
  value: string | null,
  issues: string[],
): Array<"PLANNED" | "ACTUAL"> {
  if (!value) return [];
  const raw = value.split(",").filter(Boolean);
  const types = [...new Set(raw.map((item) => item.toUpperCase()))].filter(
    (item): item is "PLANNED" | "ACTUAL" =>
      item === "PLANNED" || item === "ACTUAL",
  );
  if (types.length !== raw.length) issues.push("投入类型筛选含无效或重复值，已忽略");
  return types;
}

function parseStatuses(
  value: string | null,
  issues: string[],
): TimeCanvasUrlState["statuses"] {
  if (!value) return [];
  const raw = value.split(",").filter(Boolean);
  const allowed = new Set<TimeCanvasUrlState["statuses"][number]>([
    "PLANNED",
    "IN_PROGRESS",
    "PENDING_CONFIRMATION",
    "CONFIRMED",
    "CANCELLED",
  ]);
  const statuses = [...new Set(raw.map((item) => item.toUpperCase()))].filter(
    (item): item is TimeCanvasUrlState["statuses"][number] =>
      allowed.has(item as TimeCanvasUrlState["statuses"][number]),
  );
  if (statuses.length !== raw.length) {
    issues.push("投入状态筛选含无效或重复值，已忽略");
  }
  return statuses;
}

function normalizeZoom(value: string | undefined): TimeCanvasZoom | null {
  if (value === "WEEK" || value === "MONTH" || value === "QUARTER" || value === "YEAR") {
    return value;
  }
  if (value === "HOUR") return "WEEK";
  if (value === "DAY") return "MONTH";
  return null;
}

function normalizeLegacyZoom(value: string | undefined): TimeCanvasZoom | null {
  if (value === "HOUR") return "WEEK";
  if (value === "DAY") return "MONTH";
  if (value === "WEEK") return "QUARTER";
  if (value === "MONTH") return "YEAR";
  return null;
}

function setList(params: URLSearchParams, key: string, values: string[]) {
  if (values.length > 0) params.set(key, values.join(","));
}

function readList(searchParams: URLSearchParams, key: string) {
  return searchParams.getAll(key).filter(Boolean).join(",");
}
