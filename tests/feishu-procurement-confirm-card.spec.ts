import { expect, test } from "@playwright/test";
import {
  buildProcurementCardKitCard,
  supportsProcurementCardConfirm,
} from "../lib/feishu-procurement-card";
import { handleFeishuCardAction } from "../lib/feishu-card-action-handler";
import { prisma } from "../lib/prisma";
import {
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

test("待报销截图卡片包含发票与清单区域", () => {
  const card = buildProcurementCardKitCard(
    {
      id: "order-1",
      orderNo: "PO-20260702-0001",
      initiatorName: "张宇山",
      totalPrice: 0,
      status: "PENDING_FINANCE_REVIEW",
      team: "步兵",
      techGroup: "电控",
    },
    {
      applicantAttachments: [
        { label: "发票", imgKey: "img_v3_invoice_key" },
        {
          label: "采购清单",
          viewUrl: "https://example.com/uploads/list.docx",
        },
      ],
    },
  );

  const serialized = JSON.stringify(card);
  expect(serialized).toContain("发票与清单");
  expect(serialized).toContain("img_v3_invoice_key");
  expect(serialized).toContain("点击查看附件");
  expect(serialized).toContain("请核对下方发票与清单");
  expect(serialized).not.toContain("请打开详情页查看发票与清单");
});

test("待确认卡片 PDF 截图在卡片内展示链接", () => {
  const card = buildProcurementCardKitCard(
    {
      id: "order-1",
      orderNo: "PO-001",
      initiatorName: "测试用户",
      totalPrice: 100,
      status: "PENDING_APPLICANT_CONFIRM",
      team: "英雄",
      techGroup: "RM",
      screenshotPath: "/uploads/order-1/screenshot.pdf",
    },
    {
      screenshotIsPdf: true,
      screenshotViewUrl: "https://example.com/uploads/screenshot.pdf",
    },
  );

  const serialized = JSON.stringify(card);
  expect(serialized).toContain("点击查看 PDF");
  expect(serialized).not.toContain("见上方文件消息");
});

test("待确认卡片包含完成报销按钮与报销截图区域", () => {
  const card = buildProcurementCardKitCard(
    {
      id: "order-1",
      orderNo: "PO-001",
      initiatorName: "测试用户",
      totalPrice: 100,
      status: "PENDING_APPLICANT_CONFIRM",
      team: "英雄",
      techGroup: "RM",
      screenshotPath: "/uploads/order-1/screenshot.png",
    },
    {
      screenshotImgKey: "img_v3_test_key",
    },
  );

  const serialized = JSON.stringify(card);
  expect(supportsProcurementCardConfirm("PENDING_APPLICANT_CONFIRM")).toBe(true);
  expect(serialized).toContain("完成报销");
  expect(serialized).toContain("procurement_confirm_reimbursement");
  expect(serialized).toContain("img_v3_test_key");
  expect(serialized).toContain("报销截图");
});

test("飞书完成报销卡片回调可将订单标记为已完成", async () => {
  const normalAuth = await resolveNormalAuthMaterial();
  const fixtures = await prepareFunctionalFixtures(normalAuth);
  const order = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: fixtures.reimbursementOrderId },
    select: {
      id: true,
      status: true,
      initiator: { select: { openId: true } },
    },
  });

  if (order.status !== "PENDING_APPLICANT_CONFIRM") {
    await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        status: "PENDING_APPLICANT_CONFIRM",
        screenshotPath: "/uploads/playwright-screenshot.png",
        invoicePaths: '["/uploads/playwright-invoice.png"]',
        listDocPath: "/uploads/playwright-list.docx",
      },
    });
  }

  const result = await handleFeishuCardAction(
    {
      operator: {
        open_id: order.initiator.openId,
        name: "Playwright 普通用户",
      },
      action: {
        value: {
          action: "procurement_confirm_reimbursement",
          orderId: order.id,
        },
      },
    },
    { botKind: "approval" },
  );

  expect(JSON.stringify(result)).toContain("完成");
  await expect
    .poll(async () => {
      const latest = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      return latest.status;
    })
    .toBe("COMPLETED");
});
