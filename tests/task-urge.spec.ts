// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { submitMilestoneForReview } from "../lib/project-management/application/milestone-review-commands";
import { urgeTask } from "../lib/project-management/application/task-urge-service";
import { createTaskDraft, activateTask } from "../lib/project-management/application/lifecycle-service";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { botKindForPayload, projectManagementNotificationPayloadSchema } from "../lib/project-management/notifications/contract";
import { buildProjectManagementCard } from "../lib/notification-channels/project-management";
import { TASK_URGE_DEFAULT_MESSAGE } from "../lib/project-management/validations/task-urge";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test.beforeEach(async () => {
  await createActor("SUPER_ADMINISTRATOR");
});

test("普通可查看用户在桌面和窄屏催促，保留错误、冷却及站内通知", async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const owner = await createActor();
  const viewer = await createActor();
  const task = await createTask(owner);
  await loginAsTestUser(context, baseURL, { openId: viewer.openId, name: viewer.name });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/progress/tasks/${task.taskId}`);
  await expect(page.getByRole("button", { name: "修改任务基本信息", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "催促任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "催促任务", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(await prisma.domainAuditEvent.count({ where: { taskId: task.taskId, action: "pm.task.urge" } })).toBe(0);
  await page.setViewportSize({ width: 393, height: 851 });
  await page.getByRole("button", { name: "催促任务", exact: true }).click();
  await expectHealthyPage(page);
  await expect(dialog.getByLabel("催促信息（可选）")).toHaveAttribute("maxlength", "500");
  await dialog.getByLabel("催促信息（可选）").fill("请同步联调进展 <at id=all>所有人</at>");
  await dialog.getByRole("button", { name: "发送催促", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("催促已提交，飞书消息将由系统投递。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /催促任务（/ })).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "催促任务", exact: true }).click();
  await dialog.getByLabel("催促信息（可选）").fill("保留这条输入");
  await dialog.getByRole("button", { name: "发送催促", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("秒后重试");
  await expect(dialog.getByLabel("催促信息（可选）")).toHaveValue("保留这条输入");
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
  expect(await prisma.domainAuditEvent.count({ where: { taskId: task.taskId, action: "pm.task.urge" } })).toBe(1);
});

test("强制催促沿用评论收件人、去重并生成安全准确的飞书卡片", async () => {
  const owner = await createActor();
  const participant = await createActor();
  const actor = await createActor();
  const admin = await createActor("PROJECT_ADMINISTRATOR");
  const superAdmin = await createActor("SUPER_ADMINISTRATOR");
  const inactive = await createActor("PROJECT_ADMINISTRATOR");
  const noIdentity = await createActor();
  const removed = await createActor();
  const projectOnly = await createActor();
  await prisma.person.update({ where: { id: inactive.actor.personId }, data: { status: "INACTIVE" } });
  await prisma.accountIdentity.deleteMany({ where: { accountId: noIdentity.actor.accountId } });
  const task = await createTask(owner, [participant, noIdentity, removed]);
  await prisma.taskMember.updateMany({ where: { taskId: task.taskId, personId: removed.actor.personId }, data: { removedAt: new Date() } });
  const project = await prisma.project.create({ data: {
    name: "项目 <at id=all>名称</at>", description: "催促测试项目", status: "ACTIVE", requesterAccountId: owner.actor.accountId,
    members: { create: { personId: projectOnly.actor.personId, role: "OWNER", createdByAccountId: owner.actor.accountId } },
  } });
  await prisma.task.update({ where: { id: task.taskId }, data: { projectId: project.id } });
  await prisma.notificationPreference.create({ data: { accountId: participant.actor.accountId, category: "TASK", channel: "FEISHU", enabled: false } });
  const message = `[查看](https://example.invalid) <at id=all>所有人</at> ${"催".repeat(400)}`;
  const result = await urgeTask(actor.actor, { taskId: task.taskId, message, requestId: randomUUID() });
  const outbox = await prisma.notificationOutbox.findUniqueOrThrow({ where: { eventKey: `pm:task:urge:${result.urgeId}:feishu` } });
  const payload = projectManagementNotificationPayloadSchema.parse(JSON.parse(outbox.payload));
  expect(payload.mandatory).toBe(true);
  expect(payload.purpose).toBe("notification");
  expect(botKindForPayload(payload)).toBe("notification");
  expect(payload.projectName).toBe(project.name);
  expect(payload.context.taskStatus).toBe("ACTIVE");
  expect(payload.actorName).toBe(actor.name);
  const recipients = await prisma.inAppNotification.findMany({ where: { eventKey: { startsWith: `pm:task:urge:${result.urgeId}:inapp:` } } });
  for (const person of [owner, participant, actor, admin, superAdmin, noIdentity]) {
    expect(recipients.filter((row) => row.recipientAccountId === person.actor.accountId)).toHaveLength(1);
  }
  for (const person of [inactive, removed, projectOnly]) {
    expect(recipients.some((row) => row.recipientAccountId === person.actor.accountId)).toBe(false);
  }
  expect(payload.recipientOpenIds).toContain(participant.openId);
  expect(payload.recipientOpenIds).not.toContain(noIdentity.openId);
  const card = buildProjectManagementCard(payload, outbox.createdAt);
  const serialized = JSON.stringify(card);
  expect(serialized).toContain('"tag":"plain_text"');
  expect(serialized).not.toContain('"tag":"lark_md"');
  expect(serialized).toContain(message);
  expect(serialized).toContain(owner.name);
  expect(serialized).toContain(`/progress/tasks/${task.taskId}`);
  expect(serialized.split(project.name)).toHaveLength(2);
});

