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

test("批量提前申请通知使用明确中文并发送给唯一收件人", async () => {
  const eventKey = `playwright:progress-notify:project_stage_batch_due_change_requested:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "project_stage_batch_due_change_requested",
    requestId: "pw-batch-ddl-request",
    projectId: "pw-project-batch-ddl",
    projectName: "PW通知-批量提前项目",
    stageId: "pw-stage-current",
    stageName: "当前阶段",
    requesterName: "李棋轩",
    requesterOpenId: "ou_requester",
    reason: "测试阶段整体提前",
    durationDays: -2,
    requestedIsBenign: null,
    oldDueAt: "2026-06-29T18:00:00.000Z",
    newDueAt: "2026-06-27T18:00:00.000Z",
    affectedStageNames: ["当前阶段", "后续阶段"],
    team: "工程",
    techGroup: "宣运",
    recipientOpenIds: ["ou_requester", "ou_owner", "ou_owner", "ou_manager"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "ou_manager",
    "ou_owner",
  ]);
  expect(captured).toHaveLength(2);
  expect(captured.every((message) => message.title === "批量提前申请待审批")).toBe(
    true,
  );
  expect(captured[0]?.cardText).toContain("PW通知-批量提前项目");
  expect(captured[0]?.cardText).toContain("影响范围");
  expect(captured[0]?.cardText).toContain("提前");
  expect(captured[0]?.cardText).toContain("2 天");
});

test("批量延期审批通知使用明确中文并保留良性信息", async () => {
  const eventKey = `playwright:progress-notify:project_stage_batch_due_change_approved:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "project_stage_batch_due_change_approved",
    requestId: "pw-batch-ddl-approved",
    projectId: "pw-project-batch-ddl-approved",
    projectName: "PW通知-批量延期项目",
    stageId: "pw-stage-current",
    stageName: "当前阶段",
    reviewerName: "Playwright 管理员",
    requesterOpenId: "ou_requester",
    reason: "测试阶段整体延期",
    comment: "同意延期",
    durationDays: 3,
    finalIsBenign: true,
    oldDueAt: "2026-06-29T18:00:00.000Z",
    newDueAt: "2026-07-02T18:00:00.000Z",
    affectedStageNames: ["当前阶段", "后续阶段"],
    team: "工程",
    techGroup: "宣运",
    ownerOpenIds: ["ou_owner"],
    stageOwnerOpenIds: ["ou_stage_owner"],
    recipientOpenIds: ["ou_requester", "ou_owner", "ou_stage_owner"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "ou_owner",
    "ou_requester",
    "ou_stage_owner",
  ]);
  expect(captured).toHaveLength(3);
  expect(captured.every((message) => message.title === "批量延期已通过")).toBe(true);
  expect(captured[0]?.cardText).toContain("最终良性");
  expect(captured[0]?.cardText).toContain("同意延期");
});

test("批量任务导入通知只入队一次并发送汇总内容", async () => {
  const eventKey = `playwright:progress-notify:task_bulk_imported:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "task_bulk_imported",
    batchId: "pw-batch-imported",
    projectId: "pw-project-imported",
    projectName: "PW通知-批量导入项目",
    actorName: "李棋轩",
    taskCount: 6,
    tasks: Array.from({ length: 6 }, (_, index) => ({
      title: `导入任务 ${index + 1}`,
      stageName: "当前阶段",
      assigneeNames: "李棋轩",
      taskTechGroups: ["机械", "电控"],
      dueAt: "2026-06-29T18:00:00.000Z",
    })),
    team: "工程",
    techGroup: "宣运",
    recipientOpenIds: ["ou_owner", "ou_assignee", "ou_owner", ""],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "ou_assignee",
    "ou_owner",
  ]);
  expect(captured).toHaveLength(2);
  expect(captured.every((message) => message.title === "批量任务已导入")).toBe(true);
  expect(captured[0]?.cardText).toContain("PW通知-批量导入项目");
  expect(captured[0]?.cardText).toContain("任务数量");
  expect(captured[0]?.cardText).toContain("6 条");
  expect(captured[0]?.cardText).toContain("导入任务 1");
  expect(captured[0]?.cardText).toContain("还有 1 条");
});

test("批量任务申请通知只入队一次并发送汇总内容", async () => {
  const eventKey = `playwright:progress-notify:task_bulk_creation_requested:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "task_bulk_creation_requested",
    batchId: "pw-batch-requested",
    projectId: "pw-project-requested",
    projectName: "PW通知-批量申请项目",
    actorName: "李棋轩",
    taskCount: 2,
    tasks: [
      {
        title: "申请任务 A",
        stageName: "当前阶段",
        assigneeNames: "李棋轩",
        taskTechGroups: ["通用"],
        dueAt: "2026-06-29T18:00:00.000Z",
      },
      {
        title: "申请任务 B",
        stageName: "当前阶段",
        assigneeNames: "李棋轩",
        taskTechGroups: ["宣运"],
        dueAt: "2026-06-29T18:00:00.000Z",
      },
    ],
    team: "工程",
    techGroup: "宣运",
    recipientOpenIds: ["ou_owner", "ou_requester"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "ou_owner",
    "ou_requester",
  ]);
  expect(captured).toHaveLength(2);
  expect(captured.every((message) => message.title === "批量任务申请待审核")).toBe(
    true,
  );
  expect(captured[0]?.cardText).toContain("PW通知-批量申请项目");
  expect(captured[0]?.cardText).toContain("申请任务 A");
  expect(captured[0]?.cardText).toContain("申请人");
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
