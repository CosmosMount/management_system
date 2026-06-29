import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { createProjectSchema } from "../lib/validations/progress";
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

test("采购管理审核和老师审核能通过 UI 推进状态", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsAdminUser(context, baseURL);
  await page.goto(`/procurement/${fixtures.reviewOrderId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-审核物料")).toBeVisible();

  await page
    .getByRole("button", { name: /车组组长通过|技术组组长通过/ })
    .first()
    .click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: fixtures.reviewOrderId },
        select: {
          status: true,
          teamApproved: true,
          techGroupApproved: true,
          teamApproverOpenId: true,
          techGroupApproverOpenId: true,
        },
      });
      return order;
    })
    .toMatchObject({
      status: "TEACHER_REVIEW",
      teamApproved: true,
      techGroupApproved: true,
      teamApproverOpenId: fixtures.adminOpenId,
      techGroupApproverOpenId: fixtures.adminOpenId,
    });

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("老师审核")).toBeVisible();
  await page.getByRole("button", { name: "指导老师通过" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: fixtures.reviewOrderId },
        select: { status: true },
      });
      return order.status;
    })
    .toBe("PENDING_APPLICANT_DOCS");
  await expectHealthyPage(page);
});

test("采购草稿可从详情页直接提交到管理审核", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/procurement/${fixtures.draftOrderId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-草稿物料")).toBeVisible();
  await page.getByRole("button", { name: "提交申请" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: fixtures.draftOrderId },
        select: { status: true },
      });
      return order.status;
    })
    .toBe("MANAGEMENT_REVIEW");
  await expectHealthyPage(page);
});

test("采购申请可从新建页直接提交到管理审核", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const itemName = `PW全功能-直接提交物料-${Date.now()}`;
  await page.goto("/procurement/new", { waitUntil: "networkidle" });
  await fillNewProcurementApplication(page, itemName, "138");
  await page.getByRole("button", { name: "提交申请" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findFirst({
        where: { items: { some: { name: itemName } } },
        select: { id: true, status: true, totalPrice: true },
      });
      return order
        ? {
            status: order.status,
            totalPrice: order.totalPrice,
          }
        : null;
    })
    .toEqual({ status: "MANAGEMENT_REVIEW", totalPrice: 138 });
  await expectHealthyPage(page);
});

test("采购草稿从列表进入编辑后可再次保存草稿并提交", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const draftItemName = `PW全功能-新建草稿物料-${Date.now()}`;
  const editedItemName = `PW全功能-编辑草稿物料-${Date.now()}`;
  await page.goto("/procurement/new", { waitUntil: "networkidle" });
  await fillNewProcurementApplication(page, draftItemName, "88");
  await page.getByRole("button", { name: "保存草稿" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findFirst({
        where: { items: { some: { name: draftItemName } } },
        select: { id: true, status: true },
      });
      return order ?? null;
    })
    .toMatchObject({ status: "DRAFT" });
  const draft = await prisma.purchaseOrder.findFirstOrThrow({
    where: { items: { some: { name: draftItemName } } },
    select: { id: true, orderNo: true },
  });

  await page.goto("/procurement/list", { waitUntil: "networkidle" });
  await expect(page.getByRole("link", { name: draft.orderNo })).toBeVisible();
  await page.getByRole("link", { name: draft.orderNo }).click();
  await expect(page).toHaveURL(new RegExp(`/procurement/${draft.id}$`));
  await page.getByRole("link", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(new RegExp(`/procurement/${draft.id}/edit$`));
  await fillProcurementItemFields(page, editedItemName, "99");
  await page.getByRole("button", { name: "保存草稿" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: draft.id },
        include: { items: { select: { name: true } } },
      });
      return {
        status: order.status,
        totalPrice: order.totalPrice,
        itemName: order.items[0]?.name ?? "",
      };
    })
    .toEqual({
      status: "DRAFT",
      totalPrice: 99,
      itemName: editedItemName,
    });

  await page.goto(`/procurement/${draft.id}/edit`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "提交申请" }).click();
  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: draft.id },
        select: { status: true, totalPrice: true },
      });
      return order;
    })
    .toEqual({ status: "MANAGEMENT_REVIEW", totalPrice: 99 });
  await expectHealthyPage(page);
});

test("采购管理审核可终止驳回", async ({ page, context, baseURL }) => {
  await loginAsAdminUser(context, baseURL);
  const reason = `PW全功能-管理审核终止驳回-${Date.now()}`;
  await page.goto(`/procurement/${fixtures.managementRejectOrderId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-管理驳回物料")).toBeVisible();
  await page.getByRole("button", { name: "驳回" }).click();
  await page.getByRole("button", { name: "终止采购" }).click();
  await page.getByPlaceholder("请填写具体原因，将通知相关人员").fill(reason);
  await page.getByRole("button", { name: "确认终止" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: fixtures.managementRejectOrderId },
        select: { status: true, rejectionReason: true, rejectedByName: true },
      });
      return order;
    })
    .toMatchObject({
      status: "REJECTED",
      rejectionReason: reason,
      rejectedByName: "Playwright 管理员",
    });
  await expectHealthyPage(page);
});

test("采购老师审核可终止驳回", async ({ page, context, baseURL }) => {
  await loginAsAdminUser(context, baseURL);
  const reason = `PW全功能-老师审核终止驳回-${Date.now()}`;
  await page.goto(`/procurement/${fixtures.teacherRejectOrderId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-老师驳回物料")).toBeVisible();
  await page.getByRole("button", { name: "驳回" }).click();
  await page.getByRole("button", { name: "终止采购" }).click();
  await page.getByPlaceholder("请填写具体原因，将通知相关人员").fill(reason);
  await page.getByRole("button", { name: "确认终止" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: fixtures.teacherRejectOrderId },
        select: { status: true, rejectionReason: true, rejectedByName: true },
      });
      return order;
    })
    .toMatchObject({
      status: "REJECTED",
      rejectionReason: reason,
      rejectedByName: "Playwright 管理员",
    });
  await expectHealthyPage(page);
});

test("采购报销链路可上传凭证、财务截图并由申请人确认完成", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const item = await prisma.purchaseItem.findFirstOrThrow({
    where: { orderId: fixtures.reimbursementOrderId },
    select: { id: true },
  });

  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/procurement/${fixtures.reimbursementOrderId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW-FULL-REIMBURSE")).toBeVisible();
  await page.getByRole("button", { name: "上传凭证" }).click();

  const applicantDialog = page.getByRole("dialog", { name: "上传报销凭证" });
  await expect(applicantDialog).toBeVisible();
  await applicantDialog
    .locator('input[name="invoices"]')
    .setInputFiles([pngUpload("invoice.png")]);
  await applicantDialog
    .locator(`input[name="photo-${item.id}"]`)
    .setInputFiles([pngUpload("photo.png")]);
  await applicantDialog.getByRole("button", { name: "提交给报销员" }).click();

  await expect
    .poll(async () => {
      const [order, updatedItem] = await Promise.all([
        prisma.purchaseOrder.findUniqueOrThrow({
          where: { id: fixtures.reimbursementOrderId },
          select: {
            status: true,
            invoicePaths: true,
            invoicePath: true,
            listDocPath: true,
          },
        }),
        prisma.purchaseItem.findUniqueOrThrow({
          where: { id: item.id },
          select: { photoPath: true },
        }),
      ]);
      return {
        status: order.status,
        hasInvoiceList: order.invoicePaths !== "[]",
        hasLegacyInvoice: !!order.invoicePath,
        hasListDoc: !!order.listDocPath,
        hasPhoto: !!updatedItem.photoPath,
      };
    })
    .toEqual({
      status: "PENDING_FINANCE_REVIEW",
      hasInvoiceList: true,
      hasLegacyInvoice: true,
      hasListDoc: true,
      hasPhoto: true,
    });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/procurement/${fixtures.reimbursementOrderId}`, {
      waitUntil: "networkidle",
    });
    await adminPage.getByRole("button", { name: "上传截图" }).click();
    const financeDialog = adminPage.getByRole("dialog", { name: "报销截图" });
    await expect(financeDialog).toBeVisible();
    await financeDialog
      .locator('input[name="screenshot"]')
      .setInputFiles([pngUpload("screenshot.png")]);
    await financeDialog.getByRole("button", { name: "提交" }).click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: fixtures.reimbursementOrderId },
        select: { status: true, screenshotPath: true },
      });
      return {
        status: order.status,
        hasScreenshot: !!order.screenshotPath,
      };
    })
    .toEqual({
      status: "PENDING_APPLICANT_CONFIRM",
      hasScreenshot: true,
    });

  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/procurement/${fixtures.reimbursementOrderId}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "确认报销" }).click();
  const confirmDialog = page.getByRole("dialog", { name: "确认报销" });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog
    .getByRole("button", { name: "确认无误，完成报销" })
    .click();

  await expect
    .poll(async () => {
      const [order, outboxCount] = await Promise.all([
        prisma.purchaseOrder.findUniqueOrThrow({
          where: { id: fixtures.reimbursementOrderId },
          select: { status: true },
        }),
        prisma.notificationOutbox.count({
          where: {
            channel: "procurement",
            type: "order",
            payload: { contains: fixtures.reimbursementOrderId },
          },
        }),
      ]);
      return { status: order.status, outboxCount };
    })
    .toEqual({ status: "COMPLETED", outboxCount: 2 });
  await expectHealthyPage(page);
});

