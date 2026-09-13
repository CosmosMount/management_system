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
