import type { Prisma } from "@prisma/client";
import { firstActiveSummaryNode, type AdminSummaryRow } from "@/lib/project-management/admin-summary-markdown";
import { projectManagementStatusLabel } from "@/lib/project-management/notifications/user-facing-copy";

const summaryDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short", hour12: false,
});
export const summaryDateLabel = (date: Date | null) => date ? summaryDateFormatter.format(date) : "未设置";
const dateLabel = summaryDateLabel;

export async function collectSummaryTasksTx(tx: Prisma.TransactionClient) {
  return await tx.task.findMany({
    where: { deletedAt: null, archivedAt: null, status: { in: ["DRAFT", "ACTIVE"] },
      OR: [{ projectId: null }, { project: { deletedAt: null, status: "ACTIVE" } }] },
    include: {
      project: { select: { name: true } },
      members: { where: { removedAt: null, person: { status: "ACTIVE" } }, include: { person: { select: { displayName: true } } } },
      currentPlanVersion: { include: { nodes: { orderBy: { sequence: "asc" }, include: { node: {
        include: { milestone: { include: { reviews: { where: { result: "PENDING", revokedAt: null } } } },
          termination: { include: { reviews: { where: { result: "PENDING" } } } } },
      } } } } },
      nodes: { where: { deletedAt: null, status: { in: ["PENDING", "ACTIVE"] }, revision: { status: "PENDING_APPROVAL" } }, include: { revision: true } },
    }, orderBy: [{ projectId: "asc" }, { title: "asc" }, { id: "asc" }],
  });
}

export function summarizeTasks(tasks: Awaited<ReturnType<typeof collectSummaryTasksTx>>, now: Date,
  recipient?: { accountId: string; personId: string; canApprove: boolean }) {
  const rows: AdminSummaryRow[] = [];
  let approvalCount = 0;
  for (const task of tasks) {
    const nodes = task.currentPlanVersion.nodes.map((entry) => entry.node).filter((node) => !node.deletedAt && ["PENDING", "ACTIVE"].includes(node.status));
    const approvals = nodes.flatMap((node) => [
      ...(node.milestone?.reviews.map(() => `里程碑验收：${node.milestone?.goal}`) ?? []),
      ...(node.termination?.reviews.map(() => `任务结束审批：${node.termination?.name}`) ?? []),
    ]);
    approvals.push(...task.nodes.filter((node) => node.revision?.basePlanVersionId === task.currentPlanVersionId).map(() => "计划修订审批"));
    const related = !recipient || task.createdByAccountId === recipient.accountId || task.members.some((member) => member.personId === recipient.personId);
    if (recipient && !recipient.canApprove) approvals.length = 0;
    if (!related && !approvals.length) continue;
    approvalCount += approvals.length;
    const start = task.currentPlanVersion.plannedStartAt;
    if (task.status === "DRAFT" && (!start || start > now) && !approvals.length) continue;
    const displayed = [firstActiveSummaryNode(task.currentPlanVersion.nodes)];
    for (const node of displayed) {
      const deadline = node?.milestone?.expectedCompletedAt ?? node?.termination?.plannedAt ?? null;
      rows.push({ projectId: task.projectId, taskId: task.id, project: task.project?.name ?? "未关联项目", task: task.title,
        status: projectManagementStatusLabel(task.status), owners: task.members.filter((member) => member.role === "OWNER").map((member) => member.person.displayName).join("、") || "暂无有效负责人",
        node: node ? node.milestone?.goal ?? node.termination?.name ?? "计划修订" : "无进行中节点", plannedStart: dateLabel(start), deadline: dateLabel(deadline),
        approvals: approvals.join("；") || "无", risk: [task.status === "DRAFT" && start && start <= now ? "超过启动时间未激活" : "", deadline && deadline < now ? "节点逾期" : ""].filter(Boolean).join("；") || "无",
      });
    }
  }
  return { rows, approvalCount };
}
