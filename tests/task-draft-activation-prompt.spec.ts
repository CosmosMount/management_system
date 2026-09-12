// @playwright-project ui
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";
import { createAccountPerson, createDraftWorkbenchFixture, grantRole } from "./helpers/project-management-ui-fixtures";

test.beforeAll(async () => {
  const administrator = await createAccountPerson("草稿激活提示回归管理员");
  await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
});

test("有激活权限的用户进入编辑任务不显示离页激活提示", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  await page.getByRole("link", { name: "编辑任务", exact: true }).click();
  await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}/edit`);
  await expect(page.getByRole("dialog", { name: "离开前激活任务？" })).not.toBeVisible();
  await expect(page.getByLabel("Task 名称")).toBeVisible();
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).toMatchObject({ status: "DRAFT", lockVersion: 0 });
  await expectHealthyPage(page);
});

test("草稿详情离开可取消、保持草稿离开或激活后离开", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  const backLink = page.getByRole("link", { name: "← 全部任务", exact: true });
  await backLink.click();
  const prompt = page.getByRole("dialog", { name: "离开前激活任务？" });
  await expect(prompt).toBeVisible();
  await expectHealthyPage(page);
  await prompt.getByRole("button", { name: "留在当前页", exact: true }).click();
  await expect(prompt).not.toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/tasks/${fixture.taskId}`);
  await backLink.click();
  await prompt.getByRole("button", { name: "暂不激活，继续离开", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/progress/tasks");
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).toMatchObject({ status: "DRAFT", lockVersion: 0 });
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  await backLink.click();
  await prompt.getByRole("button", { name: "激活并离开", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/progress/tasks");
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).toMatchObject({ status: "ACTIVE", lockVersion: 1 });
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  await backLink.click();
  await expect(page).toHaveURL((url) => url.pathname === "/progress/tasks");
  await expect(prompt).not.toBeVisible();
});

test("草稿详情浏览器返回提示且取消后仍可正常返回", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto("/progress/tasks");
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.history.state?.taskDraftLeaveGuard)).toBe(fixture.taskId);
  await page.evaluate(() => window.history.back());
  const prompt = page.getByRole("dialog", { name: "离开前激活任务？" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "留在当前页", exact: true }).click();
  await page.evaluate(() => window.history.back());
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "暂不激活，继续离开", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/progress/tasks");
});

test("无激活权限的参与人离开草稿详情不提示", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.reviewer.openId, name: fixture.reviewer.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  await page.getByRole("link", { name: "← 全部任务", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/progress/tasks");
  await expect(page.getByRole("dialog", { name: "离开前激活任务？" })).not.toBeVisible();
});

test("离页激活版本冲突保留详情和草稿", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  await page.getByRole("link", { name: "← 全部任务", exact: true }).click();
  await prisma.task.update({ where: { id: fixture.taskId }, data: { lockVersion: { increment: 1 } } });
  const prompt = page.getByRole("dialog", { name: "离开前激活任务？" });
  await prompt.getByRole("button", { name: "激活并离开", exact: true }).click();
  await expect(prompt.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/tasks/${fixture.taskId}`);
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).toMatchObject({ status: "DRAFT", lockVersion: 1 });
  await expectHealthyPage(page);
});

test("保存草稿后可暂不激活，再次编辑保存后立即激活", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
  await page.getByLabel("Task 名称").fill("保存后选择暂不激活");
  await page.getByRole("button", { name: "保存 Task", exact: true }).first().click();
  const prompt = page.getByRole("dialog", { name: "任务已保存" });
  await expect(prompt).toBeVisible();
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }))
    .toMatchObject({ title: "保存后选择暂不激活", status: "DRAFT", lockVersion: 1 });
  await expectHealthyPage(page);
  await prompt.getByRole("button", { name: "暂不激活", exact: true }).click();
  await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
  await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
  await page.getByLabel("Task 名称").fill("保存后选择立即激活");
  await page.getByRole("button", { name: "保存 Task", exact: true }).first().click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "立即激活", exact: true }).click();
  await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }))
    .toMatchObject({ title: "保存后选择立即激活", status: "ACTIVE", lockVersion: 3 });
  await page.waitForLoadState("domcontentloaded");
  await expectHealthyPage(page);
});

test("保存后的激活版本冲突保留提示且不重复保存", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
  await page.getByLabel("Task 名称").fill("已保存的草稿");
  await page.getByRole("button", { name: "保存 Task", exact: true }).first().click();
  const prompt = page.getByRole("dialog", { name: "任务已保存" });
  await expect(prompt).toBeVisible();
  await prisma.task.update({ where: { id: fixture.taskId }, data: { lockVersion: { increment: 1 } } });
  await prompt.getByRole("button", { name: "立即激活", exact: true }).click();
  await expect(prompt.getByRole("alert")).toBeVisible();
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }))
    .toMatchObject({ title: "已保存的草稿", status: "DRAFT", lockVersion: 2 });
  await prompt.getByRole("button", { name: "暂不激活", exact: true }).click();
  await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
  await page.waitForLoadState("domcontentloaded");
  await expectHealthyPage(page);
});

test("参与人可保存但服务端拒绝激活，已保存内容保留", async ({ page, context, baseURL }) => {
  const fixture = await createDraftWorkbenchFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.reviewer.openId, name: fixture.reviewer.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
  await page.getByLabel("Task 名称").fill("参与人保存的草稿");
  await page.getByRole("button", { name: "保存 Task", exact: true }).first().click();
  const prompt = page.getByRole("dialog", { name: "任务已保存" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "立即激活", exact: true }).click();
  await expect(prompt.getByRole("alert")).toBeVisible();
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }))
    .toMatchObject({ title: "参与人保存的草稿", status: "DRAFT", lockVersion: 1 });
  await prompt.getByRole("button", { name: "暂不激活", exact: true }).click();
  await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
  await page.waitForLoadState("domcontentloaded");
  await expectHealthyPage(page);
});
