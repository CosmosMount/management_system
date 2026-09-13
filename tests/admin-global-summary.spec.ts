// @playwright-project ui
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Prisma } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  listAdminGlobalSummaryRuns,
  runAdminGlobalSummary,
  runAdminGlobalSummaryNow,
  getAdminGlobalSummaryRun,
} from "../lib/project-management/application/admin-global-summary-service";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { activateTask, createTaskDraft } from "../lib/project-management/application/lifecycle-service";
import { projectManagementNotificationPayloadSchema } from "../lib/project-management/notifications/contract";
import { projectManagementNotificationChannel } from "../lib/notification-channels/project-management";
import { notificationReadableWhere, ProjectManagementAuthorizationError } from "../lib/project-management/authorization";
import { runConfiguredProjectManagementReminders } from "../lib/project-management/application/maintenance-service";
import { assertOfficialPlaywrightEnvironment } from "../scripts/playwright-runner";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

const summaryKind = "project_management_global_summary_daily";
type AdministratorRole = "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR";

test.beforeEach(() => {
  assertOfficialPlaywrightEnvironment(process.env);
  expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
});

test("全局管理员生成并持久化总结，仅通知在用全局管理员且多角色去重", async () => {
  const superAdmin = await createActor("SUPER_ADMINISTRATOR");
  const projectAdmin = await createActor("PROJECT_ADMINISTRATOR");
  const normal = await createActor();
  const scoped = await createActor("PROJECT_ADMINISTRATOR", "英雄");
  const inactive = await createActor("PROJECT_ADMINISTRATOR");
  const revoked = await createActor("PROJECT_ADMINISTRATOR");
  await prisma.person.update({ where: { id: inactive.actor.personId }, data: { status: "INACTIVE" } });
  await prisma.systemRoleAssignment.updateMany({ where: { accountId: revoked.actor.accountId }, data: { revokedAt: new Date() } });
  await prisma.systemRoleAssignment.create({ data: { accountId: superAdmin.actor.accountId, role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" } });

  const run = await runAdminGlobalSummaryNow(superAdmin.actor, { requestId: randomUUID() });
  expect(run.status).toBe("SUCCEEDED");
  expect(run.markdown.trim().length).toBeGreaterThan(0);
  expect(run.errorMessage ?? "").toBe("");
  expect(run.startedAt).toBeTruthy();
  expect(run.finishedAt).toBeTruthy();
  const persisted = await prisma.adminGlobalSummaryRun.findUniqueOrThrow({ where: { id: run.id } });
  expect(persisted).toMatchObject({ status: "SUCCEEDED", markdown: run.markdown, recipientCount: run.recipientCount, actorAccountId: superAdmin.actor.accountId });
  expect(persisted.finishedAt!.getTime()).toBeGreaterThanOrEqual(persisted.startedAt.getTime());
  const outboxes = await summaryOutboxes(run.id);
  expect(outboxes).toHaveLength(1);
  const outbox = outboxes[0];
  expect(outbox).toMatchObject({ channel: "project-management", botKind: "notification", sentAt: null });
  const payload = projectManagementNotificationPayloadSchema.parse(JSON.parse(outbox.payload));
  expect(payload).toMatchObject({ kind: summaryKind, purpose: "notification", actorName: superAdmin.name });
  const recipients = payload.recipientOpenIds;
  expect(recipients).toEqual(expect.arrayContaining([superAdmin.openId, projectAdmin.openId]));
  for (const excluded of [normal, scoped, inactive, revoked]) expect(recipients).not.toContain(excluded.openId);
  expect(new Set(recipients).size).toBe(recipients.length);
  const notices = await prisma.inAppNotification.findMany({ where: { entityType: "AdminGlobalSummaryRun", entityId: run.id } });
  const notifiedAccountIds = new Set(notices.map((notice) => notice.recipientAccountId));
  expect(run.recipientCount).toBe(notifiedAccountIds.size);
  for (const included of [superAdmin, projectAdmin]) expect(notifiedAccountIds.has(included.actor.accountId)).toBe(true);
  for (const excluded of [normal, scoped, inactive, revoked]) expect(notifiedAccountIds.has(excluded.actor.accountId)).toBe(false);
  for (const part of outboxes) {
    expect(part).toMatchObject({ channel: "project-management", botKind: "notification", sentAt: null });
    expect(projectManagementNotificationPayloadSchema.parse(JSON.parse(part.payload)).recipientOpenIds).toEqual(recipients);
  }
  expect(outboxes.map((part) => part.eventKey).sort()).toEqual(
    Array.from({ length: outboxes.length }, (_, index) => `${persisted.eventKey}:part:${index + 1}:feishu`).sort(),
  );
  expect(await listAdminGlobalSummaryRuns(projectAdmin.actor)).toEqual(expect.arrayContaining([expect.objectContaining({ id: run.id, markdown: run.markdown })]));
  const projectAdminRun = await runAdminGlobalSummaryNow(projectAdmin.actor, { requestId: randomUUID() });
  expect(projectAdminRun.status).toBe("SUCCEEDED");
});

test("普通、局部、停用及已撤权管理员不能执行或读取全局总结", async () => {
  await createActor("SUPER_ADMINISTRATOR");
  const normal = await createActor();
  const scoped = await createActor("PROJECT_ADMINISTRATOR", "英雄");
  const inactive = await createActor("SUPER_ADMINISTRATOR");
  const revoked = await createActor("PROJECT_ADMINISTRATOR");
  await prisma.person.update({ where: { id: inactive.actor.personId }, data: { status: "INACTIVE" } });
  await prisma.systemRoleAssignment.updateMany({ where: { accountId: revoked.actor.accountId }, data: { revokedAt: new Date() } });
  const before = await sideEffectCounts();
  for (const denied of [normal, scoped, inactive, revoked]) {
    await expect(runAdminGlobalSummaryNow(denied.actor, { requestId: randomUUID() })).rejects.toThrow();
    await expect(listAdminGlobalSummaryRuns(denied.actor)).rejects.toThrow();
  }
  const forged: ProjectManagementActor = {
    ...normal.actor,
    systemRoles: revoked.actor.systemRoles.map((role) => ({ ...role, accountId: normal.actor.accountId, revokedAt: null })),
  };
  await expect(runAdminGlobalSummaryNow(forged, { requestId: randomUUID() })).rejects.toThrow();
  await expect(listAdminGlobalSummaryRuns(forged)).rejects.toThrow();
  expect(await sideEffectCounts()).toEqual(before);
});

test("总结只包含当前计划待办和到期启动草稿，排除终态、删除及不可用项目", async () => {
  test.setTimeout(120_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const now = new Date();
  const active = await createSummaryTask(admin, "当前计划任务");
  const dueDraft = await createSummaryTask(admin, "到期启动草稿", { active: false, start: now });
  const futureDraft = await createSummaryTask(admin, "未来启动草稿", { active: false, start: new Date(now.getTime() + 86_400_000) });
  const excludedTitles = [futureDraft.title];
  for (const status of ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED"] as const) {
    const excluded = await createSummaryTask(admin, `终态 ${status}`);
    await prisma.task.update({ where: { id: excluded.id }, data: { status } });
    excludedTitles.push(excluded.title);
  }
  for (const field of ["deletedAt", "archivedAt"] as const) {
    const excluded = await createSummaryTask(admin, field);
    await prisma.task.update({ where: { id: excluded.id }, data: { [field]: now } });
    excludedTitles.push(excluded.title);
  }
  const visibleProject = await prisma.project.create({ data: { name: `有效总结项目 ${randomUUID()}`, description: "测试", status: "ACTIVE", requesterAccountId: admin.actor.accountId } });
  await prisma.task.update({ where: { id: active.id }, data: { projectId: visibleProject.id } });
  for (const deleted of [false, true]) {
    const project = await prisma.project.create({ data: {
      name: `排除总结项目 ${randomUUID()}`, description: "测试", status: deleted ? "ACTIVE" : "COMPLETED",
      deletedAt: deleted ? now : null, requesterAccountId: admin.actor.accountId,
    } });
    const excluded = await createSummaryTask(admin, "不可用项目任务");
    await prisma.task.update({ where: { id: excluded.id }, data: { projectId: project.id } });
    excludedTitles.push(excluded.title);
  }
  const historyGoal = `历史计划节点 ${randomUUID()}`;
  await createHistoricalMilestone(admin, active, historyGoal);
  const run = await runAdminGlobalSummary({ now, slotKey: `filter-${randomUUID()}` });
  expect(run.status).toBe("SUCCEEDED");
  expect(run.markdown).toContain(active.title);
  expect(run.markdown).toContain(visibleProject.name);
  expect(run.markdown).toContain(dueDraft.title);
  expect(summaryTaskLines(run.markdown, dueDraft.title)).toContain("无进行中节点");
  expect(run.markdown).toContain("超过启动时间未激活");
  expect(run.markdown).toContain(active.nodes.find((node) => node.milestone)?.milestone?.goal);
  expect(run.markdown).not.toContain(historyGoal);
  for (const title of excludedTitles) expect(run.markdown).not.toContain(title);
});

test("当前计划三类待审批计数准确，历史计划和已撤销验收不进入总结", async () => {
  test.setTimeout(120_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const milestoneTask = await createSummaryTask(admin, "待验收任务");
  const terminationTask = await createSummaryTask(admin, "待结束审批任务", { milestoneCount: 0 });
  const revisionTask = await createSummaryTask(admin, "待修订审批任务");
  const revokedTask = await createSummaryTask(admin, "已撤销验收任务");
  const historicalTask = await createSummaryTask(admin, "历史验收任务");
  const staleRevisionTask = await createSummaryTask(admin, "历史修订任务");
  const before = await runAdminGlobalSummaryNow(admin.actor, { requestId: randomUUID() });
  expect(before.status).toBe("SUCCEEDED");
  const milestone = milestoneTask.nodes.find((node) => node.milestone)?.milestone;
  const terminal = terminationTask.nodes.find((node) => node.termination)?.termination;
  const revokedMilestone = revokedTask.nodes.find((node) => node.milestone)?.milestone;
  if (!milestone || !terminal || !revokedMilestone) throw new Error("审批测试缺少节点");
  await prisma.milestoneReview.create({ data: { milestoneNodeId: milestone.id, submittedByAccountId: admin.actor.accountId, idempotencyKey: randomUUID() } });
  await prisma.terminationReview.create({ data: { terminationNodeId: terminal.id, outcome: "SUCCESS", submittedByAccountId: admin.actor.accountId, idempotencyKey: randomUUID() } });
  await prisma.taskNode.create({ data: {
    taskId: revisionTask.id, type: "REVISION", createdByAccountId: admin.actor.accountId,
    revision: { create: { reason: "当前计划修订", revisionAt: new Date(), basePlanVersionId: revisionTask.currentPlanVersionId } },
  } });
  await prisma.milestoneReview.create({ data: { milestoneNodeId: revokedMilestone.id, submittedByAccountId: admin.actor.accountId, idempotencyKey: randomUUID(), revokedAt: new Date(), revokedByAccountId: admin.actor.accountId, revokeReason: "撤回验收" } });
  const historical = await createHistoricalMilestone(admin, historicalTask, `历史待验收节点 ${randomUUID()}`);
  await prisma.milestoneReview.create({ data: { milestoneNodeId: historical.milestone.id, submittedByAccountId: admin.actor.accountId, idempotencyKey: randomUUID() } });
  const staleBase = await createHistoricalMilestone(admin, staleRevisionTask, `历史修订基础节点 ${randomUUID()}`);
  await prisma.taskNode.create({ data: {
    taskId: staleRevisionTask.id, type: "REVISION", createdByAccountId: admin.actor.accountId,
    revision: { create: { reason: "历史计划修订", revisionAt: new Date(), basePlanVersionId: staleBase.planVersionId } },
  } });
  const run = await runAdminGlobalSummaryNow(admin.actor, { requestId: randomUUID() });
  expect(run.status).toBe("SUCCEEDED");
  expect(approvalCount(run.markdown)).toBe(approvalCount(before.markdown) + 3);
  expect(summaryTaskLines(run.markdown, milestoneTask.title)).toContain(`里程碑验收：${milestone.goal}`);
  expect(summaryTaskLines(run.markdown, terminationTask.title)).toContain(`任务结束审批：${terminal.name}`);
  expect(summaryTaskLines(run.markdown, revisionTask.title)).toContain("计划修订审批");
  for (const excluded of [revokedTask, historicalTask, staleRevisionTask]) {
    const lines = summaryTaskLines(run.markdown, excluded.title);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).not.toMatch(/里程碑验收：|任务结束审批：|计划修订审批/);
  }
  expect(run.markdown).not.toContain(historical.milestone.goal);
  expect(run.markdown).not.toContain(staleBase.milestone.goal);
});

test("执行期间共享数据库锁拒绝手动与定时并发，释放后请求可以执行", async () => {
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const input = { requestId: randomUUID() };
  const slotKey = `locked-${randomUUID()}`;
  const before = await sideEffectCounts();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('management_system:project-management:cron'), hashtext('admin-global-summary'))`;
    await expect(runAdminGlobalSummaryNow(admin.actor, input)).rejects.toThrow(/正在执行/);
    await expect(runAdminGlobalSummary({ slotKey })).rejects.toThrow(/正在执行/);
    expect(await sideEffectCounts()).toEqual(before);
  }, { timeout: 15_000 });
  expect((await runAdminGlobalSummaryNow(admin.actor, input)).status).toBe("SUCCEEDED");
  expect((await runAdminGlobalSummary({ slotKey })).status).toBe("SUCCEEDED");
});

test("自动总结使用上海日期和配置时间槽，未到点与禁用跳过，跨日独立执行", async () => {
  test.setTimeout(120_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const settingIds: string[] = [];
  const eventKey = (date: string, time: string) => `pm:admin-global-summary:${date}:${time}`;
  try {
    for (const [timeOfDay, enabled] of [["02:17", true], ["02:18", false], ["02:19", true]] as const) {
      const setting = await prisma.projectManagementReminderSetting.create({ data: {
        kind: "ADMIN_GLOBAL_SUMMARY", timeOfDay, enabled, timezone: "Asia/Shanghai",
        createdByAccountId: admin.actor.accountId, updatedByAccountId: admin.actor.accountId,
      } });
      settingIds.push(setting.id);
    }
    await runConfiguredProjectManagementReminders(new Date("2031-04-05T02:16:00+08:00"));
    expect(await prisma.adminGlobalSummaryRun.count({ where: { eventKey: eventKey("2031-04-05", "02:17") } })).toBe(0);
    await runConfiguredProjectManagementReminders(new Date("2031-04-05T02:17:00+08:00"));
    const first = await prisma.adminGlobalSummaryRun.findUniqueOrThrow({ where: { eventKey: eventKey("2031-04-05", "02:17") } });
    expect(first).toMatchObject({ status: "SUCCEEDED", trigger: "SCHEDULED", actorAccountId: null });
    const firstOutboxes = await summaryOutboxes(first.id);
    expect(firstOutboxes.length).toBeGreaterThan(0);
    await runConfiguredProjectManagementReminders(new Date("2031-04-05T02:18:00+08:00"));
    expect(await prisma.adminGlobalSummaryRun.findUnique({ where: { eventKey: first.eventKey } })).toEqual(first);
    expect((await summaryOutboxes(first.id)).map((row) => row.id).sort()).toEqual(firstOutboxes.map((row) => row.id).sort());
    for (const time of ["02:18", "02:19"]) expect(await prisma.adminGlobalSummaryRun.count({ where: { eventKey: eventKey("2031-04-05", time) } })).toBe(0);
    await runConfiguredProjectManagementReminders(new Date("2031-04-05T02:19:00+08:00"));
    expect(await prisma.adminGlobalSummaryRun.findUnique({ where: { eventKey: eventKey("2031-04-05", "02:19") } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await prisma.adminGlobalSummaryRun.count({ where: { eventKey: eventKey("2031-04-05", "02:18") } })).toBe(0);
    await runConfiguredProjectManagementReminders(new Date("2031-04-06T02:17:00+08:00"));
    const nextDay = await prisma.adminGlobalSummaryRun.findUniqueOrThrow({ where: { eventKey: eventKey("2031-04-06", "02:17") } });
    expect(nextDay.status).toBe("SUCCEEDED");
    expect(nextDay.id).not.toBe(first.id);
  } finally {
    for (const id of settingIds) await prisma.projectManagementReminderSetting.delete({ where: { id } });
  }
});

test("手动执行占锁不阻断其他提醒，自动总结在下一分钟补执行且成功槽位不重发", async () => {
  test.setTimeout(120_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const overdue = await createSummaryTask(admin, "锁冲突启动提醒", { active: false });
  const settingIds: string[] = [];
  const scheduledEventKey = "pm:admin-global-summary:2031-04-07:03:17";
  try {
    const summarySetting = await prisma.projectManagementReminderSetting.create({ data: {
      kind: "ADMIN_GLOBAL_SUMMARY", timeOfDay: "03:17", timezone: "Asia/Shanghai",
      createdByAccountId: admin.actor.accountId, updatedByAccountId: admin.actor.accountId,
    } });
    settingIds.push(summarySetting.id);
    const activationSetting = await prisma.projectManagementReminderSetting.create({ data: {
      kind: "TASK_ACTIVATION_OVERDUE", timeOfDay: "03:17", timezone: "Asia/Shanghai",
      createdByAccountId: admin.actor.accountId, updatedByAccountId: admin.actor.accountId,
    } });
    settingIds.push(activationSetting.id);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('management_system:project-management:cron'), hashtext('admin-global-summary'))`;
      await expect(runConfiguredProjectManagementReminders(new Date("2031-04-07T03:17:00+08:00"))).resolves.toMatchObject({ localDate: "2031-04-07" });
      expect(await prisma.adminGlobalSummaryRun.count({ where: { eventKey: scheduledEventKey } })).toBe(0);
      expect(await prisma.notificationOutbox.count({ where: { eventKey: `pm:task:${overdue.id}:activation_overdue:2031-04-07:${activationSetting.id}:feishu` } })).toBe(1);
    }, { timeout: 60_000 });
    const manual = await runAdminGlobalSummaryNow(admin.actor, { requestId: randomUUID() });
    expect(manual).toMatchObject({ status: "SUCCEEDED", trigger: "MANUAL" });
    await runConfiguredProjectManagementReminders(new Date("2031-04-07T03:18:00+08:00"));
    const scheduled = await prisma.adminGlobalSummaryRun.findUniqueOrThrow({ where: { eventKey: scheduledEventKey } });
    expect(scheduled).toMatchObject({ status: "SUCCEEDED", trigger: "SCHEDULED" });
    expect(scheduled.id).not.toBe(manual.id);
    const outboxes = await summaryOutboxes(scheduled.id);
    expect(outboxes.length).toBeGreaterThan(0);
    await runConfiguredProjectManagementReminders(new Date("2031-04-07T03:19:00+08:00"));
    expect(await prisma.adminGlobalSummaryRun.findUnique({ where: { eventKey: scheduledEventKey } })).toEqual(scheduled);
    expect((await summaryOutboxes(scheduled.id)).map((row) => row.id).sort()).toEqual(outboxes.map((row) => row.id).sort());
  } finally {
    for (const id of settingIds) await prisma.projectManagementReminderSetting.delete({ where: { id } });
  }
});

