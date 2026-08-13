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
