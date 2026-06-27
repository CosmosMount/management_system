import { expect, test } from "@playwright/test";
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
let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;

test.beforeAll(async () => {
  normalAuth = await resolveNormalAuthMaterial();
  try {
    fixtures = await prepareFunctionalFixtures(normalAuth);
  } catch (error) {
    throw new Error(`Playwright fixture 准备失败：${formatPrismaError(error)}`);
  }
});

test("上传文件路由要求登录且授权用户可读取文件", async ({
  page,
  context,
  baseURL,
}) => {
  await context.clearCookies();
  const anonymousResponse = await page.goto(fixtures.uploadPublicPath);
  expect(anonymousResponse?.status()).toBeLessThan(500);
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  await expect(page.getByText("请使用飞书账号登录")).toBeVisible();

  await loginAsNormalUser(context, baseURL, normalAuth);
  const authorizedResponse = await page.goto(fixtures.uploadPublicPath);
  expect(authorizedResponse?.status()).toBe(200);
  expect(authorizedResponse?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByText("playwright-owned-file")).toBeVisible();
});

test("上传文件路由对无关登录用户隐藏文件", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsOtherUser(context, baseURL);
  const unauthorizedResponse = await page.goto(fixtures.uploadPublicPath);

  expect(unauthorizedResponse?.status()).toBe(404);
  await expect(page.getByText("playwright-owned-file")).toHaveCount(0);
  await expectHealthyPage(page);
});

