// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { listProjects } from "../lib/project-management/queries/project-list-queries";
import { actor, createAccountPerson } from "./helpers/project-management-canvas-security-fixtures";
import { createProjectListFixture } from "./helpers/project-list-fixtures";

test("项目列表只传草稿和进行中摘要，整体进度排除取消与软删除任务", async () => {
  const fixture = await createProjectListFixture();
  const result = await listProjects({ actor: actor(fixture.owner), input: { mine: true, query: fixture.prefix } });
  const project = result.items.find((entry) => entry.id === fixture.project.id);
  expect(project).toMatchObject({
    taskCount: 14, completionTaskTotalCount: 13, completedTaskCount: 1,
    taskStatusCounts: { ACTIVE: 8, DRAFT: 1, COMPLETED: 1, FAILED: 1, TIMEOUT: 1, ARCHIVED: 1 },
    updatedAt: fixture.project.updatedAt.toISOString(),
  });
  expect(project?.tasks).toHaveLength(9);
  expect(project?.owners.map((owner) => owner.personId).sort()).toEqual([fixture.owner.person.id, fixture.secondOwner.person.id].sort());
  expect(project?.tasks.find((task) => task.id === fixture.overdue.taskId)).toEqual({
    id: fixture.overdue.taskId, title: fixture.overdue.title, status: "ACTIVE",
    currentNodeDeadline: { nodeId: fixture.overdue.milestoneNodeId, nodeType: "MILESTONE", dueAt: fixture.overdue.dueAt.toISOString() },
  });
  expect(project?.tasks.find((task) => task.id === fixture.missing.taskId)?.currentNodeDeadline).toBeNull();
  expect(project?.tasks.find((task) => task.id === fixture.draftId)?.currentNodeDeadline).toBeNull();
  for (const task of [...fixture.hiddenTasks, fixture.deleted]) expect(project?.tasks.some((entry) => entry.id === task.taskId)).toBe(false);
  expect(project?.tasks.every((task) => Object.keys(task).sort().join() === "currentNodeDeadline,id,status,title")).toBe(true);
  const outsider = await createAccountPerson(`列表范围 ${randomUUID()}`);
  expect((await listProjects({ actor: actor(outsider), input: { mine: true, query: fixture.prefix } })).items).toEqual([]);
  expect((await listProjects({ actor: actor(outsider), input: { mine: false, query: fixture.prefix } })).items.map((entry) => entry.id)).toContain(fixture.project.id);
  expect((await listProjects({ actor: actor(fixture.owner), input: { status: "COMPLETED", query: fixture.prefix } })).items).toEqual([]);
  await prisma.project.update({ where: { id: fixture.project.id }, data: { deletedAt: new Date() } });
  expect((await listProjects({ actor: actor(fixture.owner), input: { query: fixture.prefix } })).items).toEqual([]);
});

test("项目列表保持更新时间游标分页，空项目安全返回零进度", async () => {
  const owner = await createAccountPerson(`列表分页 ${randomUUID()}`);
  const nowMs = Date.now();
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const project = await prisma.project.create({ data: { name: `分页项目 ${index}`, description: "", status: "ACTIVE", requesterAccountId: owner.account.id, updatedAt: new Date(nowMs - index * 60_000) } });
    ids.push(project.id);
  }
  const first = await listProjects({ actor: actor(owner), input: { mine: true, limit: 2 } });
  expect(first.items.map((project) => project.id)).toEqual(ids.slice(0, 2));
  expect(first.nextCursor).not.toBeNull();
  const second = await listProjects({ actor: actor(owner), input: { mine: true, limit: 2, cursor: first.nextCursor! } });
  expect(second.items.map((project) => project.id)).toEqual(ids.slice(2));
  expect(second.nextCursor).toBeNull();
  expect(second.items[0]).toMatchObject({ taskCount: 0, completedTaskCount: 0, completionTaskTotalCount: 0, tasks: [] });
});
