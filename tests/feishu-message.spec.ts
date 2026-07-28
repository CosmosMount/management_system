import { expect, test } from "@playwright/test";
import { sendFeishuDirectMessage } from "../lib/feishu-message";
import { sendTrackedProcurementCardKitDm } from "../lib/feishu-procurement-card-sync";
import { prisma } from "../lib/prisma";

type FetchCall = { url: string; init?: RequestInit };

test.describe.configure({ mode: "serial" });

test.describe("统一飞书私信传输层", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = new Map<string, string | undefined>();
  const envNames = [
    "NOTIFICATION_DELIVERY_DISABLED",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_NOTIFICATION_APP_ID",
    "FEISHU_NOTIFICATION_APP_SECRET",
    "FEISHU_APPROVAL_APP_ID",
    "FEISHU_APPROVAL_APP_SECRET",
    "FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS",
    "FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS",
    "FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES",
  ];
  let calls: FetchCall[];
  let authResponses: Array<Record<string, unknown>>;
  let messageResponses: Array<Record<string, unknown>>;
  let cardResponses: Array<Record<string, unknown>>;

  test.beforeEach(() => {
    for (const name of envNames) originalEnv.set(name, process.env[name]);
    process.env.NOTIFICATION_DELIVERY_DISABLED = "false";
    process.env.FEISHU_APP_ID = "oauth-app";
    process.env.FEISHU_APP_SECRET = "oauth-secret";
    process.env.FEISHU_NOTIFICATION_APP_ID = "notification-app";
    process.env.FEISHU_NOTIFICATION_APP_SECRET = "notification-secret";
    delete process.env.FEISHU_APPROVAL_APP_ID;
    delete process.env.FEISHU_APPROVAL_APP_SECRET;
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS = "ou_allowed";
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "on_allowed";
    delete process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES;
    calls = [];
    authResponses = [];
    messageResponses = [];
    cardResponses = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/auth/v3/app_access_token/internal")) {
        const body = JSON.parse(String(init?.body)) as { app_id: string };
        return jsonResponse(
          authResponses.shift() ?? {
            code: 0,
            tenant_access_token: `token-for-${body.app_id}`,
          },
        );
      }
      if (url.endsWith("/cardkit/v1/cards")) {
        return jsonResponse(
          cardResponses.shift() ?? {
            code: 0,
            data: { card_id: "cardkit-test-id" },
          },
        );
      }
      if (url.includes("/contact/v3/users/")) {
        return jsonResponse({ code: 0, data: { user: {} } });
      }
      if (url.includes("/im/v1/messages")) {
        return jsonResponse(messageResponses.shift() ?? { code: 0, msg: "ok" });
      }
      throw new Error(`测试捕获到未 mock 的飞书请求: ${url}`);
    }) as typeof fetch;
  });

  test.afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of originalEnv) restoreEnv(name, value);
    originalEnv.clear();
    await prisma.user.deleteMany({
      where: {
        openId: {
          in: ["ou_feishu_transport_blocked", "ou_feishu_missing_union"],
        },
      },
    });
    await prisma.procurementFeishuCard.deleteMany({
      where: { orderId: "feishu-transport-fallback-order" },
    });
  });

  test("delivery disabled 在解析凭据和网络请求前返回 skipped", async () => {
    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    const result = await sendText("ou_allowed", "notification");

    expect(result).toEqual({
      status: "skipped",
      reason: "delivery_disabled",
    });
    expect(calls).toEqual([]);
  });

  test("allowlist 允许 open_id，通知机器人发送文本", async () => {
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";
    const result = await sendText("ou_allowed", "notification");

    expect(result).toMatchObject({
      status: "sent",
      botKind: "notification",
      receiveId: "ou_allowed",
      receiveIdType: "open_id",
      fallbackUsed: false,
    });
    const messageCall = calls.find((call) => call.url.includes("/im/v1/messages"));
    expect(messageCall?.url).toContain("receive_id_type=open_id");
    expect(messageCall?.init?.headers).toMatchObject({
      Authorization: "Bearer token-for-notification-app",
    });
    expect(JSON.parse(String(messageCall?.init?.body))).toEqual({
      receive_id: "ou_allowed",
      msg_type: "text",
      content: JSON.stringify({ text: "传输测试" }),
    });
  });

  test("allowlist 拒绝不匹配的系统用户且不发送请求", async () => {
    await prisma.user.upsert({
      where: { openId: "ou_feishu_transport_blocked" },
      update: { name: "不在白名单" },
      create: { openId: "ou_feishu_transport_blocked", name: "不在白名单" },
    });
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";

    const result = await sendText(
      "ou_feishu_transport_blocked",
      "notification",
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "recipient_not_allowed",
    });
    expect(calls).toEqual([]);
  });

  test("普通通知不能选择审批机器人", async () => {
    await expect(
      sendFeishuDirectMessage({
        recipientOpenId: "ou_allowed",
        botKind: "approval",
        purpose: "notification",
        message: { type: "text", text: "错误路由" },
        logContext: { action: "testInvalidBot", channel: "test" },
      }),
    ).rejects.toThrow("普通通知不得使用审批机器人");
    expect(calls).toEqual([]);
  });

  test("独立审批机器人使用 union_id，用户不可用时回退通知机器人", async () => {
    process.env.FEISHU_APPROVAL_APP_ID = "approval-app";
    process.env.FEISHU_APPROVAL_APP_SECRET = "approval-secret";
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS = "";
    messageResponses.push(
      { code: 230006, msg: "Bot has NO availability to this user" },
      { code: 0, msg: "ok" },
    );

    const result = await sendFeishuDirectMessage({
      recipientOpenId: "on_allowed",
      botKind: "approval",
      purpose: "approval_request",
      message: { type: "interactive", card: { header: { title: "审批" } } },
      logContext: { action: "testApprovalFallback", channel: "test" },
    });

    expect(result).toMatchObject({
      status: "sent",
      botKind: "notification",
      receiveId: "on_allowed",
      receiveIdType: "union_id",
      fallbackUsed: true,
    });
    const authBodies = calls
      .filter((call) => call.url.includes("/auth/v3/app_access_token/internal"))
      .map((call) => JSON.parse(String(call.init?.body)) as { app_id: string });
    expect(authBodies.map((body) => body.app_id)).toEqual([
      "approval-app",
      "notification-app",
    ]);
  });

  test("独立审批机器人缺少 union_id 时失败并保留给 outbox 重试", async () => {
    await prisma.user.upsert({
      where: { openId: "ou_feishu_missing_union" },
      update: { name: "缺少 union id", unionId: null },
      create: { openId: "ou_feishu_missing_union", name: "缺少 union id" },
    });
    process.env.FEISHU_APPROVAL_APP_ID = "approval-app";
    process.env.FEISHU_APPROVAL_APP_SECRET = "approval-secret";
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS =
      "ou_feishu_missing_union";
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";

    await expect(
      sendFeishuDirectMessage({
        recipientOpenId: "ou_feishu_missing_union",
        botKind: "approval",
        purpose: "approval_request",
        message: { type: "text", text: "审批请求" },
        logContext: { action: "testMissingUnionId", channel: "test" },
      }),
    ).rejects.toThrow("独立审批机器人无法解析收件人 union_id");
    expect(calls.some((call) => call.url.includes("/im/v1/messages"))).toBe(
      false,
    );
  });

  test("CardKit 由 CardKit 模块创建并在发送结果中返回 cardId", async () => {
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";
    const result = await sendFeishuDirectMessage({
      recipientOpenId: "ou_allowed",
      botKind: "notification",
      purpose: "notification",
      message: { type: "cardkit", card: { schema: "2.0", body: {} } },
      logContext: { action: "testCardKit", channel: "test" },
    });

    expect(result).toMatchObject({
      status: "sent",
      cardId: "cardkit-test-id",
      receiveIdType: "open_id",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
      "https://open.feishu.cn/open-apis/cardkit/v1/cards",
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    ]);
  });

  test("审批机器人不可用时 CardKit 跟踪记录实际 fallback 机器人和卡片", async () => {
    process.env.FEISHU_APPROVAL_APP_ID = "approval-app";
    process.env.FEISHU_APPROVAL_APP_SECRET = "approval-secret";
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS = "";
    cardResponses.push(
      { code: 0, data: { card_id: "approval-orphan-card" } },
      { code: 0, data: { card_id: "notification-fallback-card" } },
    );
    messageResponses.push(
      { code: 230006, msg: "Bot has NO availability to this user" },
      { code: 0, msg: "ok" },
    );

    const result = await sendTrackedProcurementCardKitDm(
      "on_allowed",
      { schema: "2.0", body: {} },
      "approval",
      "feishu-transport-fallback-order",
      "MANAGEMENT_REVIEW",
    );

    expect(result).toMatchObject({
      status: "sent",
      botKind: "notification",
      fallbackUsed: true,
      cardId: "notification-fallback-card",
    });
    await expect(
      prisma.procurementFeishuCard.findUniqueOrThrow({
        where: {
          orderId_openId: {
            orderId: "feishu-transport-fallback-order",
            openId: "on_allowed",
          },
        },
      }),
    ).resolves.toMatchObject({
      cardId: "notification-fallback-card",
      botKind: "notification",
      cardStage: "MANAGEMENT_REVIEW",
    });
  });

  test("CardKit 远端错误不会泄露到异常", async () => {
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";
    cardResponses.push({
      code: 500,
      msg: "access_token=card-secret app_secret=remote-secret",
    });

    let error: unknown;
    try {
      await sendFeishuDirectMessage({
        recipientOpenId: "ou_allowed",
        botKind: "notification",
        purpose: "notification",
        message: { type: "cardkit", card: { schema: "2.0", body: {} } },
        logContext: { action: "testCardKitRedaction", channel: "test" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("创建飞书卡片实例失败(500)");
    expect((error as Error).message).not.toContain("card-secret");
    expect((error as Error).message).not.toContain("remote-secret");
  });

  test("飞书错误不会把远端响应中的敏感字符串写入异常", async () => {
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";
    messageResponses.push({
      code: 500,
      msg: "access_token=secret-from-remote app_secret=also-secret",
    });

    let error: unknown;
    try {
      await sendText("ou_allowed", "notification");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("飞书私信发送失败(500)");
    expect((error as Error).message).not.toContain("secret-from-remote");
  });

  test("token 获取错误不会把远端敏感字符串写入异常", async () => {
    process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS = "";
    authResponses.push({
      code: 500,
      msg: "app_secret=token-secret access_token=remote-token",
    });

    let error: unknown;
    try {
      await sendText("ou_allowed", "notification");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "获取飞书 tenant_access_token 失败(500)",
    );
    expect((error as Error).message).not.toContain("token-secret");
    expect((error as Error).message).not.toContain("remote-token");
  });
});

function sendText(
  recipientOpenId: string,
  botKind: "notification" | "approval",
) {
  return sendFeishuDirectMessage({
    recipientOpenId,
    botKind,
    purpose: botKind === "approval" ? "approval_request" : "notification",
    message: { type: "text", text: "传输测试" },
    logContext: { action: "testTextMessage", channel: "test" },
  });
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
