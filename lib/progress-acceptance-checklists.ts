import {
  MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH,
  MAX_ACCEPTANCE_CHECKLIST_ITEMS,
} from "@/lib/validations/progress";

export type AcceptanceChecklistInputItem = {
  content: string;
};

export type AcceptanceChecklistComparableItem = {
  content: string;
};

export const DEFAULT_ACCEPTANCE_CHECKLIST_TEMPLATES = [
  "已核对任务目标与交付内容一致",
  "已打开并阅读飞书交付文档",
  "已检查关键数据/材料链接可访问",
  "已确认定量/定性指标达到任务要求",
  "已确认演示、测试或复现结果有效",
  "已记录未达标原因、风险或后续处理意见",
];

export function normalizeAcceptanceChecklistItems(
  items: AcceptanceChecklistInputItem[] | undefined,
): AcceptanceChecklistInputItem[] {
  const seen = new Set<string>();
  const normalized: AcceptanceChecklistInputItem[] = [];

  for (const item of items ?? []) {
    const content = item.content.trim().replace(/\s+/g, " ");
    if (!content || seen.has(content)) continue;
    seen.add(content);
    normalized.push({
      content: content.slice(0, MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH),
    });
    if (normalized.length >= MAX_ACCEPTANCE_CHECKLIST_ITEMS) break;
  }

  return normalized;
}

export function acceptanceChecklistContents(
  items: AcceptanceChecklistComparableItem[] | undefined,
): string[] {
  return normalizeAcceptanceChecklistItems(items).map((item) => item.content);
}

export function areAcceptanceChecklistsEqual(
  before: AcceptanceChecklistComparableItem[] | undefined,
  after: AcceptanceChecklistComparableItem[] | undefined,
): boolean {
  const beforeContents = acceptanceChecklistContents(before);
  const afterContents = acceptanceChecklistContents(after);
  if (beforeContents.length !== afterContents.length) return false;
  return beforeContents.every((content, index) => content === afterContents[index]);
}

export function formatAcceptanceChecklistSummary(
  items: AcceptanceChecklistComparableItem[] | undefined,
): string {
  const contents = acceptanceChecklistContents(items);
  if (contents.length === 0) return "无";
  const preview = contents.slice(0, 3).join("、");
  return contents.length > 3
    ? `${contents.length} 条：${preview}等`
    : `${contents.length} 条：${preview}`;
}
