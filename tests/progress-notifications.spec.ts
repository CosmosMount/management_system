import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  runWeeklyReportReminders,
  sendProgressNotification,
  type ProgressNotifyPayload,
} from "../lib/feishu-progress";
import { sendOrderNotification } from "../lib/feishu";
import { runProcurementStaleReminders } from "../lib/procurement-reminders";
import {
  getProgressDailySummarySetting,
  runProgressDailySummaries,
  runProgressDailySummariesIfDue,
  saveProgressDailySummarySetting,
  sendProgressDailySummaryTest,
  validateDailySummaryScheduleTimes,
} from "../lib/progress-daily-summary";
import { runSingleProgressReminderRule } from "../lib/progress-reminders";
import {
  drainNotificationOutbox,
  enqueueOrderNotification,
  enqueueProgressNotification,
  enqueueProgressNotificationTx,
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

test("审批提醒使用审批机器人并发送完整中文卡片", async () => {
  const eventKey = `playwright:progress-notify:approval_reminder:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "approval_reminder_requested",
    approvalKindLabel: "任务 DDL",
    projectName: "PW通知-审批提醒项目",
    subject: "机械臂联调任务",
    submitterName: "李棋轩",
    reminderName: "项目负责人",
    submittedAt: "2026-07-18T02:30:00.000Z",
    recipientOpenIds: ["ou_approval_reminder"],
    linkPath: "/progress/task/pw-approval-reminder-task",
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(resolveProgressBotKind(payload.type)).toBe("approval");
  expect(captured).toHaveLength(1);
  expect(captured[0]?.title).toBe("审批提醒");
  expect(captured[0]?.cardText).toContain("审批类型");
  expect(captured[0]?.cardText).toContain("任务 DDL");
  expect(captured[0]?.cardText).toContain("PW通知-审批提醒项目");
  expect(captured[0]?.cardText).toContain("审批事项");
  expect(captured[0]?.cardText).toContain("机械臂联调任务");
  expect(captured[0]?.cardText).toContain("提交人");
  expect(captured[0]?.cardText).toContain("提醒人");
  expect(captured[0]?.cardText).toContain("查看审批");
  expect(captured[0]?.cardText).toContain(
    "http://127.0.0.1:3002/progress/task/pw-approval-reminder-task",
  );
});

test("审批撤回使用审批机器人并发送完整中文卡片", async () => {
  const eventKey = `playwright:progress-notify:approval_withdrawn:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "approval_withdrawn",
    approvalKindLabel: "阶段验收",
    projectName: "PW通知-审批撤回项目",
    subject: "结构设计阶段",
    submitterName: "李棋轩",
    withdrawnAt: "2026-07-18T03:30:00.000Z",
    recipientOpenIds: ["ou_approval_withdrawn"],
    linkPath: "/progress/pw-approval-withdrawn?stage=pw-stage",
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(resolveProgressBotKind(payload.type)).toBe("approval");
  expect(captured).toHaveLength(1);
  expect(captured[0]?.title).toBe("审批已撤回");
  expect(captured[0]?.cardText).toContain("审批类型");
  expect(captured[0]?.cardText).toContain("阶段验收");
  expect(captured[0]?.cardText).toContain("PW通知-审批撤回项目");
  expect(captured[0]?.cardText).toContain("审批事项");
  expect(captured[0]?.cardText).toContain("结构设计阶段");
  expect(captured[0]?.cardText).toContain("提交人");
  expect(captured[0]?.cardText).toContain("撤回时间");
  expect(captured[0]?.cardText).toContain("查看详情");
  expect(captured[0]?.cardText).toContain(
    "http://127.0.0.1:3002/progress/pw-approval-withdrawn?stage=pw-stage",
  );
  expect(captured[0]?.cardText).not.toMatch(
    /approval_withdrawn|STAGE_ACCEPTANCE|WITHDRAWN/,
  );
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

test("项目评论通知使用普通通知机器人并展示完整评论信息", async () => {
  const eventKey = `playwright:progress-notify:project_comment_created:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "project_comment_created",
    projectId: "pw-project-comment-notify",
    projectName: "PW通知-评论项目",
    authorOpenId: "ou_comment_author",
    authorName: "评论人",
    content: "这里是项目评论的完整内容，需要提醒关注者查看。",
    createdAt: "2026-07-06T11:00:00.000Z",
    team: "工程",
    techGroup: "宣运",
    ownerNames: "项目负责人",
    currentStageName: "联调阶段",
    recipientOpenIds: ["ou_owner", "ou_follower", "ou_owner"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);
  const stored = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
    select: { botKind: true },
  });

  expect(stored.botKind).toBe("notification");
  expect(captured.map((message) => message.receiveId).sort()).toEqual([
    "ou_follower",
    "ou_owner",
  ]);
  expect(captured.every((message) => message.receiveIdType === "open_id")).toBe(
    true,
  );
  expect(captured).toHaveLength(2);
  expect(captured.every((message) => message.token === "notification-token")).toBe(
    true,
  );
  expect(captured.every((message) => message.title === "项目有新评论")).toBe(true);
  expect(captured[0]?.cardText).toContain("PW通知-评论项目");
  expect(captured[0]?.cardText).toContain("评论人");
  expect(captured[0]?.cardText).toContain("联调阶段");
  expect(captured[0]?.cardText).toContain("项目负责人");
  expect(captured[0]?.cardText).toContain("工程 / 宣运");
  expect(captured[0]?.cardText).toContain("这里是项目评论的完整内容");
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

test("新任务指派通知包含任务完整摘要", async () => {
  const eventKey = `playwright:progress-notify:task_assigned:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "task_assigned",
    taskId: "pw-task-assigned",
    taskTitle: "PW通知-完整任务指派",
    projectId: "pw-task-assigned-project",
    projectName: "PW通知-任务项目",
    actorName: "项目管理员",
    stageName: "联调阶段",
    assigneeNames: "李棋轩、张宇山",
    taskTechGroups: ["机械", "电控"],
    urgency: "HIGH",
    importance: "MEDIUM",
    dueAt: "2026-07-12T10:00:00.000Z",
    metrics: "完成文档评审并输出结论",
    goal: "补全测试方案文档",
    needsWeeklyReport: true,
    needsOfflineConfirmation: true,
    acceptanceChecklistItems: ["文档链接可访问", "指标说明完整"],
    team: "工程",
    techGroup: "宣运",
    assigneeOpenIds: ["ou_assignee"],
    recipientOpenIds: ["ou_assignee"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);

  expect(captured).toHaveLength(1);
  expect(captured[0]?.title).toBe("新任务指派");
  expect(captured[0]?.cardText).toContain("PW通知-完整任务指派");
  expect(captured[0]?.cardText).toContain("创建人");
  expect(captured[0]?.cardText).toContain("阶段");
  expect(captured[0]?.cardText).toContain("负责人");
  expect(captured[0]?.cardText).toContain("任务技术组");
  expect(captured[0]?.cardText).toContain("紧急/重要");
  expect(captured[0]?.cardText).toContain("DDL");
  expect(captured[0]?.cardText).toContain("定期周报");
  expect(captured[0]?.cardText).toContain("任务开始后生效");
  expect(captured[0]?.cardText).toContain("线下确认");
  expect(captured[0]?.cardText).toContain("指标");
  expect(captured[0]?.cardText).toContain("详细说明");
  expect(captured[0]?.cardText).toContain("验收清单");
});

test("任务申请通过通知包含任务完整摘要且使用通知机器人", async () => {
  const eventKey = `playwright:progress-notify:task_creation_approved:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "task_creation_approved",
    requestId: "pw-task-request-approved",
    taskId: "pw-task-created-from-request",
    projectId: "pw-project-task-request",
    projectName: "PW通知-任务申请项目",
    taskTitle: "PW通知-申请通过任务",
    reviewerName: "项目管理员",
    requesterOpenId: "ou_requester",
    stageName: "研发阶段",
    assigneeNames: "李棋轩",
    taskTechGroups: ["宣运"],
    urgency: "MEDIUM",
    importance: "HIGH",
    dueAt: "2026-07-13T10:00:00.000Z",
    metrics: "完成样件验收",
    goal: "对样件进行验收并记录问题",
    needsWeeklyReport: false,
    needsOfflineConfirmation: false,
    acceptanceChecklistItems: ["验收记录完整"],
    assigneeOpenIds: ["ou_assignee"],
    team: "工程",
    techGroup: "宣运",
    projectOwnerOpenIds: ["ou_owner"],
    recipientOpenIds: ["ou_requester", "ou_assignee"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);
  const stored = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
    select: { botKind: true },
  });

  expect(stored.botKind).toBe("notification");
  expect(captured).toHaveLength(2);
  expect(captured.every((message) => message.title === "任务申请已通过")).toBe(
    true,
  );
  expect(captured[0]?.cardText).toContain("审核人");
  expect(captured[0]?.cardText).toContain("阶段");
  expect(captured[0]?.cardText).toContain("负责人");
  expect(captured[0]?.cardText).toContain("任务技术组");
  expect(captured[0]?.cardText).toContain("紧急/重要");
  expect(captured[0]?.cardText).toContain("DDL");
  expect(captured[0]?.cardText).toContain("定期周报");
  expect(captured[0]?.cardText).toContain("不需要");
  expect(captured[0]?.cardText).toContain("验收清单");
});

test("任务验收驳回通知包含完整提交和审核信息", async () => {
  const eventKey = `playwright:progress-notify:task_rejected:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "task_rejected",
    taskId: "pw-task-delivery-rejected",
    taskTitle: "PW通知-验收驳回任务",
    projectName: "PW通知-任务验收项目",
    stageName: "验收阶段",
    assigneeNames: "李棋轩、张宇山",
    taskTechGroups: ["机械", "电控"],
    reviewerName: "项目管理员",
    submitterName: "李棋轩",
    feishuDocUrl: "https://example.feishu.cn/docx/rejected-delivery",
    keyDataUrl: "https://example.feishu.cn/sheets/rejected-data",
    assigneeOpenIds: ["ou_assignee"],
    comment: "交付材料缺少关键数据截图",
    recipientOpenIds: ["ou_assignee"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);
  const stored = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
    select: { botKind: true },
  });

  expect(stored.botKind).toBe("notification");
  expect(captured).toHaveLength(1);
  expect(captured[0]?.title).toBe("任务验收驳回");
  expect(captured[0]?.cardText).toContain("PW通知-验收驳回任务");
  expect(captured[0]?.cardText).toContain("验收阶段");
  expect(captured[0]?.cardText).toContain("李棋轩、张宇山");
  expect(captured[0]?.cardText).toContain("任务技术组");
  expect(captured[0]?.cardText).toContain("项目管理员");
  expect(captured[0]?.cardText).toContain("提交人");
  expect(captured[0]?.cardText).toContain("飞书文档");
  expect(captured[0]?.cardText).toContain("关键数据");
  expect(captured[0]?.cardText).toContain("交付材料缺少关键数据截图");
});

test("任务申请驳回通知显式发送给申请人并使用通知机器人", async () => {
  const eventKey = `playwright:progress-notify:task_creation_rejected:${Date.now()}`;
  const payload: ProgressNotifyPayload = {
    type: "task_creation_rejected",
    requestId: "pw-task-creation-rejected",
    projectId: "pw-project-task-creation-rejected",
    projectName: "PW通知-任务申请驳回项目",
    taskTitle: "PW通知-被驳回任务",
    reviewerName: "审批人",
    requesterOpenId: "ou_requester",
    comment: "任务内容不完整",
    recipientOpenIds: ["ou_requester"],
  };

  const captured = await enqueueAndDrainProgressNotification(eventKey, payload);
  const stored = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
    select: { botKind: true },
  });

  expect(stored.botKind).toBe("notification");
  expect(captured).toHaveLength(1);
  expect(captured[0]?.receiveId).toBe("ou_requester");
  expect(captured[0]?.receiveIdType).toBe("open_id");
  expect(captured[0]?.token).toBe("notification-token");
  expect(captured[0]?.title).toBe("任务申请已驳回");
  expect(captured[0]?.cardText).toContain("PW通知-被驳回任务");
  expect(captured[0]?.cardText).toContain("任务内容不完整");
});