test("生成后撤权或停用会重新过滤飞书收件人，并拒绝读取原站内总结", async () => {
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const revoked = await createActor("PROJECT_ADMINISTRATOR");
  const inactive = await createActor("PROJECT_ADMINISTRATOR");
  const run = await runAdminGlobalSummaryNow(admin.actor, { requestId: randomUUID() });
  expect(run.status).toBe("SUCCEEDED");
  const outboxes = await summaryOutboxes(run.id);
  expect(outboxes.length).toBeGreaterThan(0);
  expect(await projectManagementNotificationChannel.resolveRecipientPlan(outboxes[0])).toMatchObject({
    supported: true, openIds: expect.arrayContaining([admin.openId, revoked.openId, inactive.openId]),
  });
  for (const recipient of [admin, revoked, inactive]) {
    expect(await prisma.inAppNotification.count({ where: { AND: [notificationReadableWhere(recipient.actor), { entityId: run.id }] } })).toBeGreaterThan(0);
  }
  await prisma.systemRoleAssignment.updateMany({ where: { accountId: revoked.actor.accountId }, data: { revokedAt: new Date() } });
  await prisma.person.update({ where: { id: inactive.actor.personId }, data: { status: "INACTIVE" } });
  for (const outbox of outboxes) {
    const plan = await projectManagementNotificationChannel.resolveRecipientPlan(outbox);
    expect(plan).toMatchObject({ supported: true, openIds: expect.arrayContaining([admin.openId]) });
    for (const recipient of [revoked, inactive]) expect(plan).toMatchObject({ openIds: expect.not.arrayContaining([recipient.openId]) });
  }
  for (const recipient of [revoked, inactive]) {
    expect(await prisma.inAppNotification.count({ where: { recipientAccountId: recipient.actor.accountId, entityId: run.id } })).toBeGreaterThan(0);
    expect(await prisma.inAppNotification.count({ where: { AND: [notificationReadableWhere(recipient.actor), { entityId: run.id }] } })).toBe(0);
  }
  expect(await prisma.inAppNotification.count({ where: { AND: [notificationReadableWhere(admin.actor), { entityId: run.id }] } })).toBeGreaterThan(0);
});

