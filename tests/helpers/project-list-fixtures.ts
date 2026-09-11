import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { createDeadlineTask } from "./current-node-deadline-fixtures";
import { createAccountPerson } from "./project-management-canvas-security-fixtures";

export async function createProjectListFixture(nowMs = Date.now()) {
  const owner = await createAccountPerson(`项目列表负责人${"长姓名".repeat(8)} ${randomUUID()}`);
  const secondOwner = await createAccountPerson(`第二负责人 ${randomUUID()}`);
  const prefix = `项目摘要 ${randomUUID()}`;
  const project = await prisma.project.create({
    data: {
      name: `${prefix} ${"很长的项目名称".repeat(12)}`,
      description: "用于项目总览的长简介。".repeat(30),
      status: "ACTIVE", requesterAccountId: owner.account.id,
      members: { create: [
        { personId: owner.person.id, role: "OWNER", createdByAccountId: owner.account.id, createdAt: new Date(nowMs - 1) },
        { personId: secondOwner.person.id, role: "OWNER", createdByAccountId: owner.account.id, createdAt: new Date(nowMs) },
      ] },
      updatedAt: new Date(nowMs - 2 * 86_400_000),
    },
  });
  const normalTasks = [];
  for (let index = 0; index < 5; index += 1) {
    normalTasks.push(await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date(nowMs + 5 * 86_400_000 + index * 60_000), title: `A正常任务${index}` }));
  }
  const soon = await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date(nowMs + 60_000), title: "B即将到期任务" });
  const overdue = await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date(nowMs - 86_400_000), title: `Z紧急任务${"很长的任务名称".repeat(12)}` });
  const missing = await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date(nowMs - 86_400_000), title: "无有效节点期限" });
  await prisma.taskNode.update({ where: { id: missing.milestoneNodeId }, data: { status: "PENDING" } });
  const hiddenTasks = [];
  let draftId = "";
  for (const status of ["DRAFT", "COMPLETED", "FAILED", "TIMEOUT", "ARCHIVED", "CANCELLED"] as const) {
    const task = await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date(nowMs - 86_400_000), title: `${status}任务` });
    await prisma.task.update({ where: { id: task.taskId }, data: { status } });
    if (status === "DRAFT") draftId = task.taskId;
    else hiddenTasks.push(task);
  }
  const deleted = await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date(nowMs - 2 * 86_400_000), title: "已删除任务不应显示" });
  await prisma.task.update({ where: { id: deleted.taskId }, data: { deletedAt: new Date(nowMs) } });
  return { owner, secondOwner, project, prefix, normalTasks, soon, overdue, missing, draftId, hiddenTasks, deleted, nowMs };
}
