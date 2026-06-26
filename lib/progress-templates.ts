export const REAL_CAR_STAGE_TEMPLATE = [
  { name: "研讨", goal: "明确目标、约束、方案和验收口径" },
  { name: "机电连线图", goal: "完成机电接口、走线与连接关系文档" },
  { name: "机械图纸绘制", goal: "完成机械结构图纸与加工前评审材料" },
  { name: "发加工", goal: "完成加工文件归档并确认加工状态" },
  { name: "装车布线", goal: "完成实车装配、布线和基础检查" },
  { name: "第一次上电验收", goal: "完成首次上电检查与问题记录" },
  { name: "基础功能验收", goal: "完成底盘、通信、控制等基础功能确认" },
  { name: "功能实现", goal: "完成项目目标功能并沉淀关键数据" },
  { name: "留档", goal: "完成文档、视频、数据和复盘材料归档" },
] as const;

export type StageTemplateKey = "real-car" | "custom";

export function getDefaultStageDueAt(index: number): string {
  return getStageDueAtByOffsetDays((index + 1) * 7);
}

export function getStageDueAtByOffsetDays(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(18, 0, 0, 0);
  return toDateTimeLocalInputValue(date);
}

function toDateTimeLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}