test("幂等重试、并发和五分钟冷却只提交一次，独立任务使用默认文案", async () => {
  const owner = await createActor();
  const other = await createActor();
  const task = await createTask(owner);
  const input = { taskId: task.taskId, message: "  ", requestId: randomUUID() };
  const results = await Promise.all([urgeTask(owner.actor, input), urgeTask(owner.actor, input)]);
  expect(results[0]).toEqual(results[1]);
  await expect(urgeTask(owner.actor, { ...input, message: "更换正文" })).rejects.toThrow("该请求已提交");
  await expect(urgeTask(other.actor, { ...input, requestId: randomUUID() })).rejects.toThrow("秒后重试");
  const outbox = await prisma.notificationOutbox.findUniqueOrThrow({ where: { eventKey: `pm:task:urge:${results[0].urgeId}:feishu` } });
  const payload = projectManagementNotificationPayloadSchema.parse(JSON.parse(outbox.payload));
  expect(payload.projectName).toBeNull();
  expect(payload.summary).toBe(TASK_URGE_DEFAULT_MESSAGE);
  expect(JSON.stringify(buildProjectManagementCard(payload, outbox.createdAt))).toContain("未关联项目");
  const cooledTask = await createTask(owner);
  await prisma.domainAuditEvent.create({ data: { action: "pm.task.urge", entityType: "Task", entityId: cooledTask.taskId, taskId: cooledTask.taskId, actorAccountId: owner.actor.accountId, createdAt: new Date(Date.now() - 300_001) } });
  const competing = await Promise.allSettled([urgeTask(owner.actor, { ...input, taskId: cooledTask.taskId, requestId: randomUUID() }), urgeTask(other.actor, { ...input, taskId: cooledTask.taskId, requestId: randomUUID() })]);
  expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await prisma.domainAuditEvent.count({ where: { taskId: cooledTask.taskId, action: "pm.task.urge" } })).toBe(2);
});

test("非法输入、不存在任务、草稿、停用账号及终态不会写入催促通知", async () => {
  const owner = await createActor();
  const outsider = await createActor();
  const task = await createTask(owner, [], false);
  const input = { taskId: task.taskId, requestId: randomUUID() };
  await expect(urgeTask(outsider.actor, { ...input, taskId: randomUUID() })).rejects.toThrow("对象不存在或无权查看");
  await expect(urgeTask(outsider.actor, input)).rejects.toThrow("仅进行中的任务");
  await expect(urgeTask(owner.actor, input)).rejects.toThrow("仅进行中的任务");
  await activateTask(owner.actor, { taskId: task.taskId, expectedLockVersion: task.lockVersion });
  await expect(urgeTask(owner.actor, { ...input, message: "催".repeat(501) })).rejects.toThrow("最多 500 字");
  await prisma.person.update({ where: { id: outsider.actor.personId }, data: { status: "INACTIVE" } });
  await expect(urgeTask(outsider.actor, input)).rejects.toThrow("人员已停用");
  await prisma.task.update({ where: { id: task.taskId }, data: { status: "COMPLETED" } });
  await expect(urgeTask(owner.actor, input)).rejects.toThrow("仅进行中的任务");
  await prisma.task.update({ where: { id: task.taskId }, data: { deletedAt: new Date() } });
  await expect(urgeTask(owner.actor, input)).rejects.toThrow("对象不存在或无权查看");
  expect(await prisma.domainAuditEvent.count({ where: { taskId: task.taskId, action: "pm.task.urge" } })).toBe(0);
});