test("任务删除申请可由负责人提交并由管理员审批通过", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/progress/task/${fixtures.deletionTaskId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-删除申请任务")).toBeVisible();
  await page.getByRole("button", { name: "申请删除" }).click();

  const requestDialog = page.getByRole("dialog", { name: "申请删除任务" });
  await requestDialog
    .getByPlaceholder("填写删除原因")
    .fill("PW全功能-任务删除申请");
  await requestDialog.getByRole("button", { name: "提交申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.taskDeletionRequest.findFirst({
        where: {
          taskId: fixtures.deletionTaskId,
          reason: "PW全功能-任务删除申请",
          status: "PENDING",
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.taskDeletionRequest.findFirstOrThrow({
    where: { taskId: fixtures.deletionTaskId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/task/${fixtures.deletionTaskId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText("删除申请待审核")).toBeVisible();
    await adminPage
      .getByPlaceholder("审核意见；驳回时必填")
      .fill("PW全功能-同意删除任务");
    await adminPage.getByRole("button", { name: "通过并删除" }).click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [task, updatedRequest] = await Promise.all([
        prisma.task.findUniqueOrThrow({
          where: { id: fixtures.deletionTaskId },
          select: { deletedAt: true },
        }),
        prisma.taskDeletionRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, reviewerOpenId: true },
        }),
      ]);
      return {
        deleted: !!task.deletedAt,
        requestStatus: updatedRequest.status,
        reviewerRecorded: !!updatedRequest.reviewerOpenId,
      };
    })
    .toEqual({
      deleted: true,
      requestStatus: "APPROVED",
      reviewerRecorded: true,
    });
  await expectHealthyPage(page);
});

test("任务删除申请可由管理员驳回且任务保留", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/progress/task/${fixtures.deletionRejectTaskId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-删除驳回任务")).toBeVisible();
  await page.getByRole("button", { name: "申请删除" }).click();

  const reason = `PW全功能-任务删除驳回申请-${Date.now()}`;
  const comment = `PW全功能-不同意删除任务-${Date.now()}`;
  const requestDialog = page.getByRole("dialog", { name: "申请删除任务" });
  await requestDialog.getByPlaceholder("填写删除原因").fill(reason);
  await requestDialog.getByRole("button", { name: "提交申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.taskDeletionRequest.findFirst({
        where: {
          taskId: fixtures.deletionRejectTaskId,
          reason,
          status: "PENDING",
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.taskDeletionRequest.findFirstOrThrow({
    where: { taskId: fixtures.deletionRejectTaskId, reason },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/task/${fixtures.deletionRejectTaskId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText("删除申请待审核")).toBeVisible();
    await adminPage.getByPlaceholder("审核意见；驳回时必填").fill(comment);
    await adminPage.getByRole("button", { name: "驳回申请" }).click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [task, updatedRequest] = await Promise.all([
        prisma.task.findUniqueOrThrow({
          where: { id: fixtures.deletionRejectTaskId },
          select: { deletedAt: true },
        }),
        prisma.taskDeletionRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, reviewComment: true, reviewerOpenId: true },
        }),
      ]);
      return {
        deleted: !!task.deletedAt,
        requestStatus: updatedRequest.status,
        reviewComment: updatedRequest.reviewComment,
        reviewerRecorded: !!updatedRequest.reviewerOpenId,
      };
    })
    .toEqual({
      deleted: false,
      requestStatus: "REJECTED",
      reviewComment: comment,
      reviewerRecorded: true,
    });
  await expectHealthyPage(page);
});

test("任务可提交交付并由管理员按验收清单审批通过", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/progress/task/${fixtures.deliveryTaskId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-交付验收任务")).toBeVisible();
  await page
    .getByPlaceholder("https://xxx.feishu.cn/docx/...")
    .fill("https://example.feishu.cn/docx/playwright-delivery");
  await page
    .getByPlaceholder("视频、照片、曲线或归档材料链接，需为 URL")
    .fill("https://example.com/playwright-key-data");
  await page.getByRole("button", { name: "提交验收" }).click();

  await expect
    .poll(async () => {
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: fixtures.deliveryTaskId },
        select: { status: true },
      });
      const latestSubmission = await prisma.taskSubmission.findFirst({
        where: { taskId: fixtures.deliveryTaskId },
        orderBy: { submittedAt: "desc" },
        select: { id: true },
      });
      return {
        status: task.status,
        submissionId: latestSubmission?.id ?? "",
      };
    })
    .toMatchObject({ status: "PENDING_ACCEPTANCE" });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/task/${fixtures.deliveryTaskId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText("验收审批", { exact: true })).toBeVisible();
    await adminPage.getByLabel("PW全功能-交付验收项").check();
    await adminPage.getByRole("button", { name: "通过验收" }).click();
  } finally {
    await adminContext.close();
  }

  const savedSubmission = await prisma.taskSubmission.findFirstOrThrow({
    where: { taskId: fixtures.deliveryTaskId },
    orderBy: { submittedAt: "desc" },
    select: { id: true },
  });
  await expect
    .poll(async () => {
      const [task, approval] = await Promise.all([
        prisma.task.findUniqueOrThrow({
          where: { id: fixtures.deliveryTaskId },
          select: { status: true },
        }),
        prisma.approvalRecord.findUnique({
          where: { submissionId: savedSubmission.id },
          select: {
            decision: true,
            approverOpenId: true,
            checklistConfirmations: { select: { content: true } },
          },
        }),
      ]);
      return {
        taskStatus: task.status,
        decision: approval?.decision ?? "",
        approverRecorded: !!approval?.approverOpenId,
        checklist: approval?.checklistConfirmations.map((item) => item.content) ?? [],
      };
    })
    .toEqual({
      taskStatus: "COMPLETED",
      decision: "APPROVED",
      approverRecorded: true,
      checklist: ["PW全功能-交付验收项"],
    });
  await expectHealthyPage(page);
});

test("任务交付可由管理员驳回并退回进行中", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/progress/task/${fixtures.deliveryRejectTaskId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-交付驳回任务")).toBeVisible();
  await page
    .getByPlaceholder("https://xxx.feishu.cn/docx/...")
    .fill("https://example.feishu.cn/docx/playwright-delivery-reject");
  await page
    .getByPlaceholder("视频、照片、曲线或归档材料链接，需为 URL")
    .fill("https://example.com/playwright-key-data-reject");
  await page.getByRole("button", { name: "提交验收" }).click();

  await expect
    .poll(async () => {
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: fixtures.deliveryRejectTaskId },
        select: { status: true },
      });
      const latestSubmission = await prisma.taskSubmission.findFirst({
        where: { taskId: fixtures.deliveryRejectTaskId },
        orderBy: { submittedAt: "desc" },
        select: { id: true },
      });
      return {
        status: task.status,
        submissionId: latestSubmission?.id ?? "",
      };
    })
    .toMatchObject({ status: "PENDING_ACCEPTANCE" });

  const savedSubmission = await prisma.taskSubmission.findFirstOrThrow({
    where: { taskId: fixtures.deliveryRejectTaskId },
    orderBy: { submittedAt: "desc" },
    select: { id: true },
  });
  const rejectComment = `PW全功能-验收驳回-${Date.now()}`;

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/task/${fixtures.deliveryRejectTaskId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText("验收审批", { exact: true })).toBeVisible();
    await adminPage
      .getByPlaceholder("驳回理由（驳回时会通知任务负责人）")
      .fill(rejectComment);
    await adminPage.getByRole("button", { name: "驳回" }).click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [task, approval] = await Promise.all([
        prisma.task.findUniqueOrThrow({
          where: { id: fixtures.deliveryRejectTaskId },
          select: { status: true },
        }),
        prisma.approvalRecord.findUnique({
          where: { submissionId: savedSubmission.id },
          select: { decision: true, comment: true, approverOpenId: true },
        }),
      ]);
      return {
        taskStatus: task.status,
        decision: approval?.decision ?? "",
        comment: approval?.comment ?? "",
        approverRecorded: !!approval?.approverOpenId,
      };
    })
    .toEqual({
      taskStatus: "IN_PROGRESS",
      decision: "REJECTED",
      comment: rejectComment,
      approverRecorded: true,
    });
  await expectHealthyPage(page);
});

