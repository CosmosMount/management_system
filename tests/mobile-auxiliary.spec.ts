// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

async function createMobileUser(admin = false) {
  const suffix = randomUUID();
  const user = { openId: `ou_mobile_aux_${suffix}`, name: `手机验收-${suffix.slice(0, 8)}` };
  const identity = await resolveFeishuIdentityForUser({ ...user, unionId: null });
  await prisma.person.update({ where: { id: identity.person.id }, data: { status: "ACTIVE" } });
  if (admin) {
    await prisma.systemRoleAssignment.create({ data: { accountId: identity.account.id, role: "SUPER_ADMINISTRATOR" } });
  }
  return { ...user, identity };
}

function imageFile(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  };
}

async function expectContained(page: Page) {
  await expectHealthyPage(page);
  const main = page.locator("main").first();
  await expect(main).toBeVisible();
  expect(await main.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
}

async function capturePage(page: Page, path: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

test("mobile feedback keeps conversation drafts, images and list position across back, switching and resizing", async ({ context, page, baseURL }, testInfo) => {
  const user = await createMobileUser();
  const feedbacks: { id: string }[] = [];
  for (let index = 0; index < 12; index += 1) {
    feedbacks.push(await prisma.feedback.create({ data: {
      submitterOpenId: user.openId,
      submitterName: user.name,
      lastMessageAt: new Date(Date.now() - index * 1000),
      messages: { create: { authorOpenId: user.openId, authorName: user.name, body: `手机反馈 ${index}：${"长内容用于检查换行".repeat(8)}` } },
    } }));
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAsTestUser(context, baseURL, user);
  await page.setViewportSize({ width: 393, height: 851 });
  await page.goto("/feedback");
  const list = page.getByTestId("feedback-list-panel");
  const conversation = page.getByTestId("feedback-conversation-panel");
  await expect(list).toBeVisible();
  await expect(conversation).toBeHidden();
  await list.getByRole("button", { name: /手机反馈 8：/ }).scrollIntoViewIfNeeded();
  await page.getByTestId("feedback-list-scroll").evaluate((node) => {
    node.addEventListener("pointerdown", () => {
      // Playwright may scroll the target again before delivering the click.
      (node as HTMLElement).dataset.scrollBeforeSelect = String(node.scrollTop);
    }, { once: true });
  });
  await list.getByRole("button", { name: /手机反馈 8：/ }).click();
  const listScroll = await page.getByTestId("feedback-list-scroll").evaluate((node) => Number((node as HTMLElement).dataset.scrollBeforeSelect));
  expect(listScroll).toBeGreaterThan(0);
  await expect(conversation).toBeVisible();
  await expect(list).toBeHidden();
  await conversation.getByLabel("回复内容").fill("保留这份回复草稿");
  await conversation.locator('input[type="file"]').setInputFiles(imageFile("draft-image.png"));
  await expect(conversation.getByRole("button", { name: "移除 draft-image.png" })).toBeVisible();
  await expectContained(page);
  await capturePage(page, testInfo.outputPath("feedback-conversation-393.png"));

  await page.getByRole("button", { name: "返回反馈列表" }).click();
  await expect(list).toBeVisible();
  await expect.poll(() => page.getByTestId("feedback-list-scroll").evaluate((node) => node.scrollTop)).toBe(listScroll);
  await list.getByRole("button", { name: /手机反馈 9：/ }).click();
  await expect(conversation.getByLabel("回复内容")).toHaveValue("");
  await conversation.getByLabel("回复内容").fill("另一条会话的草稿");
  await page.getByRole("button", { name: "返回反馈列表" }).click();
  await list.getByRole("button", { name: /手机反馈 8：/ }).click();
  await expect(conversation.getByLabel("回复内容")).toHaveValue("保留这份回复草稿");
  await expect(conversation.getByRole("button", { name: "移除 draft-image.png" })).toBeVisible();

  for (const width of [1440, 360, 393]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
    await expect(conversation.getByLabel("回复内容")).toHaveValue("保留这份回复草稿");
    await expect(page.locator("#feedback-reply-body")).toHaveCount(1);
    await expectContained(page);
    await capturePage(page, testInfo.outputPath(`feedback-draft-${width}.png`));
  }
  await conversation.getByRole("button", { name: "发送回复" }).click();
  await expect(conversation.getByLabel("回复内容")).toHaveValue("");
  await expect.poll(() => prisma.feedbackMessage.count({ where: { feedbackId: feedbacks[8].id, body: "保留这份回复草稿", attachments: { some: { fileName: "draft-image.png" } } } })).toBe(1);
  await expect(conversation.getByRole("button", { name: "移除 draft-image.png" })).toHaveCount(0);
  await page.getByRole("button", { name: "返回反馈列表" }).click();
  await list.getByRole("button", { name: "新反馈", exact: true }).click();
  const newFeedback = page.getByRole("dialog", { name: "提交反馈" });
  await newFeedback.getByRole("button", { name: "提交反馈", exact: true }).click();
  await expect(newFeedback.getByText("请填写反馈内容", { exact: true })).toBeVisible();
  await newFeedback.getByPlaceholder("请输入反馈内容").fill("手机新建反馈验收");
  await capturePage(page, testInfo.outputPath("feedback-create-dialog-393.png"));
  await newFeedback.getByRole("button", { name: "提交反馈", exact: true }).click();
  await expect(newFeedback).toBeHidden();
  await expect(conversation.getByText("手机新建反馈验收", { exact: true })).toBeVisible();
  await expect.poll(() => prisma.feedback.count({ where: { submitterOpenId: user.openId, messages: { some: { body: "手机新建反馈验收" } } } })).toBe(1);
  expect(errors).toEqual([]);
});

test("delayed feedback replies preserve the other conversation draft on success and failure", async ({ context, page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 393, height: 851 });
  for (const outcome of ["success", "failure"] as const) {
    const user = await createMobileUser();
    const feedbacks: { id: string }[] = [];
    for (const title of ["延迟回复 A", "保留草稿 B"]) {
      feedbacks.push(await prisma.feedback.create({ data: {
        submitterOpenId: user.openId,
        submitterName: user.name,
        messages: { create: { authorOpenId: user.openId, authorName: user.name, body: title } },
      } }));
    }
    await loginAsTestUser(context, baseURL, user);
    await page.goto(`/feedback?selected=${feedbacks[1].id}`);
    const conversation = page.getByTestId("feedback-conversation-panel");
    const list = page.getByTestId("feedback-list-panel");
    await conversation.getByLabel("回复内容").fill("B 的文字不能被 A 的结果清空");
    await conversation.locator('input[type="file"]').setInputFiles(imageFile("reply-b.png"));
    await page.getByRole("button", { name: "返回反馈列表" }).click();
    await list.getByRole("button", { name: /延迟回复 A/ }).click();
    const replyBody = `A 的延迟回复 ${outcome}`;
    await conversation.getByLabel("回复内容").fill(replyBody);
    await conversation.locator('input[type="file"]').setInputFiles(imageFile("reply-a.png"));

    let releaseResponse = () => {};
    let markIntercepted = () => {};
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const intercepted = new Promise<void>((resolve) => { markIntercepted = resolve; });
    await page.route("**/feedback*", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = outcome === "success" ? await route.fetch() : null;
      markIntercepted();
      await responseGate;
      if (response) await route.fulfill({ response });
      else await route.fulfill({ status: 500, contentType: "text/plain", body: "" });
    });
    try {
      await conversation.getByRole("button", { name: "发送回复" }).click();
      await intercepted;
      await page.getByRole("button", { name: "返回反馈列表" }).click();
      await list.getByRole("button", { name: /保留草稿 B/ }).click();
      await expect(conversation.getByLabel("回复内容")).toHaveValue("B 的文字不能被 A 的结果清空");
      await expect(conversation.getByRole("button", { name: "移除 reply-b.png" })).toBeVisible();
      releaseResponse();
      await expect(conversation.getByRole("button", { name: "发送回复" })).toBeEnabled();
      await expect(conversation.getByLabel("回复内容")).toHaveValue("B 的文字不能被 A 的结果清空");
      await expect(conversation.getByRole("button", { name: "移除 reply-b.png" })).toBeVisible();
      await page.getByRole("button", { name: "返回反馈列表" }).click();
      await list.getByRole("button", { name: /延迟回复 A/ }).click();
      await expect(conversation.getByLabel("回复内容")).toHaveValue(outcome === "success" ? "" : replyBody);
      await expect(conversation.getByRole("button", { name: "移除 reply-a.png" })).toHaveCount(outcome === "success" ? 0 : 1);
      await expect.poll(() => prisma.feedbackMessage.count({ where: {
        feedbackId: feedbacks[0].id,
        body: replyBody,
        attachments: { some: { fileName: "reply-a.png" } },
      } })).toBe(outcome === "success" ? 1 : 0);
      await expectContained(page);
    } finally {
      releaseResponse();
      await page.unrouteAll({ behavior: "wait" });
    }
  }
  expect(errors).toEqual([]);
});

test("mobile materials register, download QR, select batches, check out and return with a photo", async ({ context, page, baseURL }, testInfo) => {
  const user = await createMobileUser();
  const materialName = `手机相机-${randomUUID().slice(0, 8)}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(() => { delete (Navigator.prototype as { serial?: unknown }).serial; });
  await loginAsTestUser(context, baseURL, user);
  await page.setViewportSize({ width: 393, height: 851 });
  await page.goto("/materials/new");
  await page.getByRole("button", { name: "登记并生成二维码" }).click();
  await expect(page.getByLabel("物资名称", { exact: true })).toBeFocused();
  await page.getByLabel("物资名称", { exact: true }).fill(materialName);
  await page.getByLabel("价格（元）", { exact: true }).fill("123.45");
  await page.getByLabel("所属技术组", { exact: true }).selectOption("硬件");
  await expectContained(page);
  await capturePage(page, testInfo.outputPath("material-form-393.png"));
  await page.getByRole("button", { name: "登记并生成二维码" }).click();
  await expect(page.getByRole("heading", { name: materialName, exact: true })).toBeVisible();
  const material = await prisma.material.findFirstOrThrow({ where: { name: materialName, createdByAccountId: user.identity.account.id } });
  await expect(page.getByRole("link", { name: "下载二维码" })).toBeVisible();
  await expect(page.getByText(/可先下载上方二维码或复制扫码链接/)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载二维码" }).click();
  expect((await download).suggestedFilename()).toContain(materialName);
  await expectContained(page);
  await capturePage(page, testInfo.outputPath("material-detail-393.png"));

  await page.goto(`/materials?q=${encodeURIComponent(materialName)}`);
  await page.getByLabel(`选择打印 ${materialName}`).check();
  await expect(page.getByRole("button", { name: "打印所选（1）" })).toBeDisabled();
  await expect(page.getByText(/批量直连打印需要支持 Web Serial/)).toBeVisible();
  for (const width of [1440, 360, 393]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
    await expectContained(page);
    await capturePage(page, testInfo.outputPath(`materials-list-${width}.png`));
  }
  await page.goto(`/materials/scan/${material.qrToken}`);
  await page.getByRole("button", { name: "确认领用" }).click();
  await expect(page.getByRole("heading", { name: "领用成功" })).toBeVisible();
  await expect.poll(() => prisma.materialLoan.count({ where: { materialId: material.id, returnedAt: null } })).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "确认归还" }).click();
  await expect(page.getByText("请先拍摄物资归还照片")).toBeVisible();
  await page.locator("#material-return-photo").setInputFiles(imageFile("return-photo.png"));
  await expectContained(page);
  await capturePage(page, testInfo.outputPath("material-return-393.png"));
  await page.getByRole("button", { name: "确认归还" }).click();
  await expect(page.getByRole("heading", { name: "归还成功" })).toBeVisible();
  const loan = await prisma.materialLoan.findFirstOrThrow({ where: { materialId: material.id } });
  expect(loan.returnedAt).not.toBeNull();
  expect(loan.returnPhotoPath).not.toBeNull();
  expect(errors).toEqual([]);
});

test("admin cards retain role controls and history at desktop, mobile and tablet widths", async ({ context, page, baseURL }, testInfo) => {
  const admin = await createMobileUser(true);
  const member = await createMobileUser();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAsTestUser(context, baseURL, admin);
  await page.goto(`/admin/accounts?q=${encodeURIComponent(member.name)}`);
  const accounts = page.getByTestId("accounts-and-roles-card");
  for (const width of [1440, 768, 393, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
    await expect(accounts.getByRole("combobox", { name: "选择要配置角色的用户", exact: true })).toBeVisible();
    await expect(accounts.getByRole("button", { name: "查看记录" })).toBeVisible();
    await expectContained(page);
    await capturePage(page, testInfo.outputPath(`admin-full-page-${width}.png`));
    await accounts.screenshot({ path: testInfo.outputPath(`admin-accounts-${width}.png`), animations: "disabled" });
    await accounts.getByRole("button", { name: "查看记录" }).click();
    const history = page.getByTestId("account-history-dialog");
    await expect(history).toContainText(member.openId);
    await expectContained(page);
    await page.screenshot({ path: testInfo.outputPath(`admin-history-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
  }
  await accounts.getByRole("combobox", { name: "选择要配置角色的用户", exact: true }).fill(member.name);
  await page.getByRole("option", { name: member.name, exact: true }).click();
  await accounts.getByRole("combobox", { name: "选择角色" }).click();
  await page.getByRole("listbox").getByRole("option", { name: "项目管理员", exact: true }).click();
  await accounts.getByRole("button", { name: "添加", exact: true }).click();
  await expect.poll(() => prisma.systemRoleAssignment.count({ where: { accountId: member.identity.account.id, role: "PROJECT_ADMINISTRATOR", revokedAt: null } })).toBe(1);
  await expect(accounts.getByRole("button", { name: `撤销 ${member.name} 的 项目管理员 角色` })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await accounts.getByRole("button", { name: `撤销 ${member.name} 的 项目管理员 角色` }).click();
  await expect.poll(() => prisma.systemRoleAssignment.count({ where: { accountId: member.identity.account.id, role: "PROJECT_ADMINISTRATOR", revokedAt: null } })).toBe(0);
  for (const route of ["/admin", "/admin/system", "/admin/budget-pools", "/admin/time-markers"]) {
    await page.goto(route);
    await expectContained(page);
    await capturePage(page, testInfo.outputPath(`${route.replaceAll("/", "-")}-360.png`));
  }
  await loginAsTestUser(context, baseURL, member);
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/$/);
  expect(errors).toEqual([]);
});

test("profile signature validation and upload work at mobile widths", async ({ context, page, baseURL }, testInfo) => {
  const user = await createMobileUser();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAsTestUser(context, baseURL, user);
  await page.setViewportSize({ width: 393, height: 851 });
  await page.goto("/profile");
  await page.getByRole("button", { name: "保存签名" }).click();
  await expect(page.getByText("请选择签名图片", { exact: true })).toBeVisible();
  await expect(page.locator("#signature")).toBeFocused();
  await page.locator("#signature").setInputFiles(imageFile("mobile-signature.png"));
  await page.getByRole("button", { name: "保存签名" }).click();
  await expect(page.getByText("当前签名", { exact: true })).toBeVisible();
  expect((await prisma.user.findUniqueOrThrow({ where: { openId: user.openId } })).signaturePath).not.toBeNull();
  for (const width of [1440, 393, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
    await expectContained(page);
    await capturePage(page, testInfo.outputPath(`profile-${width}.png`));
  }
  expect(errors).toEqual([]);
});
