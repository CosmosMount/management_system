import type { OrderItemSummary } from "@/lib/feishu";

const MAX_TABLE_ROWS = 20;

function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

export function formatOrderItemsMarkdownTable(
  items?: OrderItemSummary[],
): string {
  if (!items || items.length === 0) return "";

  const visible = items.slice(0, MAX_TABLE_ROWS);
  const rows = visible.map((item) => {
    const subtotal = item.quantity * item.unitPrice;
    return `| ${escapeMdCell(item.name)} | ${item.quantity} | ¥${item.unitPrice.toFixed(2)} | ¥${subtotal.toFixed(2)} |`;
  });

  if (items.length > MAX_TABLE_ROWS) {
    rows.push(`| … | … | … | 共 ${items.length} 项 |`);
  }

  return [
    "**采购明细**",
    "| 名称 | 数量 | 单价 | 小计 |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}
