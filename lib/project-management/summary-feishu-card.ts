const MAX_TABLE_ROWS = 20;

function cells(line: string) {
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}

function plainCell(value: string) {
  return value.replace(/&#124;/g, "|").replace(/&#96;/g, "`")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function buildSummaryFeishuCard(title: string, markdown: string, detailUrl: string) {
  const lines = markdown.split(/\r?\n/);
  const tableStart = lines.findIndex((line, index) =>
    line.trim().startsWith("|") && line.trim().endsWith("|") &&
    /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1]?.trim() ?? ""));
  const elements: Record<string, unknown>[] = [];
  const appendText = (text: string) => {
    const content = text.trim().replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
    if (content) elements.push({ tag: "markdown", content });
  };
  if (tableStart < 0) {
    appendText(markdown);
  } else {
    appendText(lines.slice(0, tableStart).join("\n"));
    const headers = cells(lines[tableStart]);
    const rows: Record<string, string>[] = [];
    let tableEnd = tableStart + 2;
    while (tableEnd < lines.length && lines[tableEnd].trim().startsWith("|") && lines[tableEnd].trim().endsWith("|")) {
      const values = cells(lines[tableEnd]);
      if (values.length !== headers.length) break;
      rows.push(Object.fromEntries(values.map((value, index) => [`column_${index}`, plainCell(value)])));
      tableEnd += 1;
    }
    if (rows.length) {
      elements.push({
        tag: "table", page_size: Math.min(10, rows.length), row_height: "low",
        header_style: { text_align: "left", text_size: "normal", background_style: "grey", text_color: "default", bold: true, lines: 1 },
        columns: headers.map((header, index) => ({
          name: `column_${index}`, display_name: plainCell(header), data_type: "text", width: "auto", horizontal_align: "left",
        })),
        rows: rows.slice(0, MAX_TABLE_ROWS),
      });
    } else {
      appendText("暂无可展示的任务明细，请查看完整总结。");
    }
    if (rows.length > MAX_TABLE_ROWS) appendText(`卡片仅展示前 ${MAX_TABLE_ROWS} 条，剩余 ${rows.length - MAX_TABLE_ROWS} 条请查看完整总结。`);
    appendText(lines.slice(tableEnd).join("\n"));
  }
  elements.push({
    tag: "button", text: { tag: "plain_text", content: "查看完整总结" }, type: "primary",
    behaviors: [{ type: "open_url", default_url: detailUrl, pc_url: detailUrl, ios_url: detailUrl, android_url: detailUrl }],
  });
  return {
    schema: "2.0", config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template: "green" },
    body: { elements },
  };
}
