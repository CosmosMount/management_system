export function firstActiveSummaryNode<Node extends { status: string; deletedAt: Date | null }>(entries: { sequence: number; node: Node }[]): Node | null {
  return [...entries].sort((left, right) => left.sequence - right.sequence)
    .find((entry) => !entry.node.deletedAt && entry.node.status === "ACTIVE")?.node ?? null;
}

export type AdminSummaryRow = {
  projectId?: string | null;
  taskId?: string;
  project: string;
  task: string;
  status: string;
  owners: string;
  node: string;
  plannedStart: string;
  deadline: string;
  approvals: string;
  risk: string;
};

export function summaryCell(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;").replace(/[\r\n]+/g, " ").replaceAll("`", "&#96;");
}

export function adminSummaryNotificationPreview(markdown: string) {
  if (markdown.length <= 6000) return markdown;
  const lines: string[] = [];
  let length = 0;
  for (const line of markdown.split("\n")) {
    if (length + line.length + 1 > 5500) break;
    lines.push(line);
    length += line.length + 1;
  }
  return `${lines.join("\n")}\n\n以上为摘要，未展示全部节点。请点击查看详情，在执行记录中查看完整 Markdown 总结。`;
}

export function buildAdminSummaryMarkdown(rows: AdminSummaryRow[], generatedAt: string, approvalCount: number, actorName = "系统", title = "管理员全局进度总结") {
  const projects = new Set(rows.filter((row) => row.project !== "未关联项目").map((row) => row.projectId ?? row.project));
  const tasks = new Set(rows.map((row) => row.taskId ?? row.task));
  const overdue = new Set(rows.filter((row) => row.risk.includes("逾期")).map((row) => row.taskId ?? row.task));
  const header = `# ${summaryCell(title)}\n\n操作人：${summaryCell(actorName)} · 生成时间：${generatedAt}（上海时间）\n\n项目：${projects.size} · 待推进任务：${tasks.size} · 逾期任务：${overdue.size} · 待审批：${approvalCount}\n\n`;
  if (!rows.length) return `${header}当前无待处理事项。`;
  return header + [
    "| 项目 | Task | 状态 | 负责人 | 当前进行中节点 | 计划启动 | 节点截止 | 待审批事项 | 风险 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${[row.project, row.task, row.status, row.owners, row.node, row.plannedStart, row.deadline, row.approvals, row.risk].map(summaryCell).join(" | ")} |`),
  ].join("\n");
}
