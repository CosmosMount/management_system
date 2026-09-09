// @playwright-project node-db
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getTaskWorkspace, listTasks } from "../lib/project-management/queries/task-queries";
import { listMyTaskOptions, searchTaskOptions, resolveTaskOptionsByIds } from "../lib/project-management/queries/task-option-queries";
import { getProjectDetail } from "../lib/project-management/queries/project-detail-queries";
import { getTimeCanvasData } from "../lib/project-management/queries/time-canvas-queries";
import { getActionInbox } from "../lib/project-management/queries/action-inbox-queries";
import { timeCanvasDataToModel } from "../components/project-management/time-canvas/adapter";
import type { CurrentNodeDeadline } from "../lib/project-management/current-node-deadline";
import { createDeadlineTask } from "./helpers/current-node-deadline-fixtures";
import { actor, createAccountPerson, grantGlobalProjectAdministrator, systemAdministratorRole } from "./helpers/project-management-canvas-security-fixtures";

test.beforeAll(async () => {
  const administrator = await createAccountPerson(`到期审批门禁 ${randomUUID()}`);
  await grantGlobalProjectAdministrator(administrator.account.id);
});

test("当前节点到期目标在所有读模型一致，并排除历史、候选和非当前审批", async () => {
  const owner = await createAccountPerson(`到期查询 ${randomUUID()}`);
  const project = await prisma.project.create({ data: { name: `到期项目 ${randomUUID()}`, description: "查询回归", status: "ACTIVE", requesterAccountId: owner.account.id } });
  const dueAt = new Date(Date.now() - 86_400_000);
  const fixture = await createDeadlineTask(owner, { dueAt, projectId: project.id });
  await prisma.taskPlanVersion.update({ where: { id: fixture.planVersionId }, data: { versionNo: 2 } });
  const history = await prisma.taskPlanVersion.create({
    data: {
      taskId: fixture.taskId, versionNo: 1, status: "HISTORICAL", createdByAccountId: owner.account.id,
      nodes: { create: { nodeId: fixture.milestoneNodeId, sequence: 1 } },
    },
  });
  const candidate = await prisma.taskPlanVersion.create({ data: { taskId: fixture.taskId, versionNo: 3, status: "DRAFT", createdByAccountId: owner.account.id } });
  const candidateNode = await prisma.taskNode.create({
    data: {
      taskId: fixture.taskId, type: "MILESTONE", status: "PENDING", createdByAccountId: owner.account.id,
      milestone: { create: { goal: "候选计划不预警", expectedCompletedAt: new Date(dueAt.getTime() - 86_400_000), completionCriteria: "候选", reviewRequirements: "候选" } },
      planVersionEntries: { create: { planVersionId: candidate.id, sequence: 1 } },
    },
  });
  const expected: CurrentNodeDeadline = { nodeId: fixture.milestoneNodeId, nodeType: "MILESTONE", dueAt: dueAt.toISOString() };
  await expectReadModels(owner, fixture, project.id, expected);
  const inbox = await getActionInbox({ actor: actor(owner) });
  expect(inbox.items.find((item) => item.nodeId === fixture.milestoneNodeId)).toMatchObject({ currentNodeDeadline: expected, severity: "CRITICAL", kind: "TASK_NEXT_NODE" });
  expect(inbox.items.some((item) => item.nodeId === candidateNode.id)).toBe(false);

  await grantGlobalProjectAdministrator(owner.account.id);
  const milestone = await prisma.milestoneNode.findUniqueOrThrow({ where: { nodeId: fixture.milestoneNodeId } });
  const ending = await prisma.terminationNode.findUniqueOrThrow({ where: { nodeId: fixture.terminationNodeId } });
  const review = await prisma.milestoneReview.create({ data: { milestoneNodeId: milestone.id, submittedByAccountId: owner.account.id, idempotencyKey: randomUUID() } });
  const approvalInbox = await getActionInbox({ actor: actor(owner, [systemAdministratorRole()]) });
  expect(approvalInbox.items.find((item) => item.kind === "MILESTONE_REVIEW")).toMatchObject({ currentNodeDeadline: expected, severity: "CRITICAL" });
  expect(approvalInbox.items[0].kind).toBe("MILESTONE_REVIEW");
  await prisma.milestoneReview.update({ where: { id: review.id }, data: { result: "REJECTED", comment: "退回补充材料", reviewerAccountId: owner.account.id, reviewedAt: new Date() } });
  await prisma.terminationReview.create({ data: { terminationNodeId: ending.id, outcome: "CANCELLED", reason: "提前结束任务", submittedByAccountId: owner.account.id, idempotencyKey: randomUUID() } });
  const endingInbox = await getActionInbox({ actor: actor(owner, [systemAdministratorRole()]) });
  expect(endingInbox.items.find((item) => item.kind === "TERMINATION_REVIEW")).toMatchObject({ currentNodeDeadline: null, severity: "HIGH" });
  expect(endingInbox.items[0].kind).toBe("TASK_NEXT_NODE");
  const historicalNode = await prisma.taskNode.create({
    data: {
      taskId: fixture.taskId, type: "MILESTONE", status: "ACTIVE", createdByAccountId: owner.account.id,
      milestone: { create: { goal: "历史节点不能作为当前预警", expectedCompletedAt: dueAt, completionCriteria: "历史", reviewRequirements: "历史" } },
      planVersionEntries: { create: { planVersionId: history.id, sequence: 2 } },
    },
  });
  await prisma.task.update({ where: { id: fixture.taskId }, data: { activeMilestoneNodeId: historicalNode.id } });
  await expectReadModels(owner, fixture, project.id, null);
  await prisma.taskNode.update({ where: { id: candidateNode.id }, data: { status: "ACTIVE" } });
  await prisma.task.update({ where: { id: fixture.taskId }, data: { activeMilestoneNodeId: candidateNode.id } });
  await expectReadModels(owner, fixture, project.id, null);
  const mismatchedInbox = await getActionInbox({ actor: actor(owner, [systemAdministratorRole()]) });
  expect(mismatchedInbox.items.every((item) => item.currentNodeDeadline === null)).toBe(true);
  const outsider = await createAccountPerson(`非参与者 ${randomUUID()}`);
  expect(await listMyTaskOptions({ actor: actor(outsider), statuses: [] })).toEqual([]);
});