test("工坊加工费可录入并直接计入采购汇总", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const feeName = `PW全功能-工坊加工费-${Date.now()}`;
  const vendorName = `PW全功能-加工商-${Date.now()}`;

  await page.goto("/procurement/workshop-fee", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "工坊加工费" })).toBeVisible();
  await page.getByText("请选择车组").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page
    .getByText("费用名称")
    .first()
    .locator("xpath=following::input[1]")
    .fill(feeName);
  await page
    .getByText("说明")
    .first()
    .locator("xpath=following::input[1]")
    .fill("PW全功能-加工说明");
  await page.getByText("请选择加工商").click();
  await page.getByRole("option", { name: /添加加工商/ }).click();
  await page.locator("#processing-vendor-name").fill(vendorName);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("加工商已添加")).toBeVisible();
  await page
    .getByText("图片")
    .first()
    .locator("xpath=following::input[@type='file'][1]")
    .setInputFiles([pngUpload("workshop-fee.png")]);
  await page
    .getByText("金额")
    .first()
    .locator("xpath=following::input[1]")
    .fill("66");
  await page.getByRole("button", { name: "提交并计入汇总" }).click();

  await expect
    .poll(async () => {
      const order = await prisma.purchaseOrder.findFirst({
        where: {
          isWorkshopFee: true,
          items: { some: { name: feeName } },
        },
        include: {
          items: {
            select: { processingVendor: true, referenceImagePath: true },
          },
        },
      });
      return order
        ? {
            status: order.status,
            isWorkshopFee: order.isWorkshopFee,
            totalPrice: order.totalPrice,
            vendor: order.items[0]?.processingVendor ?? "",
            hasPhoto: !!order.items[0]?.referenceImagePath,
          }
        : null;
    })
    .toEqual({
      status: "COMPLETED",
      isWorkshopFee: true,
      totalPrice: 66,
      vendor: vendorName,
      hasPhoto: true,
    });
  await expectHealthyPage(page);
});

test("反馈可由普通用户创建回复，并由管理员关闭", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const body = `PW全功能-新建反馈-${Date.now()}`;
  const reply = `PW全功能-反馈补充-${Date.now()}`;

  await page.goto("/feedback?new=1", { waitUntil: "networkidle" });
  await page.getByPlaceholder("请输入反馈内容").fill(body);
  await page.getByRole("button", { name: "提交反馈" }).click();

  await expect
    .poll(async () => {
      const feedback = await prisma.feedback.findFirst({
        where: { messages: { some: { body } } },
        select: { id: true },
      });
      return feedback?.id ?? "";
    })
    .not.toBe("");
  const createdFeedback = await prisma.feedback.findFirstOrThrow({
    where: { messages: { some: { body } } },
    select: { id: true },
  });
  const feedbackId = createdFeedback.id;

  await page.getByPlaceholder("继续补充情况，或回复处理结果").fill(reply);
  await page.getByRole("button", { name: "发送回复" }).click();

  await expect
    .poll(async () => {
      return prisma.feedbackMessage.count({
        where: { feedbackId, body: { in: [body, reply] } },
      });
    })
    .toBe(2);

  await loginAsAdminUser(context, baseURL);
  await page.goto(`/feedback?selected=${feedbackId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText(body).last()).toBeVisible();
  const feedbackDetailHeader = page
    .getByText("反馈详情")
    .locator("xpath=ancestor::*[contains(@class,'border-b')][1]");
  await feedbackDetailHeader.getByRole("button", { name: "已关闭" }).click();

  await expect
    .poll(async () => {
      const feedback = await prisma.feedback.findUniqueOrThrow({
        where: { id: feedbackId },
        select: { status: true, closedAt: true },
      });
      return {
        status: feedback.status,
        closed: !!feedback.closedAt,
      };
    })
    .toEqual({ status: "CLOSED", closed: true });

  await feedbackDetailHeader.getByRole("button", { name: "处理中" }).click();
  await expect
    .poll(async () => {
      const feedback = await prisma.feedback.findUniqueOrThrow({
        where: { id: feedbackId },
        select: { status: true },
      });
      return feedback.status;
    })
    .toBe("IN_PROGRESS");

  await feedbackDetailHeader.getByRole("button", { name: "开放" }).click();
  await expect
    .poll(async () => {
      const feedback = await prisma.feedback.findUniqueOrThrow({
        where: { id: feedbackId },
        select: { status: true },
      });
      return feedback.status;
    })
    .toBe("OPEN");
  await expectHealthyPage(page);
});

test("反馈图片上传限制会拦截非法类型、超大文件和超数量文件", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto("/feedback?new=1", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "提交反馈" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/单张不超过 20MB/)).toBeVisible();
  const imageInput = dialog.locator('input[type="file"]');

  await imageInput.setInputFiles([
    {
      name: "not-image.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not an image", "utf8"),
    },
  ]);
  await expect(page.getByText("反馈图片仅支持 PNG/JPG/WebP")).toBeVisible();

  await imageInput.setInputFiles([
    {
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(21 * 1024 * 1024),
    },
  ]);
  await expect(page.getByText("单张反馈图片不能超过 20MB")).toBeVisible();

  await imageInput.setInputFiles(
    Array.from({ length: 10 }, (_, index) =>
      pngUpload(`feedback-${index}.png`),
    ),
  );
  await expect(page.getByText("最多上传 9 张图片")).toBeVisible();
  await expectHealthyPage(page);
});

test("任务可通过 UI 开始、提交周报、解除风险并新增风险", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/progress/task/${fixtures.todoTaskId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-待开始任务")).toBeVisible();
  await page.getByRole("button", { name: "开始任务" }).click();

  await expect
    .poll(async () => {
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: fixtures.todoTaskId },
        select: { status: true },
      });
      return task.status;
    })
    .toBe("IN_PROGRESS");

  await page.goto(`/progress/task/${fixtures.taskId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("风险同步", { exact: true })).toBeVisible();
  await page.getByPlaceholder("风险解除说明").fill("PW全功能-风险已处理");
  await page.getByRole("button", { name: "解除风险" }).click();

  await expect
    .poll(async () => {
      const risk = await prisma.taskRiskRecord.findFirstOrThrow({
        where: {
          taskId: fixtures.taskId,
          content: "PW全功能-活动风险",
        },
        select: { status: true, resolveNote: true },
      });
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: fixtures.taskId },
        select: { riskNote: true },
      });
      return { riskStatus: risk.status, resolveNote: risk.resolveNote, riskNote: task.riskNote };
    })
    .toEqual({
      riskStatus: "RESOLVED",
      resolveNote: "PW全功能-风险已处理",
      riskNote: "",
    });

  await page.getByPlaceholder("本周完成情况").fill("PW全功能-本周完成");
  await page.getByPlaceholder("下周计划").fill("PW全功能-下周计划");
  await page.getByRole("button", { name: "提交周报" }).click();

  await expect
    .poll(async () => {
      return prisma.weeklyReport.count({
        where: {
          taskId: fixtures.taskId,
          progress: "PW全功能-本周完成",
          nextPlan: "PW全功能-下周计划",
        },
      });
    })
    .toBe(1);

  const newRisk = `PW全功能-新增风险-${Date.now()}`;
  await page
    .getByPlaceholder("说明风险、阻塞或需要组长/项管介入的问题")
    .fill(newRisk);
  await page.getByRole("button", { name: "同步风险" }).click();

  await expect
    .poll(async () => {
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: fixtures.taskId },
        select: { riskNote: true },
      });
      const activeRiskCount = await prisma.taskRiskRecord.count({
        where: {
          taskId: fixtures.taskId,
          content: newRisk,
          status: "ACTIVE",
        },
      });
      return { riskNote: task.riskNote, activeRiskCount };
    })
    .toEqual({ riskNote: newRisk, activeRiskCount: 1 });
  await expectHealthyPage(page);
});

