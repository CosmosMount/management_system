import { expect, test } from "@playwright/test";
import {
  Importance,
  ProjectStatus,
  StageStatus,
  SubmissionType,
  TaskStatus,
  Urgency,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  expectHealthyPage,
  formatPrismaError,
  loginAsAdminUser,
  loginAsNormalUser,
  loginAsOtherUser,
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
  type FunctionalFixtureIds,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

let fixtures: FunctionalFixtureIds;
let seeded: Awaited<ReturnType<typeof seedApprovalBoardFixtures>>;
let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;

test.beforeAll(async () => {
  normalAuth = await resolveNormalAuthMaterial();
  try {
    fixtures = await prepareFunctionalFixtures(normalAuth);
    seeded = await seedApprovalBoardFixtures(fixtures);
  } catch (error) {
    throw new Error(`审批看板 fixture 准备失败：${formatPrismaError(error)}`);
  }
});

test("审批看板按类别展示当前用户需要处理的项目审批", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsAdminUser(context, baseURL);
  await page.goto("/progress", { waitUntil: "networkidle" });
  const approvalBoardLink = page.getByRole("link", {
    name: "审批看板 集中查看当前账号需要处理的项目审批",
  });
  await expect(approvalBoardLink).toBeVisible();
  await approvalBoardLink.click();
  await expect(page).toHaveURL(/\/progress\/approvals$/);
  await expect(page.getByText("审批看板", { exact: true })).toBeVisible();

  await expect(
    page.getByTestId("progress-approval-category-project-establishment"),
  ).toContainText(seeded.establishmentProjectName);
  await expect(
    page.getByTestId("progress-approval-category-project-stage"),
  ).toContainText(seeded.stageApprovalName);
  await expect(
    page.getByTestId("progress-approval-category-project-ddl"),
  ).toContainText(seeded.batchDdlStageName);
  await expect(
    page.getByTestId("progress-approval-category-project-ddl"),
  ).toContainText(seeded.singleDdlStageName);
  await expect(
    page.getByTestId("progress-approval-category-task-request"),
  ).toContainText(seeded.taskCreationTitle);
  await expect(
    page.getByTestId("progress-approval-category-task-request"),
  ).toContainText(seeded.taskDeletionTitle);
  await expect(
    page.getByTestId("progress-approval-category-task-ddl"),
  ).toContainText(seeded.taskDdlTitle);
  await expect(
    page.getByTestId("progress-approval-category-task-acceptance"),
  ).toContainText(seeded.taskAcceptanceTitle);

  const visibleApprovalCount = await page
    .getByTestId("progress-approval-item")
    .count();
  expect(visibleApprovalCount).toBeGreaterThanOrEqual(8);
  await expectHealthyPage(page);

  await expectApprovalLink(page, `project-establishment:${seeded.establishmentProjectId}`, `/progress/${seeded.establishmentProjectId}`);
  await expectApprovalLink(page, `stage-submission:${seeded.stageSubmissionId}`, `/progress/${seeded.approvalProjectId}?stage=${seeded.stageApprovalId}`);
  await expectApprovalLink(page, `project-ddl:${seeded.batchDdlRequestId}`, `/progress/${seeded.approvalProjectId}?stage=${seeded.batchDdlStageId}`);
  await expectApprovalLink(page, `project-ddl:${seeded.singleDdlRequestId}`, `/progress/${seeded.approvalProjectId}?stage=${seeded.singleDdlStageId}`);
  await expectApprovalLink(page, `task-creation:${seeded.taskCreationRequestId}`, `/progress/${seeded.approvalProjectId}`);
  await expectApprovalLink(page, `task-deletion:${seeded.taskDeletionRequestId}`, `/progress/task/${seeded.taskDeletionId}`);
  await expectApprovalLink(page, `task-ddl:${seeded.taskDdlRequestId}`, `/progress/task/${seeded.taskDdlId}`);
  await expectApprovalLink(page, `task-acceptance:${seeded.taskSubmissionId}`, `/progress/task/${seeded.taskAcceptanceId}`);
});

