import type { OrderItemSummary } from "@/lib/feishu";

const MAX_TABLE_ROWS = 20;

function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/** 群 Webhook（lark_md）用列表展示明细 */
export function formatOrderItemsPlainList(
  items?: OrderItemSummary[],
): string {
  if (!items || items.length === 0) return "";

  const lines = items.slice(0, MAX_TABLE_ROWS).map((item) => {
    const subtotal = item.quantity * item.unitPrice;
    return `- ${escapeMdCell(item.name)}：${item.quantity} × ¥${item.unitPrice.toFixed(2)} = ¥${subtotal.toFixed(2)}`;
  });

  if (items.length > MAX_TABLE_ROWS) {
    lines.push(`- … 共 ${items.length} 项`);
  }

  return ["**采购明细**", ...lines].join("\n");
}

/** @deprecated CardKit 请使用 buildOrderItemsTableElement */
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

/** CardKit JSON 2.0 原生表格组件 */
export function buildOrderItemsTableElement(
  items?: OrderItemSummary[],
): Record<string, unknown> | null {
  if (!items || items.length === 0) return null;

  const visible = items.slice(0, MAX_TABLE_ROWS);
  const rows = visible.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    subtotal: item.quantity * item.unitPrice,
  }));

  if (items.length > MAX_TABLE_ROWS) {
    rows.push({
      name: `… 共 ${items.length} 项`,
      quantity: 0,
      unit_price: 0,
      subtotal: 0,
    });
  }

  return {
    tag: "table",
    page_size: Math.min(10, Math.max(1, rows.length)),
    row_height: "low",
    header_style: {
      text_align: "left",
      text_size: "normal",
      background_style: "grey",
      text_color: "default",
      bold: true,
      lines: 1,
    },
    columns: [
      {
        name: "name",
        display_name: "名称",
        data_type: "text",
        width: "auto",
        horizontal_align: "left",
      },
      {
        name: "quantity",
        display_name: "数量",
        data_type: "number",
        width: "auto",
        horizontal_align: "right",
        format: { precision: 0 },
      },
      {
        name: "unit_price",
        display_name: "单价",
        data_type: "number",
        width: "auto",
        horizontal_align: "right",
        format: { symbol: "¥", precision: 2 },
      },
      {
        name: "subtotal",
        display_name: "小计",
        data_type: "number",
        width: "auto",
        horizontal_align: "right",
        format: { symbol: "¥", precision: 2 },
      },
    ],
    rows,
  };
}
