import { taskStatusValues } from "@/lib/project-management/types/contract-values";

export type ResourcePlanTaskStatus = (typeof taskStatusValues)[number];

export const RESOURCE_PLAN_TASK_STATUS_OPTIONS = taskStatusValues;
export const DEFAULT_RESOURCE_PLAN_TASK_STATUSES = [
  "DRAFT",
  "ACTIVE",
] as const satisfies readonly ResourcePlanTaskStatus[];

export type ResourcePlanTaskStatusNotice = "INVALID" | "DUPLICATE";

const RESOURCE_PLAN_TASK_STATUS_NOTICE_MESSAGES: Record<
  ResourcePlanTaskStatusNotice,
  string
> = {
  INVALID: "已忽略无法识别的 Task 状态",
  DUPLICATE: "已忽略重复的 Task 状态",
};

const RETIRED_RESOURCE_PLAN_QUERY_KEYS = [
  "from",
  "to",
  "group",
  "types",
  "statuses",
  "tags",
  "zoom",
  "start",
  "end",
  "personId",
  "taskId",
  "timelineDate",
  "timelineFocus",
  "focusSegmentIds",
  "taskCursor",
  "personCursor",
] as const;

export function hasRetiredResourcePlanSearchParams(
  searchParams: URLSearchParams,
) {
  return RETIRED_RESOURCE_PLAN_QUERY_KEYS.some((key) =>
    searchParams.has(key),
  );
}

export function removeRetiredResourcePlanSearchParams(
  searchParams: URLSearchParams,
) {
  for (const key of RETIRED_RESOURCE_PLAN_QUERY_KEYS) {
    searchParams.delete(key);
  }
}

export function parseResourcePlanTaskStatuses(
  value: string | undefined,
): {
  statuses: ResourcePlanTaskStatus[];
  issues: string[];
  noticeCodes: ResourcePlanTaskStatusNotice[];
} {
  if (value === undefined) {
    return {
      statuses: [...DEFAULT_RESOURCE_PLAN_TASK_STATUSES],
      issues: [],
      noticeCodes: [],
    };
  }
  const raw = value
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const normalized = raw.map((status) => status.toUpperCase());
  const allowed = new Set<string>(RESOURCE_PLAN_TASK_STATUS_OPTIONS);
  const valid = normalized.filter((status) => allowed.has(status));
  const unique = new Set(valid);
  const issues: string[] = [];
  const noticeCodes: ResourcePlanTaskStatusNotice[] = [];
  if (valid.length !== normalized.length) {
    issues.push(RESOURCE_PLAN_TASK_STATUS_NOTICE_MESSAGES.INVALID);
    noticeCodes.push("INVALID");
  }
  if (unique.size !== valid.length) {
    issues.push(RESOURCE_PLAN_TASK_STATUS_NOTICE_MESSAGES.DUPLICATE);
    noticeCodes.push("DUPLICATE");
  }
  return {
    statuses: RESOURCE_PLAN_TASK_STATUS_OPTIONS.filter((status) =>
      unique.has(status),
    ),
    issues,
    noticeCodes,
  };
}

export function parseResourcePlanTaskStatusNotices(value: string | undefined) {
  const requested = new Set(
    (value ?? "")
      .split(",")
      .map((notice) => notice.trim().toUpperCase()),
  );
  const codes = (["INVALID", "DUPLICATE"] as const).filter((notice) =>
    requested.has(notice),
  );
  return {
    codes,
    issues: codes.map((code) => RESOURCE_PLAN_TASK_STATUS_NOTICE_MESSAGES[code]),
  };
}

export function setResourcePlanTaskStatusNotices(
  searchParams: URLSearchParams,
  notices: readonly ResourcePlanTaskStatusNotice[],
) {
  const selected = new Set(notices);
  const normalized = (["INVALID", "DUPLICATE"] as const).filter((notice) =>
    selected.has(notice),
  );
  if (normalized.length > 0) {
    searchParams.set("taskStatusNotice", normalized.join(","));
  } else {
    searchParams.delete("taskStatusNotice");
  }
}

export function removeTransientResourcePlanSearchParams(
  searchParams: URLSearchParams,
) {
  searchParams.delete("taskStatusNotice");
}

export function serializeResourcePlanTaskStatuses(
  statuses: readonly ResourcePlanTaskStatus[],
): string | null {
  const selected = new Set(statuses);
  const normalized = RESOURCE_PLAN_TASK_STATUS_OPTIONS.filter((status) =>
    selected.has(status),
  );
  if (
    normalized.length === DEFAULT_RESOURCE_PLAN_TASK_STATUSES.length &&
    normalized.every(
      (status, index) => status === DEFAULT_RESOURCE_PLAN_TASK_STATUSES[index],
    )
  ) {
    return null;
  }
  return normalized.join(",");
}