test("无审批权限用户在审批看板只看到空状态", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsOtherUser(context, baseURL);
  await page.goto("/progress/approvals", { waitUntil: "networkidle" });
  await expect(page.getByText("暂无需要你处理的项目审批")).toBeVisible();
  await expect(page.getByTestId("progress-approval-item")).toHaveCount(0);
  await expect(page.getByText(seeded.establishmentProjectName)).toHaveCount(0);
  await expectHealthyPage(page);
});

test("我的申请集中展示八类审批并支持筛选排序和分页", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto("/progress/approvals", { waitUntil: "networkidle" });
  await expect(page.getByRole("tab", { name: "待我审批" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "我的申请" }).click();
  await expect(page).toHaveURL(/\/progress\/approvals\?view=submitted/);
  const submissionList = page.getByRole("list", { name: "我的审批申请" });
  await expect(page.locator("#approval-status-filter")).toHaveValue("PENDING");

  for (const label of [
    "项目立项",
    "阶段验收",
    "项目批量 DDL",
    "项目单阶段 DDL",
    "任务创建",
    "任务删除",
    "任务 DDL",
    "任务验收",
  ]) {
    await expect(submissionList.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(submissionList.getByText("已失效", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("my-approval-submissions.png"),
    fullPage: true,
  });

  await page.locator("#approval-status-filter").selectOption("SUPERSEDED");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/status=SUPERSEDED/);
  await expect(page.getByText(seeded.supersededStageName)).toBeVisible();

  await page.getByRole("button", { name: "清除筛选" }).first().click();
  await expect(page).toHaveURL(/\/progress\/approvals\?view=submitted$/);
  await expect(page.locator("#approval-status-filter")).toHaveValue("PENDING");
  await page.locator("#approval-status-filter").selectOption("");
  await page.locator("#approval-sort-filter").selectOption("project");
  await page.locator("#approval-sort-direction").selectOption("asc");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/status=ALL/);
  await expect(page).toHaveURL(/sort=project/);
  await expect(page).toHaveURL(/direction=asc/);
  await expect(page.getByText(/第 1 \/ 2 页/)).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expectHealthyPage(page);
});

test("提交人可选择有权审批人员发送提醒且冷却阻止重复投递", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(
    "/progress/approvals?view=submitted&type=TASK_DDL&status=PENDING",
    { waitUntil: "networkidle" },
  );
  await expect(page.getByText(seeded.taskDdlTitle)).toBeVisible();

  async function sendReminder() {
    await page.getByRole("button", { name: "请求审批" }).click();
    await page.getByPlaceholder("搜索并选择审批人").fill("Playwright 管理员");
    await page
      .locator(`[data-testid="user-search-option"][data-open-id="${fixtures.adminOpenId}"]`)
      .click();
    if (deliveriesAfterScreenshot === 0) {
      await page.screenshot({
        path: testInfo.outputPath("approval-reminder-dialog.png"),
        fullPage: true,
      });
      deliveriesAfterScreenshot++;
    }
    await page.getByRole("button", { name: "发送提醒" }).click();
  }

  let deliveriesAfterScreenshot = 0;
  await sendReminder();
  await expect(page.getByText("已向 1 位审批人发送提醒")).toBeVisible();
  const deliveriesAfterFirst = await prisma.progressApprovalReminderDelivery.count({
    where: {
      approvalKind: "TASK_DDL",
      approvalId: seeded.taskDdlRequestId,
      recipientOpenId: fixtures.adminOpenId,
    },
  });
  expect(deliveriesAfterFirst).toBe(1);

  await sendReminder();
  await expect(
    page.getByText("已提醒 0 人，另有 1 人仍在提醒间隔内"),
  ).toBeVisible();
  const deliveriesAfterSecond = await prisma.progressApprovalReminderDelivery.count({
    where: {
      approvalKind: "TASK_DDL",
      approvalId: seeded.taskDdlRequestId,
      recipientOpenId: fixtures.adminOpenId,
    },
  });
  expect(deliveriesAfterSecond).toBe(1);
});

