import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { createAccountPerson, createTask } from "./project-management-canvas-security-fixtures";

export async function createDeadlineTask(
  owner: Awaited<ReturnType<typeof createAccountPerson>>,
  { dueAt, title = `节点到期 ${randomUUID()}`, projectId }: { dueAt: Date; title?: string; projectId?: string },
) {
  const dayMs = 86_400_000;
  const fixture = await createTask({
    ownerAccountId: owner.account.id,
    title,
    team: "英雄",
    techGroup: "电控",
    plannedStartAt: new Date(dueAt.getTime() - 7 * dayMs),
    members: [{ personId: owner.person.id, role: "OWNER" }],
  });
  await prisma.milestoneNode.update({
    where: { nodeId: fixture.milestoneNodeId },
    data: { expectedCompletedAt: dueAt },
  });
  const pending = await prisma.taskNode.create({
    data: {
      taskId: fixture.taskId, type: "MILESTONE", status: "PENDING", createdByAccountId: owner.account.id,
      milestone: { create: { goal: "后续节点", completionCriteria: "完成后续工作", reviewRequirements: "验收", expectedCompletedAt: new Date(dueAt.getTime() + 14 * dayMs) } },
      planVersionEntries: { create: { planVersionId: fixture.planVersionId, sequence: 2 } },
    },
  });
  const termination = await prisma.taskNode.create({
    data: {
      taskId: fixture.taskId, type: "TERMINATION", status: "ACTIVE", createdByAccountId: owner.account.id,
      termination: { create: { name: "交付结束", plannedOutcomeCriteria: "完成交付", plannedAt: new Date(dueAt.getTime() + 28 * dayMs) } },
      planVersionEntries: { create: { planVersionId: fixture.planVersionId, sequence: 3 } },
    },
  });
  if (projectId) await prisma.task.update({ where: { id: fixture.taskId }, data: { projectId } });
  return { ...fixture, title, dueAt, pendingNodeId: pending.id, terminationNodeId: termination.id };
}