test("待审批任务仍可由无编辑权限用户催促，不改变任务和审批", async () => {
  const owner = await createActor();
  const viewer = await createActor();
  const task = await createTask(owner);
  const active = await prisma.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const submitted = await submitMilestoneForReview(owner.actor, {
    milestoneNodeId: active.activeMilestoneNodeId,
    idempotencyKey: randomUUID(),
    evidences: [{ kind: "TEXT", note: "联调测试证据" }],
  });
  const beforeTask = await prisma.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const beforeReview = await prisma.milestoneReview.findUniqueOrThrow({ where: { id: submitted.reviewId } });
  await urgeTask(viewer.actor, { taskId: task.taskId, message: "催".repeat(500), requestId: randomUUID() });
  expect(await prisma.task.findUniqueOrThrow({ where: { id: task.taskId } })).toEqual(beforeTask);
  expect(await prisma.milestoneReview.findUniqueOrThrow({ where: { id: submitted.reviewId } })).toEqual(beforeReview);
});

test("outbox 写入失败回滚审计和站内通知，不消耗冷却", async () => {
  const owner = await createActor();
  const task = await createTask(owner);
  const input = { taskId: task.taskId, requestId: randomUUID(), message: "回滚验证" };
  const functionName = `test_urge_${randomUUID().replaceAll("-", "")}`;
  const triggerName = `test_urge_${randomUUID().replaceAll("-", "")}`;
  await prisma.$executeRaw(Prisma.sql`
    CREATE FUNCTION ${Prisma.raw(`"${functionName}"`)}() RETURNS trigger AS $$
    BEGIN
      IF NEW."type" = 'task_urged' THEN
        RAISE EXCEPTION 'injected task urge outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  try {
    await prisma.$executeRaw(Prisma.sql`
      CREATE TRIGGER ${Prisma.raw(`"${triggerName}"`)} BEFORE INSERT ON "NotificationOutbox"
      FOR EACH ROW EXECUTE FUNCTION ${Prisma.raw(`"${functionName}"`)}()
    `);
    await expect(urgeTask(owner.actor, input)).rejects.toThrow("injected task urge outbox failure");
    expect(await prisma.domainAuditEvent.count({ where: { taskId: task.taskId, action: "pm.task.urge" } })).toBe(0);
    expect(await prisma.inAppNotification.count({ where: { taskId: task.taskId, eventKey: { startsWith: "pm:task:urge:" } } })).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { type: "task_urged", payload: { contains: task.taskId } } })).toBe(0);
  } finally {
    await prisma.$executeRaw(Prisma.sql`DROP TRIGGER IF EXISTS ${Prisma.raw(`"${triggerName}"`)} ON "NotificationOutbox"`);
    await prisma.$executeRaw(Prisma.sql`DROP FUNCTION ${Prisma.raw(`"${functionName}"`)}()`);
  }
  await expect(urgeTask(owner.actor, input)).resolves.toMatchObject({ taskId: task.taskId });
});

async function createActor(role?: "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR") {
  const openId = `ou_urge_${randomUUID()}`;
  const name = `催促测试 ${randomUUID()}`;
  const account = await prisma.account.create({ data: {
    identities: { create: { provider: "FEISHU", tenantId: "default", providerSubject: `open:${openId}`, openId } },
    person: { create: { displayName: name, status: "ACTIVE" } },
    ...(role ? { systemRoles: { create: { role, team: "", techGroup: "" } } } : {}),
  }, include: { person: true, systemRoles: true } });
  if (!account.person) throw new Error("缺少测试人员");
  const actor: ProjectManagementActor = { accountId: account.id, personId: account.person.id, openId, unionId: null, systemRoles: account.systemRoles };
  return { actor, openId, name };
}

async function createTask(owner: Awaited<ReturnType<typeof createActor>>, participants: Array<Awaited<ReturnType<typeof createActor>>> = [], activate = true) {
  const task = await createTaskDraft(owner.actor, {
    title: `催促任务 ${"长名称".repeat(12)} ${randomUUID()}`, description: "催促回归", team: "英雄", techGroup: "电控", priority: "HIGH",
    members: [{ personId: owner.actor.personId, role: "OWNER" }, ...participants.map((person) => ({ personId: person.actor.personId, role: "PARTICIPANT" }))],
    plannedStartAt: new Date(Date.now() - 86_400_000).toISOString(),
    milestones: [{ goal: "完成联调", completionCriteria: "完成定向验收", expectedCompletedAt: new Date(Date.now() + 86_400_000).toISOString(), reviewRequirements: "测试证据", businessDescription: "联调" }],
    termination: { name: "结束", plannedOutcomeCriteria: "全部完成", plannedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), businessDescription: "结束" },
    idempotencyKey: `urge-${randomUUID()}`,
  });
  if (activate) await activateTask(owner.actor, { taskId: task.taskId, expectedLockVersion: task.lockVersion });
  return task;
}