test("成功请求重试在入口检查后撤权，不返回历史正文也不改写成功记录", async () => {
  const admin = await createActor("SUPER_ADMINISTRATOR");
  await createActor("SUPER_ADMINISTRATOR");
  const input = { requestId: randomUUID() };
  const succeeded = await runAdminGlobalSummaryNow(admin.actor, input);
  expect(succeeded.status).toBe("SUCCEEDED");
  const before = await sideEffectCounts();
  const originalCount = prisma.account.count;
  prisma.account.count = ((...args: Parameters<typeof originalCount>) => originalCount(...args).then(async (result) => {
    await prisma.systemRoleAssignment.updateMany({ where: { accountId: admin.actor.accountId }, data: { revokedAt: new Date() } });
    return result;
  })) as typeof originalCount;
  try {
    await expect(runAdminGlobalSummaryNow(admin.actor, input)).rejects.toThrow(ProjectManagementAuthorizationError);
  } finally {
    prisma.account.count = originalCount;
  }
  expect(await prisma.adminGlobalSummaryRun.findUnique({ where: { id: succeeded.id } })).toEqual(succeeded);
  expect(await sideEffectCounts()).toEqual(before);
});

test("requestId 校验无副作用，相同请求复用记录，不同请求独立执行", async () => {
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const before = await sideEffectCounts();
  await expect(runAdminGlobalSummaryNow(admin.actor, { requestId: "invalid-request-id" })).rejects.toThrow();
  expect(await sideEffectCounts()).toEqual(before);
  const input = { requestId: randomUUID() };
  const first = await runAdminGlobalSummaryNow(admin.actor, input);
  expect(first.status).toBe("SUCCEEDED");
  const afterFirst = await sideEffectCounts();
  const replay = await runAdminGlobalSummaryNow(admin.actor, input);
  expect(replay).toMatchObject({ id: first.id, status: first.status, markdown: first.markdown, recipientCount: first.recipientCount });
  expect(await sideEffectCounts()).toEqual(afterFirst);
  expect((await summaryOutboxes(first.id)).length).toBeGreaterThan(0);
  const second = await runAdminGlobalSummaryNow(admin.actor, { requestId: randomUUID() });
  expect(second.status).toBe("SUCCEEDED");
  expect(second.id).not.toBe(first.id);
  const rows = await prisma.adminGlobalSummaryRun.findMany({ where: { id: { in: [first.id, second.id] } } });
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.eventKey)).size).toBe(2);
  expect((await sideEffectCounts()).runs).toBe(before.runs + 2);
  expect((await summaryOutboxes(second.id)).length).toBeGreaterThan(0);
});