test("取消项目会级联取消未结束任务并保留已完成和已归档任务", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsAdminUser(context, baseURL);
  await page.goto(`/progress/${fixtures.cancelProjectId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-取消级联项目")).toBeVisible();
  const disabledCompleteButton = page.getByRole("button", { name: "完成项目" });
  await expect(disabledCompleteButton).toBeDisabled();
  await expect(disabledCompleteButton.locator("xpath=ancestor::span[1]")).toHaveAttribute(
    "title",
    /还有/,
  );

  await page.getByRole("button", { name: "取消项目" }).click();
  const dialog = page.getByRole("dialog", { name: "确认取消项目" });
  await dialog.getByPlaceholder("请填写具体原因，将通知相关人员").fill(
    "PW全功能-取消项目验证级联",
  );
  await dialog.getByRole("button", { name: "确认取消" }).click();

  await expect
    .poll(async () => {
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: fixtures.cancelProjectId },
        select: { status: true, canceledAt: true },
      });
      const tasks = await prisma.task.findMany({
        where: {
          id: {
            in: [
              fixtures.cancelTodoTaskId,
              fixtures.cancelInProgressTaskId,
              fixtures.cancelPendingTaskId,
              fixtures.cancelCompletedTaskId,
              fixtures.cancelArchivedTaskId,
            ],
          },
        },
        select: { id: true, status: true },
      });
      return {
        projectStatus: project.status,
        canceled: !!project.canceledAt,
        taskStatusById: Object.fromEntries(
          tasks.map((task) => [task.id, task.status]),
        ),
      };
    })
    .toEqual({
      projectStatus: "CANCELED",
      canceled: true,
      taskStatusById: {
        [fixtures.cancelTodoTaskId]: "PROJECT_CANCELED",
        [fixtures.cancelInProgressTaskId]: "PROJECT_CANCELED",
        [fixtures.cancelPendingTaskId]: "PROJECT_CANCELED",
        [fixtures.cancelCompletedTaskId]: "COMPLETED",
        [fixtures.cancelArchivedTaskId]: "ARCHIVED",
      },
  });
  await expectHealthyPage(page);
});

test("全部阶段和任务完成后项目可完成并归档", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsAdminUser(context, baseURL);
  await page.goto(`/progress/${fixtures.completableProjectId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-可完成项目")).toBeVisible();

  const completeButton = page.getByRole("button", { name: "完成项目" });
  await expect(completeButton).toBeEnabled();
  await completeButton.click();

  const dialog = page.getByRole("dialog", { name: "确认完成项目" });
  await dialog
    .getByPlaceholder("请填写具体原因，将通知相关人员")
    .fill("PW全功能-完成项目成功路径");
  await dialog.getByRole("button", { name: "确认完成" }).click();

  await expect
    .poll(async () => {
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: fixtures.completableProjectId },
        select: { status: true, completedAt: true, archivedAt: true },
      });
      return {
        status: project.status,
        completed: !!project.completedAt,
        archived: !!project.archivedAt,
      };
    })
    .toEqual({ status: "COMPLETED", completed: true, archived: true });
  await expectHealthyPage(page);
});
