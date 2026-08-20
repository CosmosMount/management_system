import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";
import { createAsyncOperationGeneration } from "../lib/async-operation-generation";
import { parseBudgetPoolsFromBuffer } from "../lib/import-procurement-budget";
import { persistBudgetPoolImport } from "../lib/procurement-budget-import-service";
import { listBudgetPoolViews } from "../lib/procurement-budget";
import {
  enqueueOrderNotificationTx,
} from "../lib/notification-producers/procurement";
import { enqueueFeedbackReplyNotificationTx } from "../lib/notification-producers/feedback";
import {
  reconcileOutboxRecipients,
  resetNotificationOutboxForRetry,
} from "../lib/notification-outbox";
import { prisma } from "../lib/prisma";

test.describe.configure({ mode: "serial" });

test("已取消的异步解析不能覆盖后续状态", () => {
  const generation = createAsyncOperationGeneration();
  const obsolete = generation.begin();
  generation.cancel();
  const current = generation.begin();

  expect(generation.isCurrent(obsolete)).toBe(false);
  expect(generation.isCurrent(current)).toBe(true);
});

test("预算文件混有无效行时保留错误并原子写入有效行", async ({}, testInfo) => {
  const suffix = randomUUID().replaceAll("-", "");
  const period = `partial-${testInfo.project.name}-${suffix}`;
  const sheet = XLSX.utils.aoa_to_sheet([
    ["项目", "车组", "技术组", "预算", "周期"],
    ["有效预算", "英雄", "机械", 200, period],
    ["错误预算", "不存在车组", "机械", 300, period],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "预算池");
  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Buffer;
  const parsed = parseBudgetPoolsFromBuffer(Uint8Array.from(buffer).buffer);

  expect(parsed.rows).toHaveLength(1);
  expect(parsed.errors).toEqual([
    { row: 3, message: "无效兵种组：不存在车组" },
  ]);
  try {
    await expect(persistBudgetPoolImport(parsed.rows, "append")).resolves.toBe(1);
    await expect(
      prisma.procurementBudgetPool.findMany({
        where: { period },
        select: { description: true, budgetAmount: true },
      }),
    ).resolves.toEqual([{ description: "有效预算", budgetAmount: 200 }]);
  } finally {
    await prisma.procurementBudgetPool.deleteMany({ where: { period } });
  }
});

test("追加兵种组预算时规范行覆盖同项目旧技术方向且不重复累计", async ({}, testInfo) => {
  const period = `legacy-append-${testInfo.project.name}-${randomUUID()}`;
  try {
    await prisma.procurementBudgetPool.create({
      data: {
        description: "第一版整车",
        team: "英雄",
        techGroup: "机械",
        period,
        budgetAmount: 100,
      },
    });
    await expect(
      persistBudgetPoolImport(
        [
          {
            description: "第一版整车",
            team: "英雄",
            techGroup: "旧调用方也会被规范化",
            period,
            budgetAmount: 120,
          },
        ],
        "append",
      ),
    ).resolves.toBe(1);

    await expect(listBudgetPoolViews(period)).resolves.toMatchObject([
      {
        team: "英雄",
        projects: ["第一版整车"],
        budgetAmount: 120,
      },
    ]);
    await expect(
      prisma.procurementBudgetPool.findMany({
        where: { period },
        orderBy: { techGroup: "asc" },
        select: { techGroup: true, budgetAmount: true },
      }),
    ).resolves.toEqual([
      { techGroup: "", budgetAmount: 120 },
      { techGroup: "机械", budgetAmount: 100 },
    ]);
  } finally {
    await prisma.procurementBudgetPool.deleteMany({ where: { period } });
  }
});

test("预算覆盖导入中途失败时保留原周期数据", async ({}, testInfo) => {
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `test_budget_import_fail_${suffix}`;
  const triggerName = `test_budget_import_fail_trigger_${suffix}`;
  const period = `atomic-${testInfo.project.name}-${suffix}`;

  await prisma.procurementBudgetPool.create({
    data: {
      description: "原预算",
      team: "英雄",
      techGroup: "机械",
      period,
      budgetAmount: 100,
    },
  });
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."period" = '${period}' AND NEW."description" = '触发失败' THEN
          RAISE EXCEPTION 'injected budget import failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT OR UPDATE ON "ProcurementBudgetPool"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    await expect(
      persistBudgetPoolImport(
        [
          {
            description: "新预算",
            team: "英雄",
            techGroup: "机械",
            period,
            budgetAmount: 200,
          },
          {
            description: "触发失败",
            team: "英雄",
            techGroup: "机械",
            period,
            budgetAmount: 300,
          },
        ],
        "replace",
      ),
    ).rejects.toThrow("injected budget import failure");

    const rows = await prisma.procurementBudgetPool.findMany({
      where: { period },
      select: { description: true, budgetAmount: true },
    });
    expect(rows).toEqual([{ description: "原预算", budgetAmount: 100 }]);
  } finally {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${triggerName}" ON "ProcurementBudgetPool"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS "${functionName}"()`,
    );
    await prisma.procurementBudgetPool.deleteMany({ where: { period } });
  }
});