test("提交人可从我的申请撤回八类审批且各业务状态正确回退", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const startedAt = new Date();
  const staleReminderEventKey = `playwright:withdrawal:stale-reminder:${Date.now()}`;
  const staleReminder = await prisma.notificationOutbox.create({
    data: {
      eventKey: staleReminderEventKey,
      channel: "progress",
      botKind: "approval",
      type: "approval_reminder_requested",
      payload: "{}",
      recipients: { create: { openId: fixtures.adminOpenId } },
    },
  });
  const failedReminderEventKey = `${staleReminderEventKey}:failed`;
  const failedReminder = await prisma.notificationOutbox.create({
    data: {
      eventKey: failedReminderEventKey,
      channel: "progress",
      botKind: "approval",
      type: "approval_reminder_requested",
      payload: "{}",
      status: "FAILED",
      attempts: 1,
      lastError: "模拟可重试失败",
      recipients: {
        create: {
          openId: fixtures.adminOpenId,
          status: "FAILED",
          attempts: 1,
          lastError: "模拟可重试失败",
        },
      },
    },
  });
  const processingReminderEventKey = `${staleReminderEventKey}:processing`;
  const processingReminder = await prisma.notificationOutbox.create({
    data: {
      eventKey: processingReminderEventKey,
      channel: "progress",
      botKind: "approval",
      type: "approval_reminder_requested",
      payload: "{}",
      status: "PROCESSING",
      attempts: 1,
      lockedUntil: new Date(Date.now() - 1_000),
      recipients: {
        create: {
          openId: fixtures.adminOpenId,
          status: "PROCESSING",
          attempts: 1,
          lockedUntil: new Date(Date.now() - 1_000),
        },
      },
    },
  });
  await prisma.progressApprovalReminderDelivery.createMany({
    data: [
      staleReminderEventKey,
      failedReminderEventKey,
      processingReminderEventKey,
    ].map(
      (outboxEventKey, index) => ({
        approvalKind: "TASK_DDL" as const,
        approvalId: seeded.taskDdlRequestId,
        batchId: `withdrawal-stale-${Date.now()}-${index}`,
        projectId: seeded.approvalProjectId,
        taskId: seeded.taskDdlId,
        remindedByOpenId: fixtures.normalOpenId,
        remindedByName: "李棋轩",
        recipientOpenId: fixtures.adminOpenId,
        recipientName: "Playwright 管理员",
        outboxEventKey,
      }),
    ),
  });

  const approvals = [
    {
      kind: "PROJECT_ESTABLISHMENT",
      label: "项目立项",
      subject: seeded.establishmentProjectName,
    },
    { kind: "STAGE_ACCEPTANCE", label: "阶段验收", subject: seeded.stageApprovalName },
    {
      kind: "PROJECT_BATCH_DDL",
      label: "项目批量 DDL",
      subject: seeded.batchDdlStageName,
    },
    {
      kind: "PROJECT_STAGE_DDL",
      label: "项目单阶段 DDL",
      subject: seeded.singleDdlStageName,
    },
    { kind: "TASK_CREATION", label: "任务创建", subject: seeded.taskCreationTitle },
    { kind: "TASK_DELETION", label: "任务删除", subject: seeded.taskDeletionTitle },
    { kind: "TASK_DDL", label: "任务 DDL", subject: seeded.taskDdlTitle },
    { kind: "TASK_ACCEPTANCE", label: "任务验收", subject: seeded.taskAcceptanceTitle },
  ] as const;

  for (const approval of approvals) {
    await page.goto(
      `/progress/approvals?view=submitted&type=${approval.kind}&status=PENDING`,
      { waitUntil: "networkidle" },
    );
    const row = page.getByRole("listitem").filter({ hasText: approval.subject });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: "撤回审批" })).toBeVisible();
    await row.getByRole("button", { name: "撤回审批" }).click();
    await expect(page.getByRole("heading", { name: "确认撤回审批申请" })).toBeVisible();
    if (approval.kind === "PROJECT_ESTABLISHMENT") {
      await page.screenshot({
        path: testInfo.outputPath("approval-withdrawal-dialog.png"),
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "确认撤回" }).click();
    await expect(page.getByText("审批申请已撤回")).toBeVisible();
    await expect(row).toHaveCount(0);
  }

  const [
    establishment,
    stage,
    stageSubmission,
    batchDdl,
    singleDdl,
    taskCreation,
    taskDeletion,
    taskDdl,
    taskAcceptance,
    taskSubmission,
  ] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: seeded.establishmentProjectId },
      select: {
        status: true,
        establishmentWithdrawnAt: true,
        establishmentWithdrawnByOpenId: true,
      },
    }),
    prisma.projectStage.findUniqueOrThrow({
      where: { id: seeded.stageApprovalId },
      select: { status: true, currentSubmissionId: true },
    }),
    prisma.taskSubmission.findUniqueOrThrow({
      where: { id: seeded.stageSubmissionId },
      select: { withdrawnAt: true, withdrawnByOpenId: true },
    }),
    prisma.projectDdlChangeRequest.findUniqueOrThrow({
      where: { id: seeded.batchDdlRequestId },
      select: { status: true, pendingKey: true, withdrawnAt: true },
    }),
    prisma.projectDdlChangeRequest.findUniqueOrThrow({
      where: { id: seeded.singleDdlRequestId },
      select: { status: true, pendingKey: true, withdrawnAt: true },
    }),
    prisma.taskCreationRequest.findUniqueOrThrow({
      where: { id: seeded.taskCreationRequestId },
      select: { status: true, withdrawnAt: true },
    }),
    prisma.taskDeletionRequest.findUniqueOrThrow({
      where: { id: seeded.taskDeletionRequestId },
      select: { status: true, pendingKey: true, withdrawnAt: true },
    }),
    prisma.taskDdlChangeRequest.findUniqueOrThrow({
      where: { id: seeded.taskDdlRequestId },
      select: { status: true, pendingKey: true, withdrawnAt: true },
    }),
    prisma.task.findUniqueOrThrow({
      where: { id: seeded.taskAcceptanceId },
      select: { status: true },
    }),
    prisma.taskSubmission.findUniqueOrThrow({
      where: { id: seeded.taskSubmissionId },
      select: { withdrawnAt: true, withdrawnByOpenId: true },
    }),
  ]);

  expect(establishment).toMatchObject({
    status: "ESTABLISHMENT_WITHDRAWN",
    establishmentWithdrawnByOpenId: fixtures.normalOpenId,
  });
  expect(establishment.establishmentWithdrawnAt).not.toBeNull();
  expect(stage).toEqual({ status: "IN_PROGRESS", currentSubmissionId: null });
  expect(stageSubmission).toMatchObject({ withdrawnByOpenId: fixtures.normalOpenId });
  expect(stageSubmission.withdrawnAt).not.toBeNull();
  for (const request of [batchDdl, singleDdl, taskDeletion, taskDdl]) {
    expect(request.status).toBe("WITHDRAWN");
    expect(request.pendingKey).toContain("WITHDRAWN:");
    expect(request.withdrawnAt).not.toBeNull();
  }
  expect(taskCreation.status).toBe("WITHDRAWN");
  expect(taskCreation.withdrawnAt).not.toBeNull();
  expect(taskAcceptance.status).toBe("IN_PROGRESS");
  expect(taskSubmission).toMatchObject({ withdrawnByOpenId: fixtures.normalOpenId });
  expect(taskSubmission.withdrawnAt).not.toBeNull();

  const [canceledReminders, withdrawalOutboxes, withdrawalActivities] =
    await Promise.all([
      prisma.notificationOutbox.findMany({
        where: {
          id: { in: [staleReminder.id, failedReminder.id, processingReminder.id] },
        },
        include: { recipients: true },
      }),
      prisma.notificationOutbox.findMany({
        where: {
          eventKey: { startsWith: "progress:approval_withdrawn:" },
          createdAt: { gte: startedAt },
        },
      }),
      prisma.progressActivityLog.findMany({
        where: {
          action: "approval.withdrawn",
          actorOpenId: fixtures.normalOpenId,
          createdAt: { gte: startedAt },
        },
      }),
    ]);
  expect(canceledReminders).toHaveLength(3);
  for (const canceledReminder of canceledReminders) {
    expect(canceledReminder).toMatchObject({ status: "FAILED", attempts: 8 });
    expect(canceledReminder.lastError).toContain("审批已由提交人撤回");
    expect(canceledReminder.nextRunAt.getUTCFullYear()).toBe(9999);
    expect(canceledReminder.recipients).toHaveLength(1);
    expect(canceledReminder.recipients[0]).toMatchObject({
      status: "FAILED",
      attempts: 8,
      openId: fixtures.adminOpenId,
    });
  }
  expect(withdrawalOutboxes).toHaveLength(8);
  for (const outbox of withdrawalOutboxes) {
    const envelope = JSON.parse(outbox.payload) as {
      payload: { recipientOpenIds: string[] };
    };
    expect(outbox).toMatchObject({ botKind: "approval", type: "approval_withdrawn" });
    expect(envelope.payload.recipientOpenIds).not.toContain(fixtures.normalOpenId);
  }
  expect(withdrawalActivities).toHaveLength(8);
  for (const activity of withdrawalActivities) {
    expect(activity.payload).toContain("approvalKindLabel");
    expect(activity.payload).not.toMatch(/PROJECT_|TASK_|STAGE_ACCEPTANCE/);
  }

  await page.goto("/progress/approvals?view=submitted&status=WITHDRAWN", {
    waitUntil: "networkidle",
  });
  const withdrawnList = page.getByRole("list", { name: "我的审批申请" });
  for (const approval of approvals) {
    const row = withdrawnList
      .getByRole("listitem")
      .filter({ has: page.getByText(approval.label, { exact: true }) })
      .filter({ hasText: approval.subject });
    await expect(row).toContainText("已撤回");
    await expect(row.getByRole("button", { name: "撤回审批" })).toHaveCount(0);
  }
  await expectHealthyPage(page);
});