test("任务 DDL 修改申请可由 UI 提交并审批通过", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const newDueAt = addDays(new Date(), 9);
  const newDueAtInput = formatDateTimeLocal(newDueAt);
  const reason = `PW全功能-任务 DDL 调整-${Date.now()}`;

  await page.goto(`/progress/task/${fixtures.taskId}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "申请修改 DDL" }).click();

  const dialog = page.getByRole("dialog", { name: "申请修改 DDL" });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="datetime-local"]').fill(newDueAtInput);
  await dialog
    .getByPlaceholder("说明为什么需要调整任务最晚完成时间")
    .fill(reason);
  await dialog.getByRole("button", { name: "提交申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.taskDdlChangeRequest.findFirst({
        where: {
          taskId: fixtures.taskId,
          reason,
          status: "PENDING",
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.taskDdlChangeRequest.findFirstOrThrow({
    where: { taskId: fixtures.taskId, reason },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/task/${fixtures.taskId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText(reason).first()).toBeVisible();
    await adminPage
      .getByPlaceholder("审核意见；驳回时必填")
      .fill("PW全功能-同意任务 DDL 调整");
    await adminPage
      .getByPlaceholder("审核意见；驳回时必填")
      .locator("xpath=following::button[normalize-space(.)='通过'][1]")
      .click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedTask, updatedRequest] = await Promise.all([
        prisma.task.findUniqueOrThrow({
          where: { id: fixtures.taskId },
          select: { dueAt: true },
        }),
        prisma.taskDdlChangeRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, reviewerOpenId: true },
        }),
      ]);
      return {
        status: updatedRequest.status,
        reviewerRecorded: !!updatedRequest.reviewerOpenId,
        dueAt: formatDateTimeLocal(updatedTask.dueAt),
      };
    })
    .toEqual({
      status: "APPROVED",
      reviewerRecorded: true,
      dueAt: newDueAtInput,
    });
  await expectHealthyPage(page);
});

test("任务 DDL 修改申请可由 UI 驳回且不修改截止时间", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const beforeTask = await prisma.task.findUniqueOrThrow({
    where: { id: fixtures.ddlRejectTaskId },
    select: { dueAt: true },
  });
  await loginAsNormalUser(context, baseURL, normalAuth);
  const newDueAt = addDays(new Date(), 12);
  const newDueAtInput = formatDateTimeLocal(newDueAt);
  const reason = `PW全功能-任务 DDL 驳回-${Date.now()}`;
  const comment = `PW全功能-不同意任务 DDL 调整-${Date.now()}`;

  await page.goto(`/progress/task/${fixtures.ddlRejectTaskId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-DDL 驳回任务")).toBeVisible();
  await page.getByRole("button", { name: "申请修改 DDL" }).click();

  const dialog = page.getByRole("dialog", { name: "申请修改 DDL" });
  await dialog.locator('input[type="datetime-local"]').fill(newDueAtInput);
  await dialog
    .getByPlaceholder("说明为什么需要调整任务最晚完成时间")
    .fill(reason);
  await dialog.getByRole("button", { name: "提交申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.taskDdlChangeRequest.findFirst({
        where: {
          taskId: fixtures.ddlRejectTaskId,
          reason,
          status: "PENDING",
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.taskDdlChangeRequest.findFirstOrThrow({
    where: { taskId: fixtures.ddlRejectTaskId, reason },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/task/${fixtures.ddlRejectTaskId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText(reason).first()).toBeVisible();
    await adminPage.getByPlaceholder("审核意见；驳回时必填").fill(comment);
    await adminPage
      .getByPlaceholder("审核意见；驳回时必填")
      .locator("xpath=following::button[normalize-space(.)='驳回'][1]")
      .click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedTask, updatedRequest] = await Promise.all([
        prisma.task.findUniqueOrThrow({
          where: { id: fixtures.ddlRejectTaskId },
          select: { dueAt: true },
        }),
        prisma.taskDdlChangeRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, reviewComment: true },
        }),
      ]);
      return {
        status: updatedRequest.status,
        reviewComment: updatedRequest.reviewComment,
        dueAt: formatDateTimeLocal(updatedTask.dueAt),
      };
    })
    .toEqual({
      status: "REJECTED",
      reviewComment: comment,
      dueAt: formatDateTimeLocal(beforeTask.dueAt),
    });
  await expectHealthyPage(page);
});

test("项目阶段延期申请可由 UI 提交并审批通过", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const beforeStages = await prisma.projectStage.findMany({
    where: { projectId: fixtures.projectId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, dueAt: true, extensionCount: true },
  });
  const [currentStage, nextStage] = beforeStages;
  if (!currentStage?.dueAt || !nextStage?.dueAt) {
    throw new Error("项目阶段延期测试缺少带 DDL 的 fixture 阶段");
  }
  const currentStageDueAt = currentStage.dueAt;
  const nextStageDueAt = nextStage.dueAt;

  await loginAsNormalUser(context, baseURL, normalAuth);
  const reason = `PW全功能-阶段延期-${Date.now()}`;
  await page.goto(`/progress/${fixtures.projectId}`, {
    waitUntil: "networkidle",
  });
  await page
    .getByText("阶段 1：PW全功能-当前阶段")
    .locator("xpath=ancestor::*[contains(@class,'rounded')][1]")
    .getByRole("button", { name: "申请批量延期/提前" })
    .click();
  const dialog = page.getByRole("dialog", { name: "申请批量延期/提前" });
  await expect(dialog).toBeVisible();
  await page.locator("#stage-extension-reason").fill(reason);
  await page.locator("#stage-extension-duration").fill("2");
  await page.getByRole("button", { name: "提交批量调整申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.projectDdlChangeRequest.findFirst({
        where: {
          projectId: fixtures.projectId,
          reason,
          status: "PENDING",
          type: "CASCADE_EXTENSION",
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.projectDdlChangeRequest.findFirstOrThrow({
    where: { projectId: fixtures.projectId, reason },
    select: { id: true },
  });
  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/${fixtures.projectId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText(reason).first()).toBeVisible();
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .fill("PW全功能-同意阶段延期");
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .locator("xpath=following::button[normalize-space(.)='通过'][1]")
      .click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedCurrentStage, updatedNextStage, updatedRequest, outbox] =
        await Promise.all([
          prisma.projectStage.findUniqueOrThrow({
            where: { id: currentStage.id },
            select: { dueAt: true, extensionCount: true, benignExtensionCount: true },
          }),
          prisma.projectStage.findUniqueOrThrow({
            where: { id: nextStage.id },
            select: { dueAt: true, extensionCount: true, benignExtensionCount: true },
          }),
          prisma.projectDdlChangeRequest.findUniqueOrThrow({
            where: { id: request.id },
            select: { status: true, reviewerOpenId: true, finalIsBenign: true },
          }),
          prisma.notificationOutbox.findFirst({
            where: {
              eventKey: {
                startsWith: `progress:project_stage_batch_due_change_approved:${request.id}`,
              },
            },
            select: { payload: true },
          }),
        ]);
      return {
        status: updatedRequest.status,
        reviewerOpenId: updatedRequest.reviewerOpenId,
        finalIsBenign: updatedRequest.finalIsBenign,
        currentDueAt: updatedCurrentStage.dueAt
          ? formatDateOnly(updatedCurrentStage.dueAt)
          : "",
        nextDueAt: updatedNextStage.dueAt
          ? formatDateOnly(updatedNextStage.dueAt)
          : "",
        currentExtensionCount: updatedCurrentStage.extensionCount,
        nextExtensionCount: updatedNextStage.extensionCount,
        currentBenignCount: updatedCurrentStage.benignExtensionCount,
        nextBenignCount: updatedNextStage.benignExtensionCount,
        outboxPayload: outbox?.payload ?? "",
      };
    })
    .toEqual({
      status: "APPROVED",
      reviewerOpenId: fixtures.adminOpenId,
      finalIsBenign: true,
      currentDueAt: formatDateOnly(addDays(currentStageDueAt, 2)),
      nextDueAt: formatDateOnly(addDays(nextStageDueAt, 2)),
      currentExtensionCount: currentStage.extensionCount + 1,
      nextExtensionCount: nextStage.extensionCount + 1,
      currentBenignCount: 1,
      nextBenignCount: 1,
      outboxPayload: expect.stringContaining("project_stage_batch_due_change_approved"),
    });
  await expectHealthyPage(page);
});