test("每日进度摘要为指定用户入队任务、项目和 DDL 汇总", async () => {
  const suffix = Date.now();
  const liOpenId = `ou_pw_daily_li_${suffix}`;
  const otherOpenId = `ou_pw_daily_other_${suffix}`;
  const projectName = `PW通知-每日摘要项目-${suffix}`;
  const taskTitle = `PW通知-每日摘要任务-${suffix}`;
  const overdueTaskTitle = `PW通知-每日摘要已逾期任务-${suffix}`;
  const taskOnlyProjectName = `PW通知-单任务关注项目-${suffix}`;
  const taskOnlyTitle = `PW通知-单任务关注任务-${suffix}`;
  const now = new Date("2026-07-06T19:00:00+08:00");

  await prisma.user.createMany({
    data: [
      { openId: liOpenId, name: "李棋轩", unionId: `on_pw_daily_li_${suffix}` },
      {
        openId: otherOpenId,
        name: "其他摘要用户",
        unionId: `on_pw_daily_other_${suffix}`,
      },
    ],
    skipDuplicates: true,
  });
  const project = await prisma.project.create({
    data: {
      name: projectName,
      description: "验证每日进度摘要",
      team: "英雄",
      techGroup: "电控",
      status: "IN_PROGRESS",
      ownerOpenId: liOpenId,
      ownerName: "李棋轩",
      owners: {
        create: [{ openId: liOpenId, name: "李棋轩", sortOrder: 0 }],
      },
      participants: {
        create: [{ openId: otherOpenId, name: "其他摘要用户", sortOrder: 0 }],
      },
    },
  });
  const stage = await prisma.projectStage.create({
    data: {
      projectId: project.id,
      name: "摘要联调阶段",
      goal: "验证阶段 DDL 展示",
      sortOrder: 0,
      status: "IN_PROGRESS",
      ownerOpenId: liOpenId,
      ownerName: "李棋轩",
      dueAt: new Date("2026-07-07T18:00:00+08:00"),
      riskNote: "阶段联调存在阻塞",
    },
  });
  await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: stage.id,
      title: taskTitle,
      goal: "验证每日摘要任务列表",
      urgency: "HIGH",
      importance: "HIGH",
      assigneeOpenId: liOpenId,
      assigneeName: "李棋轩",
      team: "英雄",
      techGroup: "电控",
      dueAt: new Date("2026-07-06T21:00:00+08:00"),
      status: "IN_PROGRESS",
      needsWeeklyReport: true,
      riskNote: "任务风险需要关注",
      assignees: {
        create: [{ openId: liOpenId, name: "李棋轩", sortOrder: 0 }],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
    },
  });
  await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: stage.id,
      title: overdueTaskTitle,
      goal: "验证当天已经过期的 DDL",
      urgency: "MEDIUM",
      importance: "HIGH",
      assigneeOpenId: liOpenId,
      assigneeName: "李棋轩",
      team: "英雄",
      techGroup: "电控",
      dueAt: new Date("2026-07-06T18:00:00+08:00"),
      status: "IN_PROGRESS",
      assignees: {
        create: [{ openId: liOpenId, name: "李棋轩", sortOrder: 0 }],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
    },
  });
  const taskOnlyProject = await prisma.project.create({
    data: {
      name: taskOnlyProjectName,
      description: "验证只关注单个任务时不附带项目状态",
      team: "英雄",
      techGroup: "机械",
      status: "IN_PROGRESS",
      ownerOpenId: otherOpenId,
      ownerName: "其他摘要用户",
      owners: {
        create: [{ openId: otherOpenId, name: "其他摘要用户", sortOrder: 0 }],
      },
    },
  });
  const taskOnlyStage = await prisma.projectStage.create({
    data: {
      projectId: taskOnlyProject.id,
      name: "只关注任务阶段",
      goal: "验证单任务关注",
      sortOrder: 0,
      status: "IN_PROGRESS",
      ownerOpenId: otherOpenId,
      ownerName: "其他摘要用户",
      dueAt: new Date("2026-07-12T18:00:00+08:00"),
    },
  });
  const taskOnly = await prisma.task.create({
    data: {
      projectId: taskOnlyProject.id,
      stageId: taskOnlyStage.id,
      title: taskOnlyTitle,
      goal: "李棋轩只关注该任务",
      urgency: "LOW",
      importance: "MEDIUM",
      assigneeOpenId: otherOpenId,
      assigneeName: "其他摘要用户",
      team: "英雄",
      techGroup: "机械",
      dueAt: new Date("2026-07-08T18:00:00+08:00"),
      status: "IN_PROGRESS",
      assignees: {
        create: [{ openId: otherOpenId, name: "其他摘要用户", sortOrder: 0 }],
      },
      techGroups: {
        create: [{ techGroup: "机械", sortOrder: 0 }],
      },
    },
  });
  await prisma.taskFollowPreference.create({
    data: { taskId: taskOnly.id, openId: liOpenId, state: "FOLLOWING" },
  });

  const first = await runProgressDailySummaries({
    now,
    scheduledFor: now,
    scheduleTime: "19:00",
    recipientOpenIds: [liOpenId],
    context: { appOrigin: "http://127.0.0.1:3002" },
  });
  const second = await runProgressDailySummaries({
    now,
    scheduledFor: now,
    scheduleTime: "19:00",
    recipientOpenIds: [liOpenId],
    context: { appOrigin: "http://127.0.0.1:3002" },
  });
  const later = new Date("2026-07-06T20:00:00+08:00");
  const third = await runProgressDailySummaries({
    now: later,
    scheduledFor: later,
    scheduleTime: "20:00",
    recipientOpenIds: [liOpenId],
    context: { appOrigin: "http://127.0.0.1:3002" },
  });

  expect(first).toMatchObject({
    summaryDate: "2026-07-06",
    recipients: 1,
    queued: 1,
  });
  expect(second).toMatchObject({
    summaryDate: "2026-07-06",
    recipients: 1,
    queued: 0,
  });
  expect(third).toMatchObject({ queued: 1 });
  await expect(
    prisma.notificationOutbox.findUnique({
      where: { eventKey: `progress:daily_summary:${liOpenId}:2026-07-06:20:00` },
    }),
  ).resolves.not.toBeNull();

  const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey: `progress:daily_summary:${liOpenId}:2026-07-06:19:00` },
    select: { botKind: true, type: true, payload: true },
  });
  const payload = readProgressOutboxPayload(outbox.payload);
  const tasks = payload.tasks as Array<Record<string, unknown>>;
  const projects = payload.projects as Array<Record<string, unknown>>;
  const ddlItems = payload.ddlItems as Array<Record<string, unknown>>;
  const taskTitles = tasks.map((task) => task.title);
  const projectNames = projects.map((project) => project.name);

  expect(outbox.botKind).toBe("notification");
  expect(outbox.type).toBe("progress_daily_summary");
  expect(payload.recipientOpenIds).toEqual([liOpenId]);
  expect(payload.recipientName).toBe("李棋轩");
  expect(tasks.find((task) => task.title === taskTitle)).toMatchObject({
    title: taskTitle,
    projectName,
    stageName: "摘要联调阶段",
    dueLabel: "今天截止",
    needsWeeklyReport: true,
    riskNote: "任务风险需要关注",
  });
  expect(tasks.find((task) => task.title === overdueTaskTitle)).toMatchObject({
    title: overdueTaskTitle,
    dueLabel: "今日已逾期",
    isOverdue: true,
  });
  expect(taskTitles).toContain(taskOnlyTitle);
  expect(projectNames).not.toContain(taskOnlyProjectName);
  expect(projects.find((project) => project.name === projectName)).toMatchObject({
    name: projectName,
    statusLabel: "进行中",
    currentStageName: "摘要联调阶段",
  });
  expect(ddlItems.some((item) => item.kind === "TASK" && item.title === taskTitle))
    .toBe(true);
  expect(ddlItems.some((item) => item.kind === "TASK" && item.title === overdueTaskTitle))
    .toBe(true);
  expect(ddlItems.some((item) => item.kind === "STAGE" && item.title === "摘要联调阶段"))
    .toBe(true);
  expect(payload.overview).toMatchObject({
    overdueTaskCount: 1,
    overdueDdlCount: 1,
  });
  expect(payload.linkPath).toBe("/progress");
  expect(payload.approvalsLinkPath).toBe("/progress/approvals");
});