async function expectApprovalLink(page: Parameters<typeof expectHealthyPage>[0], testId: string, url: string) {
  await page.goto("/progress/approvals", { waitUntil: "networkidle" });
  await page.getByTestId(`progress-approval-link-${testId}`).click();
  await expect(page).toHaveURL(new RegExp(escapeRegExp(url) + "$"));
}

async function seedApprovalBoardFixtures(fixtures: FunctionalFixtureIds) {
  const now = new Date();
  const tomorrow = addDays(now, 1);
  const nextWeek = addDays(now, 7);
  const normalName = "李棋轩";
  const adminName = "Playwright 管理员";
  const suffix = Date.now();

  const establishmentProjectName = `PW全功能-审批看板立项-${suffix}`;
  const establishment = await prisma.project.create({
    data: {
      name: establishmentProjectName,
      description: "approval board establishment fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.ESTABLISHING,
      ownerOpenId: fixtures.normalOpenId,
      ownerName: normalName,
      requesterOpenId: fixtures.normalOpenId,
      requesterName: normalName,
      submittedAt: now,
      owners: {
        create: [{ openId: fixtures.normalOpenId, name: normalName, sortOrder: 0 }],
      },
      participants: {
        create: [{ openId: fixtures.normalOpenId, name: normalName, sortOrder: 0 }],
      },
      stages: {
        create: [
          {
            name: `PW全功能-审批看板立项阶段-${suffix}`,
            goal: "approval board establishment stage",
            sortOrder: 0,
            status: StageStatus.NOT_STARTED,
            ownerOpenId: fixtures.normalOpenId,
            ownerName: normalName,
            dueAt: tomorrow,
          },
        ],
      },
    },
  });

  const approvalProject = await prisma.project.create({
    data: {
      name: `PW全功能-审批看板项目-${suffix}`,
      description: "approval board project fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: fixtures.adminOpenId,
      ownerName: adminName,
      owners: {
        create: [{ openId: fixtures.adminOpenId, name: adminName, sortOrder: 0 }],
      },
      participants: {
        create: [{ openId: fixtures.normalOpenId, name: normalName, sortOrder: 0 }],
      },
    },
  });

  const stageApprovalName = `PW全功能-审批看板阶段验收-${suffix}`;
  const batchDdlStageName = `PW全功能-审批看板批量 DDL-${suffix}`;
  const singleDdlStageName = `PW全功能-审批看板单阶段 DDL-${suffix}`;
  const [stageApproval, batchDdlStage, singleDdlStage] = await Promise.all([
    prisma.projectStage.create({
      data: {
        projectId: approvalProject.id,
        name: stageApprovalName,
        goal: "stage approval board fixture",
        sortOrder: 0,
        status: StageStatus.PENDING_ACCEPTANCE,
        ownerOpenId: fixtures.normalOpenId,
        ownerName: normalName,
        dueAt: tomorrow,
      },
    }),
    prisma.projectStage.create({
      data: {
        projectId: approvalProject.id,
        name: batchDdlStageName,
        goal: "batch ddl board fixture",
        sortOrder: 1,
        status: StageStatus.IN_PROGRESS,
        ownerOpenId: fixtures.normalOpenId,
        ownerName: normalName,
        dueAt: nextWeek,
      },
    }),
    prisma.projectStage.create({
      data: {
        projectId: approvalProject.id,
        name: singleDdlStageName,
        goal: "single ddl board fixture",
        sortOrder: 2,
        status: StageStatus.NOT_STARTED,
        ownerOpenId: fixtures.normalOpenId,
        ownerName: normalName,
        dueAt: addDays(nextWeek, 7),
      },
    }),
  ]);

  const stageSubmission = await prisma.taskSubmission.create({
    data: {
      projectId: approvalProject.id,
      stageId: stageApproval.id,
      type: SubmissionType.STAGE,
      feishuDocUrl: "https://example.com/stage-approval",
      note: "PW全功能-审批看板阶段提交说明",
      submittedBy: fixtures.normalOpenId,
      submitterName: normalName,
    },
  });
  await prisma.projectStage.update({
    where: { id: stageApproval.id },
    data: { currentSubmissionId: stageSubmission.id },
  });

  const [batchDdlRequest, singleDdlRequest] = await Promise.all([
    prisma.projectDdlChangeRequest.create({
      data: {
        projectId: approvalProject.id,
        stageId: batchDdlStage.id,
        type: "CASCADE_EXTENSION",
        status: "PENDING",
        pendingKey: "PENDING",
        requesterOpenId: fixtures.normalOpenId,
        requesterName: normalName,
        reason: "PW全功能-审批看板批量延期原因",
        oldDueAt: batchDdlStage.dueAt,
        newDueAt: addDays(batchDdlStage.dueAt ?? nextWeek, 2),
        durationDays: 2,
        requestedIsBenign: true,
      },
    }),
    prisma.projectDdlChangeRequest.create({
      data: {
        projectId: approvalProject.id,
        stageId: singleDdlStage.id,
        type: "SINGLE_STAGE_ADJUSTMENT",
        status: "PENDING",
        pendingKey: "PENDING",
        requesterOpenId: fixtures.normalOpenId,
        requesterName: normalName,
        reason: "PW全功能-审批看板单阶段 DDL 原因",
        oldDueAt: singleDdlStage.dueAt,
        newDueAt: addDays(singleDdlStage.dueAt ?? nextWeek, 1),
      },
    }),
  ]);

  const taskCreationTitle = `PW全功能-审批看板创建任务-${suffix}`;
  const taskCreationRequest = await prisma.taskCreationRequest.create({
    data: {
      projectId: approvalProject.id,
      requesterOpenId: fixtures.normalOpenId,
      requesterName: normalName,
      draftPayload: JSON.stringify({
        title: taskCreationTitle,
        goal: "approval board task creation",
        stageId: batchDdlStage.id,
        stageName: batchDdlStage.name,
        taskTechGroups: ["电控"],
        urgency: Urgency.MEDIUM,
        importance: Importance.HIGH,
        assigneeOpenIds: [fixtures.normalOpenId],
        assigneeNames: [normalName],
        metrics: "approval board task creation metrics",
        dueAt: tomorrow.toISOString(),
        needsOfflineConfirmation: false,
        needsWeeklyReport: false,
        acceptanceChecklistItems: [],
      }),
      status: "PENDING",
    },
  });

  const taskDeletionTitle = `PW全功能-审批看板删除任务-${suffix}`;
  const taskDdlTitle = `PW全功能-审批看板任务 DDL-${suffix}`;
  const taskAcceptanceTitle = `PW全功能-审批看板任务验收-${suffix}`;
  const [taskDeletion, taskDdl, taskAcceptance] = await Promise.all([
    createBoardTask({
      projectId: approvalProject.id,
      stageId: batchDdlStage.id,
      title: taskDeletionTitle,
      normalOpenId: fixtures.normalOpenId,
      normalName,
      dueAt: tomorrow,
      status: TaskStatus.TODO,
    }),
    createBoardTask({
      projectId: approvalProject.id,
      stageId: batchDdlStage.id,
      title: taskDdlTitle,
      normalOpenId: fixtures.normalOpenId,
      normalName,
      dueAt: tomorrow,
      status: TaskStatus.IN_PROGRESS,
    }),
    createBoardTask({
      projectId: approvalProject.id,
      stageId: batchDdlStage.id,
      title: taskAcceptanceTitle,
      normalOpenId: fixtures.normalOpenId,
      normalName,
      dueAt: tomorrow,
      status: TaskStatus.PENDING_ACCEPTANCE,
    }),
  ]);

  const [taskDeletionRequest, taskDdlRequest, taskSubmission] = await Promise.all([
    prisma.taskDeletionRequest.create({
      data: {
        taskId: taskDeletion.id,
        requesterOpenId: fixtures.normalOpenId,
        requesterName: normalName,
        reason: "PW全功能-审批看板删除任务原因",
        status: "PENDING",
        pendingKey: "PENDING",
      },
    }),
    prisma.taskDdlChangeRequest.create({
      data: {
        taskId: taskDdl.id,
        requesterOpenId: fixtures.normalOpenId,
        requesterName: normalName,
        oldDueAt: taskDdl.dueAt,
        newDueAt: addDays(taskDdl.dueAt, 3),
        reason: "PW全功能-审批看板任务 DDL 原因",
        status: "PENDING",
        pendingKey: "PENDING",
      },
    }),
    prisma.taskSubmission.create({
      data: {
        taskId: taskAcceptance.id,
        type: SubmissionType.DELIVERY,
        feishuDocUrl: "https://example.com/task-approval",
        note: "PW全功能-审批看板任务交付说明",
        submittedBy: fixtures.normalOpenId,
        submitterName: normalName,
      },
    }),
  ]);

  const supersededStageName = `PW全功能-审批看板已失效阶段-${suffix}`;
  const supersededStage = await prisma.projectStage.create({
    data: {
      projectId: approvalProject.id,
      name: supersededStageName,
      goal: "superseded stage submission fixture",
      sortOrder: 3,
      status: StageStatus.IN_PROGRESS,
      ownerOpenId: fixtures.normalOpenId,
      ownerName: normalName,
      dueAt: addDays(nextWeek, 14),
    },
  });
  await prisma.taskSubmission.create({
    data: {
      projectId: approvalProject.id,
      stageId: supersededStage.id,
      type: SubmissionType.STAGE,
      feishuDocUrl: "https://example.com/superseded-stage",
      note: "已被替代的阶段提交",
      submittedBy: fixtures.normalOpenId,
      submitterName: normalName,
      submittedAt: addDays(now, -1),
    },
  });

  await prisma.taskCreationRequest.createMany({
    data: Array.from({ length: 21 }, (_, index) => ({
      projectId: approvalProject.id,
      requesterOpenId: fixtures.normalOpenId,
      requesterName: normalName,
      draftPayload: JSON.stringify({
        title: `PW全功能-审批看板历史申请-${suffix}-${index + 1}`,
        goal: "approval history pagination fixture",
        stageId: batchDdlStage.id,
        stageName: batchDdlStage.name,
        taskTechGroups: ["电控"],
        urgency: Urgency.MEDIUM,
        importance: Importance.MEDIUM,
        assigneeOpenIds: [fixtures.normalOpenId],
        assigneeNames: [normalName],
        metrics: "history fixture",
        dueAt: tomorrow.toISOString(),
        needsOfflineConfirmation: false,
        needsWeeklyReport: false,
        acceptanceChecklistItems: [],
      }),
      status: index === 0 ? "REJECTED" as const : "APPROVED" as const,
      reviewerOpenId: fixtures.adminOpenId,
      reviewerName: adminName,
      reviewedAt: addDays(now, -30 - index),
      createdAt: addDays(now, -30 - index),
    })),
  });

  return {
    establishmentProjectId: establishment.id,
    establishmentProjectName,
    approvalProjectId: approvalProject.id,
    stageApprovalId: stageApproval.id,
    stageApprovalName,
    stageSubmissionId: stageSubmission.id,
    batchDdlStageId: batchDdlStage.id,
    batchDdlStageName,
    batchDdlRequestId: batchDdlRequest.id,
    singleDdlStageId: singleDdlStage.id,
    singleDdlStageName,
    singleDdlRequestId: singleDdlRequest.id,
    taskCreationTitle,
    taskCreationRequestId: taskCreationRequest.id,
    taskDeletionTitle,
    taskDeletionId: taskDeletion.id,
    taskDeletionRequestId: taskDeletionRequest.id,
    taskDdlTitle,
    taskDdlId: taskDdl.id,
    taskDdlRequestId: taskDdlRequest.id,
    taskAcceptanceTitle,
    taskAcceptanceId: taskAcceptance.id,
    taskSubmissionId: taskSubmission.id,
    supersededStageName,
  };
}

async function createBoardTask({
  projectId,
  stageId,
  title,
  normalOpenId,
  normalName,
  dueAt,
  status,
}: {
  projectId: string;
  stageId: string;
  title: string;
  normalOpenId: string;
  normalName: string;
  dueAt: Date;
  status: TaskStatus;
}) {
  return prisma.task.create({
    data: {
      projectId,
      stageId,
      title,
      goal: "approval board task fixture",
      urgency: Urgency.MEDIUM,
      importance: Importance.MEDIUM,
      assigneeOpenId: normalOpenId,
      assigneeName: normalName,
      team: "英雄",
      techGroup: "电控",
      dueAt,
      status,
      metrics: "approval board task metrics",
      assignees: {
        create: [{ openId: normalOpenId, name: normalName, sortOrder: 0 }],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
    },
  });
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