test("项目阶段批量提前申请可由 UI 提交并审批通过", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const beforeStages = await prisma.projectStage.findMany({
    where: { projectId: fixtures.projectId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, dueAt: true, extensionCount: true, benignExtensionCount: true },
  });
  const [currentStage, nextStage] = beforeStages;
  if (!currentStage?.dueAt || !nextStage?.dueAt) {
    throw new Error("项目阶段提前测试缺少带 DDL 的 fixture 阶段");
  }

  await loginAsNormalUser(context, baseURL, normalAuth);
  const reason = `PW全功能-阶段提前-${Date.now()}`;
  await page.goto(`/progress/${fixtures.projectId}`, {
    waitUntil: "networkidle",
  });
  await page
    .getByText("阶段 1：PW全功能-当前阶段")
    .locator("xpath=ancestor::*[contains(@class,'rounded')][1]")
    .getByRole("button", { name: "申请批量延期/提前" })
    .click();
  const dialog = page.getByRole("dialog", { name: "申请批量延期/提前" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("调整类型").click();
  await page.getByRole("option", { name: "提前" }).click();
  await page.locator("#stage-extension-reason").fill(reason);
  await page.locator("#stage-extension-duration").fill("1");
  await page.getByRole("button", { name: "提交批量调整申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.projectDdlChangeRequest.findFirst({
        where: {
          projectId: fixtures.projectId,
          reason,
          status: "PENDING",
          type: "CASCADE_EXTENSION",
          durationDays: -1,
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.projectDdlChangeRequest.findFirstOrThrow({
    where: { projectId: fixtures.projectId, reason },
    select: { id: true },
  });
  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/${fixtures.projectId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText(reason).first()).toBeVisible();
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .fill("PW全功能-同意阶段提前");
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .locator("xpath=following::button[normalize-space(.)='通过'][1]")
      .click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedCurrentStage, updatedNextStage, updatedRequest, outbox] =
        await Promise.all([
          prisma.projectStage.findUniqueOrThrow({
            where: { id: currentStage.id },
            select: { dueAt: true, extensionCount: true, benignExtensionCount: true },
          }),
          prisma.projectStage.findUniqueOrThrow({
            where: { id: nextStage.id },
            select: { dueAt: true, extensionCount: true, benignExtensionCount: true },
          }),
          prisma.projectDdlChangeRequest.findUniqueOrThrow({
            where: { id: request.id },
            select: { status: true, reviewerOpenId: true, finalIsBenign: true },
          }),
          prisma.notificationOutbox.findFirst({
            where: {
              eventKey: {
                startsWith: `progress:project_stage_batch_due_change_approved:${request.id}`,
              },
            },
            select: { payload: true },
          }),
        ]);
      return {
        status: updatedRequest.status,
        reviewerOpenId: updatedRequest.reviewerOpenId,
        finalIsBenign: updatedRequest.finalIsBenign,
        currentDueAt: updatedCurrentStage.dueAt
          ? formatDateOnly(updatedCurrentStage.dueAt)
          : "",
        nextDueAt: updatedNextStage.dueAt
          ? formatDateOnly(updatedNextStage.dueAt)
          : "",
        currentExtensionCount: updatedCurrentStage.extensionCount,
        nextExtensionCount: updatedNextStage.extensionCount,
        currentBenignCount: updatedCurrentStage.benignExtensionCount,
        nextBenignCount: updatedNextStage.benignExtensionCount,
        outboxPayload: outbox?.payload ?? "",
      };
    })
    .toEqual({
      status: "APPROVED",
      reviewerOpenId: fixtures.adminOpenId,
      finalIsBenign: null,
      currentDueAt: formatDateOnly(addDays(currentStage.dueAt, -1)),
      nextDueAt: formatDateOnly(addDays(nextStage.dueAt, -1)),
      currentExtensionCount: currentStage.extensionCount,
      nextExtensionCount: nextStage.extensionCount,
      currentBenignCount: currentStage.benignExtensionCount,
      nextBenignCount: nextStage.benignExtensionCount,
      outboxPayload: expect.stringContaining("\"durationDays\":-1"),
    });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("提前 1 次", { exact: true })).toBeVisible();
  await expectHealthyPage(page);
});

