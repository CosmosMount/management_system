import { expect, test } from "@playwright/test";
import {
  sendProgressNotification,
  type ProgressNotifyPayload,
} from "../lib/feishu-progress";
import { sendOrderNotification } from "../lib/feishu";
import { runProcurementStaleReminders } from "../lib/procurement-reminders";
import {
  drainNotificationOutbox,
  enqueueOrderNotification,
  enqueueProgressNotification,
  orderNotificationEventKey,
  resetNotificationOutboxForRetry,
} from "../lib/notification-outbox";
import { resolveProgressBotKind } from "../lib/feishu-bot-routing";
import { prisma } from "../lib/prisma";

type CapturedFeishuMessage = {
  receiveId: string;
  receiveIdType: string;
  title: string;
  cardText: string;
  token: string;
};

type CapturedFeishuAuthRequest = {
  appId: string;
  appSecret: string;
};

const notificationDeliveryDisabled =
  process.env.NOTIFICATION_DELIVERY_DISABLED === "true";

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  expect(notificationDeliveryDisabled).toBe(true);
  await prisma.notificationOutbox.deleteMany();
});

test("项目立项通知发送给审批人并使用明确中文", async () => {
  const eventKey = `playwright:progress-notify:project_establishment_requested:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "project_establishment_requested",
    projectId: "pw-project-establishment",
    projectName: "PW通知-项目立项",
    requesterName: "李棋轩",
    requesterOpenId: "ou_requester",
    team: "工程",
    techGroup: "宣运",
    ownerNames: "项目负责人",
    participantNames: "项目参与人",
    stageCount: 3,
    recipientOpenIds: ["ou_manager", "ou_owner", "ou_manager", ""],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "on_manager",
    "on_owner",
  ]);
  expect(captured.every((message) => message.receiveIdType === "union_id")).toBe(
    true,
  );
  expect(captured).toHaveLength(2);
  expect(captured.every((message) => message.title === "项目立项待审批")).toBe(
    true,
  );
  expect(captured[0]?.cardText).toContain("PW通知-项目立项");
  expect(captured[0]?.cardText).toContain("申请人");
  expect(captured[0]?.cardText).toContain("项目参与人");
  expect(captured[0]?.cardText).toContain("阶段数量");
});

test("项目立项审批结果通知中文清晰且不重复", async () => {
  const approvedEventKey = `playwright:progress-notify:project_establishment_approved:${Date.now()}`;
  const approvedPayload: ProgressNotifyPayload = {
    type: "project_establishment_approved",
    projectId: "pw-project-approved",
    projectName: "PW通知-项目立项通过",
    requesterOpenId: "ou_requester",
    requesterName: "李棋轩",
    reviewerName: "项目管理员",
    comment: "同意立项",
    team: "工程",
    techGroup: "宣运",
    ownerOpenIds: ["ou_owner"],
    ownerNames: "项目负责人",
    participantOpenIds: ["ou_participant"],
    participantNames: "项目参与人",
    stageCount: 2,
    recipientOpenIds: ["ou_requester", "ou_owner", "ou_participant", "ou_owner"],
  };
  const rejectedEventKey = `playwright:progress-notify:project_establishment_rejected:${Date.now()}`;
  const rejectedPayload: ProgressNotifyPayload = {
    type: "project_establishment_rejected",
    projectId: "pw-project-rejected",
    projectName: "PW通知-项目立项驳回",
    requesterOpenId: "ou_requester",
    requesterName: "李棋轩",
    reviewerName: "项目管理员",
    comment: "目标不清晰",
    team: "工程",
    techGroup: "宣运",
    recipientOpenIds: ["ou_requester"],
  };

  const approved = await enqueueAndDrainProgressNotification(
    approvedEventKey,
    approvedPayload,
  );
  const rejected = await enqueueAndDrainProgressNotification(
    rejectedEventKey,
    rejectedPayload,
  );

  expect(approved.map((message) => message.receiveId).sort()).toEqual([
    "ou_owner",
    "ou_participant",
    "ou_requester",
  ]);
  expect(approved.every((message) => message.title === "项目立项已通过")).toBe(
    true,
  );
  expect(approved[0]?.cardText).toContain("同意立项");
  expect(approved[0]?.cardText).toContain("项目参与人");
  expect(approved[0]?.cardText).toContain("未开始");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.receiveId).toBe("ou_requester");
  expect(rejected[0]?.title).toBe("项目立项已驳回");
  expect(rejected[0]?.cardText).toContain("目标不清晰");
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
    "on_manager",
    "on_owner",
  ]);
  expect(captured.every((message) => message.receiveIdType === "union_id")).toBe(
    true,
  );
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
    "on_owner",
    "on_requester",
  ]);
  expect(captured.every((message) => message.receiveIdType === "union_id")).toBe(
    true,
  );
  expect(captured).toHaveLength(2);
  expect(captured.every((message) => message.title === "批量任务申请待审核")).toBe(
    true,
  );
  expect(captured[0]?.cardText).toContain("PW通知-批量申请项目");
  expect(captured[0]?.cardText).toContain("申请任务 A");
  expect(captured[0]?.cardText).toContain("申请人");
});

test("进度审批待办使用审批机器人，普通进度通知使用通知机器人", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
    },
    async () => {
      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
      );
      try {
        await sendProgressNotification({
          type: "project_establishment_requested",
          projectId: "pw-project-bot-routing-requested",
          projectName: "PW机器人-立项待审",
          requesterName: "李棋轩",
          requesterOpenId: "ou_requester",
          team: "工程",
          techGroup: "宣运",
          ownerNames: "项目负责人",
          participantNames: "项目参与人",
          stageCount: 1,
          recipientOpenIds: ["ou_approval"],
        });
        await sendProgressNotification({
          type: "project_establishment_approved",
          projectId: "pw-project-bot-routing-approved",
          projectName: "PW机器人-立项通过",
          requesterOpenId: "ou_requester",
          requesterName: "李棋轩",
          reviewerName: "审批人",
          comment: "同意",
          team: "工程",
          techGroup: "宣运",
          ownerOpenIds: ["ou_owner"],
          ownerNames: "项目负责人",
          participantOpenIds: [],
          participantNames: "",
          stageCount: 1,
          recipientOpenIds: ["ou_notification"],
        });
      } finally {
        restoreFetch();
      }

      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "notification-app",
        "approval-app",
        "notification-app",
      ]);
      expect(capturedMessages.map((message) => message.token)).toEqual([
        "approval-token",
        "notification-token",
      ]);
      expect(capturedMessages.map((message) => message.receiveIdType)).toEqual([
        "union_id",
        "open_id",
      ]);
      expect(capturedMessages.map((message) => message.receiveId)).toEqual([
        "on_approval",
        "ou_notification",
      ]);
    },
  );
});

test("审批机器人未配置时审批消息回退通知机器人", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: undefined,
      FEISHU_APPROVAL_APP_SECRET: undefined,
    },
    async () => {
      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
      );
      try {
        await sendProgressNotification({
          type: "task_ddl_change_requested",
          requestId: "pw-task-ddl-request",
          taskId: "pw-task-ddl",
          taskTitle: "PW机器人-任务 DDL 待审",
          projectName: "PW机器人项目",
          requesterName: "李棋轩",
          reason: "需要调整",
          oldDueAt: "2026-06-29T18:00:00.000Z",
          newDueAt: "2026-06-30T18:00:00.000Z",
          recipientOpenIds: ["ou_approval"],
        });
      } finally {
        restoreFetch();
      }

      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "notification-app",
      ]);
      expect(capturedMessages.map((message) => message.token)).toEqual([
        "notification-token",
      ]);
      expect(capturedMessages.map((message) => message.receiveIdType)).toEqual([
        "open_id",
      ]);
      expect(capturedMessages.map((message) => message.receiveId)).toEqual([
        "ou_approval",
      ]);
    },
  );
});

test("独立审批机器人缺少 union_id 时不会回退通知机器人", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
    },
    async () => {
      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
        { failContactOpenIds: new Set(["ou_missing_union"]) },
      );
      try {
        await expect(
          sendProgressNotification({
            type: "task_creation_requested",
            requestId: "pw-missing-union-request",
            projectId: "pw-missing-union-project",
            projectName: "PW机器人-缺少union",
            taskTitle: "PW机器人-任务申请待审",
            requesterName: "李棋轩",
            team: "工程",
            techGroup: "宣运",
            projectOwnerOpenIds: ["ou_owner"],
            stageName: "当前阶段",
            assigneeNames: "李棋轩",
            taskTechGroups: ["宣运"],
            dueAt: "2026-06-30T18:00:00.000Z",
            recipientOpenIds: ["ou_missing_union"],
          }),
        ).rejects.toThrow("union_id");
      } finally {
        restoreFetch();
      }

      expect(capturedMessages).toHaveLength(0);
      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "notification-app",
      ]);
    },
  );
});

test("审批 outbox 部分收件人失败后只重试失败收件人", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
    },
    async () => {
      const eventKey = `playwright:recipient-retry:${Date.now()}`;
      await enqueueProgressNotification(
        eventKey,
        {
          type: "task_ddl_change_requested",
          requestId: "pw-recipient-retry-request",
          taskId: "pw-recipient-retry-task",
          taskTitle: "PW收件人重试任务",
          projectName: "PW收件人重试项目",
          requesterName: "李棋轩",
          reason: "验证失败收件人单独重试",
          oldDueAt: "2026-06-29T18:00:00.000Z",
          newDueAt: "2026-06-30T18:00:00.000Z",
          recipientOpenIds: ["ou_retry_ok", "ou_retry_fail", "ou_retry_other"],
        },
        { appOrigin: "http://127.0.0.1:3002" },
      );

      const firstMessages: CapturedFeishuMessage[] = [];
      const restoreFirstFetch = mockFeishuFetch(firstMessages, [], {
        failMessageReceiveIds: new Set(["on_retry_fail"]),
      });
      try {
        await expect(
          drainNotificationOutbox(10, { ignoreDeliveryDisabled: true }),
        ).resolves.toBe(0);
      } finally {
        restoreFirstFetch();
      }

      expect(firstMessages.map((message) => message.receiveId).sort()).toEqual([
        "on_retry_ok",
        "on_retry_other",
      ]);

      const firstState = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        include: {
          recipients: {
            select: { openId: true, status: true, attempts: true, lastError: true },
            orderBy: { openId: "asc" },
          },
        },
      });
      expect(firstState.status).toBe("FAILED");
      expect(firstState.recipients).toEqual([
        expect.objectContaining({
          openId: "ou_retry_fail",
          status: "FAILED",
          attempts: 1,
        }),
        expect.objectContaining({
          openId: "ou_retry_ok",
          status: "SENT",
          attempts: 1,
        }),
        expect.objectContaining({
          openId: "ou_retry_other",
          status: "SENT",
          attempts: 1,
        }),
      ]);

      await prisma.notificationOutbox.update({
        where: { eventKey },
        data: { nextRunAt: new Date() },
      });
      await prisma.notificationOutboxRecipient.updateMany({
        where: { outboxId: firstState.id, status: "FAILED" },
        data: { nextRunAt: new Date() },
      });

      const secondMessages: CapturedFeishuMessage[] = [];
      const restoreSecondFetch = mockFeishuFetch(secondMessages);
      try {
        await expect(
          drainNotificationOutbox(10, { ignoreDeliveryDisabled: true }),
        ).resolves.toBe(1);
      } finally {
        restoreSecondFetch();
      }

      expect(secondMessages.map((message) => message.receiveId)).toEqual([
        "on_retry_fail",
      ]);
      await expect(
        prisma.notificationOutbox.findUniqueOrThrow({
          where: { eventKey },
          select: {
            status: true,
            recipients: { select: { status: true } },
          },
        }),
      ).resolves.toEqual({
        status: "SENT",
        recipients: [{ status: "SENT" }, { status: "SENT" }, { status: "SENT" }],
      });
    },
  );
});

test("审批 outbox 子收件人锁未过期时父 outbox 不空转重试", async () => {
  const eventKey = `playwright:recipient-lock:${Date.now()}`;
  await enqueueProgressNotification(
    eventKey,
    {
      type: "task_ddl_change_requested",
      requestId: "pw-recipient-lock-request",
      taskId: "pw-recipient-lock-task",
      taskTitle: "PW收件人锁任务",
      projectName: "PW收件人锁项目",
      requesterName: "李棋轩",
      reason: "验证子收件人锁调度",
      oldDueAt: "2026-06-29T18:00:00.000Z",
      newDueAt: "2026-06-30T18:00:00.000Z",
      recipientOpenIds: ["ou_locked_recipient"],
    },
    { appOrigin: "http://127.0.0.1:3002" },
  );

  const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
  });
  const past = new Date(Date.now() - 60_000);
  const childLockedUntil = new Date(Date.now() + 60_000);
  await prisma.notificationOutbox.update({
    where: { id: outbox.id },
    data: {
      status: "FAILED",
      attempts: 2,
      nextRunAt: past,
      lockedUntil: null,
    },
  });
  await prisma.notificationOutboxRecipient.create({
    data: {
      outboxId: outbox.id,
      openId: "ou_locked_recipient",
      status: "PROCESSING",
      attempts: 1,
      nextRunAt: past,
      lockedUntil: childLockedUntil,
    },
  });

  const capturedMessages: CapturedFeishuMessage[] = [];
  const restoreFetch = mockFeishuFetch(capturedMessages);
  try {
    await expect(
      drainNotificationOutbox(10, { ignoreDeliveryDisabled: true }),
    ).resolves.toBe(0);
  } finally {
    restoreFetch();
  }

  expect(capturedMessages).toHaveLength(0);
  const afterFirstDrain = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { id: outbox.id },
    select: { status: true, attempts: true, nextRunAt: true },
  });
  expect(afterFirstDrain.status).toBe("FAILED");
  expect(afterFirstDrain.attempts).toBe(3);
  expect(afterFirstDrain.nextRunAt.getTime()).toBeGreaterThanOrEqual(
    childLockedUntil.getTime(),
  );

  await expect(
    drainNotificationOutbox(10, { ignoreDeliveryDisabled: true }),
  ).resolves.toBe(0);
  await expect(
    prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: outbox.id },
      select: { attempts: true },
    }),
  ).resolves.toEqual({ attempts: 3 });
});

test("手动重试审批 outbox 只恢复失败收件人不重发已成功收件人", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
    },
    async () => {
      const eventKey = `playwright:recipient-manual-retry:${Date.now()}`;
      await enqueueProgressNotification(
        eventKey,
        {
          type: "task_ddl_change_requested",
          requestId: "pw-recipient-manual-retry-request",
          taskId: "pw-recipient-manual-retry-task",
          taskTitle: "PW手动重试任务",
          projectName: "PW手动重试项目",
          requesterName: "李棋轩",
          reason: "验证手动重试不重发成功收件人",
          oldDueAt: "2026-06-29T18:00:00.000Z",
          newDueAt: "2026-06-30T18:00:00.000Z",
          recipientOpenIds: ["ou_manual_retry_ok", "ou_manual_retry_fail"],
        },
        { appOrigin: "http://127.0.0.1:3002" },
      );

      const firstMessages: CapturedFeishuMessage[] = [];
      const restoreFirstFetch = mockFeishuFetch(firstMessages, [], {
        failMessageReceiveIds: new Set(["on_manual_retry_fail"]),
      });
      try {
        await drainNotificationOutbox(10, { ignoreDeliveryDisabled: true });
      } finally {
        restoreFirstFetch();
      }
      expect(firstMessages.map((message) => message.receiveId)).toEqual([
        "on_manual_retry_ok",
      ]);

      const failedState = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        include: {
          recipients: {
            orderBy: { openId: "asc" },
            select: { openId: true, status: true, attempts: true },
          },
        },
      });
      expect(failedState.status).toBe("FAILED");
      expect(failedState.recipients).toEqual([
        expect.objectContaining({
          openId: "ou_manual_retry_fail",
          status: "FAILED",
          attempts: 1,
        }),
        expect.objectContaining({
          openId: "ou_manual_retry_ok",
          status: "SENT",
          attempts: 1,
        }),
      ]);

      await prisma.notificationOutboxRecipient.updateMany({
        where: { outboxId: failedState.id, status: "FAILED" },
        data: {
          attempts: 8,
          nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
          lastError: "mock exhausted",
        },
      });

      await expect(
        resetNotificationOutboxForRetry({
          id: failedState.id,
          channel: "progress",
          type: "task_ddl_change_requested",
        }),
      ).resolves.toEqual({ count: 1 });

      await expect(
        prisma.notificationOutboxRecipient.findMany({
          where: { outboxId: failedState.id },
          orderBy: { openId: "asc" },
          select: { openId: true, status: true, attempts: true, lastError: true },
        }),
      ).resolves.toEqual([
        {
          openId: "ou_manual_retry_fail",
          status: "PENDING",
          attempts: 0,
          lastError: "",
        },
        {
          openId: "ou_manual_retry_ok",
          status: "SENT",
          attempts: 1,
          lastError: "",
        },
      ]);

      const retryMessages: CapturedFeishuMessage[] = [];
      const restoreRetryFetch = mockFeishuFetch(retryMessages);
      try {
        await expect(
          drainNotificationOutbox(10, { ignoreDeliveryDisabled: true }),
        ).resolves.toBe(1);
      } finally {
        restoreRetryFetch();
      }

      expect(retryMessages.map((message) => message.receiveId)).toEqual([
        "on_manual_retry_fail",
      ]);
    },
  );
});

test("审批 outbox 收件人去重且空收件人不落库", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
    },
    async () => {
      const eventKey = `playwright:recipient-dedupe:${Date.now()}`;
      await enqueueProgressNotification(
        eventKey,
        {
          type: "project_establishment_requested",
          projectId: "pw-project-recipient-dedupe",
          projectName: "PW收件人去重",
          requesterName: "李棋轩",
          requesterOpenId: "ou_requester",
          team: "工程",
          techGroup: "宣运",
          ownerNames: "项目负责人",
          participantNames: "",
          stageCount: 1,
          recipientOpenIds: ["ou_duplicate", "ou_duplicate", ""],
        },
        { appOrigin: "http://127.0.0.1:3002" },
      );

      const capturedMessages: CapturedFeishuMessage[] = [];
      const restoreFetch = mockFeishuFetch(capturedMessages);
      try {
        await drainNotificationOutbox(10, { ignoreDeliveryDisabled: true });
      } finally {
        restoreFetch();
      }

      const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        include: { recipients: true },
      });
      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0]?.receiveId).toBe("on_duplicate");
      expect(outbox.recipients.map((recipient) => recipient.openId)).toEqual([
        "ou_duplicate",
      ]);
      expect(outbox.status).toBe("SENT");
    },
  );
});

test("通知机器人未配置时普通消息回退 OAuth 主应用", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: undefined,
      FEISHU_NOTIFICATION_APP_SECRET: undefined,
      FEISHU_APPROVAL_APP_ID: undefined,
      FEISHU_APPROVAL_APP_SECRET: undefined,
    },
    async () => {
      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
      );
      try {
        await sendProgressNotification({
          type: "project_canceled",
          projectId: "pw-project-oauth-fallback",
          projectName: "PW机器人-OAuth回退",
          team: "工程",
          techGroup: "宣运",
          ownerOpenIds: ["ou_owner"],
          ownerNames: "项目负责人",
          participantOpenIds: [],
          participantNames: "",
          recipientOpenIds: ["ou_notification"],
          canceledTaskCount: 0,
        });
      } finally {
        restoreFetch();
      }

      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "oauth-app",
      ]);
      expect(capturedMessages.map((message) => message.token)).toEqual([
        "oauth-token",
      ]);
    },
  );
});

test("采购审批待办 eventKey 使用状态进入时间保持稳定", async () => {
  const statusEnteredAt = new Date("2026-06-29T08:00:00.000Z");
  const firstKey = orderNotificationEventKey({
    id: "pw-order-stable-key",
    status: "MANAGEMENT_REVIEW",
    statusEnteredAt,
  });
  const secondKey = orderNotificationEventKey({
    id: "pw-order-stable-key",
    status: "MANAGEMENT_REVIEW",
    statusEnteredAt,
  });
  expect(firstKey).toBe(secondKey);

  await enqueueOrderNotification(firstKey, {
    id: "pw-order-stable-key",
    orderNo: "PW-STABLE-KEY",
    initiatorName: "李棋轩",
    totalPrice: 100,
    status: "MANAGEMENT_REVIEW",
    team: "工程",
    techGroup: "宣运",
    items: [],
  });
  await enqueueOrderNotification(secondKey, {
    id: "pw-order-stable-key",
    orderNo: "PW-STABLE-KEY",
    initiatorName: "李棋轩",
    totalPrice: 120,
    status: "MANAGEMENT_REVIEW",
    team: "工程",
    techGroup: "宣运",
    items: [],
  });

  await expect(
    prisma.notificationOutbox.count({ where: { eventKey: firstKey } }),
  ).resolves.toBe(1);
});

test("测试收件人 allowlist 只放行李棋轩", async () => {
  const allowedOpenId = `ou_allow_liqixuan_${Date.now()}`;
  const blockedOpenId = `ou_allow_blocked_${Date.now()}`;
  await prisma.user.createMany({
    data: [
      { openId: allowedOpenId, name: "李棋轩", unionId: `on_allow_liqixuan_${Date.now()}` },
      { openId: blockedOpenId, name: "其他测试用户", unionId: `on_allow_blocked_${Date.now()}` },
    ],
    skipDuplicates: true,
  });

  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: undefined,
      FEISHU_APPROVAL_APP_SECRET: undefined,
      FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES: "李棋轩",
      FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS: undefined,
      FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS: undefined,
    },
    async () => {
      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
      );
      try {
        await sendProgressNotification({
          type: "project_canceled",
          projectId: "pw-project-allowlist",
          projectName: "PW机器人-收件人拦截",
          team: "工程",
          techGroup: "宣运",
          ownerOpenIds: [allowedOpenId],
          ownerNames: "李棋轩",
          participantOpenIds: [blockedOpenId],
          participantNames: "其他测试用户",
          recipientOpenIds: [allowedOpenId, blockedOpenId],
          canceledTaskCount: 0,
        });
      } finally {
        restoreFetch();
      }

      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "notification-app",
      ]);
      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0]?.receiveId).toBe(allowedOpenId);
      expect(capturedMessages[0]?.token).toBe("notification-token");
    },
  );
});

test("采购审批催办使用审批机器人 token", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
      FEISHU_WEBHOOK_URL: undefined,
      FEISHU_PROCUREMENT_WEBHOOK_URL: undefined,
    },
    async () => {
      const suffix = Date.now();
      const openId = `ou_procurement_reminder_${suffix}`;
      const unionId = `on_procurement_reminder_${suffix}`;
      const techGroup = `PW机器人催办组-${suffix}`;
      const team = `PW机器人催办车组-${suffix}`;
      const user = await prisma.user.upsert({
        where: { openId },
        update: { name: "采购催办审批人", unionId },
        create: { openId, name: "采购催办审批人", unionId },
      });
      await prisma.purchaseOrder.updateMany({
        where: {
          status: {
            in: [
              "MANAGEMENT_REVIEW",
              "TEACHER_REVIEW",
              "PENDING_APPLICANT_DOCS",
              "PENDING_FINANCE_REVIEW",
              "PENDING_APPLICANT_CONFIRM",
            ],
          },
        },
        data: { lastReminderAt: new Date() },
      });
      await prisma.userRole.createMany({
        data: [
          {
            openId,
            role: "TECH_GROUP_ADMIN",
            team: "",
            techGroup,
          },
        ],
        skipDuplicates: true,
      });
      await prisma.purchaseOrder.create({
        data: {
          orderNo: `PW-BOT-REMINDER-${suffix}`,
          initiatorId: user.id,
          initiatorName: "李棋轩",
          team,
          techGroup,
          totalPrice: 100,
          status: "MANAGEMENT_REVIEW",
          statusEnteredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          items: {
            create: [
              {
                name: "审批催办物料",
                spec: "REM",
                purchaseLink: "https://example.com/reminder",
                quantity: 1,
                unitPrice: 100,
              },
            ],
          },
        },
      });

      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
      );
      try {
        await expect(
          runProcurementStaleReminders({
            appOrigin: "http://127.0.0.1:3002",
          }),
        ).resolves.toBeGreaterThanOrEqual(1);
      } finally {
        restoreFetch();
      }

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0]?.token).toBe("approval-token");
      expect(capturedMessages[0]?.receiveIdType).toBe("union_id");
      expect(capturedMessages[0]?.receiveId).toBe(unionId);
      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "approval-app",
        "approval-app",
      ]);
    },
  );
});

test("采购审批催办全部发送失败时不标记已催办", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
      FEISHU_WEBHOOK_URL: undefined,
      FEISHU_PROCUREMENT_WEBHOOK_URL: undefined,
    },
    async () => {
      const suffix = Date.now();
      const openId = `ou_procurement_reminder_missing_${suffix}`;
      const techGroup = `PW机器人催办缺union组-${suffix}`;
      const team = `PW机器人催办缺union车组-${suffix}`;
      const user = await prisma.user.upsert({
        where: { openId },
        update: { name: "采购催办缺Union审批人", unionId: null },
        create: { openId, name: "采购催办缺Union审批人" },
      });
      await prisma.purchaseOrder.updateMany({
        where: {
          status: {
            in: [
              "MANAGEMENT_REVIEW",
              "TEACHER_REVIEW",
              "PENDING_APPLICANT_DOCS",
              "PENDING_FINANCE_REVIEW",
              "PENDING_APPLICANT_CONFIRM",
            ],
          },
        },
        data: { lastReminderAt: new Date() },
      });
      await prisma.userRole.createMany({
        data: [
          {
            openId,
            role: "TECH_GROUP_ADMIN",
            team: "",
            techGroup,
          },
        ],
        skipDuplicates: true,
      });
      const order = await prisma.purchaseOrder.create({
        data: {
          orderNo: `PW-BOT-REMINDER-MISSING-${suffix}`,
          initiatorId: user.id,
          initiatorName: "李棋轩",
          team,
          techGroup,
          totalPrice: 100,
          status: "MANAGEMENT_REVIEW",
          statusEnteredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          items: {
            create: [
              {
                name: "审批催办缺Union物料",
                spec: "REM-MISSING",
                purchaseLink: "https://example.com/reminder-missing",
                quantity: 1,
                unitPrice: 100,
              },
            ],
          },
        },
      });

      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
        { failContactOpenIds: new Set([openId]) },
      );
      try {
        await expect(
          runProcurementStaleReminders({
            appOrigin: "http://127.0.0.1:3002",
          }),
        ).resolves.toBe(0);
      } finally {
        restoreFetch();
      }

      const updated = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { lastReminderAt: true },
      });
      expect(capturedMessages).toHaveLength(0);
      expect(updated.lastReminderAt).toBeNull();
    },
  );
});

test("机器人凭证半配置时 fail fast，避免静默串用", async () => {
  await expect(
    withFeishuBotEnv(
      {
        FEISHU_APP_ID: "oauth-app",
        FEISHU_APP_SECRET: "oauth-secret",
        FEISHU_NOTIFICATION_APP_ID: "notification-app",
        FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
        FEISHU_APPROVAL_APP_ID: "approval-app",
        FEISHU_APPROVAL_APP_SECRET: undefined,
      },
      async () => {
        await sendProgressNotification({
          type: "project_establishment_requested",
          projectId: "pw-project-half-config",
          projectName: "PW机器人-半配置",
          requesterName: "李棋轩",
          requesterOpenId: "ou_requester",
          team: "工程",
          techGroup: "宣运",
          ownerNames: "项目负责人",
          participantNames: "",
          stageCount: 1,
          recipientOpenIds: ["ou_approval"],
        });
      },
    ),
  ).rejects.toThrow("FEISHU_APPROVAL_APP_ID");

  await expect(
    withFeishuBotEnv(
      {
        FEISHU_APP_ID: "oauth-app",
        FEISHU_APP_SECRET: "oauth-secret",
        FEISHU_NOTIFICATION_APP_ID: "notification-app",
        FEISHU_NOTIFICATION_APP_SECRET: undefined,
        FEISHU_APPROVAL_APP_ID: undefined,
        FEISHU_APPROVAL_APP_SECRET: undefined,
      },
      async () => {
        await sendProgressNotification({
          type: "project_canceled",
          projectId: "pw-project-notification-half-config",
          projectName: "PW机器人-通知半配置",
          team: "工程",
          techGroup: "宣运",
          ownerOpenIds: ["ou_owner"],
          ownerNames: "项目负责人",
          participantOpenIds: [],
          participantNames: "",
          recipientOpenIds: ["ou_notification"],
          canceledTaskCount: 0,
        });
      },
    ),
  ).rejects.toThrow("FEISHU_NOTIFICATION_APP_ID");
});

test("采购待审和确认入队为审批机器人，上传凭证入队为通知机器人", async () => {
  const approvalEventKey = `playwright:procurement-bot:teacher:${Date.now()}`;
  const financeEventKey = `playwright:procurement-bot:finance:${Date.now()}`;
  const confirmEventKey = `playwright:procurement-bot:confirm:${Date.now()}`;
  const notificationEventKey = `playwright:procurement-bot:docs:${Date.now()}`;
  const baseOrder = {
    id: "pw-order-bot-routing",
    orderNo: "PW-BOT-001",
    initiatorName: "李棋轩",
    totalPrice: 100,
    team: "工程",
    techGroup: "宣运",
    items: [],
  };

  await enqueueOrderNotification(approvalEventKey, {
    ...baseOrder,
    status: "TEACHER_REVIEW",
  });
  await enqueueOrderNotification(financeEventKey, {
    ...baseOrder,
    id: "pw-order-bot-routing-finance",
    orderNo: "PW-BOT-004",
    status: "PENDING_FINANCE_REVIEW",
  });
  await enqueueOrderNotification(confirmEventKey, {
    ...baseOrder,
    id: "pw-order-bot-routing-confirm",
    orderNo: "PW-BOT-003",
    status: "PENDING_APPLICANT_CONFIRM",
  });
  await enqueueOrderNotification(notificationEventKey, {
    ...baseOrder,
    id: "pw-order-bot-routing-docs",
    orderNo: "PW-BOT-002",
    status: "PENDING_APPLICANT_DOCS",
  });

  const rows = await prisma.notificationOutbox.findMany({
    where: {
      eventKey: {
        in: [
          approvalEventKey,
          financeEventKey,
          confirmEventKey,
          notificationEventKey,
        ],
      },
    },
    select: { eventKey: true, channel: true, type: true, botKind: true },
    orderBy: { eventKey: "asc" },
  });

  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        eventKey: approvalEventKey,
        channel: "procurement",
        type: "order",
        botKind: "approval",
      }),
      expect.objectContaining({
        eventKey: financeEventKey,
        channel: "procurement",
        type: "order",
        botKind: "approval",
      }),
      expect.objectContaining({
        eventKey: confirmEventKey,
        channel: "procurement",
        type: "order",
        botKind: "approval",
      }),
      expect.objectContaining({
        eventKey: notificationEventKey,
        channel: "procurement",
        type: "order",
        botKind: "notification",
      }),
    ]),
  );
});

test("采购 CardKit 审批卡使用审批机器人 token", async () => {
  await withFeishuBotEnv(
    {
      FEISHU_APP_ID: "oauth-app",
      FEISHU_APP_SECRET: "oauth-secret",
      FEISHU_NOTIFICATION_APP_ID: "notification-app",
      FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
      FEISHU_APPROVAL_APP_ID: "approval-app",
      FEISHU_APPROVAL_APP_SECRET: "approval-secret",
      FEISHU_WEBHOOK_URL: undefined,
      FEISHU_PROCUREMENT_WEBHOOK_URL: undefined,
    },
    async () => {
      const openId = `ou_procurement_approval_${Date.now()}`;
      const techGroup = `PW机器人审批组-${Date.now()}`;
      const team = `PW机器人车组-${Date.now()}`;
      await prisma.user.upsert({
        where: { openId },
        update: { name: "采购审批人" },
        create: { openId, name: "采购审批人" },
      });
      await prisma.userRole.createMany({
        data: [
          {
            openId,
            role: "TECH_GROUP_ADMIN",
            team: "",
            techGroup,
          },
        ],
        skipDuplicates: true,
      });

      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
      );
      try {
        await sendOrderNotification({
          id: "pw-order-cardkit-approval",
          orderNo: "PW-BOT-CARDKIT",
          initiatorName: "李棋轩",
          totalPrice: 100,
          status: "MANAGEMENT_REVIEW",
          team,
          techGroup,
          items: [],
        });
      } finally {
        restoreFetch();
      }

      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "notification-app",
        "approval-app",
        "approval-app",
      ]);
      expect(capturedMessages.map((message) => message.token)).toEqual([
        "approval-token",
      ]);
      expect(capturedMessages.map((message) => message.receiveIdType)).toEqual([
        "union_id",
      ]);
      expect(capturedMessages.map((message) => message.receiveId)).toEqual([
        `on_procurement_approval_${openId.replace(/^ou_procurement_approval_/, "")}`,
      ]);
    },
  );
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
      select: {
        eventKey: true,
        channel: true,
        botKind: true,
        type: true,
        payload: true,
        status: true,
      },
    });
    expect(outboxes).toHaveLength(1);
    expect(outboxes[0]?.eventKey).toBe(eventKey);
    expect(outboxes[0]?.eventKey).not.toContain(":recipient:");
    expect(outboxes[0]?.channel).toBe("progress");
    expect(outboxes[0]?.type).toBe(payload.type);
    expect(outboxes[0]?.botKind).toBe(resolveProgressBotKind(payload.type));
    expect(outboxes[0]?.status).toBe("PENDING");
    expect(outboxes[0]?.payload).toContain("recipientOpenIds");

    const sentCount = await drainNotificationOutbox(10);
    expect(sentCount).toBe(notificationDeliveryDisabled ? 0 : 1);

    const stored = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      select: { status: true, attempts: true, lastError: true },
    });
    if (notificationDeliveryDisabled) {
      expect(stored).toMatchObject({
        status: "PENDING",
        attempts: 0,
        lastError: "",
      });
      await sendProgressNotification(payload, {
        appOrigin: "http://127.0.0.1:3002",
      });
    } else {
      expect(stored).toMatchObject({
        status: "SENT",
        attempts: 1,
        lastError: "",
      });
    }

    return capturedMessages;
  } finally {
    restoreFetch();
  }
}

function mockFeishuFetch(
  capturedMessages: CapturedFeishuMessage[],
  capturedAuthRequests: CapturedFeishuAuthRequest[] = [],
  options: {
    failContactOpenIds?: Set<string>;
    failMessageReceiveIds?: Set<string>;
  } = {},
): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input);
    if (url.includes("/auth/v3/app_access_token/internal")) {
      const body = parseJsonRecord(init?.body);
      const appId = readString(body.app_id);
      capturedAuthRequests.push({
        appId,
        appSecret: readString(body.app_secret),
      });
      return Response.json({
        code: 0,
        tenant_access_token: tokenForAppId(appId),
      });
    }

    if (url.includes("/cardkit/v1/cards")) {
      return Response.json({
        code: 0,
        msg: "ok",
        data: { card_id: "playwright-cardkit-card" },
      });
    }

    if (url.includes("/im/v1/messages")) {
      const body = parseJsonRecord(init?.body);
      const receiveId = readString(body.receive_id);
      if (options.failMessageReceiveIds?.has(receiveId)) {
        return Response.json({ code: 230006, msg: "mock message failure" });
      }
      const card = parseJsonRecord(body.content);
      capturedMessages.push({
        receiveId,
        receiveIdType:
          new URL(url).searchParams.get("receive_id_type") ?? "open_id",
        title:
          typeof card.type === "string" && card.type === "card"
            ? "CardKit"
            : readNestedString(card, ["header", "title", "content"]),
        cardText: JSON.stringify(card),
        token: readAuthorizationToken(init?.headers),
      });
      return Response.json({ code: 0, msg: "ok" });
    }

    if (url.includes("/contact/v3/users/")) {
      const request = new URL(url);
      const rawId = decodeURIComponent(request.pathname.split("/").pop() ?? "");
      if (options.failContactOpenIds?.has(rawId)) {
        return Response.json({ code: 404, msg: "not found" });
      }
      const userIdType = request.searchParams.get("user_id_type");
      const suffix = rawId.replace(/^(ou_|on_)/, "");
      return Response.json({
        code: 0,
        msg: "ok",
        data: {
          user: {
            open_id: userIdType === "union_id" ? `ou_${suffix}` : rawId,
            union_id: userIdType === "open_id" ? `on_${suffix}` : rawId,
          },
        },
      });
    }

    throw new Error(`Unexpected Feishu fetch in notification test: ${url}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function withFeishuBotEnv(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>,
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function tokenForAppId(appId: string): string {
  if (appId === process.env.FEISHU_APPROVAL_APP_ID) return "approval-token";
  if (appId === process.env.FEISHU_NOTIFICATION_APP_ID) {
    return "notification-token";
  }
  if (appId === process.env.FEISHU_APP_ID) return "oauth-token";
  return "playwright-tenant-token";
}

function readAuthorizationToken(headers: HeadersInit | undefined): string {
  const authorization = new Headers(headers).get("Authorization") ?? "";
  return authorization.replace(/^Bearer\s+/i, "");
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
