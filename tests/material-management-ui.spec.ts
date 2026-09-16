// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test.describe("material management UI", () => {
  test("paired registration links matching sequence and scans either item as one set", async ({ context, page, baseURL }) => {
    const suffix = randomUUID();
    const openId = `ou_material_pair_${suffix}`;
    const displayName = `配套物资用户 ${suffix.slice(0, 8)}`;
    const identity = await resolveFeishuIdentityForUser({
      openId,
      unionId: null,
      name: displayName,
    });
    await prisma.person.update({
      where: { id: identity.person.id },
      data: { status: "ACTIVE" },
    });
    await loginAsTestUser(context, baseURL, { openId, name: displayName });
    await page.goto("/materials/new");
    await page.getByLabel("物资名称", { exact: true }).fill("采访麦克");
    await page.getByLabel("数量", { exact: true }).fill("2");
    await page.getByLabel("价格（元）", { exact: true }).fill("200");
    await page.getByLabel("所属技术组", { exact: true }).selectOption("硬件");
    await page.getByLabel("登记配套物品", { exact: true }).check();
    await page.getByRole("button", { name: "登记并生成二维码" }).click();
    await expect(page.getByText("请输入配套物品名称", { exact: true })).toBeVisible();
    await expect(page.locator("#material-companion-name")).toBeFocused();
    await page.getByLabel("配套物品名称", { exact: true }).fill("无线接收器");
    await page.getByLabel("配套物品价格（元）", { exact: true }).fill("80");
    await page.getByLabel("配套物品所属技术组", { exact: true }).selectOption("电控");
    await page.getByRole("button", { name: "登记并生成二维码" }).click();
    await expect(page).toHaveURL(/\/materials$/);
    for (const name of ["采访麦克-1", "采访麦克-2", "无线接收器-1", "无线接收器-2"]) {
      await expect(page.getByRole("link", { name, exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText("配套：无线接收器-1", { exact: true })).toBeVisible();
    const microphone = await prisma.material.findFirstOrThrow({ where: { name: "采访麦克-1" } });
    const receiver = await prisma.material.findFirstOrThrow({
      where: { pairKey: microphone.pairKey, id: { not: microphone.id } },
    });
    await page.goto(`/materials/scan/${receiver.qrToken}`);
    await expect(page.getByText("配套物品：采访麦克-1", { exact: true })).toBeVisible();
    await expect(page.getByText(/同时领用当前物资和配套物品/)).toBeVisible();
    await page.getByRole("button", { name: "确认领用" }).click();
    await expect(page.getByRole("heading", { name: "领用成功" })).toBeVisible();
    await expect.poll(() => prisma.materialLoan.count({
      where: { materialId: { in: [microphone.id, receiver.id] }, returnedAt: null },
    })).toBe(2);
    await page.goto(`/materials/scan/${microphone.qrToken}`);
    await expect(page.getByText(/同时归还当前物资和配套物品/)).toBeVisible();
    await page.locator("#material-return-photo").setInputFiles({
      name: "paired-return.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await page.getByRole("button", { name: "确认归还" }).click();
    await expect(page.getByRole("heading", { name: "归还成功" })).toBeVisible();
    await expect.poll(() => prisma.materialLoan.count({
      where: { materialId: { in: [microphone.id, receiver.id] }, returnedAt: null },
    })).toBe(0);
    const returned = await prisma.materialLoan.findMany({
      where: { materialId: { in: [microphone.id, receiver.id] } },
    });
    expect(returned).toHaveLength(2);
    expect(new Set(returned.map((loan) => loan.returnedAt?.toISOString())).size).toBe(1);
    expect(returned.every((loan) => loan.returnPhotoPath)).toBe(true);
    await expectHealthyPage(page);
  });

  test("delete confirmation works at desktop and narrow widths and keeps historical details read-only", async ({ context, page, baseURL }) => {
    const openId = `ou_material_delete_ui_${randomUUID()}`;
    const identity = await resolveFeishuIdentityForUser({ openId, unionId: null, name: "删除物资用户" });
    await prisma.person.update({ where: { id: identity.person.id }, data: { status: "ACTIVE" } });
    await loginAsTestUser(context, baseURL, { openId, name: "删除物资用户" });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const material = await prisma.material.create({ data: {
        name: `${"物资长名称".repeat(25)}-${randomUUID()}`, price: "5", techGroup: "硬件",
        registrationKey: randomUUID(), createdByAccountId: identity.account.id,
      } });
      await page.goto(`/materials/${material.id}`);
      await page.getByRole("button", { name: "删除物资", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "确认删除物资？" });
      await expect(dialog).toBeVisible();
      await expectHealthyPage(page);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toBeHidden();
      expect((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).deletedAt).toBeNull();
      await page.getByRole("button", { name: "删除物资", exact: true }).click();
      await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
      await expect(page).toHaveURL(/\/materials$/);
      expect((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).deletedAt).not.toBeNull();
      await expect(page.getByRole("link", { name: material.name, exact: true })).toHaveCount(0);
      await page.goto(`/materials/${material.id}`);
      await expect(page.getByText(/物资已删除（/)).toBeVisible();
      await expect(page.getByRole("button", { name: "删除物资", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "下载二维码" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "领用历史" })).toBeVisible();
      await expectHealthyPage(page);
      await page.goto(`/materials/scan/${material.qrToken}`);
      await expect(page.getByRole("button", { name: "确认领用", exact: true })).toHaveCount(0);
    }
    expect(browserErrors).toEqual([]);
  });

  test("delete UI denies non-owners and inactive owners, permits super administrators, and handles a stale active loan", async ({ context, page, baseURL }) => {
    const owner = await resolveFeishuIdentityForUser({ openId: `ou_delete_owner_${randomUUID()}`, unionId: null, name: "删除登记人" });
    const otherOpenId = `ou_delete_other_${randomUUID()}`;
    const other = await resolveFeishuIdentityForUser({ openId: otherOpenId, unionId: null, name: "删除其他用户" });
    await prisma.person.updateMany({ where: { id: { in: [owner.person.id, other.person.id] } }, data: { status: "ACTIVE" } });
    const material = await prisma.material.create({ data: {
      name: "删除权限物资", price: "5", techGroup: "硬件", registrationKey: randomUUID(), createdByAccountId: owner.account.id,
    } });
    await loginAsTestUser(context, baseURL, { openId: otherOpenId, name: "删除其他用户" });
    await page.goto(`/materials/${material.id}`);
    await expect(page.getByRole("heading", { name: material.name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "删除物资", exact: true })).toHaveCount(0);
    await prisma.systemRoleAssignment.create({ data: { accountId: other.account.id, role: "SUPER_ADMINISTRATOR" } });
    await page.reload();
    await page.getByRole("button", { name: "删除物资", exact: true }).click();
    await prisma.materialLoan.create({ data: { materialId: material.id, borrowerAccountId: other.account.id, checkoutIdempotencyKey: randomUUID() } });
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("物资正在使用中，请先归还后再删除");
    expect((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).deletedAt).toBeNull();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "删除物资", exact: true })).toBeDisabled();
    await expect(page.getByText("使用中，归还后可删除", { exact: true })).toBeVisible();
    await expectHealthyPage(page);
    await prisma.person.update({ where: { id: other.person.id }, data: { status: "INACTIVE" } });
    await page.reload();
    await expect(page.getByRole("button", { name: "删除物资", exact: true })).toHaveCount(0);
  });

  test("batch form validates quantity and creates numbered materials at desktop and narrow widths", async ({ context, page, baseURL }) => {
    const openId = `ou_material_batch_${randomUUID()}`;
    const identity = await resolveFeishuIdentityForUser({ openId, unionId: null, name: "批量登记用户" });
    await prisma.person.update({ where: { id: identity.person.id }, data: { status: "ACTIVE" } });
    await loginAsTestUser(context, baseURL, { openId, name: "批量登记用户" });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/materials/new");
      const materialName = `批量物资${randomUUID()}`;
      await page.getByLabel("物资名称", { exact: true }).fill(materialName);
      await page.getByLabel("价格（元）", { exact: true }).fill("25.50");
      await page.getByLabel("所属技术组", { exact: true }).selectOption("硬件");
      for (const quantity of ["0", "1.5", "101", ""]) {
        await page.getByLabel("数量", { exact: true }).fill(quantity);
        await page.getByRole("button", { name: "登记并生成二维码" }).click();
        await expect(page.getByText("数量须为 1 至 100 的整数", { exact: true })).toBeVisible();
        await expect(page.getByLabel("数量", { exact: true })).toBeFocused();
      }
      await page.getByLabel("数量", { exact: true }).fill("3");
      await expectHealthyPage(page);
      await page.getByRole("button", { name: "登记并生成二维码" }).click();
      await expect(page).toHaveURL(/\/materials$/);
      for (const index of [1, 2, 3]) {
        await expect(page.getByRole("link", { name: `${materialName}-${index}`, exact: true })).toBeVisible();
      }
      expect(await prisma.material.count({ where: { name: { startsWith: materialName } } })).toBe(3);
      await expectHealthyPage(page);
    }
    expect(browserErrors).toEqual([]);
  });

  test("selects visible materials for batch label printing at desktop and narrow widths", async ({ context, page, baseURL }) => {
    const suffix = randomUUID();
    const openId = `ou_material_batch_print_${suffix}`;
    const displayName = `批量打印用户 ${suffix.slice(0, 8)}`;
    const identity = await resolveFeishuIdentityForUser({
      openId,
      unionId: null,
      name: displayName,
    });
    await prisma.person.update({
      where: { id: identity.person.id },
      data: { status: "ACTIVE" },
    });
    await prisma.material.createMany({
      data: [1, 2, 3].map((index) => ({
        name: `批量打印物资-${suffix}-${index}`,
        price: "25.50",
        techGroup: "硬件",
        registrationKey: randomUUID(),
        createdByAccountId: identity.account.id,
      })),
    });
    await loginAsTestUser(context, baseURL, { openId, name: displayName });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/materials?q=${encodeURIComponent(`批量打印物资-${suffix}`)}`);
      const checkboxes = page.getByRole("checkbox", { name: /选择打印 批量打印物资-/ });
      await expect(checkboxes).toHaveCount(3);
      await expect(page.getByRole("button", { name: "打印所选（0）" })).toBeDisabled();

      await checkboxes.first().check();
      await expect(page.getByRole("button", { name: "打印所选（1）" })).toBeEnabled();
      await page.getByRole("button", { name: "全选当前结果" }).click();
      for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeChecked();
      await expect(page.getByRole("button", { name: "打印所选（3）" })).toBeEnabled();

      await page.getByRole("button", { name: "清空选择" }).click();
      for (const checkbox of await checkboxes.all()) await expect(checkbox).not.toBeChecked();
      await expect(page.getByRole("button", { name: "打印所选（0）" })).toBeDisabled();
      await expectHealthyPage(page);
    }

    expect(browserErrors).toEqual([]);
  });

  test("users register a material and scan its stable QR to check out and return on desktop and mobile", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const suffix = randomUUID();
    const openId = `ou_material_ui_${suffix}`;
    const displayName = `物资测试用户 ${suffix.slice(0, 8)}`;
    const identity = await resolveFeishuIdentityForUser({
      openId,
      unionId: null,
      name: displayName,
    });
    await prisma.person.update({
      where: { id: identity.person.id },
      data: { status: "ACTIVE" },
    });
    await loginAsTestUser(context, baseURL, { openId, name: displayName });

    await page.goto("/");
    await expect(
      page.getByRole("link", {
        name: /物资管理 物资台账、二维码领用归还与在用状态/,
      }),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/materials");
    await expect(
      page.getByRole("heading", { name: "物资台账" }),
    ).toBeVisible();
    if (testInfo.project.name === "desktop") {
      await expect(
        page.getByTestId("material-management-sidebar"),
      ).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "物资管理导航" })
          .getByRole("link", { name: "物资台账" }),
      ).toHaveAttribute("aria-current", "page");
    } else {
      await expect(
        page.getByTestId("material-management-sidebar"),
      ).toBeHidden();
      await page
        .getByRole("button", { name: "打开物资管理导航" })
        .click();
      await expect(
        page
          .getByTestId("material-management-drawer")
          .getByRole("link", { name: "登记物资" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await expectHealthyPage(page);

    await page.getByRole("link", { name: "登记物资" }).first().click();
    await page.getByRole("button", { name: "登记并生成二维码" }).click();
    await expect(page.locator("#material-name")).toBeFocused();
    await expect(page.getByText("请输入物资名称")).toBeVisible();

    const materialName = `高精度示波器 ${"长名称".repeat(20)} ${suffix.slice(0, 8)}`;
    await page.locator("#material-name").fill(materialName);
    await page.locator("#material-price").fill("12888.50");
    await page.locator("#material-tech-group").selectOption("硬件");
    await page.getByRole("button", { name: "登记并生成二维码" }).click();
    await expect(page).toHaveURL(/\/materials\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: materialName }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: `${materialName}的领用归还二维码` }),
    ).toBeVisible();
    const qrDownload = page.getByRole("link", { name: "下载二维码" });
    await expect(qrDownload).toHaveAttribute(
      "download",
      `${materialName}-二维码.png`,
    );
    await expect(qrDownload).toHaveAttribute("href", /^data:image\/png;base64,/);
    await expect(
      page.getByRole("button", { name: "连接 D110 系列并打印" }),
    ).toBeVisible();
    await expect(
      page.getByText("由当前电脑的浏览器通过 Web Serial 直连 D110 或 D110_M，不经过本地打印服务。"),
    ).toBeVisible();
    await expectHealthyPage(page);

    const materialId = new URL(page.url()).pathname.split("/").at(-1);
    if (!materialId) throw new Error("物资详情 URL 缺少 ID");
    const material = await prisma.material.findUniqueOrThrow({
      where: { id: materialId },
      select: { qrToken: true },
    });

    await context.clearCookies();
    await page.goto(`/materials/scan/${material.qrToken}`);
    await expect(page).toHaveURL(
      new RegExp(
        `/login\\?callbackUrl=%2Fmaterials%2Fscan%2F${material.qrToken}`,
      ),
    );
    await loginAsTestUser(context, baseURL, { openId, name: displayName });

    await page.goto(`/materials/scan/${material.qrToken}`);
    await expect(
      page.getByRole("heading", { name: "扫码领用 / 归还" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认领用" }).click();
    await expect(page.getByRole("heading", { name: "领用成功" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/materials?q=${encodeURIComponent(materialName)}`);
    const list = page.getByRole("list", { name: "物资列表" });
    await expect(list.getByText(materialName)).toBeVisible();
    await expect(list.getByText(`当前使用人：${displayName}（我）`)).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/materials/scan/${material.qrToken}`);
    const returnPhotoInput = page.locator("#material-return-photo");
    await expect(returnPhotoInput).toHaveAttribute("capture", "environment");
    await page.getByRole("button", { name: "确认归还" }).click();
    await expect(page.getByText("请先拍摄物资归还照片")).toBeVisible();
    await expect(returnPhotoInput).toBeFocused();
    await returnPhotoInput.setInputFiles({
      name: "return-photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(
      page.getByRole("img", { name: "待提交的物资归还照片" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认归还" }).click();
    await expect(page.getByRole("heading", { name: "归还成功" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/materials/${materialId}`);
    await expect(
      page.getByRole("button", { name: `预览 ${displayName}的物资归还照片` }),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(
      `/materials?q=${encodeURIComponent(materialName)}&status=AVAILABLE`,
    );
    await expect(page.getByText("当前无人使用，可扫描二维码领用")).toBeVisible();
    await expectHealthyPage(page);
  });
});
