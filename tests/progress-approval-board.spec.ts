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
