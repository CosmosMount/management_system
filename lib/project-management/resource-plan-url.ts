const RETIRED_RESOURCE_PLAN_QUERY_KEYS = [
  "from",
  "to",
  "group",
  "types",
  "statuses",
  "tags",
  "zoom",
] as const;

export function removeRetiredResourcePlanSearchParams(
  searchParams: URLSearchParams,
) {
  for (const key of RETIRED_RESOURCE_PLAN_QUERY_KEYS) {
    searchParams.delete(key);
  }
}
