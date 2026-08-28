import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  drainNotificationOutbox,
  drainNotificationOutboxSoon,
} from "../lib/notification-delivery";
import { enqueueNotification } from "../lib/notification-outbox";
import { getGlobalSuperAdministratorOpenIds } from "../lib/account-authorization";
import { feedbackNotificationChannel } from "../lib/notification-channels/feedback";
import { projectManagementNotificationChannel } from "../lib/notification-channels/project-management";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import type { ProjectManagementNotificationPayload } from "../lib/project-management/notifications/contract";
import { prisma } from "../lib/prisma";
import { withGlobalApprovalAdministratorGuardDisabled } from "./helpers/global-approval-administrator-guard";

const EVENT_PREFIX = "playwright:notification-adapter:";
const ACTIVE_RECIPIENT_OPEN_IDS = [
  "ou_outbox_success",
  "ou_outbox_retry",
  "ou_outbox_wrong_bot",
  "ou_outbox_link_approval",
] as const;
const originalFeedbackRecipientResolver =
  feedbackNotificationChannel.resolveRecipientPlan;
let revisionFixtureAdministratorAccountId: string | null = null;
const revisionFixtureTaskIds: string[] = [];

test.describe.configure({ mode: "serial" });

test.describe("notification outbox channel adapters", () => {
  const originalFetch = globalThis.fetch;
  const originalDeliveryDisabled = process.env.NOTIFICATION_DELIVERY_DISABLED;
  const originalAllowedOpenIds =
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS;
  const originalAllowedUnionIds =
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS;
  const originalAllowedNames = process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES;
  const originalNotificationAppId = process.env.FEISHU_NOTIFICATION_APP_ID;
  const originalNotificationAppSecret =
    process.env.FEISHU_NOTIFICATION_APP_SECRET;
  const originalApprovalAppId = process.env.FEISHU_APPROVAL_APP_ID;
  const originalApprovalAppSecret = process.env.FEISHU_APPROVAL_APP_SECRET;
  const originalProcurementWebhookUrl =
    process.env.FEISHU_PROCUREMENT_WEBHOOK_URL;
  const originalProcurementWebhookSecret =
    process.env.FEISHU_PROCUREMENT_WEBHOOK_SECRET;
  const originalTestLockMs = process.env.NOTIFICATION_OUTBOX_TEST_LOCK_MS;
  let sendAttempts: string[];
  let webhookAttempts: number;
  let failRecipientOnce: string | null;
  let authResponses: Array<Record<string, unknown>>;
  let authAppIds: string[];
  let directMessageBodies: Array<Record<string, unknown>>;
  let cardKitCards: Array<Record<string, unknown>>;

  test.beforeEach(async () => {
    assertTestDatabase();
    await prisma.notificationOutbox.deleteMany();
    await Promise.all(
      ACTIVE_RECIPIENT_OPEN_IDS.map(ensureActiveFeishuRecipient),
    );
    process.env.NOTIFICATION_DELIVERY_DISABLED = "false";
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS =
      "ou_outbox_success,ou_outbox_retry,ou_outbox_wrong_bot,ou_outbox_link_approval";
    delete process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS;
    delete process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES;
    process.env.FEISHU_NOTIFICATION_APP_ID = "notification-app";
    process.env.FEISHU_NOTIFICATION_APP_SECRET = "notification-secret";
    delete process.env.FEISHU_APPROVAL_APP_ID;
    delete process.env.FEISHU_APPROVAL_APP_SECRET;
    process.env.FEISHU_PROCUREMENT_WEBHOOK_URL =
      "https://open.feishu.cn/open-apis/bot/v2/hook/mock-outbox";
    delete process.env.FEISHU_PROCUREMENT_WEBHOOK_SECRET;
    sendAttempts = [];
    webhookAttempts = 0;
    failRecipientOnce = null;
    authResponses = [];
    authAppIds = [];
    directMessageBodies = [];
    cardKitCards = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/auth/v3/app_access_token/internal")) {
        const body = JSON.parse(String(init?.body)) as { app_id: string };
        authAppIds.push(body.app_id);
        return jsonResponse(
          authResponses.shift() ?? {
            code: 0,
            tenant_access_token: "mock-token",
          },
        );
      }
      if (url.endsWith("/cardkit/v1/cards")) {
        const body = JSON.parse(String(init?.body)) as { data: string };
        cardKitCards.push(JSON.parse(body.data) as Record<string, unknown>);
        return jsonResponse({
          code: 0,
          data: { card_id: `outbox-card-${cardKitCards.length}` },
        });
      }
      if (url.includes("/im/v1/messages")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
          receive_id: string;
        };
        directMessageBodies.push(body);
        sendAttempts.push(body.receive_id);
        if (failRecipientOnce === body.receive_id) {
          failRecipientOnce = null;
          return jsonResponse({ code: 500, msg: "temporary failure" });
        }
        return jsonResponse({ code: 0, msg: "ok" });
      }
      if (url.includes("/bot/v2/hook/mock-outbox")) {
        webhookAttempts += 1;
        return jsonResponse({ code: 0, msg: "ok" });
      }
      throw new Error(`测试捕获到未 mock 的请求: ${url}`);
    }) as typeof fetch;
  });

  test.afterEach(async () => {
    globalThis.fetch = originalFetch;
    feedbackNotificationChannel.resolveRecipientPlan =
      originalFeedbackRecipientResolver;
    restoreEnv(
      "NOTIFICATION_DELIVERY_DISABLED",
      originalDeliveryDisabled,
    );
    restoreEnv(
      "FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS",
      originalAllowedOpenIds,
    );
    restoreEnv(
      "FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS",
      originalAllowedUnionIds,
    );
    restoreEnv(
      "FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES",
      originalAllowedNames,
    );
    restoreEnv("FEISHU_NOTIFICATION_APP_ID", originalNotificationAppId);
    restoreEnv(
      "FEISHU_NOTIFICATION_APP_SECRET",
      originalNotificationAppSecret,
    );
    restoreEnv("FEISHU_APPROVAL_APP_ID", originalApprovalAppId);
    restoreEnv("FEISHU_APPROVAL_APP_SECRET", originalApprovalAppSecret);
    restoreEnv(
      "FEISHU_PROCUREMENT_WEBHOOK_URL",
      originalProcurementWebhookUrl,
    );
    restoreEnv(
      "FEISHU_PROCUREMENT_WEBHOOK_SECRET",
      originalProcurementWebhookSecret,
    );
    restoreEnv("NOTIFICATION_OUTBOX_TEST_LOCK_MS", originalTestLockMs);
    await prisma.notificationOutbox.deleteMany({
      where: { eventKey: { startsWith: EVENT_PREFIX } },
    });
    await prisma.procurementFeishuCard.deleteMany({
      where: { orderId: { startsWith: "outbox-adapter-order-" } },
    });
    await prisma.userRole.deleteMany({
      where: { openId: "ou_outbox_approver" },
    });
    await prisma.user.deleteMany({
      where: {
        openId: { in: ["ou_outbox_approver", "ou_outbox_link_approval"] },
      },
    });
  });

  test.afterAll(async () => {
    assertTestDatabase();
    const identities = await prisma.accountIdentity.findMany({
      where: {
        provider: "FEISHU",
        tenantId: "default",
        openId: { in: [...ACTIVE_RECIPIENT_OPEN_IDS] },
      },
      select: { accountId: true },
    });
    const accountIds = [...new Set(identities.map(({ accountId }) => accountId))];
    await withGlobalApprovalAdministratorGuardDisabled(async () => {
      if (revisionFixtureTaskIds.length > 0) {
        await prisma.task.updateMany({
          where: { id: { in: revisionFixtureTaskIds } },
          data: { deletedAt: new Date() },
        });
      }
      if (revisionFixtureAdministratorAccountId) {
        await prisma.systemRoleAssignment.deleteMany({
          where: { accountId: revisionFixtureAdministratorAccountId },
        });
      }
      if (accountIds.length === 0) return;
      await prisma.$transaction([
        prisma.accountIdentity.deleteMany({
          where: { accountId: { in: accountIds } },
        }),
        prisma.person.deleteMany({ where: { accountId: { in: accountIds } } }),
        prisma.account.deleteMany({ where: { id: { in: accountIds } } }),
      ]);
    });
  });

  test("event key 幂等且收件人去重，失败收件人重试不重复成功收件人", async () => {
    const eventKey = `${EVENT_PREFIX}dedupe-retry`;
    const payload = {
      kind: "reply",
      payload: {
        feedbackId: "feedback-test",
        actorName: "测试管理员",
        body: "请查看处理结果",
        recipientOpenIds: [
          "ou_outbox_success",
          "ou_outbox_retry",
          "ou_outbox_success",
          "",
        ],
        actorIsAdmin: true,
      },
      appOrigin: "http://127.0.0.1:3002",
    };

    expect(
      await enqueueNotification({
        eventKey,
        channel: "feedback",
        type: "reply",
        payload,
      }),
    ).toEqual({ created: true });
    expect(
      await enqueueNotification({
        eventKey,
        channel: "feedback",
        type: "reply",
        payload,
      }),
    ).toEqual({ created: false });

    failRecipientOnce = "ou_outbox_retry";
    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);

    const failed = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: { orderBy: { openId: "asc" } } },
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.recipients).toHaveLength(2);
    expect(
      failed.recipients.map((recipient) => ({
        openId: recipient.openId,
        status: recipient.status,
        attempts: recipient.attempts,
      })),
    ).toEqual([
      { openId: "ou_outbox_retry", status: "FAILED", attempts: 1 },
      { openId: "ou_outbox_success", status: "SENT", attempts: 1 },
    ]);

    await prisma.$transaction([
      prisma.notificationOutbox.update({
        where: { id: failed.id },
        data: { nextRunAt: new Date(0) },
      }),
      prisma.notificationOutboxRecipient.updateMany({
        where: { outboxId: failed.id, status: "FAILED" },
        data: { nextRunAt: new Date(0) },
      }),
    ]);
    sendAttempts = [];

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    expect(sendAttempts).toEqual(["ou_outbox_retry"]);

    const sent = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: { orderBy: { openId: "asc" } } },
    });
    expect(sent.status).toBe("SENT");
    expect(sent.recipients.map((recipient) => recipient.attempts)).toEqual([
      2,
      1,
    ]);
  });

  test("无效 payload 与未知 channel 被标记失败且不会请求飞书", async () => {
    const invalidKey = `${EVENT_PREFIX}invalid-payload`;
    const unknownKey = `${EVENT_PREFIX}unknown-channel`;
    await enqueueNotification({
      eventKey: invalidKey,
      channel: "procurement",
      type: "order",
      payload: { kind: "order", order: { id: "missing-required-fields" } },
    });
    await enqueueNotification({
      eventKey: unknownKey,
      channel: "unknown",
      type: "unknown",
      payload: {},
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    const rows = await prisma.notificationOutbox.findMany({
      where: { eventKey: { in: [invalidKey, unknownKey] } },
      orderBy: { eventKey: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "FAILED")).toBe(true);
    expect(rows.every((row) => row.attempts === 8)).toBe(true);
    expect(
      rows.some((row) => row.lastError.includes("未知通知通道")),
    ).toBe(true);
    expect(sendAttempts).toEqual([]);
  });

  test("反馈 adapter 拒绝审批机器人并终止错误配置", async () => {
    const eventKey = `${EVENT_PREFIX}wrong-bot`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      botKind: "approval",
      type: "status",
      payload: {
        kind: "status",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          status: "CLOSED",
          submitterOpenId: "ou_outbox_wrong_bot",
        },
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(8);
    expect(row.lastError).toContain("反馈通知不得使用审批机器人");
    expect(row.recipients).toHaveLength(0);
    expect(sendAttempts).toEqual([]);
  });

  test("反馈状态通知使用明确的待处理文案", async () => {
    const eventKey = `${EVENT_PREFIX}feedback-open-copy`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "status",
      payload: {
        kind: "status",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          status: "OPEN",
          submitterOpenId: "ou_outbox_success",
        },
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    expect(sendAttempts).toEqual(["ou_outbox_success"]);
    const serializedMessages = JSON.stringify(directMessageBodies);
    expect(serializedMessages).toContain("当前状态**：待处理");
    expect(serializedMessages).not.toContain("当前状态**：开放");
  });

  test("损坏的 type 和 botKind 元数据会终止失败且不发送", async () => {
    const mismatchedTypeKey = `${EVENT_PREFIX}mismatched-type`;
    const invalidBotKey = `${EVENT_PREFIX}invalid-bot`;
    const payload = {
      kind: "status",
      payload: {
        feedbackId: "feedback-test",
        actorName: "测试管理员",
        status: "CLOSED",
        submitterOpenId: "ou_outbox_success",
      },
    };
    await enqueueNotification({
      eventKey: mismatchedTypeKey,
      channel: "feedback",
      type: "reply",
      payload,
    });
    await enqueueNotification({
      eventKey: invalidBotKey,
      channel: "feedback",
      type: "status",
      payload,
    });
    await prisma.notificationOutbox.update({
      where: { eventKey: invalidBotKey },
      data: { botKind: "damaged-bot-kind" },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    const rows = await prisma.notificationOutbox.findMany({
      where: { eventKey: { in: [mismatchedTypeKey, invalidBotKey] } },
      include: { recipients: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "FAILED")).toBe(true);
    expect(rows.every((row) => row.attempts === 8)).toBe(true);
    expect(rows.every((row) => row.recipients.length === 0)).toBe(true);
    expect(rows.map((row) => row.lastError).join("\n")).toContain(
      "元数据不一致",
    );
    expect(rows.map((row) => row.lastError).join("\n")).toContain(
      "机器人类型无效",
    );
    expect(sendAttempts).toEqual([]);
  });

  test("首次收件人解析失败后可重试恢复", async () => {
    const eventKey = `${EVENT_PREFIX}recipient-resolution-retry`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          body: "解析恢复测试",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });
    let failOnce = true;
    feedbackNotificationChannel.resolveRecipientPlan = async (row) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("temporary recipient lookup failure");
      }
      return originalFeedbackRecipientResolver(row);
    };

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    const failed = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(failed.recipients).toHaveLength(0);

    await prisma.notificationOutbox.update({
      where: { eventKey },
      data: { nextRunAt: new Date(0) },
    });
    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    const sent = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(sent.status).toBe("SENT");
    expect(sent.recipients).toMatchObject([
      { openId: "ou_outbox_success", status: "SENT" },
    ]);
  });

  test("过期 outbox 与收件人锁会恢复投递", async () => {
    const eventKey = `${EVENT_PREFIX}expired-lock`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          body: "锁恢复测试",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
    });
    await prisma.$transaction([
      prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: "PROCESSING", lockedUntil: new Date(0) },
      }),
      prisma.notificationOutboxRecipient.create({
        data: {
          outboxId: row.id,
          openId: "ou_outbox_success",
          status: "PROCESSING",
          attempts: 1,
          lockedUntil: new Date(0),
          nextRunAt: new Date(0),
        },
      }),
    ]);

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    const sent = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(sent.status).toBe("SENT");
    expect(sent.recipients).toMatchObject([
      { status: "SENT", attempts: 2 },
    ]);
    expect(sendAttempts).toEqual(["ou_outbox_success"]);
  });

  test("扫描后旧 worker 续租时不会被新 claim 覆盖", async () => {
    const eventKey = `${EVENT_PREFIX}scan-renew-race`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          body: "扫描续租竞态",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });
    const row = await prisma.notificationOutbox.update({
      where: { eventKey },
      data: { status: "PROCESSING", attempts: 1, lockedUntil: new Date(0) },
    });
    const delegate = prisma.notificationOutbox as typeof prisma.notificationOutbox & {
      updateMany: typeof prisma.notificationOutbox.updateMany;
    };
    const originalUpdateMany = delegate.updateMany.bind(delegate);
    const replacementLock = new Date(Date.now() + 60_000);
    let intercepted = false;
    delegate.updateMany = (async (args) => {
      if (!intercepted) {
        intercepted = true;
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: { lockedUntil: replacementLock },
        });
      }
      return originalUpdateMany(args);
    }) as typeof delegate.updateMany;
    try {
      await expect(
        drainNotificationOutbox(1, { ignoreDeliveryDisabled: true }),
      ).resolves.toBe(0);
      await expect(
        prisma.notificationOutbox.findUniqueOrThrow({
          where: { id: row.id },
          select: { status: true, attempts: true, lockedUntil: true },
        }),
      ).resolves.toEqual({
        status: "PROCESSING",
        attempts: 1,
        lockedUntil: replacementLock,
      });
      expect(sendAttempts).toEqual([]);
    } finally {
      delegate.updateMany = originalUpdateMany as typeof delegate.updateMany;
    }
  });

  test("外部发送超过初始租约时心跳阻止第二 worker 重复发送", async () => {
    process.env.NOTIFICATION_OUTBOX_TEST_LOCK_MS = "200";
    const eventKey = `${EVENT_PREFIX}delivery-heartbeat`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          body: "长发送租约心跳",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });
    const forwardingFetch = globalThis.fetch;
    let releaseSend = () => {};
    let markSendStarted = () => {};
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("/im/v1/messages")) {
        markSendStarted();
        await sendRelease;
      }
      return forwardingFetch(input, init);
    }) as typeof fetch;
    const firstDrain = drainNotificationOutbox(1, {
      ignoreDeliveryDisabled: true,
    });
    try {
      await sendStarted;
      await new Promise((resolve) => setTimeout(resolve, 350));
      await expect(
        drainNotificationOutbox(1, { ignoreDeliveryDisabled: true }),
      ).resolves.toBe(0);
      releaseSend();
      await expect(firstDrain).resolves.toBe(1);
      expect(sendAttempts).toEqual(["ou_outbox_success"]);
    } finally {
      releaseSend();
      await firstDrain;
      globalThis.fetch = forwardingFetch;
    }
  });

  test("过期 worker 不会覆盖新 worker 的 outbox 与收件人租约", async () => {
    const eventKey = `${EVENT_PREFIX}stale-claim-writer`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          body: "租约所有权测试",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });

    const forwardingFetch = globalThis.fetch;
    let releaseSend = () => {};
    let markSendStarted = () => {};
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("/im/v1/messages")) {
        markSendStarted();
        await sendRelease;
      }
      return forwardingFetch(input, init);
    }) as typeof fetch;

    const staleDrain = drainNotificationOutbox(20, {
      ignoreDeliveryDisabled: true,
    });
    try {
      await sendStarted;
      const claimed = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        include: { recipients: true },
      });
      const recipient = claimed.recipients[0];
      expect(recipient).toBeDefined();
      const replacementLock = new Date(Date.now() + 60_000);
      await prisma.$transaction([
        prisma.notificationOutbox.update({
          where: { id: claimed.id },
          data: {
            status: "PROCESSING",
            attempts: claimed.attempts + 1,
            lockedUntil: replacementLock,
          },
        }),
        prisma.notificationOutboxRecipient.update({
          where: { id: recipient!.id },
          data: {
            status: "PROCESSING",
            attempts: recipient!.attempts + 1,
            lockedUntil: replacementLock,
          },
        }),
      ]);

      releaseSend();
      await expect(staleDrain).resolves.toBe(0);
      await expect(
        prisma.notificationOutbox.findUniqueOrThrow({
          where: { eventKey },
          select: { status: true, attempts: true, lockedUntil: true },
        }),
      ).resolves.toEqual({
        status: "PROCESSING",
        attempts: claimed.attempts + 1,
        lockedUntil: replacementLock,
      });
      await expect(
        prisma.notificationOutboxRecipient.findUniqueOrThrow({
          where: { id: recipient!.id },
          select: { status: true, attempts: true, lockedUntil: true },
        }),
      ).resolves.toEqual({
        status: "PROCESSING",
        attempts: recipient!.attempts + 1,
        lockedUntil: replacementLock,
      });
    } finally {
      releaseSend();
      await staleDrain;
    }
  });

  test("收件人解析阻塞到租约过期后旧 worker 不会协调或重复发送", async () => {
    const eventKey = `${EVENT_PREFIX}stale-recipient-resolution`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          body: "解析租约测试",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });

    let releaseFirstResolution = () => {};
    let markFirstResolutionStarted = () => {};
    const firstResolutionRelease = new Promise<void>((resolve) => {
      releaseFirstResolution = resolve;
    });
    const firstResolutionStarted = new Promise<void>((resolve) => {
      markFirstResolutionStarted = resolve;
    });
    let resolutionCount = 0;
    feedbackNotificationChannel.resolveRecipientPlan = async (row) => {
      resolutionCount += 1;
      if (resolutionCount === 1) {
        markFirstResolutionStarted();
        await firstResolutionRelease;
      }
      return originalFeedbackRecipientResolver(row);
    };

    const staleDrain = drainNotificationOutbox(1, {
      ignoreDeliveryDisabled: true,
    });
    try {
      await firstResolutionStarted;
      await prisma.notificationOutbox.update({
        where: { eventKey },
        data: { lockedUntil: new Date(0) },
      });
      await expect(
        drainNotificationOutbox(1, { ignoreDeliveryDisabled: true }),
      ).resolves.toBe(1);

      releaseFirstResolution();
      await expect(staleDrain).resolves.toBe(0);
      const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        include: { recipients: true },
      });
      expect(outbox.status).toBe("SENT");
      expect(outbox.recipients).toMatchObject([
        { openId: "ou_outbox_success", status: "SENT", attempts: 1 },
      ]);
      expect(sendAttempts).toEqual(["ou_outbox_success"]);
    } finally {
      releaseFirstResolution();
      await staleDrain;
    }
  });

  test("收件人重试耗尽时同步终止父 outbox", async () => {
    const eventKey = `${EVENT_PREFIX}recipient-exhausted`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-test",
          actorName: "测试管理员",
          body: "耗尽测试",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
    });
    await prisma.$transaction([
      prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: "PROCESSING",
          attempts: 1,
          lockedUntil: new Date(0),
        },
      }),
      prisma.notificationOutboxRecipient.create({
        data: {
          outboxId: row.id,
          openId: "ou_outbox_success",
          status: "FAILED",
          attempts: 8,
          lastError: "terminal recipient error",
          nextRunAt: new Date(0),
        },
      }),
    ]);

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    const exhausted = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
    });
    expect(exhausted).toMatchObject({ status: "FAILED", attempts: 8 });
    expect(exhausted.nextRunAt.getUTCFullYear()).toBe(9999);
    expect(sendAttempts).toEqual([]);
  });

  test("采购审批没有真实私信审批人时不会被 Webhook 伪装成成功", async () => {
    const eventKey = `${EVENT_PREFIX}approval-without-direct-recipient`;
    await enqueueNotification({
      eventKey,
      channel: "procurement",
      botKind: "approval",
      type: "order",
      payload: {
        kind: "order",
        order: {
          id: "outbox-adapter-order-no-approver",
          orderNo: "PW-NO-APPROVER",
          initiatorName: "测试采购人",
          totalPrice: 42,
          status: "MANAGEMENT_REVIEW",
          team: "不存在的审批车组",
          techGroup: "不存在的审批技术组",
          items: [{ name: "测试物料", quantity: 1, unitPrice: 42 }],
        },
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(row).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(row.lastError).toContain("没有可投递的真实私信收件人");
    expect(row.recipients).toHaveLength(0);
    expect(webhookAttempts).toBe(0);
    expect(sendAttempts).toEqual([]);
  });

  test("采购审批选择审批机器人并保留完整卡片和 CardKit 跟踪", async () => {
    const eventKey = `${EVENT_PREFIX}approval-positive-routing`;
    const orderId = "outbox-adapter-order-approval-routing";
    await prisma.userRole.deleteMany({
      where: { openId: "ou_outbox_approver" },
    });
    const approverIdentity = await resolveFeishuIdentityForUser({
      openId: "ou_outbox_approver",
      unionId: "on_outbox_approver",
      name: "测试审批人",
    });
    await prisma.user.upsert({
      where: { openId: "ou_outbox_approver" },
      update: {
        accountId: approverIdentity.account.id,
        name: "测试审批人",
        unionId: "on_outbox_approver",
      },
      create: {
        accountId: approverIdentity.account.id,
        openId: "ou_outbox_approver",
        unionId: "on_outbox_approver",
        name: "测试审批人",
      },
    });
    const approverRole = await prisma.userRole.create({
      data: {
        accountId: approverIdentity.account.id,
        openId: "ou_outbox_approver",
        role: "TEAM_ADMIN",
        team: "英雄",
        techGroup: "",
      },
    });
    const suspendedRoles = await prisma.userRole.findMany({
      where: {
        id: { not: approverRole.id },
        revokedAt: null,
        OR: [
          { role: "TEAM_ADMIN", team: "英雄" },
          { role: "TECH_GROUP_ADMIN", techGroup: "电控" },
        ],
      },
      select: { id: true },
    });
    await prisma.userRole.updateMany({
      where: { id: { in: suspendedRoles.map((role) => role.id) } },
      data: { revokedAt: new Date() },
    });
    try {
      process.env.FEISHU_APPROVAL_APP_ID = "approval-app";
      process.env.FEISHU_APPROVAL_APP_SECRET = "approval-secret";
      const [superAdminOpenIds, reimbursementApprovers] = await Promise.all([
        getGlobalSuperAdministratorOpenIds(),
        prisma.userRole.findMany({
        where: {
          revokedAt: null,
          OR: [
            { role: "TEAM_ADMIN", team: "英雄" },
            { role: "TECH_GROUP_ADMIN", techGroup: "电控" },
          ],
        },
        select: { openId: true },
        }),
      ]);
      process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS = [
        "ou_outbox_approver",
        ...superAdminOpenIds,
        ...reimbursementApprovers.map((role) => role.openId),
      ].join(",");
      process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";

    await enqueueNotification({
      eventKey,
      channel: "procurement",
      botKind: "approval",
      type: "order",
      payload: {
        kind: "order",
        order: {
          id: orderId,
          orderNo: "PW-APPROVAL-ROUTING",
          initiatorName: "测试采购发起人",
          totalPrice: 128,
          status: "MANAGEMENT_REVIEW",
          team: "英雄",
          techGroup: "电控",
          items: [{ name: "长名称测试物料", quantity: 2, unitPrice: 64 }],
        },
        appOrigin: "http://127.0.0.1:3002",
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: { orderBy: { openId: "asc" } } },
    });
    expect(row.status).toBe("SENT");
    expect(row.recipients.length).toBeGreaterThanOrEqual(2);
    expect(
      row.recipients.find(
        (recipient) => recipient.openId === "ou_outbox_approver",
      ),
    ).toMatchObject({
      status: "SENT",
      receiveId: "on_outbox_approver",
      receiveIdType: "union_id",
    });
    expect(webhookAttempts).toBe(1);
    expect(sendAttempts).toContain("on_outbox_approver");
    expect(authAppIds.length).toBeGreaterThan(0);
    expect(authAppIds.every((appId) => appId === "approval-app")).toBe(true);
    expect(JSON.stringify(cardKitCards)).toContain("PW-APPROVAL-ROUTING");
    expect(JSON.stringify(cardKitCards)).toContain("测试采购发起人");
    expect(JSON.stringify(cardKitCards)).toContain("长名称测试物料");
    const trackedCard = await prisma.procurementFeishuCard.findUniqueOrThrow({
      where: {
        orderId_openId: { orderId, openId: "ou_outbox_approver" },
      },
    });
    expect(trackedCard).toMatchObject({
      botKind: "approval",
      cardStage: "MANAGEMENT_REVIEW",
    });
      expect(trackedCard.cardId).toMatch(/^outbox-card-\d+$/);
    } finally {
      await prisma.userRole.updateMany({
        where: { id: { in: suspendedRoles.map((role) => role.id) } },
        data: { revokedAt: null },
      });
    }
  });

  test("反馈 adapter 使用通知机器人并生成完整消息", async () => {
    const eventKey = `${EVENT_PREFIX}feedback-content`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-content-test",
          actorName: "测试反馈管理员",
          body: "这里是需要收件人直接理解的完整处理说明",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
        appOrigin: "http://127.0.0.1:3002",
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    expect(authAppIds).toEqual(["notification-app"]);
    expect(directMessageBodies).toHaveLength(1);
    const content = JSON.parse(
      String(directMessageBodies[0]?.content),
    ) as Record<string, unknown>;
    expect(JSON.stringify(content)).toContain("测试反馈管理员");
    expect(JSON.stringify(content)).toContain(
      "这里是需要收件人直接理解的完整处理说明",
    );
    expect(JSON.stringify(content)).toContain("feedback-content-test");
  });

  test("即时 drain 遵守禁发开关并在启用后非阻塞投递", async () => {
    const eventKey = `${EVENT_PREFIX}drain-soon`;
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-drain-soon",
          actorName: "即时投递测试管理员",
          body: "事务提交后立即触发 outbox drain",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });

    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    drainNotificationOutboxSoon(5);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "PENDING" });
    expect(directMessageBodies).toHaveLength(0);

    process.env.NOTIFICATION_DELIVERY_DISABLED = "false";
    drainNotificationOutboxSoon(5);
    await expect
      .poll(async () => {
        const row = await prisma.notificationOutbox.findUniqueOrThrow({
          where: { eventKey },
          select: { status: true },
        });
        return row.status;
      })
      .toBe("SENT");
    expect(directMessageBodies).toHaveLength(1);
  });

  test("项目管理 adapter 使用通知机器人并生成完整业务卡片", async () => {
    const eventKey = `${EVENT_PREFIX}project-management-content`;
    await enqueueNotification({
      eventKey,
      channel: "project-management",
      botKind: "notification",
      type: "task_activated",
      payload: {
        kind: "task_activated",
        payloadVersion: 1,
        purpose: "notification",
        category: "TASK",
        title: "Task 已激活",
        summary: "李棋轩已激活任务「电控调试」",
        actorName: "李棋轩",
        taskId: "pm-task-id",
        taskTitle: "电控调试",
        entityType: "Task",
        entityId: "pm-task-id",
        linkPath: "/progress/tasks/pm-task-id",
        recipientOpenIds: ["ou_outbox_success", "ou_outbox_success"],
        mandatory: true,
        appOrigin: "http://127.0.0.1:3002",
        context: {
          taskStatus: "ACTIVE",
          recipientResolution: "PERSON_INACTIVE",
          internalDebugName: "GLOBAL_ADMINISTRATORS_V2",
        },
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    expect(authAppIds).toEqual(["notification-app"]);
    expect(directMessageBodies).toHaveLength(1);
    const content = JSON.parse(
      String(directMessageBodies[0]?.content),
    ) as Record<string, unknown>;
    const rendered = JSON.stringify(content);
    expect(rendered).toContain("任务已开始执行");
    expect(rendered).toContain("李棋轩");
    expect(rendered).toContain("电控调试");
    expect(rendered).toContain("任务状态");
    expect(rendered).toContain("进行中");
    expect(rendered).toContain("相关事项");
    expect(rendered).toContain("查看详情");
    expect(rendered).not.toContain("Task 已激活");
    expect(rendered).not.toContain("PERSON_INACTIVE");
    expect(rendered).not.toContain("GLOBAL_ADMINISTRATORS_V2");
    expect(rendered).not.toContain("internalDebugName");
    expect(rendered).toContain("/progress/tasks/pm-task-id");
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(row.status).toBe("SENT");
    expect(row.recipients).toHaveLength(1);
    expect(row.recipients[0]).toMatchObject({
      openId: "ou_outbox_success",
      status: "SENT",
      receiveIdType: "open_id",
    });
  });

  test("Revision 取消使用通知机器人并直达 Task 详情", async () => {
    const eventKey = `${EVENT_PREFIX}revision-cancelled`;
    await enqueueNotification({
      eventKey,
      channel: "project-management",
      botKind: "notification",
      type: "revision_cancelled",
      payload: projectManagementPayload({
        kind: "revision_cancelled",
        category: "REVISION",
        title: "计划修订已取消",
        summary:
          "任务「电控调试」的计划修订「调整联调顺序」已取消；取消说明：需求已经撤回",
        actorName: "李棋轩",
        taskId: "pm-revision-task",
        taskTitle: "电控调试",
        entityType: "RevisionNode",
        entityId: "pm-revision-cancelled",
        linkPath: "/progress/tasks/pm-revision-task",
        mandatory: true,
        context: {
          revisionName: "调整联调顺序",
          round: 2,
          beforeStatus: "PENDING_APPROVAL",
          afterStatus: "CANCELLED",
          cancelReason: "需求已经撤回",
        },
      }),
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    expect(authAppIds).toEqual(["notification-app"]);
    expect(directMessageBodies).toHaveLength(1);
    const rendered = JSON.stringify(
      JSON.parse(String(directMessageBodies[0]?.content)),
    );
    expect(rendered).toContain("计划修订已取消");
    expect(rendered).toContain("李棋轩");
    expect(rendered).toContain("调整联调顺序");
    expect(rendered).toContain("取消说明");
    expect(rendered).toContain("需求已经撤回");
    expect(rendered).toContain("已取消");
    expect(
      projectManagementButton(directMessageBodies[0]).url,
    ).toBe("http://127.0.0.1:3002/progress/tasks/pm-revision-task");
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        select: { status: true, botKind: true },
      }),
    ).resolves.toEqual({ status: "SENT", botKind: "notification" });
  });

  test("Revision 审批在收件人解析后失效时发送前再次取消", async () => {
    const revision = await createPendingRevisionFixture(1);
    const eventKey = `${EVENT_PREFIX}revision-stale-before-send`;
    await enqueueNotification({
      eventKey,
      channel: "project-management",
      botKind: "approval",
      type: "revision_pending_review",
      payload: projectManagementPayload({
        kind: "revision_pending_review",
        purpose: "approval_request",
        category: "REVISION",
        taskId: revision.taskId,
        taskTitle: "发送前失效 Revision Task",
        entityType: "RevisionNode",
        entityId: revision.revisionId,
        recipientOpenIds: ["ou_outbox_success"],
        context: { round: 1 },
      }),
    });
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
    });
    await expect(
      projectManagementNotificationChannel.resolveRecipientPlan(row),
    ).resolves.toMatchObject({
      supported: true,
      openIds: ["ou_outbox_success"],
    });

    await prisma.revisionNode.update({
      where: { id: revision.revisionId },
      data: { status: "REJECTED" },
    });

    await expect(
      projectManagementNotificationChannel.sendToRecipient(
        row,
        "ou_outbox_success",
      ),
    ).rejects.toThrow("计划修订已不再等待审批");
    expect(authAppIds).toEqual([]);
    expect(directMessageBodies).toHaveLength(0);
  });

  test("无 round 的旧 Revision 审批只兼容首轮且不会在重提后误发", async () => {
    const staleRevision = await createPendingRevisionFixture(2);
    const staleEventKey = `pm:revision:pending_review:${staleRevision.revisionId}:feishu`;
    await enqueueNotification({
      eventKey: staleEventKey,
      channel: "project-management",
      botKind: "approval",
      type: "revision_pending_review",
      payload: projectManagementPayload({
        kind: "revision_pending_review",
        purpose: "approval_request",
        category: "REVISION",
        taskId: staleRevision.taskId,
        taskTitle: "旧轮次 Revision Task",
        entityType: "RevisionNode",
        entityId: staleRevision.revisionId,
        recipientOpenIds: ["ou_outbox_success"],
        context: {},
      }),
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: staleEventKey },
        select: { status: true, lastError: true },
      }),
    ).resolves.toMatchObject({
      status: "CANCELED",
      lastError: expect.stringContaining("审批轮次已更新"),
    });
    expect(directMessageBodies).toHaveLength(0);

    const firstRoundRevision = await createPendingRevisionFixture(1);
    await enqueueNotification({
      eventKey: `pm:revision:pending_review:${firstRoundRevision.revisionId}:feishu`,
      channel: "project-management",
      botKind: "approval",
      type: "revision_pending_review",
      payload: projectManagementPayload({
        kind: "revision_pending_review",
        purpose: "approval_request",
        category: "REVISION",
        taskId: firstRoundRevision.taskId,
        taskTitle: "首轮兼容 Revision Task",
        entityType: "RevisionNode",
        entityId: firstRoundRevision.revisionId,
        recipientOpenIds: ["ou_outbox_success"],
        context: {},
      }),
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    expect(directMessageBodies).toHaveLength(1);
  });

  test("项目管理 adapter 将旧版 My Work 链接推导为 Task 详情绝对地址", async () => {
    const eventKey = `${EVENT_PREFIX}project-management-legacy-task-link`;
    await enqueueNotification({
      eventKey,
      channel: "project-management",
      botKind: "notification",
      type: "task_activated",
      payload: {
        kind: "task_activated",
        payloadVersion: 1,
        purpose: "notification",
        category: "TASK",
        title: "Task 已激活",
        summary: "旧版通知链接兼容验证",
        actorName: "测试操作人",
        taskId: "pm-legacy-task-id",
        taskTitle: "旧版链接测试任务",
        entityType: "Task",
        entityId: "pm-legacy-task-id",
        linkPath: "/progress",
        recipientOpenIds: ["ou_outbox_success"],
        mandatory: true,
        appOrigin: "http://127.0.0.1:3002",
        context: { taskStatus: "ACTIVE" },
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    expect(authAppIds).toEqual(["notification-app"]);
    expect(directMessageBodies).toHaveLength(1);
    const content = JSON.parse(
      String(directMessageBodies[0]?.content),
    ) as {
      elements?: Array<{
        tag?: string;
        actions?: Array<{ tag?: string; url?: string }>;
      }>;
    };
    const detailButton = content.elements
      ?.find((element) => element.tag === "action")
      ?.actions?.find((action) => action.tag === "button");
    expect(detailButton?.url).toBe(
      "http://127.0.0.1:3002/progress/tasks/pm-legacy-task-id",
    );
  });

  test("项目管理 adapter 为实体、删除事件和既有深链生成规范绝对地址", async () => {
    const cases: Array<{
      name: string;
      payload: ProjectManagementNotificationPayload;
      botKind: "notification" | "approval";
      expectedUrl: string;
      expectedButtonText: "查看详情" | "查看并审批";
    }> = [
      {
        name: "Project 目标",
        payload: projectManagementPayload({
          kind: "risk_created",
          category: "PROJECT",
          projectId: "pm-risk-project",
          projectName: "风险项目",
          entityType: "RiskRecord",
          entityId: "pm-risk-record",
          linkPath: "",
        }),
        botKind: "notification",
        expectedUrl:
          "http://127.0.0.1:3002/progress/projects/pm-risk-project",
        expectedButtonText: "查看详情",
      },
      {
        name: "Task 优先且评论可投递",
        payload: projectManagementPayload({
          kind: "comment_created",
          category: "TASK",
          taskId: "pm-comment-task",
          taskTitle: "评论任务",
          projectId: "pm-comment-project",
          projectName: "评论项目",
          entityType: "Comment",
          entityId: "pm-comment-record",
          linkPath: "/progress/projects/pm-comment-project",
        }),
        botKind: "notification",
        expectedUrl:
          "http://127.0.0.1:3002/progress/tasks/pm-comment-task",
        expectedButtonText: "查看详情",
      },
      {
        name: "Task 删除列表",
        payload: projectManagementPayload({
          kind: "task_deleted",
          category: "TASK",
          taskId: "pm-deleted-task",
          taskTitle: "已删除任务",
          entityType: "Task",
          entityId: "pm-deleted-task",
          linkPath: "/progress/tasks/pm-deleted-task",
        }),
        botKind: "notification",
        expectedUrl: "http://127.0.0.1:3002/progress/tasks",
        expectedButtonText: "查看详情",
      },
      {
        name: "Project 删除列表",
        payload: projectManagementPayload({
          kind: "project_deleted",
          category: "PROJECT",
          projectId: "pm-deleted-project",
          projectName: "已删除项目",
          entityType: "Project",
          entityId: "pm-deleted-project",
          linkPath: "/progress/projects/pm-deleted-project",
        }),
        botKind: "notification",
        expectedUrl: "http://127.0.0.1:3002/progress/projects",
        expectedButtonText: "查看详情",
      },
      {
        name: "Segment focus",
        payload: projectManagementPayload({
          kind: "segment_confirmation_due",
          category: "WORK_SEGMENT",
          taskId: "pm-segment-task",
          taskTitle: "投入确认任务",
          entityType: "WorkSegment",
          entityId: "pm-segment-card",
          linkPath: "/progress?focus=pm-segment-card",
        }),
        botKind: "notification",
        expectedUrl:
          "http://127.0.0.1:3002/progress?focus=pm-segment-card",
        expectedButtonText: "查看详情",
      },
      {
        name: "Terminal focus",
        payload: projectManagementPayload({
          kind: "termination_review_result",
          category: "REVIEW",
          taskId: "pm-terminal-task",
          taskTitle: "结束审批任务",
          entityType: "TerminationReview",
          entityId: "pm-terminal-review",
          linkPath:
            "/progress/tasks/pm-terminal-task?focus=pm-terminal-node",
        }),
        botKind: "notification",
        expectedUrl:
          "http://127.0.0.1:3002/progress/tasks/pm-terminal-task?focus=pm-terminal-node",
        expectedButtonText: "查看详情",
      },
      {
        name: "Project 立项锚点",
        payload: projectManagementPayload({
          kind: "project_establishment_submitted",
          purpose: "approval_request",
          category: "PROJECT",
          projectId: "pm-establishment-project",
          projectName: "立项项目",
          entityType: "ProjectEstablishmentRequest",
          entityId: "pm-establishment-request",
          linkPath:
            "/progress/projects/pm-establishment-project#establishment",
          recipientOpenIds: ["ou_outbox_link_approval"],
        }),
        botKind: "approval",
        expectedUrl:
          "http://127.0.0.1:3002/progress/projects/pm-establishment-project#establishment",
        expectedButtonText: "查看并审批",
      },
    ];

    process.env.FEISHU_APPROVAL_APP_ID = "approval-app";
    process.env.FEISHU_APPROVAL_APP_SECRET = "approval-secret";
    const approvalIdentity =
      await prisma.accountIdentity.findUniqueOrThrow({
        where: {
          provider_tenantId_openId: {
            provider: "FEISHU",
            tenantId: "default",
            openId: "ou_outbox_link_approval",
          },
        },
        select: { accountId: true },
      });
    await prisma.user.upsert({
      where: { openId: "ou_outbox_link_approval" },
      update: {
        accountId: approvalIdentity.accountId,
        unionId: "on_outbox_link_approval",
        name: "项目管理链接审批人",
      },
      create: {
        accountId: approvalIdentity.accountId,
        openId: "ou_outbox_link_approval",
        unionId: "on_outbox_link_approval",
        name: "项目管理链接审批人",
      },
    });
    for (const [index, testCase] of cases.entries()) {
      await enqueueNotification({
        eventKey: `${EVENT_PREFIX}project-management-link-${index}`,
        channel: "project-management",
        botKind: testCase.botKind,
        type: testCase.payload.kind,
        payload: testCase.payload,
      });

      expect(
        await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
        testCase.name,
      ).toBe(1);
      const button = projectManagementButton(directMessageBodies.at(-1));
      expect(
        button.url,
        testCase.name,
      ).toBe(testCase.expectedUrl);
      expect(button.text, testCase.name).toBe(testCase.expectedButtonText);
    }
    expect(authAppIds).toContain("notification-app");
    expect(authAppIds).toContain("approval-app");
  });

  test("项目管理 adapter 遵守禁发 guard 且不会把跳过投递标记为成功", async () => {
    const eventKey = `${EVENT_PREFIX}project-management-delivery-disabled`;
    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    await enqueueNotification({
      eventKey,
      channel: "project-management",
      botKind: "notification",
      type: "segment_confirmation_due",
      payload: {
        kind: "segment_confirmation_due",
        payloadVersion: 1,
        purpose: "notification",
        category: "WORK_SEGMENT",
        title: "投入确认禁发验证",
        summary: "禁发开关打开时不能将项目管理飞书通知标记为成功",
        actorName: "系统",
        taskId: "pm-task-id",
        taskTitle: "电控调试 Task",
        entityType: "WorkSegment",
        entityId: "pm-segment-disabled",
        linkPath: "/progress?focus=pm-segment-disabled",
        recipientOpenIds: ["ou_outbox_success"],
        mandatory: true,
        appOrigin: "http://127.0.0.1:3002",
        context: { status: "PENDING_CONFIRMATION" },
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    expect(authAppIds).toEqual([]);
    expect(directMessageBodies).toHaveLength(0);
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("delivery_disabled");
    expect(row.recipients).toHaveLength(1);
    expect(row.recipients[0]).toMatchObject({
      openId: "ou_outbox_success",
      status: "FAILED",
    });
    expect(row.recipients[0]?.lastError).toContain("delivery_disabled");
  });

  test("token 远端错误不会进入 outbox 持久化错误", async () => {
    const eventKey = `${EVENT_PREFIX}token-error-redaction`;
    authResponses.push({
      code: 500,
      msg: "app_secret=outbox-secret access_token=outbox-token",
    });
    await enqueueNotification({
      eventKey,
      channel: "feedback",
      type: "reply",
      payload: {
        kind: "reply",
        payload: {
          feedbackId: "feedback-token-error",
          actorName: "测试管理员",
          body: "token 错误脱敏",
          recipientOpenIds: ["ou_outbox_success"],
          actorIsAdmin: true,
        },
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(0);
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("tenant_access_token 失败(500)");
    expect(row.lastError).not.toContain("outbox-secret");
    expect(row.lastError).not.toContain("outbox-token");
    expect(row.recipients).toHaveLength(1);
    expect(row.recipients[0]?.lastError).not.toContain("outbox-secret");
    expect(row.recipients[0]?.lastError).not.toContain("outbox-token");
  });

  test("采购 adapter 将群 Webhook 作为独立收件人投递并记录状态", async () => {
    const eventKey = `${EVENT_PREFIX}procurement-webhook`;
    await enqueueNotification({
      eventKey,
      channel: "procurement",
      type: "procurement_rejected",
      payload: {
        kind: "procurement_rejected",
        order: {
          id: "missing-order-for-webhook-only",
          orderNo: "PW-WEBHOOK-ONLY",
          initiatorName: "测试采购人",
          totalPrice: 42,
          status: "REJECTED",
          team: "英雄",
          techGroup: "电控",
          items: [{ name: "测试物料", quantity: 1, unitPrice: 42 }],
        },
        reason: "测试驳回原因",
        rejectedByName: "测试管理员",
        appOrigin: "http://127.0.0.1:3002",
      },
    });

    expect(
      await drainNotificationOutbox(20, { ignoreDeliveryDisabled: true }),
    ).toBe(1);
    const row = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(row.status).toBe("SENT");
    expect(row.recipients).toHaveLength(1);
    expect(row.recipients[0]).toMatchObject({
      openId: "__procurement_order_webhook__",
      status: "SENT",
    });
    expect(webhookAttempts).toBe(1);
    expect(sendAttempts).toEqual([]);
  });
});

function projectManagementPayload(
  input: Pick<
    ProjectManagementNotificationPayload,
    "kind" | "category" | "entityType" | "entityId"
  > &
    Partial<ProjectManagementNotificationPayload>,
): ProjectManagementNotificationPayload {
  return {
    payloadVersion: 1,
    purpose: "notification",
    title: "项目管理通知链接验证",
    summary: "验证项目管理通知能够通过 mock 飞书传输并直达目标",
    actorName: "测试操作人",
    linkPath: "",
    recipientOpenIds: ["ou_outbox_success"],
    mandatory: false,
    appOrigin: "http://127.0.0.1:3002",
    context: {},
    ...input,
  };
}

function projectManagementButton(
  body: Record<string, unknown> | undefined,
): { url: string; text: string } {
  if (!body) throw new Error("测试期望飞书私信请求体");
  const content = JSON.parse(String(body.content)) as {
    elements?: Array<{
      tag?: string;
      actions?: Array<{
        tag?: string;
        url?: string;
        text?: { content?: string };
      }>;
    }>;
  };
  const button = content.elements
    ?.find((element) => element.tag === "action")
    ?.actions?.find((action) => action.tag === "button");
  if (!button?.url || !button.text?.content) {
    throw new Error("测试期望项目管理卡片详情按钮 URL 与文案");
  }
  return { url: button.url, text: button.text.content };
}

async function ensureActiveFeishuRecipient(openId: string) {
  const identity = await prisma.accountIdentity.findUnique({
    where: {
      provider_tenantId_openId: {
        provider: "FEISHU",
        tenantId: "default",
        openId,
      },
    },
    select: { accountId: true },
  });
  if (identity) {
    await prisma.person.upsert({
      where: { accountId: identity.accountId },
      create: {
        accountId: identity.accountId,
        displayName: `Outbox recipient ${openId}`,
        status: "ACTIVE",
      },
      update: { status: "ACTIVE" },
    });
    return;
  }
  await prisma.account.create({
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
        create: {
          displayName: `Outbox recipient ${openId}`,
          status: "ACTIVE",
        },
      },
    },
  });
}

async function createPendingRevisionFixture(reviewRound: number) {
  const administratorAccountId =
    await ensureRevisionFixtureAdministratorAccount();
  const taskId = randomUUID();
  const planVersionId = randomUUID();
  const nodeId = randomUUID();
  const revisionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({
      data: {
        id: taskId,
        title: `Outbox Revision Fixture ${taskId}`,
        status: "ACTIVE",
        currentPlanVersionId: planVersionId,
        createdByAccountId: administratorAccountId,
        startedAt: new Date(),
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planVersionId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        reason: "Adapter stale approval fixture",
        createdByAccountId: administratorAccountId,
        activatedAt: new Date(),
      },
    });
    await tx.taskNode.create({
      data: {
        id: nodeId,
        taskId,
        type: "REVISION",
        status: "ACTIVE",
        businessDescription: "Adapter stale approval fixture",
        createdByAccountId: administratorAccountId,
      },
    });
    await tx.revisionNode.create({
      data: {
        id: revisionId,
        nodeId,
        reason: "Adapter stale approval fixture",
        revisionAt: new Date(),
        reviewRound,
        basePlanVersionId: planVersionId,
        status: "PENDING_APPROVAL",
      },
    });
  });
  revisionFixtureTaskIds.push(taskId);
  return { taskId, revisionId };
}

async function ensureRevisionFixtureAdministratorAccount() {
  if (revisionFixtureAdministratorAccountId) {
    return revisionFixtureAdministratorAccountId;
  }
  const openId = `ou_revision_adapter_fixture_${randomUUID()}`;
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
        create: {
          displayName: "Revision adapter fixture administrator",
          status: "ACTIVE",
        },
      },
    },
    select: { id: true },
  });
  await prisma.systemRoleAssignment.create({
    data: {
      accountId: account.id,
      role: "PROJECT_ADMINISTRATOR",
      team: "",
      techGroup: "",
    },
  });
  revisionFixtureAdministratorAccountId = account.id;
  return account.id;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function assertTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(`拒绝清理非测试数据库: ${databaseName}`);
  }
}
