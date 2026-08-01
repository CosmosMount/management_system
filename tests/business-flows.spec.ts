import { expect, test, type Page } from "@playwright/test";
import { UserRoleType } from "@prisma/client";
import { handleFeishuCardAction } from "../lib/feishu-card-action-handler";
import { approveProcurementByOpenId } from "../lib/procurement-approve-by-open-id";
import {
  enqueueOrderNotification,
  orderNotificationEventKey,
} from "../lib/notification-outbox";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import {
  expectHealthyPage,
  formatPrismaError,
  loginAsAdminUser,
  loginAsNormalUser,
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
          teamApproverAccountId: true,
          teamApproverOpenId: true,
          techGroupApproverAccountId: true,
          techGroupApproverOpenId: true,
        },
      });
      return order;
    })
    .toMatchObject({
      status: "TEACHER_REVIEW",
      teamApproved: true,
      techGroupApproved: true,
      teamApproverAccountId: expect.any(String),
      teamApproverOpenId: fixtures.adminOpenId,
      techGroupApproverAccountId: expect.any(String),
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

test("采购管理审核部分通过不刷新审批轮次时间", async () => {
  const teamOnlyOpenId = `ou_pw_team_only_${Date.now()}`;
  const identity = await resolveFeishuIdentityForUser({
    openId: teamOnlyOpenId,
    name: "PW车组审批人",
  });
  await prisma.user.upsert({
    where: { openId: teamOnlyOpenId },
    update: {
      accountId: identity.account.id,
      name: "PW车组审批人",
      signaturePath: "/uploads/playwright/signature-admin.png",
    },
    create: {
      accountId: identity.account.id,
      openId: teamOnlyOpenId,
      name: "PW车组审批人",
      signaturePath: "/uploads/playwright/signature-admin.png",
    },
  });
  await prisma.userRole.create({
    data: {
      accountId: identity.account.id,
      openId: teamOnlyOpenId,
      role: UserRoleType.TEAM_ADMIN,
      team: "英雄",
    },
  });

  const order = await createProcurementOrderForNormalUser({
    orderNo: `PW-FULL-MGMT-PARTIAL-${Date.now()}`,
    itemName: `PW全功能-管理审核部分通过-${Date.now()}`,
    totalPrice: 166,
    status: "MANAGEMENT_REVIEW",
  });
  const originalStatusEnteredAt = new Date("2026-06-29T08:00:00.000Z");
  await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: { statusEnteredAt: originalStatusEnteredAt },
  });
  const original = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: order.id },
    include: { items: true },
  });
  const managementReviewKey = orderNotificationEventKey(original);

  await enqueueOrderNotification(managementReviewKey, {
    id: original.id,
    orderNo: original.orderNo,
    initiatorName: original.initiatorName,
    totalPrice: original.totalPrice,
    status: original.status,
    team: original.team,
    techGroup: original.techGroup,
    items: [],
  });

  await approveProcurementByOpenId(teamOnlyOpenId, order.id);

  const partiallyApproved = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: order.id },
    include: { items: true },
  });
  expect(partiallyApproved).toMatchObject({
    status: "MANAGEMENT_REVIEW",
    teamApproved: true,
    techGroupApproved: false,
    teamApproverAccountId: identity.account.id,
    teamApproverOpenId: teamOnlyOpenId,
  });
  expect(partiallyApproved.statusEnteredAt.toISOString()).toBe(
    original.statusEnteredAt.toISOString(),
  );

  await enqueueOrderNotification(orderNotificationEventKey(partiallyApproved), {
    id: partiallyApproved.id,
    orderNo: partiallyApproved.orderNo,
    initiatorName: partiallyApproved.initiatorName,
    totalPrice: partiallyApproved.totalPrice,
    status: partiallyApproved.status,
    team: partiallyApproved.team,
    techGroup: partiallyApproved.techGroup,
    items: [],
  });
  await expect(
    prisma.notificationOutbox.count({ where: { eventKey: managementReviewKey } }),
  ).resolves.toBe(1);

  await approveProcurementByOpenId(fixtures.adminOpenId, order.id);
  const advanced = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: order.id },
  });
  expect(advanced.status).toBe("TEACHER_REVIEW");
  expect(advanced.statusEnteredAt.getTime()).toBeGreaterThan(
    original.statusEnteredAt.getTime(),
  );
  const teacherReviewKey = orderNotificationEventKey(advanced);
  await expect(
    prisma.notificationOutbox.count({ where: { eventKey: teacherReviewKey } }),
  ).resolves.toBe(1);
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