test("同周期预算导入会等待事务锁，避免并发覆盖交错", async ({}, testInfo) => {
  const period = `locked-${testInfo.project.name}-${randomUUID()}`;
  let releaseBlocker = () => {};
  let markBlockerReady = () => {};
  const blockerRelease = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const blockerReady = new Promise<void>((resolve) => {
    markBlockerReady = resolve;
  });
  const blocker = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${`procurement-budget-import:${period}`})
      )
    `;
    markBlockerReady();
    await blockerRelease;
  });

  try {
    await blockerReady;
    const imported = persistBudgetPoolImport(
      [
        {
          description: "并发预算",
          team: "英雄",
          techGroup: "机械",
          period,
          budgetAmount: 200,
        },
      ],
      "replace",
    );
    const outcome = await Promise.race([
      imported.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 100);
      }),
    ]);
    expect(outcome).toBe("blocked");

    releaseBlocker();
    await Promise.all([blocker, imported]);
    await expect(
      prisma.procurementBudgetPool.count({ where: { period } }),
    ).resolves.toBe(1);
  } finally {
    releaseBlocker();
    await blocker;
    await prisma.procurementBudgetPool.deleteMany({ where: { period } });
  }
});

test("并发覆盖同周期后只保留一份完整导入集合", async ({}, testInfo) => {
  const period = `replace-race-${testInfo.project.name}-${randomUUID()}`;
  const makeRows = (prefix: string) =>
    ["机械", "电控"].map((techGroup, index) => ({
      description: `${prefix}-${index + 1}`,
      team: "英雄",
      techGroup,
      period,
      budgetAmount: 100 + index,
    }));
  try {
    await Promise.all([
      persistBudgetPoolImport(makeRows("A"), "replace"),
      persistBudgetPoolImport(makeRows("B"), "replace"),
    ]);
    const descriptions = await prisma.procurementBudgetPool.findMany({
      where: { period },
      orderBy: { description: "asc" },
      select: { description: true },
    });
    expect([
      [{ description: "A-1" }, { description: "A-2" }],
      [{ description: "B-1" }, { description: "B-2" }],
    ]).toContainEqual(descriptions);
  } finally {
    await prisma.procurementBudgetPool.deleteMany({ where: { period } });
  }
});

test("反序多周期并发覆盖不会死锁或跨导入混合", async ({}, testInfo) => {
  const suffix = `${testInfo.project.name}-${randomUUID()}`;
  const periods = [`multi-a-${suffix}`, `multi-b-${suffix}`];
  const makeRows = (prefix: string, orderedPeriods: string[]) =>
    orderedPeriods.map((period, index) => ({
      description: `${prefix}-${index + 1}`,
      team: "英雄",
      techGroup: "机械",
      period,
      budgetAmount: 200 + index,
    }));
  try {
    await Promise.race([
      Promise.all([
        persistBudgetPoolImport(makeRows("A", periods), "replace"),
        persistBudgetPoolImport(makeRows("B", [...periods].reverse()), "replace"),
      ]),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("多周期并发导入超时")), 5_000);
      }),
    ]);
    const descriptions = await prisma.procurementBudgetPool.findMany({
      where: { period: { in: periods } },
      orderBy: { period: "asc" },
      select: { description: true },
    });
    expect([
      [{ description: "A-1" }, { description: "A-2" }],
      [{ description: "B-2" }, { description: "B-1" }],
    ]).toContainEqual(descriptions);
  } finally {
    await prisma.procurementBudgetPool.deleteMany({
      where: { period: { in: periods } },
    });
  }
});

test("事务内会拒绝已撤销超级管理员覆盖预算", async ({}, testInfo) => {
  const suffix = `${testInfo.project.name}-${randomUUID()}`;
  const openId = `ou_revoked_budget_admin_${suffix}`;
  const period = `revoked-budget-${suffix}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: {
        create: { displayName: "已撤权预算管理员", status: "ACTIVE" },
      },
      systemRoles: {
        create: {
          role: "SUPER_ADMINISTRATOR",
          team: "",
          techGroup: "",
          revokedAt: new Date(),
        },
      },
    },
  });
  try {
    await expect(
      persistBudgetPoolImport(
        [{
          description: "不得写入的预算",
          team: "英雄",
          techGroup: "",
          period,
          budgetAmount: 100,
        }],
        "replace",
        { accountId: account.id, openId },
      ),
    ).rejects.toThrow("无管理权限");
    await expect(
      prisma.procurementBudgetPool.count({ where: { period } }),
    ).resolves.toBe(0);
  } finally {
    await prisma.systemRoleAssignment.deleteMany({
      where: { accountId: account.id },
    });
    await prisma.accountIdentity.deleteMany({
      where: { accountId: account.id },
    });
    await prisma.person.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } });
  }
});