test("每日进度摘要设置控制启停、到点和同日幂等", async () => {
  await prisma.notificationOutbox.deleteMany({
    where: { channel: "progress", type: "progress_daily_summary" },
  });
  await prisma.progressDailySummarySetting.deleteMany();

  const defaultSetting = await getProgressDailySummarySetting();
  expect(defaultSetting).toMatchObject({
    enabled: true,
    schedules: [{ scheduleTime: "19:00", lastRunAt: null }],
  });

  await saveProgressDailySummarySetting({ enabled: false, scheduleTimes: ["19:00"] });
  const disabled = await runProgressDailySummariesIfDue({
    now: new Date("2026-07-06T20:00:00+08:00"),
  });
  expect(disabled).toMatchObject({
    ran: false,
    reason: "disabled",
    scheduleTimes: ["19:00"],
  });

  await saveProgressDailySummarySetting({ enabled: true, scheduleTimes: ["23:00"] });
  await prisma.progressDailySummarySchedule.updateMany({
    data: { activeFrom: new Date("2026-07-06T20:00:00+08:00") },
  });
  const notDue = await runProgressDailySummariesIfDue({
    now: new Date("2026-07-06T20:00:00+08:00"),
  });
  expect(notDue).toMatchObject({
    ran: false,
    reason: "not_due",
    scheduleTimes: ["23:00"],
  });

  await saveProgressDailySummarySetting({ enabled: true, scheduleTimes: ["19:00"] });
  await prisma.progressDailySummarySchedule.update({
    where: { settingId_scheduleTime: { settingId: "default", scheduleTime: "19:00" } },
    data: {
      activeFrom: new Date("2026-07-05T00:00:00+08:00"),
      lastProcessedSlotAt: new Date("2026-07-06T19:00:00+08:00"),
      lastRunAt: new Date("2026-07-06T19:01:00+08:00"),
    },
  });
  const alreadyRan = await runProgressDailySummariesIfDue({
    now: new Date("2026-07-06T20:00:00+08:00"),
  });
  expect(alreadyRan).toMatchObject({
    ran: false,
    reason: "already_ran",
    scheduleTimes: ["19:00"],
  });

  await prisma.progressDailySummarySchedule.update({
    where: { settingId_scheduleTime: { settingId: "default", scheduleTime: "19:00" } },
    data: {
      lastProcessedSlotAt: new Date("2026-07-05T19:00:00+08:00"),
      lastRunAt: new Date("2026-07-05T19:01:00+08:00"),
    },
  });
  const due = await runProgressDailySummariesIfDue({
    now: new Date("2026-07-06T20:00:00+08:00"),
    context: { appOrigin: "http://127.0.0.1:3002" },
  });
  expect(due.ran).toBe(true);
  const saved = await getProgressDailySummarySetting();
  expect(saved.schedules[0]?.lastRunAt).toBe("2026-07-06T12:00:00.000Z");
});