test("采购人可在管理审核阶段修改清单并重新提交", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  const editedItemName = `PW全功能-审核中改单物料-${Date.now()}`;
  const order = await createProcurementOrderForNormalUser({
    orderNo: `PW-FULL-WITHDRAW-${Date.now()}`,
    itemName: `PW全功能-待撤回修改物料-${Date.now()}`,
    totalPrice: 256,
    status: "MANAGEMENT_REVIEW",
  });

  await page.goto(`/procurement/${order.id}/edit?withdraw=1`, {
    waitUntil: "networkidle",
  });
  await expect(page).toHaveURL(new RegExp(`/procurement/${order.id}$`));
  await expect
    .poll(async () => {
      const latest = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      return latest.status;
    })
    .toBe("MANAGEMENT_REVIEW");

  await page.goto(`/procurement/${order.id}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("button", { name: "修改清单" })).toBeVisible();
  await page.getByRole("button", { name: "修改清单" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/procurement/${order.id}/edit$`),
  );

  await expect
    .poll(async () => {
      const latest = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      return latest.status;
    })
    .toBe("DRAFT");

  await fillProcurementItemFields(page, editedItemName, "320");
  await page.getByRole("button", { name: "提交申请" }).click();

  await expect
    .poll(async () => {
      const latest = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: { select: { name: true } } },
      });
      return {
        status: latest.status,
        totalPrice: latest.totalPrice,
        itemName: latest.items[0]?.name ?? "",
      };
    })
    .toEqual({
      status: "MANAGEMENT_REVIEW",
      totalPrice: 320,
      itemName: editedItemName,
    });
  await expectHealthyPage(page);
});

test("飞书采购卡片回调区分退回修改和终止采购", async () => {
  const returnReason = `PW全功能-飞书退回修改-${Date.now()}`;
  const terminateReason = `PW全功能-飞书终止采购-${Date.now()}`;
  const returnOrder = await createProcurementOrderForNormalUser({
    orderNo: `PW-FULL-CARD-RETURN-${Date.now()}`,
    itemName: `PW全功能-飞书退回物料-${Date.now()}`,
    totalPrice: 188,
    status: "MANAGEMENT_REVIEW",
  });
  const terminateOrder = await createProcurementOrderForNormalUser({
    orderNo: `PW-FULL-CARD-TERMINATE-${Date.now()}`,
    itemName: `PW全功能-飞书终止物料-${Date.now()}`,
    totalPrice: 199,
    status: "MANAGEMENT_REVIEW",
  });

  await handleFeishuCardAction({
    operator: { open_id: fixtures.adminOpenId, name: "Playwright 管理员" },
    action: {
      value: {
        action: "procurement_reject_resubmit",
        orderId: returnOrder.id,
      },
      form_value: {
        Input_procurement_reject_reason: returnReason,
      },
    },
  });
  await handleFeishuCardAction({
    operator: { open_id: fixtures.adminOpenId, name: "Playwright 管理员" },
    action: {
      value: {
        action: "procurement_reject_terminate",
        orderId: terminateOrder.id,
      },
      form_value: {
        Input_procurement_reject_reason: terminateReason,
      },
    },
  });

  await expect
    .poll(async () => {
      const [returned, terminated, returnOutbox, terminateOutbox] =
        await Promise.all([
          prisma.purchaseOrder.findUniqueOrThrow({
            where: { id: returnOrder.id },
            select: { status: true, rejectionReason: true },
          }),
          prisma.purchaseOrder.findUniqueOrThrow({
            where: { id: terminateOrder.id },
            select: { status: true, rejectionReason: true },
          }),
          prisma.notificationOutbox.findFirst({
            where: {
              channel: "procurement",
              type: "procurement_return_draft",
              payload: { contains: returnOrder.id },
            },
            select: { id: true },
          }),
          prisma.notificationOutbox.findFirst({
            where: {
              channel: "procurement",
              type: "procurement_rejected",
              payload: { contains: terminateOrder.id },
            },
            select: { id: true },
          }),
        ]);
      return {
        returned,
        terminated,
        hasReturnOutbox: Boolean(returnOutbox),
        hasTerminateOutbox: Boolean(terminateOutbox),
      };
    })
    .toEqual({
      returned: {
        status: "DRAFT",
        rejectionReason: returnReason,
      },
      terminated: {
        status: "REJECTED",
        rejectionReason: terminateReason,
      },
      hasReturnOutbox: true,
      hasTerminateOutbox: true,
    });
});