test("老师审核状态与邮件 outbox 可在同一事务持久化", async () => {
  const eventKey = `test:teacher-email-outbox:${randomUUID()}`;
  try {
    await prisma.$transaction(async (tx) => {
      await enqueueOrderNotificationTx(
        tx,
        eventKey,
        {
          id: randomUUID(),
          orderNo: "TEST-TEACHER-EMAIL",
          initiatorName: "测试申请人",
          totalPrice: 10,
          status: "TEACHER_REVIEW",
          statusEnteredAt: new Date(),
          team: "英雄",
          techGroup: "机械",
        },
        { appOrigin: "http://127.0.0.1:3000" },
      );
    });

    const rows = await prisma.notificationOutbox.findMany({
      where: { eventKey: { startsWith: eventKey } },
      orderBy: { eventKey: "asc" },
      select: { eventKey: true, channel: true, status: true, type: true },
    });
    expect(rows).toEqual([
      {
        eventKey,
        channel: "procurement",
        status: "PENDING",
        type: "order",
      },
      {
        eventKey: `${eventKey}:teacher_email`,
        channel: "email",
        status: "PENDING",
        type: "teacher_review_email",
      },
    ]);
  } finally {
    await prisma.notificationOutbox.deleteMany({
      where: { eventKey: { startsWith: eventKey } },
    });
  }
});

test("收件人角色变化会取消尚未发送的旧 recipient", async () => {
  const eventKey = `test:recipient-reconciliation:${randomUUID()}`;
  const outbox = await prisma.notificationOutbox.create({
    data: {
      eventKey,
      channel: "email",
      type: "teacher_review_email",
      payload: "{}",
    },
  });
  try {
    await reconcileOutboxRecipients(outbox.id, ["ou_old"]);
    await reconcileOutboxRecipients(outbox.id, ["ou_current"]);
    const recipients = await prisma.notificationOutboxRecipient.findMany({
      where: { outboxId: outbox.id },
      orderBy: { openId: "asc" },
      select: { openId: true, status: true },
    });
    expect(recipients).toEqual([
      { openId: "ou_current", status: "PENDING" },
      { openId: "ou_old", status: "CANCELED" },
    ]);
  } finally {
    await prisma.notificationOutbox.deleteMany({ where: { eventKey } });
  }
});

