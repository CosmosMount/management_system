import { expect, test } from "@playwright/test";
import type { ProgressNotifyPayload } from "../lib/feishu-progress";
import {
  drainNotificationOutbox,
  enqueueProgressNotification,
} from "../lib/notification-outbox";
import { prisma } from "../lib/prisma";

type CapturedFeishuMessage = {
  receiveId: string;
  title: string;
  cardText: string;
};

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await prisma.notificationOutbox.deleteMany();
});

test("项目创建通知只入队一次并发送给唯一收件人", async () => {
  const eventKey = `playwright:progress-notify:project_created:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "project_created",
    projectId: "pw-project-created",
    projectName: "PW通知-创建项目",
    team: "工程",
    techGroup: "宣运",
    ownerOpenIds: ["ou_owner"],
    ownerNames: "项目负责人",
    participantOpenIds: ["ou_participant"],
    participantNames: "项目参与人",
    recipientOpenIds: [
      "ou_owner",
      "ou_participant",
      "ou_manager",
      "ou_owner",
      "",
    ],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "ou_manager",
    "ou_owner",
    "ou_participant",
  ]);
  expect(captured).toHaveLength(3);
  expect(captured.every((message) => message.title === "新项目已创建")).toBe(
    true,
  );
  expect(captured[0]?.cardText).toContain("PW通知-创建项目");
  expect(captured[0]?.cardText).toContain("项目负责人");
  expect(captured[0]?.cardText).toContain("项目参与人");
  expect(captured[0]?.cardText).toContain("工程 / 宣运");
});

test("项目取消通知只入队一次并发送完整取消内容", async () => {
  const eventKey = `playwright:progress-notify:project_canceled:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "project_canceled",
    projectId: "pw-project-canceled",
    projectName: "PW通知-取消项目",
    team: "工程",
    techGroup: "宣运",
    ownerOpenIds: ["ou_owner"],
    ownerNames: "项目负责人",
    participantOpenIds: ["ou_participant"],
    participantNames: "项目参与人",
    recipientOpenIds: ["ou_owner", "ou_participant", "ou_manager", "ou_owner"],
    canceledTaskCount: 3,
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "ou_manager",
    "ou_owner",
    "ou_participant",
  ]);
  expect(captured).toHaveLength(3);
  expect(captured.every((message) => message.title === "项目已取消")).toBe(true);
  expect(captured[0]?.cardText).toContain("PW通知-取消项目");
  expect(captured[0]?.cardText).toContain("项目负责人");
  expect(captured[0]?.cardText).toContain("项目参与人");
  expect(captured[0]?.cardText).toContain("同步取消任务");
  expect(captured[0]?.cardText).toContain("3 个");
});

async function enqueueAndDrainProgressNotification(
  eventKey: string,
  payload: ProgressNotifyPayload,
): Promise<CapturedFeishuMessage[]> {
  const capturedMessages: CapturedFeishuMessage[] = [];
  const restoreFetch = mockFeishuFetch(capturedMessages);

  try {
    const result = await enqueueProgressNotification(eventKey, payload, {
      appOrigin: "http://127.0.0.1:3002",
    });
    expect(result.created).toBe(true);

    const outboxes = await prisma.notificationOutbox.findMany({
      where: { eventKey: { startsWith: eventKey } },
      select: { eventKey: true, payload: true, status: true },
    });
    expect(outboxes).toHaveLength(1);
    expect(outboxes[0]?.eventKey).toBe(eventKey);
    expect(outboxes[0]?.eventKey).not.toContain(":recipient:");
    expect(outboxes[0]?.status).toBe("PENDING");
    expect(outboxes[0]?.payload).toContain("recipientOpenIds");

    const sentCount = await drainNotificationOutbox(10);
    expect(sentCount).toBe(1);

    const stored = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      select: { status: true, attempts: true, lastError: true },
    });
    expect(stored).toMatchObject({
      status: "SENT",
      attempts: 1,
      lastError: "",
    });

    return capturedMessages;
  } finally {
    restoreFetch();
  }
}

function mockFeishuFetch(capturedMessages: CapturedFeishuMessage[]): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input);
    if (url.includes("/auth/v3/app_access_token/internal")) {
      return Response.json({
        code: 0,
        tenant_access_token: "playwright-tenant-token",
      });
    }

    if (url.includes("/im/v1/messages")) {
      const body = parseJsonRecord(init?.body);
      const card = parseJsonRecord(body.content);
      capturedMessages.push({
        receiveId: readString(body.receive_id),
        title: readNestedString(card, ["header", "title", "content"]),
        cardText: JSON.stringify(card),
      });
      return Response.json({ code: 0, msg: "ok" });
    }

    throw new Error(`Unexpected Feishu fetch in notification test: ${url}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("Expected JSON string body");
  }
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Expected JSON object body");
  }
  return parsed;
}

function readString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected string value");
  }
  return value;
}

function readNestedString(
  record: Record<string, unknown>,
  path: string[],
): string {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) {
      throw new Error(`Expected object at ${key}`);
    }
    current = current[key];
  }
  return readString(current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