test("项目阶段批量延期只影响所选阶段及后续阶段", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const beforeStages = await prisma.projectStage.findMany({
    where: { projectId: fixtures.projectId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, dueAt: true, extensionCount: true },
  });
  const [previousStage, selectedStage, followingStage] = beforeStages;
  if (!previousStage?.dueAt || !selectedStage?.dueAt || !followingStage?.dueAt) {
    throw new Error("批量 DDL 范围测试缺少三段带 DDL 的 fixture 阶段");
  }

  await loginAsNormalUser(context, baseURL, normalAuth);
  const reason = `PW全功能-阶段范围延期-${Date.now()}`;
  await page.goto(`/progress/${fixtures.projectId}`, {
    waitUntil: "networkidle",
  });
  await page
    .getByRole("button", { name: /2 PW全功能-后续阶段/ })
    .click();
  await expect(page.getByText("阶段 2：PW全功能-后续阶段")).toBeVisible();
  await page
    .getByText("阶段 2：PW全功能-后续阶段")
    .locator("xpath=ancestor::*[contains(@class,'rounded')][1]")
    .getByRole("button", { name: "申请批量延期/提前" })
    .click();
  const dialog = page.getByRole("dialog", { name: "申请批量延期/提前" });
  await expect(dialog).toBeVisible();
  await page.locator("#stage-extension-reason").fill(reason);
  await page.locator("#stage-extension-duration").fill("3");
  await page.getByRole("button", { name: "提交批量调整申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.projectDdlChangeRequest.findFirst({
        where: {
          projectId: fixtures.projectId,
          stageId: selectedStage.id,
          reason,
          status: "PENDING",
          type: "CASCADE_EXTENSION",
          durationDays: 3,
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/${fixtures.projectId}`, {
      waitUntil: "networkidle",
    });
    await adminPage
      .getByRole("button", { name: /2 PW全功能-后续阶段/ })
      .click();
    await expect(
      adminPage.getByText("阶段 2：PW全功能-后续阶段"),
    ).toBeVisible();
    await expect(adminPage.getByText(reason).first()).toBeVisible();
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .fill("PW全功能-同意范围延期");
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .locator("xpath=following::button[normalize-space(.)='通过'][1]")
      .click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedPreviousStage, updatedSelectedStage, updatedFollowingStage] =
        await Promise.all([
          prisma.projectStage.findUniqueOrThrow({
            where: { id: previousStage.id },
            select: { dueAt: true, extensionCount: true },
          }),
          prisma.projectStage.findUniqueOrThrow({
            where: { id: selectedStage.id },
            select: { dueAt: true, extensionCount: true },
          }),
          prisma.projectStage.findUniqueOrThrow({
            where: { id: followingStage.id },
            select: { dueAt: true, extensionCount: true },
          }),
        ]);
      return {
        previousDueAt: updatedPreviousStage.dueAt
          ? formatDateOnly(updatedPreviousStage.dueAt)
          : "",
        selectedDueAt: updatedSelectedStage.dueAt
          ? formatDateOnly(updatedSelectedStage.dueAt)
          : "",
        followingDueAt: updatedFollowingStage.dueAt
          ? formatDateOnly(updatedFollowingStage.dueAt)
          : "",
        previousExtensionCount: updatedPreviousStage.extensionCount,
        selectedExtensionCount: updatedSelectedStage.extensionCount,
        followingExtensionCount: updatedFollowingStage.extensionCount,
      };
    })
    .toEqual({
      previousDueAt: formatDateOnly(previousStage.dueAt),
      selectedDueAt: formatDateOnly(addDays(selectedStage.dueAt, 3)),
      followingDueAt: formatDateOnly(addDays(followingStage.dueAt, 3)),
      previousExtensionCount: previousStage.extensionCount,
      selectedExtensionCount: selectedStage.extensionCount + 1,
      followingExtensionCount: followingStage.extensionCount + 1,
    });
  await expectHealthyPage(page);
});

test("无关用户不能在项目详情申请批量 DDL 调整", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsOtherUser(context, baseURL);
  await page.goto(`/progress/${fixtures.projectId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-逾期项目")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "申请批量延期/提前" }),
  ).toHaveCount(0);
  await expectHealthyPage(page);
});

test("项目单阶段 DDL 修改申请只更新当前阶段", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const [currentStage, nextStage] = await Promise.all([
    prisma.projectStage.findUniqueOrThrow({
      where: { id: fixtures.stageDueChangeCurrentStageId },
      select: { dueAt: true, extensionCount: true },
    }),
    prisma.projectStage.findUniqueOrThrow({
      where: { id: fixtures.stageDueChangeNextStageId },
      select: { dueAt: true, extensionCount: true },
    }),
  ]);
  if (!currentStage.dueAt || !nextStage.dueAt) {
    throw new Error("单阶段 DDL 测试缺少带 DDL 的 fixture 阶段");
  }
  const proposedDueAt = addDays(currentStage.dueAt, 2);
  const proposedDueAtInput = formatDateTimeLocal(proposedDueAt);
  const reason = `PW全功能-单阶段 DDL-${Date.now()}`;

  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto(`/progress/${fixtures.stageDueChangeProjectId}`, {
    waitUntil: "networkidle",
  });
  await page
    .getByText("阶段 1：PW全功能-单阶段当前阶段")
    .locator("xpath=ancestor::*[contains(@class,'rounded')][1]")
    .getByRole("button", { name: "申请修改 DDL" })
    .click();
  const dialog = page.getByRole("dialog", { name: "申请修改阶段 DDL" });
  await expect(dialog).toBeVisible();
  await dialog.locator("#stage-due-change-new").fill(proposedDueAtInput);
  await dialog.locator("#stage-due-change-reason").fill(reason);
  await dialog.getByRole("button", { name: "提交修改申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.projectDdlChangeRequest.findFirst({
        where: {
          projectId: fixtures.stageDueChangeProjectId,
          reason,
          type: "SINGLE_STAGE_ADJUSTMENT",
          status: "PENDING",
        },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.projectDdlChangeRequest.findFirstOrThrow({
    where: { projectId: fixtures.stageDueChangeProjectId, reason },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/${fixtures.stageDueChangeProjectId}`, {
      waitUntil: "networkidle",
    });
    await expect(adminPage.getByText(reason).first()).toBeVisible();
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .fill("PW全功能-同意单阶段 DDL");
    await adminPage
      .getByPlaceholder("审批意见（通过和驳回都必填）")
      .locator("xpath=following::button[normalize-space(.)='通过'][1]")
      .click();
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedCurrentStage, updatedNextStage, updatedRequest, outbox] =
        await Promise.all([
          prisma.projectStage.findUniqueOrThrow({
            where: { id: fixtures.stageDueChangeCurrentStageId },
            select: { dueAt: true, extensionCount: true },
          }),
          prisma.projectStage.findUniqueOrThrow({
            where: { id: fixtures.stageDueChangeNextStageId },
            select: { dueAt: true, extensionCount: true },
          }),
          prisma.projectDdlChangeRequest.findUniqueOrThrow({
            where: { id: request.id },
            select: { status: true, reviewerOpenId: true },
          }),
          prisma.notificationOutbox.findFirst({
            where: {
              eventKey: {
                startsWith: `progress:project_stage_due_change_approved:${request.id}`,
              },
            },
            select: { id: true },
          }),
        ]);
      return {
        status: updatedRequest.status,
        reviewerOpenId: updatedRequest.reviewerOpenId,
        currentDueAt: updatedCurrentStage.dueAt
          ? formatDateTimeLocal(updatedCurrentStage.dueAt)
          : "",
        nextDueAt: updatedNextStage.dueAt
          ? formatDateTimeLocal(updatedNextStage.dueAt)
          : "",
        currentExtensionCount: updatedCurrentStage.extensionCount,
        nextExtensionCount: updatedNextStage.extensionCount,
        hasOutbox: !!outbox,
      };
    })
    .toEqual({
      status: "APPROVED",
      reviewerOpenId: fixtures.adminOpenId,
      currentDueAt: proposedDueAtInput,
      nextDueAt: formatDateTimeLocal(nextStage.dueAt),
      currentExtensionCount: currentStage.extensionCount + 1,
      nextExtensionCount: nextStage.extensionCount,
      hasOutbox: true,
    });
  await expectHealthyPage(page);
});

test("项目参与人可申请新任务并由管理员审批创建", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const title = `PW全功能-申请创建任务-${Date.now()}`;
  await page.goto(`/progress/${fixtures.taskRequestProjectId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-任务申请项目")).toBeVisible();
  await page.getByRole("button", { name: "申请新任务" }).click();
  await fillTaskCreationRequestDialog(page, title);
  await page.getByRole("button", { name: "提交任务申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.taskCreationRequest.findFirst({
        where: { projectId: fixtures.taskRequestProjectId, draftPayload: { contains: title } },
        select: { id: true, status: true },
      });
      return request ?? null;
    })
    .toMatchObject({ status: "PENDING" });
  const request = await prisma.taskCreationRequest.findFirstOrThrow({
    where: { projectId: fixtures.taskRequestProjectId, draftPayload: { contains: title } },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/${fixtures.taskRequestProjectId}`, {
      waitUntil: "networkidle",
    });
    const requestCard = adminPage
      .getByText(title)
      .locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(requestCard).toBeVisible();
    await requestCard
      .getByPlaceholder("审核意见；驳回时必填")
      .fill("PW全功能-同意创建任务");
    await requestCard.getByRole("button", { name: "通过并创建任务" }).click();
    await expect
      .poll(async () => {
        const updatedRequest = await prisma.taskCreationRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true },
        });
        return updatedRequest.status;
      })
      .toBe("APPROVED");
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedRequest, outbox] = await Promise.all([
        prisma.taskCreationRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, createdTaskId: true, reviewerOpenId: true },
        }),
        prisma.notificationOutbox.findFirst({
          where: {
            eventKey: {
              startsWith: `progress:task_creation_approved:${request.id}`,
            },
          },
          select: { id: true },
        }),
      ]);
      const createdTask = updatedRequest.createdTaskId
        ? await prisma.task.findUnique({
            where: { id: updatedRequest.createdTaskId },
            select: { title: true, status: true },
          })
        : null;
      return {
        requestStatus: updatedRequest.status,
        reviewerOpenId: updatedRequest.reviewerOpenId,
        taskTitle: createdTask?.title ?? "",
        taskStatus: createdTask?.status ?? "",
        hasOutbox: !!outbox,
      };
    })
    .toEqual({
      requestStatus: "APPROVED",
      reviewerOpenId: fixtures.adminOpenId,
      taskTitle: title,
      taskStatus: "TODO",
      hasOutbox: true,
    });
  await expectHealthyPage(page);
});

test("项目参与人的新任务申请可由管理员驳回且不创建任务", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const title = `PW全功能-驳回创建任务-${Date.now()}`;
  const comment = `PW全功能-暂不创建-${Date.now()}`;
  await page.goto(`/progress/${fixtures.taskRequestProjectId}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "申请新任务" }).click();
  await fillTaskCreationRequestDialog(page, title);
  await page.getByRole("button", { name: "提交任务申请" }).click();

  await expect
    .poll(async () => {
      const request = await prisma.taskCreationRequest.findFirst({
        where: { projectId: fixtures.taskRequestProjectId, draftPayload: { contains: title } },
        select: { id: true },
      });
      return request?.id ?? "";
    })
    .not.toBe("");
  const request = await prisma.taskCreationRequest.findFirstOrThrow({
    where: { projectId: fixtures.taskRequestProjectId, draftPayload: { contains: title } },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  await loginAsAdminUser(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto(`/progress/${fixtures.taskRequestProjectId}`, {
      waitUntil: "networkidle",
    });
    const requestCard = adminPage
      .getByText(title)
      .locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(requestCard).toBeVisible();
    await requestCard
      .getByPlaceholder("审核意见；驳回时必填")
      .fill(comment);
    await requestCard.getByRole("button", { name: "驳回申请" }).click();
    await expect
      .poll(async () => {
        const updatedRequest = await prisma.taskCreationRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true },
        });
        return updatedRequest.status;
      })
      .toBe("REJECTED");
  } finally {
    await adminContext.close();
  }

  await expect
    .poll(async () => {
      const [updatedRequest, taskCount, outbox] = await Promise.all([
        prisma.taskCreationRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, reviewComment: true, createdTaskId: true },
        }),
        prisma.task.count({
          where: {
            projectId: fixtures.taskRequestProjectId,
            title,
          },
        }),
        prisma.notificationOutbox.findUnique({
          where: { eventKey: `progress:task_creation_rejected:${request.id}` },
          select: { id: true },
        }),
      ]);
      return {
        requestStatus: updatedRequest.status,
        reviewComment: updatedRequest.reviewComment,
        createdTaskId: updatedRequest.createdTaskId,
        taskCount,
        hasOutbox: !!outbox,
      };
    })
    .toEqual({
      requestStatus: "REJECTED",
      reviewComment: comment,
      createdTaskId: null,
      taskCount: 0,
      hasOutbox: true,
    });
  await expectHealthyPage(page);
});