test("每日进度摘要设置校验数量、重复和跨午夜最小间隔", async () => {
  expect(validateDailySummaryScheduleTimes(["19:00", "09:00"])).toEqual([
    "09:00",
    "19:00",
  ]);
  expect(() => validateDailySummaryScheduleTimes([])).toThrow(
    "请至少配置一个发送时间",
  );
  expect(() =>
    validateDailySummaryScheduleTimes([
      "01:00",
      "02:00",
      "03:00",
      "04:00",
      "05:00",
      "06:00",
      "07:00",
      "08:00",
      "09:00",
    ]),
  ).toThrow("每天最多配置 8 个发送时间");
  expect(() => validateDailySummaryScheduleTimes(["09:00", "09:00"])).toThrow(
    "发送时间不能重复",
  );
  expect(() => validateDailySummaryScheduleTimes(["09:00", "09:04"])).toThrow(
    "相邻发送时间至少间隔 5 分钟",
  );
  expect(() => validateDailySummaryScheduleTimes(["00:02", "23:58"])).toThrow(
    "相邻发送时间至少间隔 5 分钟",
  );
  expect(() => validateDailySummaryScheduleTimes(["9:00"])).toThrow(
    "请输入有效的发送时间",
  );
});

test("每日进度摘要并发保存不会产生任一请求都未包含的残缺时刻集合", async () => {
  await prisma.progressDailySummarySetting.deleteMany();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await saveProgressDailySummarySetting({ enabled: true, scheduleTimes: ["19:00"] });
    await Promise.all([
      saveProgressDailySummarySetting({ enabled: true, scheduleTimes: ["20:00"] }),
      saveProgressDailySummarySetting({
        enabled: true,
        scheduleTimes: ["19:00", "21:00"],
      }),
    ]);
    const savedTimes = (
      await prisma.progressDailySummarySchedule.findMany({
        where: { settingId: "default" },
        orderBy: { scheduleTime: "asc" },
        select: { scheduleTime: true },
      })
    ).map((row) => row.scheduleTime);
    expect([["20:00"], ["19:00", "21:00"]]).toContainEqual(savedTimes);
  }
});

test("每日进度摘要积压多个时刻只执行最近一场并记录其余场次", async () => {
  await prisma.progressDailySummarySetting.deleteMany();
  await saveProgressDailySummarySetting({
    enabled: true,
    scheduleTimes: ["09:00", "12:00", "19:00"],
  });
  await prisma.progressDailySummarySchedule.updateMany({
    where: { settingId: "default" },
    data: { activeFrom: new Date("2026-07-05T00:00:00+08:00") },
  });

  const result = await runProgressDailySummariesIfDue({
    now: new Date("2026-07-06T20:00:00+08:00"),
    context: { appOrigin: "http://127.0.0.1:3002" },
  });
  expect(result).toMatchObject({
    ran: true,
    scheduleTime: "19:00",
    scheduledFor: "2026-07-06T11:00:00.000Z",
    skippedScheduleTimes: ["12:00", "09:00"],
  });
  const schedules = await prisma.progressDailySummarySchedule.findMany({
    where: { settingId: "default" },
    orderBy: { scheduleTime: "asc" },
  });
  expect(schedules.map((row) => row.lastProcessedSlotAt?.toISOString())).toEqual([
    "2026-07-06T01:00:00.000Z",
    "2026-07-06T04:00:00.000Z",
    "2026-07-06T11:00:00.000Z",
  ]);
  expect(schedules.map((row) => row.lastRunAt?.toISOString() ?? null)).toEqual([
    null,
    null,
    "2026-07-06T12:00:00.000Z",
  ]);

  const repeated = await runProgressDailySummariesIfDue({
    now: new Date("2026-07-06T20:04:00+08:00"),
  });
  expect(repeated).toMatchObject({ ran: false, reason: "already_ran" });
});

test("每日进度摘要可在午夜后处理前一日临近午夜的时刻", async () => {
  await prisma.progressDailySummarySetting.deleteMany();
  await saveProgressDailySummarySetting({ enabled: true, scheduleTimes: ["23:58"] });
  await prisma.progressDailySummarySchedule.updateMany({
    data: { activeFrom: new Date("2026-07-05T00:00:00+08:00") },
  });

  const result = await runProgressDailySummariesIfDue({
    now: new Date("2026-07-07T00:01:00+08:00"),
    context: { appOrigin: "http://127.0.0.1:3002" },
  });
  expect(result).toMatchObject({
    ran: true,
    scheduleTime: "23:58",
    scheduledFor: "2026-07-06T15:58:00.000Z",
  });
});

test("每日进度摘要首次设置兼容旧 cron 环境变量", async () => {
  const previous = process.env.PROGRESS_DAILY_SUMMARY_CRON;
  await prisma.progressDailySummarySetting.deleteMany();
  process.env.PROGRESS_DAILY_SUMMARY_CRON = "30 21 * * *";
  try {
    const defaultSetting = await getProgressDailySummarySetting();
    expect(defaultSetting).toMatchObject({
      enabled: true,
      schedules: [{ scheduleTime: "21:30", lastRunAt: null }],
    });
  } finally {
    if (previous === undefined) {
      delete process.env.PROGRESS_DAILY_SUMMARY_CRON;
    } else {
      process.env.PROGRESS_DAILY_SUMMARY_CRON = previous;
    }
    await prisma.progressDailySummarySetting.deleteMany();
  }
});

test("每日进度摘要单人测试为空用户也入队且不更新正式运行时间", async () => {
  const suffix = Date.now();
  const openId = `ou_pw_daily_empty_${suffix}`;
  await prisma.notificationOutbox.deleteMany({
    where: { channel: "progress", type: "progress_daily_summary" },
  });
  await prisma.progressDailySummarySetting.deleteMany();
  await prisma.user.create({
    data: { openId, name: `PW空摘要用户-${suffix}` },
  });
  await saveProgressDailySummarySetting({ enabled: true, scheduleTimes: ["19:00"] });
  await prisma.progressDailySummarySchedule.update({
    where: { settingId_scheduleTime: { settingId: "default", scheduleTime: "19:00" } },
    data: {
      lastProcessedSlotAt: new Date("2026-07-05T19:00:00+08:00"),
      lastRunAt: new Date("2026-07-05T19:01:00+08:00"),
    },
  });

  const result = await sendProgressDailySummaryTest({
    openId,
    now: new Date("2026-07-06T20:00:00+08:00"),
    context: { appOrigin: "http://127.0.0.1:3002" },
  });
  expect(result.eventKey).toContain(`progress:daily_summary:test:${openId}:`);
  expect(result.created).toBe(true);

  const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey: result.eventKey },
  });
  expect(outbox.botKind).toBe("notification");
  expect(outbox.type).toBe("progress_daily_summary");
  const payload = readProgressOutboxPayload(outbox.payload) as {
    recipientOpenIds: string[];
    overview: {
      taskCount: number;
      projectCount: number;
      ddlCount: number;
    };
  };
  expect(payload.recipientOpenIds).toEqual([openId]);
  expect(payload.overview).toMatchObject({
    taskCount: 0,
    projectCount: 0,
    ddlCount: 0,
  });
  const setting = await getProgressDailySummarySetting();
  expect(setting.schedules[0]?.lastRunAt).toBe("2026-07-05T11:01:00.000Z");
});

