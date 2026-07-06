import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import {
  uploadFeishuMessageFile,
  uploadFeishuMessageImage,
} from "../lib/feishu-im-upload";
import { postToFeishuWebhook } from "../lib/feishu-webhook";
import { storagePathToAbsolute } from "../lib/upload-paths";

test.describe("Feishu delivery safety guard", () => {
  const originalFetch = globalThis.fetch;
  const originalPlaywrightDatabaseUrl = process.env.PLAYWRIGHT_DATABASE_URL;
  const originalOAuthAppId = process.env.FEISHU_APP_ID;
  const originalOAuthAppSecret = process.env.FEISHU_APP_SECRET;
  const originalNotificationAppId = process.env.FEISHU_NOTIFICATION_APP_ID;
  const originalNotificationAppSecret = process.env.FEISHU_NOTIFICATION_APP_SECRET;
  const originalApprovalAppId = process.env.FEISHU_APPROVAL_APP_ID;
  const originalApprovalAppSecret = process.env.FEISHU_APPROVAL_APP_SECRET;
  const uploadDir = "playwright/feishu-delivery-guard";
  const imagePublicPath = `/${path.posix.join("uploads", uploadDir, "image.png")}`;
  const filePublicPath = `/${path.posix.join("uploads", uploadDir, "file.pdf")}`;
  let fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

  test.beforeEach(async () => {
    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    delete process.env.CONFIRM_SEND_FEISHU;
    process.env.PLAYWRIGHT_DATABASE_URL =
      process.env.PLAYWRIGHT_DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/management_system_test";
    process.env.FEISHU_APP_ID = "oauth-app";
    process.env.FEISHU_APP_SECRET = "oauth-secret";
    process.env.FEISHU_NOTIFICATION_APP_ID = "notification-app";
    process.env.FEISHU_NOTIFICATION_APP_SECRET = "notification-secret";
    process.env.FEISHU_APPROVAL_APP_ID = "approval-app";
    process.env.FEISHU_APPROVAL_APP_SECRET = "approval-secret";

    const absoluteUploadDir = storagePathToAbsolute(uploadDir);
    await mkdir(absoluteUploadDir, { recursive: true });
    await writeFile(storagePathToAbsolute(`${uploadDir}/image.png`), "fake-png");
    await writeFile(storagePathToAbsolute(`${uploadDir}/file.pdf`), "fake-pdf");

    fetchCalls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ input, init });
      if (url.includes("/auth/v3/app_access_token/internal")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "mock-token" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/im/v1/images")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { image_key: "mock-image-key" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/im/v1/files")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { file_key: "mock-file-key" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ code: 0, msg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  test.afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.CONFIRM_SEND_FEISHU;
    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    restoreEnv("PLAYWRIGHT_DATABASE_URL", originalPlaywrightDatabaseUrl);
    restoreEnv("FEISHU_APP_ID", originalOAuthAppId);
    restoreEnv("FEISHU_APP_SECRET", originalOAuthAppSecret);
    restoreEnv("FEISHU_NOTIFICATION_APP_ID", originalNotificationAppId);
    restoreEnv("FEISHU_NOTIFICATION_APP_SECRET", originalNotificationAppSecret);
    restoreEnv("FEISHU_APPROVAL_APP_ID", originalApprovalAppId);
    restoreEnv("FEISHU_APPROVAL_APP_SECRET", originalApprovalAppSecret);
    await rm(storagePathToAbsolute(uploadDir), { recursive: true, force: true });
  });

  test("NOTIFICATION_DELIVERY_DISABLED blocks Feishu webhook fetch", async () => {
    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      "playwright-secret",
      { msg_type: "text", content: { text: "should not send" } },
    );

    expect(fetchCalls).toHaveLength(0);
  });

  test("explicit bypass allows Feishu webhook fetch in controlled tests", async () => {
    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      undefined,
      { msg_type: "text", content: { text: "mock send" } },
      { ignoreDeliveryDisabled: true },
    );

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0]?.input)).toContain("/open-apis/bot/v2/hook/");
  });

  test("CONFIRM_SEND_FEISHU alone does not bypass test delivery disable", async () => {
    process.env.CONFIRM_SEND_FEISHU = "true";

    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      undefined,
      { msg_type: "text", content: { text: "should still not send" } },
    );

    expect(fetchCalls).toHaveLength(0);
  });

  test("NOTIFICATION_DELIVERY_DISABLED blocks Feishu IM media upload fetches", async () => {
    const imageKey = await uploadFeishuMessageImage(imagePublicPath, "notification");
    const fileKey = await uploadFeishuMessageFile(filePublicPath, "approval");

    expect(imageKey).toBeNull();
    expect(fileKey).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test("explicit bypass allows Feishu IM media upload fetches in controlled tests", async () => {
    const imageKey = await uploadFeishuMessageImage(imagePublicPath, "notification", {
      ignoreDeliveryDisabled: true,
    });
    const fileKey = await uploadFeishuMessageFile(filePublicPath, "approval", {
      ignoreDeliveryDisabled: true,
    });

    expect(imageKey).toBe("mock-image-key");
    expect(fileKey).toBe("mock-file-key");
    expect(fetchCalls.map((call) => String(call.input))).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/images",
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/files",
    ]);
  });

  test("explicit bypass is ignored in non-test app processes without human confirmation", async () => {
    delete process.env.PLAYWRIGHT_DATABASE_URL;

    await postToFeishuWebhook(
      "https://open.feishu.cn/open-apis/bot/v2/hook/playwright-webhook",
      undefined,
      { msg_type: "text", content: { text: "should still not send" } },
      { ignoreDeliveryDisabled: true },
    );

    expect(fetchCalls).toHaveLength(0);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