test("当前里程碑结束后统一回退结束节点，任务终态不再预警", async () => {
  const owner = await createAccountPerson(`结束节点查询 ${randomUUID()}`);
  const project = await prisma.project.create({ data: { name: `结束项目 ${randomUUID()}`, description: "结束节点回归", status: "ACTIVE", requesterAccountId: owner.account.id } });
  const fixture = await createDeadlineTask(owner, { dueAt: new Date(Date.now() - 86_400_000), projectId: project.id });
  await prisma.$transaction([
    prisma.taskNode.update({ where: { id: fixture.milestoneNodeId }, data: { status: "COMPLETED" } }),
    prisma.taskNode.update({ where: { id: fixture.pendingNodeId }, data: { status: "COMPLETED" } }),
    prisma.task.update({ where: { id: fixture.taskId }, data: { activeMilestoneNodeId: null } }),
  ]);
  const ending = await prisma.terminationNode.findUniqueOrThrow({ where: { nodeId: fixture.terminationNodeId } });
  const expected: CurrentNodeDeadline = { nodeId: fixture.terminationNodeId, nodeType: "TERMINATION", dueAt: ending.plannedAt.toISOString() };
  await expectReadModels(owner, fixture, project.id, expected);
  expect((await getActionInbox({ actor: actor(owner) })).items.find((item) => item.nodeId === fixture.terminationNodeId)?.currentNodeDeadline).toEqual(expected);
  for (const status of ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED", "DRAFT"] as const) {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status } });
    await expectReadModels(owner, fixture, project.id, null);
    expect((await getActionInbox({ actor: actor(owner) })).items).toEqual([]);
  }
});

async function expectReadModels(
  owner: Awaited<ReturnType<typeof createAccountPerson>>,
  fixture: Awaited<ReturnType<typeof createDeadlineTask>>,
  projectId: string,
  expected: CurrentNodeDeadline | null,
) {
  const viewer = actor(owner);
  const [workspace, list, options, search, resolved, project, canvas] = await Promise.all([
    getTaskWorkspace({ actor: viewer, taskId: fixture.taskId }),
    listTasks({ actor: viewer, input: { mine: true } }),
    listMyTaskOptions({ actor: viewer, statuses: [] }),
    searchTaskOptions({ actor: viewer, input: { query: fixture.title } }),
    resolveTaskOptionsByIds({ actor: viewer, input: { ids: [fixture.taskId] } }),
    getProjectDetail({ actor: viewer, projectId }),
    getTimeCanvasData({ actor: viewer, input: { scope: { kind: "TASK_SCOPED", taskId: fixture.taskId }, groupBy: "TASK", taskIds: [fixture.taskId], rangeStart: new Date(fixture.dueAt.getTime() - 8 * 86_400_000).toISOString(), rangeEnd: new Date(fixture.dueAt.getTime() + 30 * 86_400_000).toISOString() } }),
  ]);
  const targets = [workspace.task, list.items.find((task) => task.id === fixture.taskId), options[0], search.items[0], resolved[0], project.tasks[0], canvas.anchors[0]];
  for (const task of targets) {
    expect(task).toBeDefined();
    expect(task?.currentNodeDeadline).toEqual(expected);
  }
  const model = timeCanvasDataToModel(canvas, "TASK_WORKBENCH");
  const marked = model.anchors.filter((anchor) => anchor.currentNodeDeadline);
  expect(marked).toHaveLength(expected ? 1 : 0);
  if (expected) expect(marked[0].currentNodeDeadline).toEqual(expected);
}