test("项目负责人可从验收标准 CSV 批量导入任务且只发送汇总通知", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const importedTitle = `PW全功能-验收导入任务-${Date.now()}`;
  const editedTitle = `${importedTitle}-已编辑`;
  const secondTitle = `${importedTitle}-多组`;
  const dueDate = formatDateOnly(addDays(new Date(), 5));

  await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "导入任务" }).click();
  const dialog = page.getByRole("dialog", { name: "从验收标准导入任务" });
  await expect(dialog).toBeVisible();

  await page.getByTestId("progress-task-import-file").setInputFiles(
    csvTaskImportUpload([
      "测试/验收内容,负责组别,负责人,参考/要求,是否需要定期周报,测试类型,紧急程度,重要程度,最晚完成时间",
      `${importedTitle},宣运,李棋轩,完成导入验收,否,导入测试,低,高,${dueDate}`,
      `"${secondTitle}","机械, 电控","李棋轩,Playwright 管理员","连续稳定成功",是,压力测试,高,高,${dueDate}`,
    ].join("\n")),
  );
  await expect(
    dialog.getByTestId("progress-task-import-row").filter({ hasText: importedTitle }).first(),
  ).toBeVisible();
  await dialog.getByLabel("批量所属阶段").click();
  await page.getByRole("option", { name: "PW全功能-当前阶段" }).click();

  await dialog.getByTestId("progress-task-import-detail").getByLabel("导入任务目标").fill(editedTitle);
  await dialog.getByTestId("progress-task-import-submit").click();

  const currentStage = await prisma.projectStage.findFirstOrThrow({
    where: { projectId: fixtures.projectId, name: "PW全功能-当前阶段" },
    select: { id: true },
  });
  await expect
    .poll(async () => {
      const tasks = await prisma.task.findMany({
        where: {
          projectId: fixtures.projectId,
          title: { in: [editedTitle, secondTitle] },
        },
        include: {
          assignees: { orderBy: { sortOrder: "asc" } },
          techGroups: { orderBy: { sortOrder: "asc" } },
        },
        orderBy: { title: "asc" },
      });
      const bulkOutboxCount = await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: "progress:task_bulk_imported:" },
          payload: { contains: editedTitle },
        },
      });
      const individualNotificationCount = await prisma.notificationOutbox.count({
        where: {
          eventKey: {
            in: tasks.map((task) => `progress:task_assigned:${task.id}`),
          },
        },
      });
      return {
        taskCount: tasks.length,
        stageIds: tasks.map((task) => task.stageId),
        firstGoal: tasks.find((task) => task.title === editedTitle)?.goal ?? "",
        secondGroups:
          tasks
            .find((task) => task.title === secondTitle)
            ?.techGroups.map((group) => group.techGroup) ?? [],
        secondAssignees:
          tasks
            .find((task) => task.title === secondTitle)
            ?.assignees.map((assignee) => assignee.name) ?? [],
        secondNeedsWeeklyReport:
          tasks.find((task) => task.title === secondTitle)?.needsWeeklyReport ?? false,
        secondUrgency: tasks.find((task) => task.title === secondTitle)?.urgency ?? "",
        bulkOutboxCount,
        individualNotificationCount,
      };
    })
    .toEqual({
      taskCount: 2,
      stageIds: [currentStage.id, currentStage.id],
      firstGoal: "测试类型：导入测试",
      secondGroups: ["机械", "电控"],
      secondAssignees: ["李棋轩", "Playwright 管理员"],
      secondNeedsWeeklyReport: true,
      secondUrgency: "HIGH",
      bulkOutboxCount: 1,
      individualNotificationCount: 0,
    });
  await expectHealthyPage(page);
});

test("项目参与人可从验收标准 CSV 批量提交任务申请", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const title = `PW全功能-验收导入申请-${Date.now()}`;
  const dueDate = formatDateOnly(addDays(new Date(), 6));

  await page.goto(`/progress/${fixtures.taskRequestProjectId}`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "导入任务" }).click();
  const dialog = page.getByRole("dialog", { name: "从验收标准导入任务" });
  await expect(dialog).toBeVisible();

  await page.getByTestId("progress-task-import-file").setInputFiles(
    csvTaskImportUpload([
      "测试/验收内容,负责组别,负责人,参考/要求,是否需要定期周报,备注,紧急程度,重要程度,最晚完成时间",
      `${title},通用,李棋轩,完成申请导入验收,否,申请导入备注,中,高,${dueDate}`,
    ].join("\n")),
  );
  await dialog.getByLabel("批量所属阶段").click();
  await page.getByRole("option", { name: "PW全功能-任务申请阶段" }).click();
  await dialog.getByTestId("progress-task-import-submit").click();

  await expect
    .poll(async () => {
      const [request, task, outbox] = await Promise.all([
        prisma.taskCreationRequest.findFirst({
          where: {
            projectId: fixtures.taskRequestProjectId,
            draftPayload: { contains: title },
          },
          select: { status: true, draftPayload: true },
        }),
        prisma.task.findFirst({
          where: { projectId: fixtures.taskRequestProjectId, title },
          select: { id: true },
        }),
        prisma.notificationOutbox.count({
          where: {
            eventKey: { startsWith: "progress:task_bulk_creation_requested:" },
            payload: { contains: title },
          },
        }),
      ]);
      return {
        requestStatus: request?.status ?? "",
        draftContainsGoal: request?.draftPayload.includes("申请导入备注") ?? false,
        taskCreated: !!task,
        bulkOutboxCount: outbox,
      };
    })
    .toEqual({
      requestStatus: "PENDING",
      draftContainsGoal: true,
      taskCreated: false,
      bulkOutboxCount: 1,
  });
  await expectHealthyPage(page);
});