test("内部定时入口按 slotKey 去重，不同槽位独立记录", async () => {
  await createActor("SUPER_ADMINISTRATOR");
  const before = await sideEffectCounts();
  const slotKey = `summary-test-${randomUUID()}`;
  const now = new Date();
  await runAdminGlobalSummary({ now, slotKey });
  const afterFirst = await sideEffectCounts();
  expect(afterFirst.runs).toBe(before.runs + 1);
  expect(afterFirst.outboxes).toBeGreaterThan(before.outboxes);
  await runAdminGlobalSummary({ now, slotKey });
  expect(await sideEffectCounts()).toEqual(afterFirst);
  await runAdminGlobalSummary({ now, slotKey: `${slotKey}-next` });
  const afterSecond = await sideEffectCounts();
  expect(afterSecond.runs).toBe(before.runs + 2);
  expect(afterSecond.outboxes).toBeGreaterThan(afterFirst.outboxes);
});

test("长总结仅发送有完整入口的单条摘要，重放不重复且持久化 Markdown 不截断", async () => {
  test.setTimeout(90_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const now = Date.now();
  const title = `分页总结任务 ${randomUUID()}`;
  const draft = await createTaskDraft(admin.actor, {
    title, description: "验证完整总结与通知分页", team: "英雄", techGroup: "电控", priority: "HIGH",
    members: [{ personId: admin.actor.personId, role: "OWNER" }],
    plannedStartAt: new Date(now - 86_400_000).toISOString(),
    milestones: Array.from({ length: 8 }, (_, index) => ({
      goal: `分页节点 ${index + 1} ${"长节点名称".repeat(200)}`,
      completionCriteria: "保留完整内容", expectedCompletedAt: new Date(now + (index + 1) * 86_400_000).toISOString(),
      reviewRequirements: "分页验收", businessDescription: "总结测试",
    })),
    termination: { name: "总结分页结束节点", plannedOutcomeCriteria: "全部验收", plannedAt: new Date(now + 10 * 86_400_000).toISOString(), businessDescription: "结束" },
    idempotencyKey: `summary-${randomUUID()}`,
  });
  await activateTask(admin.actor, { taskId: draft.taskId, expectedLockVersion: draft.lockVersion });
  for (let index = 0; index < 7; index += 1) {
    const extra = await createSummaryTask(admin, `长摘要补充任务 ${index}`);
    const current = extra.nodes.find((node) => node.status === "ACTIVE" && node.milestone);
    if (!current?.milestone) throw new Error("长摘要测试缺少进行中节点");
    await prisma.milestoneNode.update({ where: { id: current.milestone.id }, data: { goal: "长节点名称".repeat(200) } });
  }
  const input = { requestId: randomUUID() };
  const run = await runAdminGlobalSummaryNow(admin.actor, input);
  expect(run.status).toBe("SUCCEEDED");
  expect(run.markdown.length).toBeGreaterThan(6000);
  expect(run.markdown).toContain(title);
  expect(summaryTaskLines(run.markdown, title)).toContain("分页节点 1");
  expect(summaryTaskLines(run.markdown, title)).not.toContain("分页节点 8");
  expect(summaryTaskLines(run.markdown, title)).not.toContain("总结分页结束节点");
  const persisted = await prisma.adminGlobalSummaryRun.findUniqueOrThrow({ where: { id: run.id } });
  const outboxes = await summaryOutboxes(run.id);
  expect(outboxes).toHaveLength(1);
  expect(outboxes[0]).toMatchObject({ eventKey: `${persisted.eventKey}:part:1:feishu`, botKind: "notification", sentAt: null });
  const payload = projectManagementNotificationPayloadSchema.parse(JSON.parse(outboxes[0].payload));
  expect(payload.summary.length).toBeLessThanOrEqual(6000);
  expect(payload.summary).toContain("查看完整 Markdown 总结");
  expect(persisted.markdown).toBe(run.markdown);
  const replay = await runAdminGlobalSummaryNow(admin.actor, input);
  expect(replay.id).toBe(run.id);
  expect((await summaryOutboxes(run.id)).map((row) => row.id).sort()).toEqual(outboxes.map((row) => row.id).sort());
});

test("outbox 写入失败保留安全 FAILED 记录，通知和成功审计全部回滚", async () => {
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const input = { requestId: randomUUID() };
  const functionName = `test_summary_${randomUUID().replaceAll("-", "")}`;
  const triggerName = `test_summary_${randomUUID().replaceAll("-", "")}`;
  await prisma.$executeRaw(Prisma.sql`
    CREATE FUNCTION ${Prisma.raw(`"${functionName}"`)}() RETURNS trigger AS $$
    BEGIN
      IF NEW."type" = 'project_management_global_summary_daily' THEN
        RAISE EXCEPTION 'injected summary outbox failure';
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
    const failed = await runAdminGlobalSummaryNow(admin.actor, input);
    expect(failed.status).toBe("FAILED");
    expect(failed.recipientCount).toBe(0);
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.errorMessage).toMatch(/[\u4e00-\u9fff]/);
    expect(failed.errorMessage).not.toMatch(/injected|Prisma|SQL|stack/i);
    expect(await prisma.adminGlobalSummaryRun.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "FAILED", errorMessage: failed.errorMessage });
    expect(await summaryOutboxes(failed.id)).toHaveLength(0);
    expect(await prisma.inAppNotification.count({ where: { entityId: failed.id } })).toBe(0);
    expect(await prisma.domainAuditEvent.count({ where: { entityId: failed.id, action: "pm.admin_global_summary.executed" } })).toBe(0);
    expect(await listAdminGlobalSummaryRuns(admin.actor)).toEqual(expect.arrayContaining([expect.objectContaining({ id: failed.id, status: "FAILED" })]));
  } finally {
    await prisma.$executeRaw(Prisma.sql`DROP TRIGGER IF EXISTS ${Prisma.raw(`"${triggerName}"`)} ON "NotificationOutbox"`);
    await prisma.$executeRaw(Prisma.sql`DROP FUNCTION ${Prisma.raw(`"${functionName}"`)}()`);
  }
  expect((await runAdminGlobalSummaryNow(admin.actor, { requestId: randomUUID() })).status).toBe("SUCCEEDED");
});

test("管理员在桌面执行总结，最近 Markdown 记录刷新后保留", async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  await loginAsTestUser(context, baseURL, { openId: admin.openId, name: admin.name });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/progress/notifications?view=settings");
  await expect(page.getByRole("heading", { name: "管理员全局总结", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const before = await prisma.adminGlobalSummaryRun.count({ where: { actorAccountId: admin.actor.accountId } });
  const execute = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "管理员全局总结", exact: true }) }).getByRole("button", { name: "立即执行", exact: true });
  await expect(execute).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await execute.click();
  await expect.poll(() => prisma.adminGlobalSummaryRun.count({ where: { actorAccountId: admin.actor.accountId, status: "SUCCEEDED" } })).toBe(before + 1);
  const latest = await prisma.adminGlobalSummaryRun.findFirstOrThrow({ where: { actorAccountId: admin.actor.accountId }, orderBy: { startedAt: "desc" } });
  await page.locator("summary").filter({ hasText: "查看完整 Markdown" }).first().click();
  await expect(page.getByLabel("完整总结内容", { exact: true }).first()).toHaveText(latest.markdown);
  await expectHealthyPage(page);
  await page.reload();
  await page.locator("summary").filter({ hasText: "查看完整 Markdown" }).first().click();
  await expect(page.getByLabel("完整总结内容", { exact: true }).first()).toHaveText(latest.markdown);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("管理员增删改多个总结时间点，禁用不阻止确认后的立即执行", async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  await loginAsTestUser(context, baseURL, { openId: admin.openId, name: admin.name });
  await page.goto("/progress/notifications?view=settings");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "管理员全局总结", exact: true }) });
  const times = card.getByLabel("管理员全局总结时间", { exact: true });
  const initialCount = await times.count();
  const savedTimes = await prisma.projectManagementReminderSetting.findMany({ where: { kind: "ADMIN_GLOBAL_SUMMARY" } });
  expect(initialCount).toBe(savedTimes.length);
  await card.getByLabel("新增管理员全局总结时间", { exact: true }).fill("23:51");
  await card.getByRole("button", { name: "新增时间点", exact: true }).click();
  await expect(times).toHaveCount(initialCount + 1);
  await expect(times.last()).toHaveValue("23:51");
  await times.last().fill("23:52");
  await card.getByRole("button", { name: "编辑", exact: true }).last().click();
  await expect.poll(() => prisma.projectManagementReminderSetting.count({ where: { kind: "ADMIN_GLOBAL_SUMMARY", timeOfDay: "23:52" } })).toBe(1);
  await expect(times.last()).toHaveValue("23:52");
  const toggle = card.getByRole("checkbox", { name: "管理员全局总结总开关", exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(card.getByText("禁用", { exact: true })).toBeVisible();
  await expect.poll(() => prisma.projectManagementReminderSetting.count({ where: { kind: "ADMIN_GLOBAL_SUMMARY", enabled: true } })).toBe(0);
  const before = await prisma.adminGlobalSummaryRun.count({ where: { actorAccountId: admin.actor.accountId } });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("未启用");
    await dialog.accept();
  });
  await card.getByRole("button", { name: "立即执行", exact: true }).click();
  await expect.poll(() => prisma.adminGlobalSummaryRun.count({ where: { actorAccountId: admin.actor.accountId, status: "SUCCEEDED" } })).toBe(before + 1);
  await expect(toggle).toBeEnabled();
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toBeChecked();
  await expect(card.getByText("启用", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "删除", exact: true }).last().click();
  await expect(times).toHaveCount(initialCount);
  expect(await prisma.projectManagementReminderSetting.count({ where: { kind: "ADMIN_GLOBAL_SUMMARY", timeOfDay: "23:52" } })).toBe(0);
  await expectHealthyPage(page);
});

test("旧总结超过最近20条后仍可从通知打开全文，撤权后拒绝访问", async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const admin = await createActor("SUPER_ADMINISTRATOR");
  const run = await runAdminGlobalSummaryNow(admin.actor, { requestId: randomUUID() });
  expect(run.status).toBe("SUCCEEDED");
  await prisma.adminGlobalSummaryRun.createMany({ data: Array.from({ length: 21 }, (_, index) => ({
    eventKey: `summary-history-${randomUUID()}`, trigger: "SCHEDULED", status: "SUCCEEDED", markdown: "较新的执行记录",
    startedAt: new Date(run.startedAt.getTime() + index + 1), finishedAt: new Date(),
  })) });
  expect((await listAdminGlobalSummaryRuns(admin.actor)).map((record) => record.id)).not.toContain(run.id);
  const payload = projectManagementNotificationPayloadSchema.parse(JSON.parse((await summaryOutboxes(run.id))[0].payload));
  expect(payload.linkPath).toBe(`/progress/notifications/summaries/${run.id}`);
  await loginAsTestUser(context, baseURL, { openId: admin.openId, name: admin.name });
  await page.goto(payload.linkPath);
  await expect(page.getByLabel("完整总结内容")).toHaveText(run.markdown);
  await expectHealthyPage(page);
  await prisma.systemRoleAssignment.updateMany({ where: { accountId: admin.actor.accountId }, data: { revokedAt: new Date() } });
  await expect(getAdminGlobalSummaryRun(admin.actor, { id: run.id })).rejects.toThrow(ProjectManagementAuthorizationError);
  await page.reload();
  await expect(page.getByLabel("完整总结内容")).toHaveCount(0);
});

test("普通用户不能从设置页操作管理员全局总结", async ({ page, context, baseURL }) => {
  await createActor("SUPER_ADMINISTRATOR");
  const normal = await createActor();
  await loginAsTestUser(context, baseURL, { openId: normal.openId, name: normal.name });
  await page.goto("/progress/notifications?view=settings");
  await expect(page.getByRole("article").filter({ has: page.getByRole("heading", { name: "管理员全局总结", exact: true }) }).getByRole("button", { name: "立即执行", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("完整总结内容", { exact: true })).toHaveCount(0);
  await expectHealthyPage(page);
});

async function createActor(role?: AdministratorRole, team = "") {
  const openId = `ou_summary_${randomUUID()}`;
  const name = `总结测试 ${"长姓名".repeat(8)} ${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: { create: { provider: "FEISHU", tenantId: "default", providerSubject: `open:${openId}`, openId } },
      person: { create: { displayName: name, status: "ACTIVE" } },
      ...(role ? { systemRoles: { create: { role, team, techGroup: "", revokedAt: team ? new Date() : null } } } : {}),
    },
    include: { person: true, systemRoles: true },
  });
  if (!account.person) throw new Error("缺少总结测试人员");
  const actor: ProjectManagementActor = { accountId: account.id, personId: account.person.id, openId, unionId: null, systemRoles: account.systemRoles };
  return { actor, openId, name };
}

async function summaryOutboxes(runId: string) {
  const rows = await prisma.notificationOutbox.findMany({ where: { type: summaryKind } });
  return rows.filter((row) => projectManagementNotificationPayloadSchema.parse(JSON.parse(row.payload)).entityId === runId);
}

async function sideEffectCounts() {
  return {
    runs: await prisma.adminGlobalSummaryRun.count(),
    outboxes: await prisma.notificationOutbox.count({ where: { type: summaryKind } }),
    inApp: await prisma.inAppNotification.count({ where: { entityType: "AdminGlobalSummaryRun" } }),
    audits: await prisma.domainAuditEvent.count({ where: { action: "pm.admin_global_summary.executed" } }),
  };
}

async function createSummaryTask(
  owner: Awaited<ReturnType<typeof createActor>>,
  label: string,
  options: { active?: boolean; start?: Date; milestoneCount?: number } = {},
) {
  const now = Date.now();
  const title = `${label} ${randomUUID()}`;
  const draft = await createTaskDraft(owner.actor, {
    title, description: "管理员总结过滤回归", team: "英雄", techGroup: "电控", priority: "HIGH",
    members: [{ personId: owner.actor.personId, role: "OWNER" }],
    plannedStartAt: (options.start ?? new Date(now - 86_400_000)).toISOString(),
    milestones: Array.from({ length: options.milestoneCount ?? 2 }, (_, index) => ({
      goal: `${label}节点 ${index + 1}`, completionCriteria: "验收通过", expectedCompletedAt: new Date(now + (index + 1) * 86_400_000).toISOString(),
      reviewRequirements: "测试证据", businessDescription: "总结节点",
    })),
    termination: { name: `${label}结束节点`, plannedOutcomeCriteria: "全部完成", plannedAt: new Date(now + 5 * 86_400_000).toISOString(), businessDescription: "结束" },
    idempotencyKey: `summary-filter-${randomUUID()}`,
  });
  if (options.active !== false) await activateTask(owner.actor, { taskId: draft.taskId, expectedLockVersion: draft.lockVersion });
  return prisma.task.findUniqueOrThrow({ where: { id: draft.taskId }, include: { nodes: { include: { milestone: true, termination: true } } } });
}

async function createHistoricalMilestone(
  owner: Awaited<ReturnType<typeof createActor>>,
  task: Awaited<ReturnType<typeof createSummaryTask>>,
  goal: string,
) {
  const version = await prisma.taskPlanVersion.create({ data: { taskId: task.id, versionNo: 99, createdByAccountId: owner.actor.accountId } });
  const node = await prisma.taskNode.create({ data: {
    taskId: task.id, type: "MILESTONE", status: "PENDING", createdByAccountId: owner.actor.accountId,
    planVersionEntries: { create: { planVersionId: version.id, sequence: 1 } },
    milestone: { create: { goal, completionCriteria: "历史验收", expectedCompletedAt: new Date(), reviewRequirements: "历史证据" } },
  }, include: { milestone: true } });
  if (!node.milestone) throw new Error("缺少历史里程碑");
  return { milestone: node.milestone, planVersionId: version.id };
}

function approvalCount(markdown: string) {
  const match = markdown.match(/待审批：(\d+)/);
  if (!match) throw new Error("总结缺少待审批计数");
  return Number(match[1]);
}

function summaryTaskLines(markdown: string, title: string) {
  return markdown.split("\n").filter((line) => line.startsWith("| ") && line.includes(title)).join("\n");
}

test("管理员总结迁移重复部署幂等且隔离数据库与 Prisma schema 无漂移", () => {
  test.setTimeout(300_000);
  assertOfficialPlaywrightEnvironment(process.env);
  const env = { ...process.env, NOTIFICATION_DELIVERY_DISABLED: "true" };
  for (const [command, args] of [
    ["npm", ["run", "db:deploy"]],
    ["npx", ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"]],
  ] as const) {
    const result = spawnSync(command, [...args], { env, encoding: "utf8", timeout: 120_000 });
    expect(result.error, `${command} ${args.join(" ")}`).toBeUndefined();
    expect(result.signal, `${command} ${args.join(" ")}`).toBeNull();
    expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
  }
});