test("收件人协调不会取消租约仍有效的投递", async () => {
  const eventKey = `test:recipient-active-lease:${randomUUID()}`;
  const outbox = await prisma.notificationOutbox.create({
    data: {
      eventKey,
      channel: "email",
      type: "teacher_review_email",
      payload: "{}",
    },
  });
  try {
    await prisma.notificationOutboxRecipient.createMany({
      data: [
        {
          outboxId: outbox.id,
          openId: "ou_active",
          status: "PROCESSING",
          lockedUntil: new Date(Date.now() + 60_000),
        },
        {
          outboxId: outbox.id,
          openId: "ou_expired",
          status: "PROCESSING",
          lockedUntil: new Date(Date.now() - 60_000),
        },
        {
          outboxId: outbox.id,
          openId: "ou_pending",
          status: "PENDING",
        },
      ],
    });

    await reconcileOutboxRecipients(outbox.id, []);
    const recipients = await prisma.notificationOutboxRecipient.findMany({
      where: { outboxId: outbox.id },
      orderBy: { openId: "asc" },
      select: { openId: true, status: true },
    });
    expect(recipients).toEqual([
      { openId: "ou_active", status: "PROCESSING" },
      { openId: "ou_expired", status: "CANCELED" },
      { openId: "ou_pending", status: "CANCELED" },
    ]);
  } finally {
    await prisma.notificationOutbox.deleteMany({ where: { eventKey } });
  }
});

test("管理员回复自己提交的反馈时不创建零收件人 outbox", async () => {
  const eventKey = `test:feedback-self-reply:${randomUUID()}`;
  try {
    const result = await prisma.$transaction((tx) =>
      enqueueFeedbackReplyNotificationTx(
        tx,
        eventKey,
        {
          feedbackId: randomUUID(),
          actorName: "测试管理员",
          actorIsAdmin: true,
          recipientOpenIds: [],
          body: "自回复",
        },
        { appOrigin: "http://127.0.0.1:3000" },
      ),
    );
    expect(result).toEqual({ created: false });
    await expect(
      prisma.notificationOutbox.count({ where: { eventKey } }),
    ).resolves.toBe(0);
  } finally {
    await prisma.notificationOutbox.deleteMany({ where: { eventKey } });
  }
});

test("手动重试不会恢复已撤权的收件人", async () => {
  const eventKey = `test:canceled-recipient-retry:${randomUUID()}`;
  const outbox = await prisma.notificationOutbox.create({
    data: {
      eventKey,
      channel: "email",
      type: "teacher_review_email",
      payload: "{}",
      status: "FAILED",
    },
  });
  try {
    await prisma.notificationOutboxRecipient.createMany({
      data: [
        {
          outboxId: outbox.id,
          openId: "ou_retry",
          status: "FAILED",
        },
        {
          outboxId: outbox.id,
          openId: "ou_revoked",
          status: "CANCELED",
        },
      ],
    });

    await resetNotificationOutboxForRetry({
      id: outbox.id,
      channel: "email",
      type: "teacher_review_email",
    });

    const recipients = await prisma.notificationOutboxRecipient.findMany({
      where: { outboxId: outbox.id },
      orderBy: { openId: "asc" },
      select: { openId: true, status: true },
    });
    expect(recipients).toEqual([
      { openId: "ou_retry", status: "PENDING" },
      { openId: "ou_revoked", status: "CANCELED" },
    ]);
  } finally {
    await prisma.notificationOutbox.deleteMany({ where: { eventKey } });
  }
});

test("收件人重新取得资格后由重新计算结果恢复投递", async () => {
  const eventKey = `test:recipient-regranted:${randomUUID()}`;
  const outbox = await prisma.notificationOutbox.create({
    data: {
      eventKey,
      channel: "email",
      type: "teacher_review_email",
      payload: "{}",
    },
  });
  try {
    await reconcileOutboxRecipients(outbox.id, ["ou_teacher"]);
    await reconcileOutboxRecipients(outbox.id, []);
    await reconcileOutboxRecipients(outbox.id, ["ou_teacher"]);

    await expect(
      prisma.notificationOutboxRecipient.findUnique({
        where: {
          outboxId_openId: {
            outboxId: outbox.id,
            openId: "ou_teacher",
          },
        },
        select: { status: true, attempts: true, lastError: true },
      }),
    ).resolves.toEqual({ status: "PENDING", attempts: 0, lastError: "" });
  } finally {
    await prisma.notificationOutbox.deleteMany({ where: { eventKey } });
  }
});
