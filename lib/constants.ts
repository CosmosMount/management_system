export const TEAM_OPTIONS = [
  "英雄",
  "工程",
  "步兵",
  "哨兵",
  "无人机",
  "飞镖",
  "雷达",
  "通用",
] as const;

export const TECH_GROUP_OPTIONS = [
  "机械",
  "硬件",
  "电控",
  "算法",
  "通用",
] as const;

export type TeamOption = (typeof TEAM_OPTIONS)[number];
export type TechGroupOption = (typeof TECH_GROUP_OPTIONS)[number];
