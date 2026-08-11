import { expect, test } from "@playwright/test";
import {
  drainNotificationOutbox,
  enqueueNotification,
} from "../lib/notification-outbox";
import { getGlobalSuperAdministratorOpenIds } from "../lib/account-authorization";
import { feedbackNotificationChannel } from "../lib/notification-channels/feedback";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import { prisma } from "../lib/prisma";

const EVENT_PREFIX = "playwright:notification-adapter:";
const originalFeedbackRecipientResolver =
  feedbackNotificationChannel.resolveRecipientPlan;

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
    process.env.NOTIFICATION_DELIVERY_DISABLED = "false";
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS =
      "ou_outbox_success,ou_outbox_retry,ou_outbox_wrong_bot";
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
      where: { openId: "ou_outbox_approver" },
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
        summary: "李棋轩已激活电控调试 Task",
        actorName: "李棋轩",
        taskId: "pm-task-id",
        taskTitle: "电控调试 Task",
        entityType: "Task",
        entityId: "pm-task-id",
        linkPath: "/progress/tasks/pm-task-id",
        recipientOpenIds: ["ou_outbox_success", "ou_outbox_success"],
        mandatory: true,
        appOrigin: "http://127.0.0.1:3002",
        context: { status: "ACTIVE" },
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
    expect(rendered).toContain("Task 已激活");
    expect(rendered).toContain("李棋轩");
    expect(rendered).toContain("电控调试 Task");
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
