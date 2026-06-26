import { normalizeTechGroupName } from "@/lib/constants";

export type TaskTechGroupLike = {
  techGroup: string;
  sortOrder?: number;
};

export type TaskWithTechGroups = {
  techGroup: string;
  techGroups?: TaskTechGroupLike[];
};

export function getTaskTechGroups(task: TaskWithTechGroups): string[] {
  const groups = (task.techGroups ?? [])
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((item) => normalizeTechGroupName(item.techGroup))
    .filter(Boolean);
  if (groups.length > 0) return [...new Set(groups)];
  return [normalizeTechGroupName(task.techGroup || "通用")];
}

export function formatTaskTechGroups(task: TaskWithTechGroups): string {
  return getTaskTechGroups(task).join("、");
}

export function normalizeTaskTechGroups(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => normalizeTechGroupName(value)).filter(Boolean)),
  ];
}