test("飞书过期管理审核卡片不能推进老师审核", async () => {
  const order = await createProcurementOrderForNormalUser({
    orderNo: `PW-FULL-CARD-STALE-${Date.now()}`,
    itemName: `PW全功能-飞书过期卡片物料-${Date.now()}`,
    totalPrice: 211,
    status: "MANAGEMENT_REVIEW",
  });
  const payload = {
    operator: { open_id: fixtures.adminOpenId, name: "Playwright 管理员" },
    action: {
      value: {
        action: "procurement_approve_management",
        orderId: order.id,
      },
    },
  };

  await handleFeishuCardAction(payload);
  await expect
    .poll(async () => {
      const latest = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      return latest.status;
    })
    .toBe("TEACHER_REVIEW");

  const staleResult = await handleFeishuCardAction(payload);

  await expect
    .poll(async () => {
      const latest = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      return latest.status;
    })
    .toBe("TEACHER_REVIEW");
  expect(JSON.stringify(staleResult)).toContain("已失效");
});

test("独立审批机器人卡片回调用 union_id 映射系统审批人", async () => {
  const order = await createProcurementOrderForNormalUser({
    orderNo: `PW-FULL-CARD-UNION-${Date.now()}`,
    itemName: `PW全功能-审批机器人映射物料-${Date.now()}`,
    totalPrice: 233,
    status: "MANAGEMENT_REVIEW",
  });
  const unionId = `on_pw_admin_${Date.now()}`;
  await prisma.user.update({
    where: { openId: fixtures.adminOpenId },
    data: { unionId },
  });

  const result = await handleFeishuCardAction(
    {
      operator: {
        open_id: `ou_approval_scoped_${Date.now()}`,
        union_id: unionId,
        name: "Playwright 管理员",
      },
      action: {
        value: {
          action: "procurement_approve_management",
          orderId: order.id,
        },
      },
    },
    { botKind: "approval" },
  );

  expect(JSON.stringify(result)).toContain("已");
  await expect
    .poll(async () => {
      const latest = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, teamApproverOpenId: true },
      });
      return latest;
    })
    .toEqual({
      status: "TEACHER_REVIEW",
      teamApproverOpenId: fixtures.adminOpenId,
    });
});

test("采购管理审核可终止驳回", async ({ page, context, baseURL }) => {
  await loginAsAdminUser(context, baseURL);
  const reason = `PW全功能-管理审核终止驳回-${Date.now()}`;
  await page.goto(`/procurement/${fixtures.managementRejectOrderId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("PW全功能-管理驳回物料")).toBeVisible();
  await page.getByRole("button", { name: "驳回", exact: true }).click();
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
  await page.getByRole("button", { name: "驳回", exact: true }).click();
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
    .setInputFiles([pdfUpload("invoice.pdf")]);
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
  const adminSessionResponse = await context.request.get("/api/auth/session");
  expect(adminSessionResponse.ok()).toBe(true);
  await expect(adminSessionResponse.json()).resolves.toMatchObject({
    user: {
      openId: fixtures.adminOpenId,
      name: "Playwright 管理员",
    },
  });
  await page.goto(`/feedback?selected=${feedbackId}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("反馈清单")).toBeVisible();
  await expect(page.getByRole("link", { name: "管理员面板" })).toBeVisible();
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

function pdfUpload(name: string) {
  return {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(
      "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n",
      "utf8",
    ),
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

async function createProcurementOrderForNormalUser({
  orderNo,
  itemName,
  totalPrice,
  status,
}: {
  orderNo: string;
  itemName: string;
  totalPrice: number;
  status: "MANAGEMENT_REVIEW" | "TEACHER_REVIEW";
}) {
  const initiator = await prisma.user.findUniqueOrThrow({
    where: { openId: normalAuth.openId },
    select: { id: true },
  });
  return prisma.purchaseOrder.create({
    data: {
      orderNo,
      initiatorId: initiator.id,
      initiatorName: normalAuth.name,
      team: "英雄",
      techGroup: "电控",
      totalPrice,
      status,
      teamApproved: status === "TEACHER_REVIEW",
      techGroupApproved: status === "TEACHER_REVIEW",
      items: {
        create: [
          {
            name: itemName,
            spec: "PW-SPEC",
            purchaseLink: "https://example.com/playwright-card-item",
            quantity: 1,
            unitPrice: totalPrice,
          },
        ],
      },
    },
  });
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