test("正式每日进度摘要跳过没有待跟进内容的用户", async () => {
  const suffix = Date.now();
  const openId = `ou_pw_daily_formal_empty_${suffix}`;
  await prisma.notificationOutbox.deleteMany({
    where: { channel: "progress", type: "progress_daily_summary" },
  });
  await prisma.user.create({
    data: { openId, name: `PW正式空摘要用户-${suffix}` },
  });

  const result = await runProgressDailySummaries({
    recipientOpenIds: [openId],
    now: new Date("2026-07-06T20:00:00+08:00"),
    scheduledFor: new Date("2026-07-06T19:00:00+08:00"),
    scheduleTime: "19:00",
    context: { appOrigin: "http://127.0.0.1:3002" },
  });

  expect(result).toMatchObject({
    recipients: 0,
    queued: 0,
    skipped: 0,
  });
  await expect(
    prisma.notificationOutbox.count({
      where: {
        channel: "progress",
        type: "progress_daily_summary",
        eventKey: { contains: openId },
      },
    }),
  ).resolves.toBe(0);
});

test("每日进度摘要 cron 按数据库设置检查且测试安全栏只放行李棋轩", async () => {
  const [cronSource, dockerCompose, playwrightConfig, playwrightServer] =
    await Promise.all([
      readFile("scripts/cron.ts", "utf8"),
      readFile("docker-compose.yml", "utf8"),
      readFile("playwright.config.ts", "utf8"),
      readFile("scripts/start-playwright-server.ts", "utf8"),
    ]);

  expect(cronSource).toContain(
    'process.env.PROGRESS_DAILY_SUMMARY_CHECK_CRON ?? "*/5 * * * *"',
  );
  expect(cronSource).toContain('const CRON_TIMEZONE = "Asia/Shanghai"');
  expect(cronSource).toMatch(
    /cron\.schedule\(\s*PROGRESS_DAILY_SUMMARY_CHECK_CRON,[\s\S]*\{\s*timezone:\s*CRON_TIMEZONE\s*\},\s*\);/,
  );
  expect(dockerCompose).toContain(
    "NOTIFICATION_DELIVERY_DISABLED: ${NOTIFICATION_DELIVERY_DISABLED:-true}",
  );
  expect(dockerCompose).toContain(
    'PROGRESS_DAILY_SUMMARY_CHECK_CRON: "${PROGRESS_DAILY_SUMMARY_CHECK_CRON:-*/5 * * * *}"',
  );
  expect(dockerCompose).toContain(
    "FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES: ${FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES-李棋轩}",
  );
  expect(playwrightConfig).toContain(
    'process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES?.trim() || "李棋轩"',
  );
  expect(playwrightServer).toContain(
    'process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES?.trim() || "李棋轩"',
  );
});

test("每日进度摘要卡片包含链接并在测试 allowlist 下只投递给李棋轩", async () => {
  const suffix = Date.now();
  const liOpenId = `ou_pw_daily_card_li_${suffix}`;
  const blockedOpenId = `ou_pw_daily_card_blocked_${suffix}`;
  await prisma.user.createMany({
    data: [
      { openId: liOpenId, name: "李棋轩", unionId: `on_pw_daily_card_li_${suffix}` },
      {
        openId: blockedOpenId,
        name: "其他摘要用户",
        unionId: `on_pw_daily_card_blocked_${suffix}`,
      },
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
      const restoreFetch = mockFeishuFetch(capturedMessages);
      try {
        await sendProgressNotification(
          {
            type: "progress_daily_summary",
            summaryDate: "2026-07-06",
            generatedAt: "2026-07-06T11:00:00.000Z",
            recipientOpenIds: [liOpenId, blockedOpenId],
            recipientName: "李棋轩",
            overview: {
              taskCount: 1,
              projectCount: 1,
              ddlCount: 1,
              overdueTaskCount: 0,
              pendingAcceptanceTaskCount: 0,
              riskTaskCount: 1,
              overdueDdlCount: 0,
            },
            tasks: [
              {
                taskId: "pw-daily-task",
                title: "PW卡片-摘要任务",
                projectName: "PW卡片-摘要项目",
                stageName: "联调阶段",
                statusLabel: "进行中",
                assigneeNames: "李棋轩",
                taskTechGroups: ["电控"],
                urgencyLabel: "高",
                importanceLabel: "高",
                dueAt: "2026-07-06T13:00:00.000Z",
                dueLabel: "今天截止",
                isOverdue: false,
                riskNote: "需要关注接口风险",
                needsWeeklyReport: true,
                linkPath: "/progress/task/pw-daily-task",
              },
            ],
            taskTotalCount: 1,
            projects: [
              {
                projectId: "pw-daily-project",
                name: "PW卡片-摘要项目",
                statusLabel: "进行中",
                team: "英雄",
                techGroup: "电控",
                ownerNames: "李棋轩",
                currentStageName: "联调阶段",
                currentStageStatusLabel: "进行中",
                projectDueAt: "2026-07-07T10:00:00.000Z",
                projectDueLabel: "明天截止",
                activeTaskCount: 1,
                overdueTaskCount: 0,
                pendingAcceptanceTaskCount: 0,
                riskCount: 1,
                linkPath: "/progress/pw-daily-project",
              },
            ],
            projectTotalCount: 1,
            ddlItems: [
              {
                kind: "TASK",
                id: "task:pw-daily-task",
                title: "PW卡片-摘要任务",
                projectName: "PW卡片-摘要项目",
                stageName: "联调阶段",
                dueAt: "2026-07-06T13:00:00.000Z",
                dueLabel: "今天截止",
                isOverdue: false,
                linkPath: "/progress/task/pw-daily-task",
              },
            ],
            ddlTotalCount: 1,
            linkPath: "/progress",
            approvalsLinkPath: "/progress/approvals",
          },
          { appOrigin: "http://127.0.0.1:3002" },
        );
      } finally {
        restoreFetch();
      }

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0]?.receiveId).toBe(liOpenId);
      expect(capturedMessages[0]?.token).toBe("notification-token");
      expect(capturedMessages[0]?.title).toBe("每日进度摘要 · 2026-07-06");
      expect(capturedMessages[0]?.cardText).toContain("今日概览");
      expect(capturedMessages[0]?.cardText).toContain("任务列表");
      expect(capturedMessages[0]?.cardText).toContain('"tag":"table"');
      expect(capturedMessages[0]?.cardText).toContain('"display_name":"任务"');
      expect(capturedMessages[0]?.cardText).toContain('"display_name":"项目/阶段"');
      expect(capturedMessages[0]?.cardText).toContain('"display_name":"项目"');
      expect(capturedMessages[0]?.cardText).toContain('"display_name":"当前阶段"');
      expect(capturedMessages[0]?.cardText).toContain('"display_name":"事项"');
      expect(capturedMessages[0]?.cardText).toContain('"page_size":1');
      expect(capturedMessages[0]?.cardText).toContain("项目状态");
      expect(capturedMessages[0]?.cardText).toContain("DDL 提醒");
      expect(capturedMessages[0]?.cardText).toContain("PW卡片-摘要任务");
      expect(capturedMessages[0]?.cardText).toContain("http://127.0.0.1:3002/progress/task/pw-daily-task");
      expect(capturedMessages[0]?.cardText).toContain("打开进度首页");
      expect(capturedMessages[0]?.cardText).toContain("查看审批看板");
      expect(capturedMessages[0]?.cardText).toContain('"schema":"2.0"');
      expect(
        (capturedMessages[0]?.cardText.match(/"tag":"table"/g) ?? []).length,
      ).toBe(3);
    },
  );
});