test("阶段负责人导入任务申请时不能选择无权限阶段", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const ownedStageName = `PW全功能-可申请阶段-${Date.now()}`;
  const blockedStageName = `PW全功能-不可申请阶段-${Date.now()}`;
  const project = await prisma.project.create({
    data: {
      name: `PW全功能-阶段权限导入-${Date.now()}`,
      description: "验证阶段负责人不能跨阶段导入申请",
      team: "英雄",
      techGroup: "电控",
      status: "IN_PROGRESS",
      ownerOpenId: fixtures.adminOpenId,
      ownerName: "Playwright 管理员",
      owners: {
        create: [
          {
            openId: fixtures.adminOpenId,
            name: "Playwright 管理员",
            sortOrder: 0,
          },
        ],
      },
      stages: {
        create: [
          {
            name: ownedStageName,
            goal: "normal user owned stage",
            sortOrder: 0,
            status: "IN_PROGRESS",
            ownerOpenId: normalAuth.openId,
            ownerName: normalAuth.name,
            dueAt: addDays(new Date(), 5),
          },
          {
            name: blockedStageName,
            goal: "admin owned stage",
            sortOrder: 1,
            status: "NOT_STARTED",
            ownerOpenId: fixtures.adminOpenId,
            ownerName: "Playwright 管理员",
            dueAt: addDays(new Date(), 10),
          },
        ],
      },
    },
  });

  await page.goto(`/progress/${project.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "导入任务" }).click();
  const dialog = page.getByRole("dialog", { name: "从验收标准导入任务" });
  await expect(dialog).toBeVisible();
  await page.getByTestId("progress-task-import-file").setInputFiles(
    csvTaskImportUpload([
      "测试/验收内容,负责组别,负责人,参考/要求,是否需要定期周报,紧急程度,重要程度,最晚完成时间",
      `PW全功能-阶段权限任务,通用,李棋轩,验证阶段权限,否,中,高,${formatDateOnly(addDays(new Date(), 5))}`,
    ].join("\n")),
  );
  await dialog.getByLabel("批量所属阶段").click();
  await expect(page.getByRole("option", { name: ownedStageName })).toBeVisible();
  await expect(page.getByRole("option", { name: blockedStageName })).toHaveCount(0);
  await expectHealthyPage(page);
});

test("普通用户提交立项后创建立项中项目且不能直接启动", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const projectName = `PW全功能-普通立项-${Date.now()}`;
  await page.goto("/progress/new", { waitUntil: "networkidle" });
  await page.getByText("项目名称").locator("xpath=following::input[1]").fill(projectName);
  await selectUserFromSearch(page, "搜索项目负责人", "李棋轩");
  await page.getByText("车组").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page.getByText("技术组", { exact: true }).locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "电控" }).click();
  await page.getByRole("button", { name: "提交立项" }).click();
  await expect(page).toHaveURL(/\/progress$/);
  await expect(page.getByText("立项审批")).toBeVisible();
  await expect(page.getByText(projectName)).toBeVisible();

  await expect
    .poll(async () => {
      const project = await prisma.project.findFirst({
        where: { name: projectName },
        select: { id: true, status: true, requesterOpenId: true },
      });
      const outboxCount = project
        ? await prisma.notificationOutbox.count({
            where: {
              eventKey: {
                startsWith: `progress:project_establishment_requested:${project.id}:`,
              },
            },
          })
        : 0;
      return project
        ? {
            status: project.status,
            requesterOpenId: project.requesterOpenId,
            outboxCount,
          }
        : null;
    })
    .toEqual({
      status: "ESTABLISHING",
      requesterOpenId: normalAuth.openId,
      outboxCount: 1,
    });
  const project = await prisma.project.findFirstOrThrow({
    where: { name: projectName },
    select: { id: true },
  });
  await page.goto(`/progress/${project.id}`, { waitUntil: "networkidle" });
  await expect(page.getByText("立项中")).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑项目" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "启动项目" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导入任务" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /新增任务|申请新任务/ })).toHaveCount(0);
  await expectHealthyPage(page);
});

test("立项被驳回后可基于原项目修改并重新提交", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const projectName = `PW全功能-驳回重提立项-${Date.now()}`;
  const resubmittedProjectName = `${projectName}-重提`;
  await page.goto("/progress/new", { waitUntil: "networkidle" });
  await page.getByText("项目名称").locator("xpath=following::input[1]").fill(projectName);
  await selectUserFromSearch(page, "搜索项目负责人", "李棋轩");
  await selectUserFromSearch(page, "搜索参与人员", "Playwright 管理员");
  await page.getByText("车组").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page.getByText("技术组", { exact: true }).locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "电控" }).click();
  await page.getByLabel("阶段 1 耗时").fill("2");
  await page.getByRole("button", { name: "提交立项" }).click();
  await expect(page).toHaveURL(/\/progress$/);

  await expect
    .poll(async () =>
      prisma.project.findFirst({
        where: { name: projectName },
        select: { id: true, status: true },
      }),
    )
    .toMatchObject({ status: "ESTABLISHING" });
  const sourceProject = await prisma.project.findFirstOrThrow({
    where: { name: projectName },
    select: { id: true },
  });
  const sourceProjectId = sourceProject.id;
  await page.goto(`/progress/new?fromProject=${sourceProjectId}`, {
    waitUntil: "networkidle",
  });
  await expect(
    page.getByText(/页面不存在或无权访问|404|This page could not be found|找不到/),
  ).toBeVisible();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  try {
    await loginAsAdminUser(adminContext, baseURL);
    await adminPage.goto("/progress", { waitUntil: "networkidle" });
    const adminRequestCard = adminPage.locator("li").filter({ hasText: projectName });
    await adminRequestCard
      .getByPlaceholder("审核意见；驳回时必填")
      .fill("补充阶段计划后重新提交");
    await adminRequestCard.getByRole("button", { name: "驳回立项" }).click();
    await expect
      .poll(async () => {
        const project = await prisma.project.findUnique({
          where: { id: sourceProjectId },
          select: { status: true, reviewComment: true },
        });
        return project;
      })
      .toEqual({
        status: "ESTABLISHMENT_REJECTED",
        reviewComment: "补充阶段计划后重新提交",
      });
  } finally {
    await adminContext.close();
  }

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  try {
    await loginAsOtherUser(otherContext, baseURL);
    await otherPage.goto(`/progress/new?fromProject=${sourceProjectId}`, {
      waitUntil: "networkidle",
    });
    await expect(
      otherPage.getByText(/页面不存在或无权访问|404|This page could not be found|找不到/),
    ).toBeVisible();
  } finally {
    await otherContext.close();
  }

  await page.goto("/progress", { waitUntil: "networkidle" });
  const rejectedCard = page.locator("li").filter({ hasText: projectName });
  await expect(rejectedCard.getByText("补充阶段计划后重新提交")).toBeVisible();
  await page.goto(`/progress/${sourceProjectId}`, { waitUntil: "networkidle" });
  await expect(page.getByText("驳回了项目立项")).toBeVisible();
  await expect(
    page.getByText("审核意见：补充阶段计划后重新提交"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "删除立项" })).toBeVisible();
  await page.goto("/progress", { waitUntil: "networkidle" });
  await rejectedCard.getByRole("link", { name: "修改后重新提交" }).click();
  await expect(page).toHaveURL(new RegExp(`/progress/new\\?fromProject=${sourceProjectId}`));
  await expect(
    page.getByText("项目名称").locator("xpath=following::input[1]"),
  ).toHaveValue(projectName);
  await expect(page.getByText("Playwright 管理员")).toBeVisible();

  await page
    .getByText("项目名称")
    .locator("xpath=following::input[1]")
    .fill(resubmittedProjectName);
  await page.getByLabel("阶段 1 耗时").fill("3");
  await page.getByRole("button", { name: "重新提交立项" }).click();
  await expect(page).toHaveURL(/\/progress$/);

  await expect
    .poll(async () => {
      const project = await prisma.project.findUnique({
        where: { id: sourceProjectId },
        include: { stages: { orderBy: { sortOrder: "asc" } } },
      });
      const outboxCount = project
        ? await prisma.notificationOutbox.count({
            where: {
              eventKey: {
                startsWith: `progress:project_establishment_requested:${project.id}:`,
              },
            },
          })
        : 0;
      return project
        ? {
            id: project.id,
            status: project.status,
            name: project.name,
            firstStageDurationDays: project.stages[0]?.dueAt
              ? localDayNumber(project.stages[0].dueAt) -
                localDayNumber(project.submittedAt ?? project.createdAt)
              : 0,
            outboxCount,
          }
        : null;
    })
    .toMatchObject({
      id: sourceProjectId,
      status: "ESTABLISHING",
      name: resubmittedProjectName,
      firstStageDurationDays: 3,
      outboxCount: 2,
    });

  const approvalContext = await browser.newContext();
  const approvalPage = await approvalContext.newPage();
  try {
    await loginAsAdminUser(approvalContext, baseURL);
    await approvalPage.goto("/progress", { waitUntil: "networkidle" });
    await approvalPage
      .locator("li")
      .filter({ hasText: resubmittedProjectName })
      .getByRole("button", { name: "通过立项" })
      .click();
  } finally {
    await approvalContext.close();
  }

  await expect
    .poll(async () => {
      const project = await prisma.project.findUnique({
        where: { id: sourceProjectId },
        include: { stages: { orderBy: { sortOrder: "asc" } } },
      });
      return project
        ? {
            status: project.status,
            stageCount: project.stages.length,
            firstStageDueHour: project.stages[0]?.dueAt?.getHours(),
          }
        : null;
    })
    .toMatchObject({
      status: "NOT_STARTED",
      firstStageDueHour: 18,
    });
  await page.goto("/progress", { waitUntil: "networkidle" });
  await expectHealthyPage(page);
});

test("被驳回立项可由申请人在审批面板删除", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const projectName = `PW全功能-删除驳回立项-${Date.now()}`;
  await page.goto("/progress/new", { waitUntil: "networkidle" });
  await page.getByText("项目名称").locator("xpath=following::input[1]").fill(projectName);
  await selectUserFromSearch(page, "搜索项目负责人", "李棋轩");
  await page.getByText("车组").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page.getByText("技术组", { exact: true }).locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "电控" }).click();
  await page.getByRole("button", { name: "提交立项" }).click();
  await expect(page).toHaveURL(/\/progress$/);

  const project = await prisma.project.findFirstOrThrow({
    where: { name: projectName },
    select: { id: true },
  });

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  try {
    await loginAsAdminUser(adminContext, baseURL);
    await adminPage.goto("/progress", { waitUntil: "networkidle" });
    const adminRequestCard = adminPage.locator("li").filter({ hasText: projectName });
    await adminRequestCard
      .getByPlaceholder("审核意见；驳回时必填")
      .fill("不予立项，可删除草案");
    await adminRequestCard.getByRole("button", { name: "驳回立项" }).click();
    await expect
      .poll(async () => {
        const record = await prisma.project.findUnique({
          where: { id: project.id },
          select: { status: true },
        });
        return record?.status ?? null;
      })
      .toBe("ESTABLISHMENT_REJECTED");
  } finally {
    await adminContext.close();
  }

  await page.goto("/progress", { waitUntil: "networkidle" });
  const rejectedCard = page.locator("li").filter({ hasText: projectName });
  await expect(rejectedCard.getByRole("button", { name: "删除立项" })).toBeVisible();
  await rejectedCard.getByRole("button", { name: "删除立项" }).click();
  await expect(page.getByRole("dialog", { name: "删除被驳回立项" })).toBeVisible();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect
    .poll(async () =>
      prisma.project.findUnique({
        where: { id: project.id },
        select: { id: true },
      }),
    )
    .toBeNull();
  await expect(page.getByText(projectName)).toHaveCount(0);
  await expectHealthyPage(page);
});

test("立项通过后按模板耗时生成阶段 DDL 且通知包含参与人", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsAdminUser(context, baseURL);
  const templateName = `PW全功能-耗时模板-${Date.now()}`;
  const projectName = `PW全功能-模板立项-${Date.now()}`;
  await prisma.projectTemplate.deleteMany({ where: { name: templateName } });
  await prisma.projectTemplate.create({
    data: {
      name: templateName,
      description: "PW全功能-耗时模板",
      enabled: true,
      stages: {
        create: [
          { name: "阶段一", goal: "阶段一目标", dueOffsetDays: 2, sortOrder: 0 },
          { name: "阶段二", goal: "阶段二目标", dueOffsetDays: 5, sortOrder: 1 },
          { name: "阶段三", goal: "阶段三目标", dueOffsetDays: 1, sortOrder: 2 },
        ],
      },
    },
  });

  await page.goto("/progress/new", { waitUntil: "networkidle" });
  await page.getByLabel("项目模板").click();
  await page.getByRole("option", { name: templateName }).click();
  await page.getByRole("button", { name: "套用模板" }).click();
  await page.getByText("项目名称").locator("xpath=following::input[1]").fill(projectName);
  await selectUserFromSearch(page, "搜索项目负责人", "李棋轩");
  await selectUserFromSearch(page, "搜索参与人员", "Playwright 管理员");
  await page.getByText("车组").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "工程" }).click();
  await page.getByText("技术组", { exact: true }).locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "宣运" }).click();
  await page.getByRole("button", { name: "提交立项" }).click();
  await expect(page).toHaveURL(/\/progress$/);

  await expect
    .poll(async () =>
      prisma.project.findFirst({
        where: { name: projectName },
        select: { id: true, status: true, requesterName: true },
      }),
    )
    .toMatchObject({ status: "ESTABLISHING", requesterName: "Playwright 管理员" });

  const projectRecord = await prisma.project.findFirstOrThrow({
    where: { name: projectName },
    select: { id: true },
  });
  const requestedOutboxes = await prisma.notificationOutbox.findMany({
    where: {
      eventKey: {
        startsWith: `progress:project_establishment_requested:${projectRecord.id}:`,
      },
    },
    select: { eventKey: true, payload: true },
  });
  expect(requestedOutboxes).toHaveLength(1);
  expect(requestedOutboxes[0]?.payload).toContain("project_establishment_requested");
  expect(requestedOutboxes[0]?.payload).toContain("Playwright 管理员");

  await expect(page.getByText("立项审批")).toBeVisible();
  await expect(page.getByText(projectName)).toBeVisible();
  const approvedAt = new Date();
  const approvalCard = page.locator("li").filter({ hasText: projectName });
  await approvalCard
    .getByPlaceholder("审核意见；驳回时必填")
    .fill("立项材料完整，同意进入未开始");
  await approvalCard.getByRole("button", { name: "通过立项" }).click();

  await expect
    .poll(async () => {
      const project = await prisma.project.findFirst({
        where: { name: projectName },
        include: {
          participants: true,
          stages: { orderBy: { sortOrder: "asc" } },
        },
      });
      if (!project) return null;
      const outbox = await prisma.notificationOutbox.findFirst({
        where: {
          eventKey: {
            startsWith: `progress:project_establishment_approved:${project.id}:`,
          },
        },
        select: { payload: true },
      });
      const firstDueAt = project.stages[0]?.dueAt;
      return {
        projectStatus: project.status,
        stageNames: project.stages.map((stage) => stage.name),
        dayOffsets: project.stages.map((stage) =>
          localDayNumber(stage.dueAt ?? new Date(0)) - localDayNumber(approvedAt),
        ),
        dayDeltas: firstDueAt
          ? project.stages.map((stage) =>
              Math.round(
                ((stage.dueAt?.getTime() ?? firstDueAt.getTime()) -
                  firstDueAt.getTime()) /
                  (24 * 60 * 60 * 1000),
              ),
            )
          : [],
        participantNames: project.participants.map((participant) => participant.name),
        payload: outbox?.payload ?? "",
      };
    })
    .toMatchObject({
      projectStatus: "NOT_STARTED",
      stageNames: ["阶段一", "阶段二", "阶段三"],
      dayOffsets: [2, 7, 8],
      dayDeltas: [0, 5, 6],
      participantNames: ["Playwright 管理员"],
    });

  const parsedPayload = createProjectSchema.parse({
    name: "PW全功能-恶意 DDL 字段校验",
    team: "工程",
    techGroup: "宣运",
    ownerOpenIds: ["fixture-owner"],
    allowOwnerSelfApproval: false,
    stages: [
      {
        name: "恶意阶段",
        goal: "服务端不应读取客户端 dueAt",
        ownerOpenId: "fixture-owner",
        durationDays: 2,
        dueAt: "2000-01-01T00:00",
      },
    ],
  });
  expect("dueAt" in parsedPayload.stages[0]).toBe(false);

  const project = await prisma.project.findFirstOrThrow({
    where: { name: projectName },
    select: { id: true },
  });
  const outbox = await prisma.notificationOutbox.findFirstOrThrow({
    where: {
      eventKey: {
        startsWith: `progress:project_establishment_approved:${project.id}:`,
      },
    },
    select: { payload: true },
  });
  const projectApprovedOutboxes = await prisma.notificationOutbox.findMany({
    where: {
      eventKey: {
        startsWith: `progress:project_establishment_approved:${project.id}:`,
      },
    },
    select: { eventKey: true },
  });
  const legacyProjectCreatedOutboxes = await prisma.notificationOutbox.count({
    where: { eventKey: { startsWith: `progress:project_created:${project.id}` } },
  });
  expect(projectApprovedOutboxes).toHaveLength(1);
  expect(legacyProjectCreatedOutboxes).toBe(0);
  expect(outbox.payload).toContain("participantNames");
  expect(outbox.payload).toContain("Playwright 管理员");
  expect(outbox.payload).toContain("recipientOpenIds");
  await page.goto(`/progress/${project.id}`, { waitUntil: "networkidle" });
  await expect(page.getByText("通过了项目立项")).toBeVisible();
  await expect(
    page.getByText("审核意见：立项材料完整，同意进入未开始"),
  ).toBeVisible();
  await expectHealthyPage(page);
});

test("无关用户看不到立项审批按钮且未立项项目无法推进工作流", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const projectName = `PW全功能-立项权限-${Date.now()}`;
  await page.goto("/progress/new", { waitUntil: "networkidle" });
  await page.getByText("项目名称").locator("xpath=following::input[1]").fill(projectName);
  await selectUserFromSearch(page, "搜索项目负责人", "李棋轩");
  await page.getByText("车组").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page.getByText("技术组", { exact: true }).locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "电控" }).click();
  await page.getByRole("button", { name: "提交立项" }).click();
  await expect(page).toHaveURL(/\/progress$/);

  const project = await prisma.project.findFirstOrThrow({
    where: { name: projectName },
    include: { stages: { orderBy: { sortOrder: "asc" } } },
  });

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  try {
    await loginAsOtherUser(otherContext, baseURL);
    await otherPage.goto(`/progress/${project.id}`, { waitUntil: "networkidle" });
    await expect(otherPage.getByRole("button", { name: "通过立项" })).toHaveCount(0);
    await expect(otherPage.getByRole("button", { name: "驳回立项" })).toHaveCount(0);
  } finally {
    await otherContext.close();
  }

  await expectHealthyPage(page);
});

function formatDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateOnly(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDayNumber(date: Date): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() /
      (24 * 60 * 60 * 1000),
  );
}

function pngUpload(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  };
}

function csvTaskImportUpload(content: string) {
  return {
    name: "progress-task-import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`\uFEFF${content}`, "utf8"),
  };
}

async function fillNewProcurementApplication(
  page: Page,
  itemName: string,
  lineTotal: string,
) {
  await page.getByText("请选择车组").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page.getByText("请选择技术组").click();
  await page.getByRole("option", { name: "电控" }).click();
  await fillProcurementItemFields(page, itemName, lineTotal);
}

async function fillProcurementItemFields(
  page: Page,
  itemName: string,
  lineTotal: string,
) {
  await page
    .getByText("物品名称")
    .first()
    .locator("xpath=following::input[1]")
    .fill(itemName);
  await page
    .getByText("规格")
    .first()
    .locator("xpath=following::input[1]")
    .fill("PW-SPEC");
  await page
    .getByPlaceholder("https://")
    .first()
    .fill("https://example.com/playwright-item");
  await page
    .getByText("行总价")
    .first()
    .locator("xpath=following::input[1]")
    .fill(lineTotal);
}

async function fillTaskCreationRequestDialog(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: "申请新任务" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByText("任务目标")
    .locator("xpath=following::input[1]")
    .fill(title);
  await dialog
    .getByText("详细说明")
    .locator("xpath=following::input[1]")
    .fill("PW全功能-任务创建申请说明");
  await dialog.getByLabel("宣运").check();
  await dialog.getByPlaceholder("搜索负责人姓名").fill("李棋轩");
  await page.getByRole("button", { name: /李棋轩/ }).last().click();
  await dialog
    .getByText("定量/定性指标")
    .locator("xpath=following::input[1]")
    .fill("PW全功能-创建申请指标");
  await dialog
    .locator('input[type="datetime-local"]')
    .fill(formatDateTimeLocal(addDays(new Date(), 5)));
}

async function selectUserFromSearch(
  page: Page,
  placeholder: string,
  name: string,
  index = 0,
) {
  await page.getByPlaceholder(placeholder).nth(index).fill(name);
  await page.getByRole("button", { name: new RegExp(name) }).last().click();
}
