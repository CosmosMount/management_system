// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

const longItemName = "手机采购明细：超长名称与规格仍可完整阅读-手机采购明细：超长名称与规格仍可完整阅读-手机采购明细：超长名称与规格仍可完整阅读-手机采购明细：超长名称与规格仍可完整阅读";

async function createFixture(status: "DRAFT" | "PENDING_APPLICANT_DOCS") {
  const suffix = randomUUID();
  const user = { openId: `ou_mobile_purchase_${suffix}`, name: "手机采购验收申请人" };
  const identity = await resolveFeishuIdentityForUser(user);
  const order = await prisma.purchaseOrder.create({
    data: {
      orderNo: `PW-MOBILE-${suffix}`,
      initiatorId: identity.reimbursementUser.id,
      initiatorName: user.name,
      team: "英雄",
      techGroup: "电控",
      status,
      totalPrice: 125,
      items: {
        create: {
          name: longItemName,
          spec: "LongUnbrokenSpecification".repeat(5),
          purchaseLink: "https://example.com/mobile-procurement",
          quantity: 2,
          unitPrice: 62.5,
        },
      },
    },
  });
  return { user, order };
}

async function expectWithinViewport(page: Page, locator: Locator) {
  const width = page.viewportSize()!.width;
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return box !== null && box.x >= 0 && box.x + box.width <= width + 1;
  }, { message: "控件在调整屏宽后应完整位于视口内" }).toBe(true);
}

