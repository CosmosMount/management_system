// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";
import {
  createPaginationActor,
  createPaginationProject,
  createPaginationTaskRows,
  grantPaginationAdministrator,
} from "./helpers/project-management-pagination-fixtures";

async function createListFixture() {
  const key = `列表基础${randomUUID()}`;
  const administrator = await createPaginationActor(`负责人${"LongName".repeat(28)}`);
  await grantPaginationAdministrator(administrator.accountId);
  const outsider = await createPaginationActor(`独立成员${randomUUID()}`);
  const name = `${key}${"LongContent".repeat(14)}`;
  const description = "无空格描述".repeat(200);
  const project = await createPaginationProject(administrator, name);
  await prisma.project.update({ where: { id: project.id }, data: { description } });
  const otherProject = await createPaginationProject(outsider, `${key}其他参与人`);
  const completedProject = await createPaginationProject(administrator, `${key}已结束`);
  await prisma.project.update({ where: { id: completedProject.id }, data: { status: "COMPLETED" } });
  const taskId = randomUUID();
  const otherTaskId = randomUUID();
  await createPaginationTaskRows({
    accountId: administrator.accountId,
    personId: administrator.personId,
    rows: [{ id: taskId, status: "ACTIVE", title: name, updatedAt: new Date() }],
  });
  await prisma.task.update({
    where: { id: taskId },
    data: { description, projectId: project.id, priority: "HIGH" },
  });
  await createPaginationTaskRows({
    accountId: outsider.accountId,
    personId: outsider.personId,
    rows: [{ id: otherTaskId, status: "ACTIVE", title: `${key}其他参与人`, updatedAt: new Date() }],
  });
  await prisma.task.update({ where: { id: otherTaskId }, data: { priority: "HIGH" } });
  const terminalTaskIds: string[] = [];
  for (const status of ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED"] as const) {
    const terminalTaskId = randomUUID();
    await createPaginationTaskRows({
      accountId: administrator.accountId,
      personId: administrator.personId,
      rows: [{ id: terminalTaskId, status: "ACTIVE", title: `${key}${status}`, updatedAt: new Date() }],
    });
    await prisma.task.update({ where: { id: terminalTaskId }, data: { status, priority: "HIGH" } });
    terminalTaskIds.push(terminalTaskId);
  }
  return { administrator, key, name, description, project, otherProject, completedProject, taskId, otherTaskId, terminalTaskIds };
}