test("旧周报直发提醒入口已废弃", async () => {
  await expect(runWeeklyReportReminders()).rejects.toThrow("已废弃");
});

test("规则化周报未交提醒排除未开始任务", async () => {
  const suffix = Date.now();
  const assigneeOpenId = `ou_pw_rule_weekly_${suffix}`;
  const assigneeName = `PW规则周报用户-${suffix}`;
  const inProgressTitle = `PW通知-规则进行中周报-${suffix}`;
  const todoTitle = `PW通知-规则未开始周报-${suffix}`;

  await prisma.notificationOutbox.deleteMany();
  await prisma.user.create({
    data: {
      openId: assigneeOpenId,
      unionId: `on_pw_rule_weekly_${suffix}`,
      name: assigneeName,
    },
  });
  const project = await prisma.project.create({
    data: {
      name: `PW通知-规则周报项目-${suffix}`,
      description: "验证规则化周报提醒不催未开始任务",
      team: "工程",
      techGroup: "宣运",
      status: "IN_PROGRESS",
      ownerOpenId: assigneeOpenId,
      ownerName: assigneeName,
      owners: {
        create: [{ openId: assigneeOpenId, name: assigneeName, sortOrder: 0 }],
      },
    },
  });
  await prisma.task.createMany({
    data: [
      {
        projectId: project.id,
        title: todoTitle,
        goal: "未开始任务不应触发规则化周报提醒",
        urgency: "LOW",
        importance: "MEDIUM",
        assigneeOpenId,
        assigneeName,
        team: "工程",
        techGroup: "宣运",
        dueAt: new Date("2026-07-10T10:00:00.000Z"),
        status: "TODO",
        needsWeeklyReport: true,
      },
      {
        projectId: project.id,
        title: inProgressTitle,
        goal: "进行中任务应触发规则化周报提醒",
        urgency: "LOW",
        importance: "MEDIUM",
        assigneeOpenId,
        assigneeName,
        team: "工程",
        techGroup: "宣运",
        dueAt: new Date("2026-07-10T10:00:00.000Z"),
        status: "IN_PROGRESS",
        needsWeeklyReport: true,
      },
    ],
  });
  const tasks = await prisma.task.findMany({
    where: { projectId: project.id },
    select: { id: true },
  });
  await prisma.taskAssignee.createMany({
    data: tasks.map((task) => ({
      taskId: task.id,
      openId: assigneeOpenId,
      name: assigneeName,
      sortOrder: 0,
    })),
  });

  const queued = await runSingleProgressReminderRule({
    kind: "WEEKLY_REPORT_MISSING",
    params: { weekday: 5, cooldownHours: 24 },
    recipientConfig: {
      assignees: true,
      projectOwners: false,
      projectParticipants: false,
      stageOwners: false,
      managers: false,
    },
    now: new Date("2026-07-03T12:00:00+08:00"),
    context: { appOrigin: "http://127.0.0.1:3002" },
  });

  const [inProgressOutbox, todoOutbox] = await Promise.all([
    prisma.notificationOutbox.findFirst({
      where: { type: "progress_reminder", payload: { contains: inProgressTitle } },
      select: { botKind: true, payload: true },
    }),
    prisma.notificationOutbox.findFirst({
      where: { type: "progress_reminder", payload: { contains: todoTitle } },
      select: { id: true },
    }),
  ]);

  expect(queued).toBeGreaterThanOrEqual(1);
  expect(inProgressOutbox?.botKind).toBe("notification");
  expect(inProgressOutbox?.payload).toContain("周报未交提醒");
  expect(todoOutbox).toBeNull();
});

test("项目阶段风险通知使用普通通知机器人并发送明确内容", async () => {
  const syncEventKey = `playwright:progress-notify:project_stage_risk_synced:${Date.now()}`;
  const syncPayload: ProgressNotifyPayload = {
    type: "project_stage_risk_synced",
    projectId: "pw-project-stage-risk",
    projectName: "PW通知-阶段风险项目",
    stageId: "pw-stage-risk",
    stageName: "联调阶段",
    team: "工程",
    techGroup: "宣运",
    ownerNames: "项目负责人",
    stageOwnerName: "阶段负责人",
    actorName: "李棋轩",
    riskNote: "机械臂联调阻塞",
    recipientOpenIds: ["ou_owner", "ou_participant", "ou_owner", ""],
  };

  const syncCaptured = await enqueueAndDrainProgressNotification(
    syncEventKey,
    syncPayload,
  );

  expect(resolveProgressBotKind(syncPayload.type)).toBe("notification");
  expect(syncCaptured.map((message) => message.receiveId).sort()).toEqual([
    "ou_owner",
    "ou_participant",
  ]);
  expect(syncCaptured).toHaveLength(2);
  expect(syncCaptured.every((message) => message.title === "项目阶段风险同步"))
    .toBe(true);
  expect(syncCaptured[0]?.cardText).toContain("PW通知-阶段风险项目");
  expect(syncCaptured[0]?.cardText).toContain("联调阶段");
  expect(syncCaptured[0]?.cardText).toContain("机械臂联调阻塞");

  const resolvedEventKey = `playwright:progress-notify:project_stage_risk_resolved:${Date.now()}`;
  const resolvedPayload: ProgressNotifyPayload = {
    type: "project_stage_risk_resolved",
    projectId: "pw-project-stage-risk",
    projectName: "PW通知-阶段风险项目",
    stageId: "pw-stage-risk",
    stageName: "联调阶段",
    riskNote: "机械臂联调阻塞",
    resolveNote: "已完成参数修正",
    resolverName: "李棋轩",
    recipientOpenIds: ["ou_owner", "ou_participant"],
  };

  const resolvedCaptured = await enqueueAndDrainProgressNotification(
    resolvedEventKey,
    resolvedPayload,
  );

  expect(resolveProgressBotKind(resolvedPayload.type)).toBe("notification");
  expect(resolvedCaptured).toHaveLength(2);
  expect(
    resolvedCaptured.every((message) => message.title === "项目阶段风险已取消"),
  ).toBe(true);
  expect(resolvedCaptured[0]?.cardText).toContain("取消说明");
  expect(resolvedCaptured[0]?.cardText).toContain("已完成参数修正");
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

test("审批待办收件人为空时 outbox 不会静默标记为已发送", async () => {
  const eventKey = `playwright:progress-empty-approval:${Date.now()}`;
  await enqueueProgressNotification(eventKey, {
    type: "project_establishment_requested",
    projectId: "pw-empty-approval-project",
    projectName: "PW通知-空审批收件人",
    requesterName: "李棋轩",
    requesterOpenId: "ou_requester_empty",
    team: "英雄",
    techGroup: "电控",
    ownerNames: "项目负责人",
    participantNames: "",
    stageCount: 1,
    recipientOpenIds: [],
  });

  const sentCount = await drainNotificationOutbox(10, {
    ignoreDeliveryDisabled: true,
  });
  expect(sentCount).toBe(0);
  const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
    include: { recipients: true },
  });
  expect(outbox.status).toBe("FAILED");
  expect(outbox.lastError).toContain("没有可投递收件人");
  expect(outbox.recipients).toHaveLength(0);

  await prisma.notificationOutbox.update({
    where: { eventKey },
    data: { nextRunAt: new Date(0) },
  });

  const retrySentCount = await drainNotificationOutbox(10, {
    ignoreDeliveryDisabled: true,
  });
  expect(retrySentCount).toBe(0);
  const retriedOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
    include: { recipients: true },
  });
  expect(retriedOutbox.status).toBe("FAILED");
  expect(retriedOutbox.lastError).toContain("没有可投递收件人");
  expect(retriedOutbox.lastError).not.toContain("历史审批 outbox");
  expect(retriedOutbox.attempts).toBeLessThan(8);
  expect(retriedOutbox.recipients).toHaveLength(0);
});