test("采购订单在桌面和手机保留完整动作，调整屏宽后可保存同一份草稿", async ({ page, context, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { user, order } = await createFixture("DRAFT");
  try {
    await loginAsTestUser(context, baseURL, user);
    for (const width of [1440, 393, 360]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
      await page.goto("/procurement/list");
      const card = page.getByTestId(`procurement-order-${order.id}`);
      await expect(card).toBeVisible();
      await expect(card.getByRole("link", { name: "继续编辑" })).toBeVisible();
      await expect(card.getByRole("button", { name: "提交申请", exact: true })).toBeVisible();
      await expectWithinViewport(page, card.getByRole("button", { name: "提交申请", exact: true }));
      const toggle = card.getByRole("button", { name: `展开 ${order.orderNo} 明细` });
      await toggle.click();
      await expect(card.getByRole("button", { name: `收起 ${order.orderNo} 明细` })).toHaveAttribute("aria-expanded", "true");
      await expectWithinViewport(page, card.getByRole("button", { name: "提交申请", exact: true }));
      const items = page.getByRole("table", { name: `${order.orderNo} 采购明细`, exact: true });
      await expect(items.getByText(longItemName, { exact: true })).toBeVisible();
      if (width < 768) {
        await expectWithinViewport(page, card);
        await expectWithinViewport(page, items);
        await expectWithinViewport(page, items.getByText(longItemName, { exact: true }));
      }
      await expectHealthyPage(page);
      await page.screenshot({ path: testInfo.outputPath(`procurement-list-${width}.png`), animations: "disabled" });
    }

    await page.getByTestId(`procurement-order-${order.id}`).getByRole("link", { name: "继续编辑" }).click();
    const editedName = "手机编辑并保存的采购物品";
    await page.getByLabel("物品名称", { exact: true }).fill(editedName);
    await page.getByLabel("行总价", { exact: true }).fill("260");
    await page.getByRole("button", { name: "从 Excel 导入", exact: true }).click();
    const importDialog = page.getByRole("dialog", { name: "从 Excel 导入采购明细" });
    await importDialog.locator('input[type="file"]').setInputFiles({
      name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("invalid"),
    });
    await expect(importDialog.getByRole("alert")).toContainText("仅支持 .xlsx 或 .xls 文件");
    await expectWithinViewport(page, importDialog);
    await page.screenshot({ path: testInfo.outputPath("procurement-import-error-360.png"), animations: "disabled" });
    await importDialog.getByRole("button", { name: "取消", exact: true }).click();

    for (const width of [1440, 393, 360]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
      await expect(page.getByLabel("物品名称", { exact: true })).toHaveCount(1);
      await expect(page.getByLabel("物品名称", { exact: true })).toHaveValue(editedName);
      await expect(page.getByLabel("行总价", { exact: true })).toHaveValue("260");
      await expectWithinViewport(page, page.getByLabel("物品名称", { exact: true }));
      await expectHealthyPage(page);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("procurement-draft-360.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/procurement/${order.id}$`));
    await expect.poll(async () => {
      const saved = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
      return { status: saved.status, total: saved.totalPrice, name: saved.items[0].name };
    }).toEqual({ status: "DRAFT", total: 260, name: editedName });
    await expect(page.getByRole("table", { name: "采购明细", exact: true }).getByText(editedName)).toBeVisible();
    await expectHealthyPage(page);
    expect(errors).toEqual([]);
  } finally {
    await prisma.purchaseOrder.deleteMany({ where: { id: order.id } });
  }
});

test("手机报销明细可增删和校验，文件与输入随屏宽保留，汇总滚动和导出可达", async ({ page, context, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { user, order } = await createFixture("PENDING_APPLICANT_DOCS");
  try {
    await loginAsTestUser(context, baseURL, user);
    await page.setViewportSize({ width: 393, height: 851 });
    await page.goto(`/procurement/${order.id}`);
    await page.getByRole("button", { name: "上传凭证", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "上传报销凭证", exact: true });
    await dialog.getByLabel("物品名称", { exact: true }).fill("手机报销物品");
    await dialog.getByRole("button", { name: "添加一行", exact: true }).click();
    await expect(dialog.getByLabel("物品名称", { exact: true })).toHaveCount(2);
    await dialog.getByRole("button", { name: "删除「该行」", exact: true }).click();
    await expect(dialog.getByLabel("物品名称", { exact: true })).toHaveCount(1);
    await dialog.getByRole("button", { name: "提交给报销员", exact: true }).click();
    const photo = dialog.getByLabel("上传「手机报销物品」实物照片", { exact: true });
    await expect(photo).toBeFocused();
    await expect(photo).toHaveAttribute("aria-invalid", "true");
    await photo.setInputFiles({ name: "selected-photo.png", mimeType: "image/png", buffer: Buffer.from("not-submitted") });

    for (const width of [393, 1440, 360]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
      await expect(dialog.getByLabel("物品名称", { exact: true })).toHaveValue("手机报销物品");
      await expect.poll(() => photo.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe("selected-photo.png");
      await expectWithinViewport(page, dialog);
      await expectWithinViewport(page, photo);
      await expect.poll(() => photo.evaluate((element) => {
        const parent = element.closest('[role="dialog"]');
        if (!parent) return false;
        // Sample both bounds in one frame while the resized dialog settles.
        const dialogBox = parent.getBoundingClientRect();
        const photoBox = element.getBoundingClientRect();
        return photoBox.left >= dialogBox.left && photoBox.right <= dialogBox.right;
      }), { message: "照片输入应完整位于弹窗的左右边界内" }).toBe(true);
      if (width < 768) {
        await expectWithinViewport(page, dialog.getByLabel("行总价", { exact: true }));
      }
      await expectHealthyPage(page);
      await dialog.evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`procurement-voucher-${width}.png`), animations: "disabled" });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_APPLICANT_DOCS");

    await page.goto("/procurement/summary");
    await page.getByRole("combobox", { name: "按车组筛选" }).click();
    await page.getByRole("option", { name: "英雄", exact: true }).click();
    const region = page.getByRole("region", { name: "采购明细汇总，可横向滚动" });
    await expect(region.getByRole("link", { name: order.orderNo, exact: true })).toBeVisible();
    await expectWithinViewport(page, region);
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await region.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出该车组 BOM", exact: true }).click();
    expect((await downloaded).suggestedFilename()).toMatch(/\.xlsx$/);
    await expectHealthyPage(page);
    await page.screenshot({ path: testInfo.outputPath("procurement-summary-360.png"), animations: "disabled" });
    expect(errors).toEqual([]);
  } finally {
    await prisma.purchaseOrder.deleteMany({ where: { id: order.id } });
  }
});