for (const domain of ["project", "task"] as const) {
  test(`${domain} list keeps query, scope and terminal states across navigation in the shared frontend`, async ({ context, page, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    const fixture = await createListFixture();
    await loginAsTestUser(context, baseURL, { openId: fixture.administrator.openId, name: "列表独立管理员" });
    const isProject = domain === "project";
    const label = isProject ? "项目" : "任务";
    const path = `/progress/${isProject ? "projects" : "tasks"}`;
    const itemId = isProject ? fixture.project.id : fixture.taskId;
    const otherId = isProject ? fixture.otherProject.id : fixture.otherTaskId;
    const row = page.getByTestId(`${domain}-list-item-${itemId}`);
    const form = page.getByRole("form", { name: `${label}筛选` });
    const range = form.getByLabel(`${label}范围`);
    const scope = page.getByTestId(`${domain}-list-scope`);

    await page.goto(path);
    await expect(range).toHaveValue("1");
    await expect(page.getByRole("navigation", { name: `${label}快捷筛选` })).toHaveCount(0);
    await expect(form.getByRole("textbox")).toHaveCount(1);
    await expect(form.getByRole("combobox")).toHaveCount(isProject ? 2 : 3);
    await expect(scope).not.toHaveAttribute("open", "");
    await expect(form.getByLabel(`${label}状态`)).toHaveValue("ACTIVE");
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`${domain}-list-item-${otherId}`)).toHaveCount(0);
    await expectHealthyPage(page);
    await page.screenshot({ path: testInfo.outputPath(`${domain}-list-desktop.png`), animations: "disabled" });
    if (isProject) {
      await row.getByRole("link").filter({ has: page.getByRole("heading", { name: fixture.name, exact: true }) }).focus();
      await expect(page.getByRole("tooltip")).toContainText(fixture.name);
      await expect(page.getByRole("tooltip")).toContainText(fixture.description);
      await page.keyboard.press("Escape");
    } else {
      await row.locator("summary").click();
      await expect(row.locator("details")).toHaveAttribute("open", "");
      await expect(row.getByText(`${label}名称：${fixture.name}`, { exact: true })).toBeVisible();
      await expect(row.getByText(`任务描述：${fixture.description}`, { exact: true })).toBeVisible();
    }
    await expectHealthyPage(page);
    await expect(row).toHaveCSS("grid-template-columns", ((isProject ? /^(?:\S+ ){6}\S+$/ : /^(?:\S+ ){4}\S+$/)));
    if (!isProject) await row.locator("summary").click();

    await form.getByRole("textbox").fill(fixture.key);
    if (!isProject) await form.getByLabel("任务优先级").selectOption("HIGH");
    await form.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("q") === fixture.key);
    await range.selectOption("0");
    await form.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("mine") === "0" && url.searchParams.get("q") === fixture.key);
    await expect(form.getByRole("textbox")).toHaveValue(fixture.key);
    await expect(range).toHaveValue("0");
    await expect(page.getByTestId(`${domain}-list-item-${otherId}`)).toBeVisible();
    await expect(scope).toContainText(`全部可见${label}`);
    if (!isProject) await expect(form.getByLabel("任务优先级")).toHaveValue("HIGH");
    const allVisibleUrl = page.url();

    await form.getByLabel(`${label}状态`).selectOption("");
    await form.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.has("status") && url.searchParams.get("status") === "" && url.searchParams.get("q") === fixture.key);
    await expect(form.getByLabel(`${label}状态`)).toHaveValue("");
    for (const terminalId of isProject ? [fixture.completedProject.id] : fixture.terminalTaskIds) {
      await expect(page.getByTestId(`${domain}-list-item-${terminalId}`)).toBeVisible();
    }
    await expect(scope).toContainText(isProject ? "含草稿与已结束" : "含终态与归档");
    await expect(page.getByRole("link", { name: `下一页${label}` })).toHaveCount(0);
    const allStatusesUrl = page.url();
    await page.reload();
    await expect(form.getByLabel(`${label}状态`)).toHaveValue("");
    await expect(form.getByRole("textbox")).toHaveValue(fixture.key);
    {
      const sidebar = page.getByTestId("project-management-sidebar");
      await sidebar.getByRole("button", { name: "折叠项目管理导航", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(sidebar).toHaveAttribute("data-state", "collapsed");
      await sidebar.getByRole("button", { name: "展开项目管理导航", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(sidebar).toHaveAttribute("data-state", "expanded");
    }
    await expect(page).toHaveURL(allStatusesUrl);
    await form.getByRole("textbox").fill("尚未提交的搜索草稿");
    await page.goBack();
    await expect(page).toHaveURL(allVisibleUrl);
    await expect(form.getByLabel(`${label}状态`)).toHaveValue("ACTIVE");
    await expect(form.getByRole("textbox")).toHaveValue(fixture.key);
    await expect(range).toHaveValue("0");
    if (!isProject) await expect(form.getByLabel("任务优先级")).toHaveValue("HIGH");
    await expect(scope).toContainText("进行中");
    await expect(row).toBeVisible();
    for (const terminalId of isProject ? [fixture.completedProject.id] : fixture.terminalTaskIds) {
      await expect(page.getByTestId(`${domain}-list-item-${terminalId}`)).toHaveCount(0);
    }
    await page.goForward();
    await expect(page).toHaveURL(allStatusesUrl);
    await expect(form.getByLabel(`${label}状态`)).toHaveValue("");
    await expect(form.getByRole("textbox")).toHaveValue(fixture.key);
    await expect(range).toHaveValue("0");
    if (!isProject) await expect(form.getByLabel("任务优先级")).toHaveValue("HIGH");
    await expect(scope).toContainText(isProject ? "含草稿与已结束" : "含终态与归档");
    for (const terminalId of isProject ? [fixture.completedProject.id] : fixture.terminalTaskIds) {
      await expect(page.getByTestId(`${domain}-list-item-${terminalId}`)).toBeVisible();
    }
    await expectHealthyPage(page);

    await page.goto(`${allStatusesUrl}&cursor=ignored-search-cursor`);
    await range.selectOption("1");
    await form.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("cursor") && url.searchParams.get("q") === fixture.key && url.searchParams.get("status") === "" && url.searchParams.get("mine") === "1");
    await expect(range).toHaveValue("1");
    await expect(page.getByTestId(`${domain}-list-item-${otherId}`)).toHaveCount(0);
    await form.getByLabel(`${label}状态`).selectOption("DRAFT");
    await form.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page.getByText(isProject ? "没有符合条件的项目" : "当前没有可见任务。", { exact: true })).toBeVisible();
    await expect(scope).toContainText("显示 0 项");
    await expectHealthyPage(page);
    await page.getByRole("link", { name: "重置为默认筛选" }).click();
    await expect(page).toHaveURL((url) => url.pathname === path && url.search === "");
    await expect(form.getByRole("textbox")).toHaveValue("");
    await expect(form.getByLabel(`${label}状态`)).toHaveValue("ACTIVE");
    await expect(range).toHaveValue("1");
    if (!isProject) await expect(form.getByLabel("任务优先级")).toHaveValue("");
    await expect(row).toBeVisible();
    await form.getByRole("textbox").fill("尚未提交的筛选草稿");
    await range.selectOption("0");
    await form.getByLabel(`${label}状态`).selectOption("");
    await page.getByRole("link", { name: "重置为默认筛选" }).click();
    await expect(page).toHaveURL((url) => url.pathname === path && url.search === "");
    await expect(form.getByRole("textbox")).toHaveValue("");
    await expect(range).toHaveValue("1");
    await expect(form.getByLabel(`${label}状态`)).toHaveValue("ACTIVE");
    await expectHealthyPage(page);
    expect(errors).toEqual([]);
  });
}