test("旧任务提醒类型只发送给显式关注过滤后的收件人", async () => {
  await withFeishuBotEnv({}, async () => {
    const capturedMessages: CapturedFeishuMessage[] = [];
    const restoreFetch = mockFeishuFetch(capturedMessages);
    try {
      await sendProgressNotification(
        {
          type: "task_overdue",
          taskId: "pw-task-overdue-filtered",
          taskTitle: "PW通知-逾期任务",
          projectName: "PW通知-关注过滤项目",
          team: "工程",
          techGroup: "宣运",
          assigneeOpenIds: ["ou_assignee_should_not_receive"],
          recipientOpenIds: ["ou_filtered_overdue"],
        },
        { appOrigin: "http://127.0.0.1:3002" },
      );
      await sendProgressNotification(
        {
          type: "weekly_report_reminder",
          taskId: "pw-task-weekly-filtered",
          taskTitle: "PW通知-周报任务",
          assigneeOpenIds: ["ou_weekly_assignee_should_not_receive"],
          recipientOpenIds: ["ou_filtered_weekly"],
        },
        { appOrigin: "http://127.0.0.1:3002" },
      );
    } finally {
      restoreFetch();
    }

    expect(capturedMessages.map((message) => message.receiveId)).toEqual([
      "ou_filtered_overdue",
      "ou_filtered_weekly",
    ]);
    expect(capturedMessages.map((message) => message.title)).toEqual([
      "任务逾期警报",
      "周报填写提醒",
    ]);
  });
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

test("审批机器人对用户不可用时该收件人回退通知机器人", async () => {
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
      const openId = `ou_approval_unavailable_${Date.now()}`;
      const unionId = `on_${openId.replace(/^ou_/, "")}`;
      const capturedMessages: CapturedFeishuMessage[] = [];
      const capturedAuthRequests: CapturedFeishuAuthRequest[] = [];
      const restoreFetch = mockFeishuFetch(
        capturedMessages,
        capturedAuthRequests,
        {
          failMessageReceiveIds: new Set([unionId]),
          failMessageText: "Bot has NO availability to this user.",
        },
      );
      try {
        await sendProgressNotification({
          type: "project_establishment_requested",
          projectId: "pw-project-approval-unavailable",
          projectName: "PW审批机器人不可用回退",
          requesterName: "李棋轩",
          requesterOpenId: "ou_requester",
          team: "工程",
          techGroup: "宣运",
          ownerNames: "项目负责人",
          participantNames: "",
          stageCount: 1,
          recipientOpenIds: [openId],
        });
      } finally {
        restoreFetch();
      }

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0]).toMatchObject({
        receiveId: openId,
        receiveIdType: "open_id",
        token: "notification-token",
        title: "项目立项待审批",
      });
      expect(capturedAuthRequests.map((request) => request.appId)).toEqual([
        "notification-app",
        "approval-app",
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
      let firstDrainLogs: string[] = [];
      try {
        firstDrainLogs = await captureLogLines(async () => {
          await expect(
            drainNotificationOutbox(10, { ignoreDeliveryDisabled: true }),
          ).resolves.toBe(0);
        });
      } finally {
        restoreFirstFetch();
      }

      const failedRecipientLog = firstDrainLogs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === "notification.outbox.recipient.failed");
      expect(failedRecipientLog).toMatchObject({
        event: "notification.outbox.recipient.failed",
        eventKey,
        recipientOpenId: "ou_retry_fail",
        botKind: "approval",
        attempts: 1,
      });
      expect(firstDrainLogs.join("\n")).not.toContain("approval-secret");
      expect(firstDrainLogs.join("\n")).not.toContain("notification-secret");

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

test("事务内通知入队日志使用 prepared 语义且回滚后不留下 outbox", async () => {
  const eventKey = `playwright:tx-prepared:${Date.now()}`;

  const logs = await captureLogLines(async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueProgressNotificationTx(
          tx,
          eventKey,
          {
            type: "task_ddl_change_requested",
            requestId: "pw-tx-prepared-request",
            taskId: "pw-tx-prepared-task",
            taskTitle: "PW事务日志任务",
            projectName: "PW事务日志项目",
            requesterName: "李棋轩",
            reason: "验证事务内日志语义",
            oldDueAt: "2026-06-29T18:00:00.000Z",
            newDueAt: "2026-06-30T18:00:00.000Z",
            recipientOpenIds: ["ou_tx_prepared"],
          },
          { appOrigin: "http://127.0.0.1:3002" },
        );
        throw new Error("rollback for prepared log test");
      }),
    ).rejects.toThrow("rollback for prepared log test");
  });

  const entries = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries).toContainEqual(
    expect.objectContaining({
      event: "notification.outbox.enqueue_tx.prepared",
      action: "enqueueNotificationTx",
      eventKey,
      result: "prepared",
      transactional: true,
    }),
  );
  expect(entries).not.toContainEqual(
    expect.objectContaining({
      event: "notification.outbox.enqueue",
      action: "enqueueNotificationTx",
      eventKey,
    }),
  );
  await expect(
    prisma.notificationOutbox.findUnique({ where: { eventKey } }),
  ).resolves.toBeNull();
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

test("历史复合失败 outbox 不会自动拆分重发给已成功收件人", async () => {
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
      const eventKey = `playwright:legacy-composite-failed:${Date.now()}`;
      await enqueueProgressNotification(
        eventKey,
        {
          type: "project_establishment_requested",
          projectId: "pw-project-legacy-composite",
          projectName: "PW历史复合失败",
          requesterName: "李棋轩",
          requesterOpenId: "ou_requester",
          team: "工程",
          techGroup: "宣运",
          ownerNames: "项目负责人",
          participantNames: "",
          stageCount: 1,
          recipientOpenIds: ["ou_legacy_sent", "ou_legacy_failed"],
        },
        { appOrigin: "http://127.0.0.1:3002" },
      );
      const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
      });
      await prisma.notificationOutbox.update({
        where: { id: outbox.id },
        data: {
          status: "FAILED",
          attempts: 2,
          lastError:
            "飞书通知发送失败：1/2 个收件人失败；历史整批发送可能已有收件人成功",
          nextRunAt: new Date(),
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
      await expect(
        prisma.notificationOutbox.findUniqueOrThrow({
          where: { eventKey },
          select: {
            status: true,
            attempts: true,
            lastError: true,
            recipients: { select: { id: true } },
          },
        }),
      ).resolves.toMatchObject({
        status: "FAILED",
        attempts: 8,
        lastError: expect.stringContaining("历史审批 outbox 已停止自动重试"),
        recipients: [],
      });
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

test("测试收件人 allowlist 只放行指定三人", async () => {
  const suffix = Date.now();
  const allowedOpenId = `ou_allow_liqixuan_${suffix}`;
  const secondAllowedOpenId = `ou_allow_zhangyushan_${suffix}`;
  const thirdAllowedOpenId = `ou_allow_chenyanlin_${suffix}`;
  const blockedOpenId = `ou_allow_blocked_${Date.now()}`;
  const temporaryOpenIds = [
    allowedOpenId,
    secondAllowedOpenId,
    thirdAllowedOpenId,
    blockedOpenId,
  ];
  await prisma.user.createMany({
    data: [
      { openId: allowedOpenId, name: "李棋轩", unionId: `on_allow_liqixuan_${suffix}` },
      {
        openId: secondAllowedOpenId,
        name: "张宇山",
        unionId: `on_allow_zhangyushan_${suffix}`,
      },
      {
        openId: thirdAllowedOpenId,
        name: "陈彦霖",
        unionId: `on_allow_chenyanlin_${suffix}`,
      },
      {
        openId: blockedOpenId,
        name: "其他测试用户",
        unionId: `on_allow_blocked_${suffix}`,
      },
    ],
    skipDuplicates: true,
  });

  try {
    await withFeishuBotEnv(
      {
        FEISHU_APP_ID: "oauth-app",
        FEISHU_APP_SECRET: "oauth-secret",
        FEISHU_NOTIFICATION_APP_ID: "notification-app",
        FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
        FEISHU_APPROVAL_APP_ID: undefined,
        FEISHU_APPROVAL_APP_SECRET: undefined,
        FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES: "李棋轩,张宇山,陈彦霖",
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
            participantOpenIds: [
              secondAllowedOpenId,
              thirdAllowedOpenId,
              blockedOpenId,
            ],
            participantNames: "张宇山、陈彦霖、其他测试用户",
            recipientOpenIds: temporaryOpenIds,
            canceledTaskCount: 0,
          });
        } finally {
          restoreFetch();
        }

        expect(
          capturedAuthRequests.every((request) => request.appId === "notification-app"),
        ).toBe(true);
        expect(capturedMessages.map((message) => message.receiveId).sort()).toEqual([
          allowedOpenId,
          secondAllowedOpenId,
          thirdAllowedOpenId,
        ].sort());
        expect(capturedMessages.every((message) => message.token === "notification-token"))
          .toBe(true);
      },
    );
  } finally {
    await prisma.user.deleteMany({ where: { openId: { in: temporaryOpenIds } } });
  }
});

test("测试收件人 allowlist 的多个身份维度必须同时匹配", async () => {
  const suffix = Date.now();
  const allowedOpenId = `ou_allow_exact_${suffix}`;
  const sameNameOpenId = `ou_allow_same_name_${suffix}`;
  const allowedUnionId = `on_allow_exact_${suffix}`;
  const temporaryOpenIds = [allowedOpenId, sameNameOpenId];
  await prisma.user.createMany({
    data: [
      { openId: allowedOpenId, name: "李棋轩", unionId: allowedUnionId },
      {
        openId: sameNameOpenId,
        name: "李棋轩",
        unionId: `on_allow_same_name_${suffix}`,
      },
    ],
  });

  try {
    await withFeishuBotEnv(
      {
        FEISHU_APP_ID: "oauth-app",
        FEISHU_APP_SECRET: "oauth-secret",
        FEISHU_NOTIFICATION_APP_ID: "notification-app",
        FEISHU_NOTIFICATION_APP_SECRET: "notification-secret",
        FEISHU_APPROVAL_APP_ID: undefined,
        FEISHU_APPROVAL_APP_SECRET: undefined,
        FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES: "李棋轩",
        FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS: allowedOpenId,
        FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS: allowedUnionId,
      },
      async () => {
        const capturedMessages: CapturedFeishuMessage[] = [];
        const restoreFetch = mockFeishuFetch(capturedMessages);
        try {
          await sendProgressNotification({
            type: "project_canceled",
            projectId: "pw-project-exact-allowlist",
            projectName: "PW机器人-精确收件人拦截",
            team: "工程",
            techGroup: "宣运",
            ownerOpenIds: temporaryOpenIds,
            ownerNames: "李棋轩",
            participantOpenIds: [],
            participantNames: "",
            recipientOpenIds: temporaryOpenIds,
            canceledTaskCount: 0,
          });
        } finally {
          restoreFetch();
        }

        expect(capturedMessages.map((message) => message.receiveId)).toEqual([
          allowedOpenId,
        ]);
      },
    );
  } finally {
    await prisma.user.deleteMany({ where: { openId: { in: temporaryOpenIds } } });
  }
});

test("outbox 收件人被安全名单拦截时不会误标为已发送", async () => {
  const suffix = Date.now();
  const blockedOpenId = `ou_outbox_allowlist_blocked_${suffix}`;
  await prisma.user.create({
    data: {
      openId: blockedOpenId,
      unionId: `on_outbox_allowlist_blocked_${suffix}`,
      name: "同名测试用户",
    },
  });
  const eventKey = `playwright:outbox-allowlist-blocked:${suffix}`;

  try {
    await withFeishuBotEnv(
      {
        FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES: "李棋轩",
        FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS: `ou_real_${suffix}`,
        FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS: `on_real_${suffix}`,
      },
      async () => {
        await enqueueProgressNotification(eventKey, {
          type: "approval_reminder_requested",
          approvalKindLabel: "任务 DDL",
          projectName: "PW安全名单项目",
          subject: "安全名单拦截验证",
          submitterName: "申请人",
          reminderName: "提醒人",
          submittedAt: "2026-07-18T08:00:00.000Z",
          recipientOpenIds: [blockedOpenId],
          linkPath: "/progress/approvals",
        });
        await expect(
          drainNotificationOutbox(1, { ignoreDeliveryDisabled: true }),
        ).resolves.toBe(0);
      },
    );

    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      include: { recipients: true },
    });
    expect(outbox.status).toBe("FAILED");
    expect(outbox.recipients).toEqual([
      expect.objectContaining({
        openId: blockedOpenId,
        status: "FAILED",
        receiveId: "",
        receiveIdType: "",
        sentAt: null,
      }),
    ]);
  } finally {
    await prisma.user.delete({ where: { openId: blockedOpenId } });
  }
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
  return withFeishuBotEnv({}, async () => {
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
  });
}

function mockFeishuFetch(
  capturedMessages: CapturedFeishuMessage[],
  capturedAuthRequests: CapturedFeishuAuthRequest[] = [],
  options: {
    failContactOpenIds?: Set<string>;
    failMessageReceiveIds?: Set<string>;
    failMessageText?: string;
  } = {},
): () => void {
  const originalFetch = globalThis.fetch;
  let lastCardKitCard: Record<string, unknown> | null = null;

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
      const body = parseJsonRecord(init?.body);
      const cardData =
        typeof body.data === "string" ? body.data : JSON.stringify(body.data ?? {});
      lastCardKitCard = parseJsonRecord(cardData);
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
        return Response.json({
          code: 230006,
          msg: options.failMessageText ?? "mock message failure",
        });
      }
      const card = parseJsonRecord(body.content);
      const isCardKitRef =
        typeof card.type === "string" && card.type === "card";
      capturedMessages.push({
        receiveId,
        receiveIdType:
          new URL(url).searchParams.get("receive_id_type") ?? "open_id",
        title: isCardKitRef
          ? readNestedString(lastCardKitCard ?? {}, [
              "header",
              "title",
              "content",
            ]) || "CardKit"
          : readNestedString(card, ["header", "title", "content"]),
        cardText: JSON.stringify(
          isCardKitRef && lastCardKitCard ? lastCardKitCard : card,
        ),
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

async function captureLogLines(callback: () => Promise<void>): Promise<string[]> {
  const previousFormat = process.env.LOG_FORMAT;
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_FORMAT = "json";
  process.env.LOG_LEVEL = "debug";
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await callback();
    return lines.filter((line) => line.trim().startsWith("{"));
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    if (previousFormat === undefined) {
      delete process.env.LOG_FORMAT;
    } else {
      process.env.LOG_FORMAT = previousFormat;
    }
    if (previousLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previousLevel;
    }
  }
}

async function withFeishuBotEnv<T>(
  values: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  const effectiveValues = { ...values };
  for (const key of [
    "FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES",
    "FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS",
    "FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS",
  ]) {
    if (!(key in effectiveValues)) effectiveValues[key] = undefined;
  }
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(effectiveValues)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await callback();
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

function readProgressOutboxPayload(rawPayload: string): Record<string, unknown> {
  const parsed = JSON.parse(rawPayload) as { payload?: Record<string, unknown> };
  return parsed.payload ?? {};
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
