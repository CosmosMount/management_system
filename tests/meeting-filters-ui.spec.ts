// @playwright-project ui
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createAccountPerson, createTask } from "./helpers/project-management-canvas-security-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test("会议筛选提交、分页、刷新、重置与窄窗口使用同一套控件", async ({ page, context, baseURL }) => {
  const owner = await createAccountPerson(`会议筛选用户 ${randomUUID()}`);
  const participant = await createAccountPerson(`历史参会人员 ${randomUUID()}`);
  const prefix = `会议筛选界面 ${randomUUID()}`;
  const records = await Promise.all(Array.from({ length: 26 }, (_, index) => prisma.meetingRecord.create({ data: {
    topic: `${prefix} ${index}`, createdByAccountId: owner.account.id,
    rangeStart: new Date("2026-09-01T00:00:00Z"), rangeEnd: new Date("2026-09-03T00:00:00Z"),
    participants: { create: { personId: participant.person.id } },
  } })));
  await prisma.person.update({ where: { id: participant.person.id }, data: { status: "INACTIVE" } });
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/progress/meetings");
  const form = page.getByRole("form", { name: "会议筛选" });
  await form.getByLabel("搜索会议主题", { exact: true }).fill("尚未提交的条件");
  await form.getByRole("link", { name: "重置", exact: true }).click();
  await expect(form.getByLabel("搜索会议主题", { exact: true })).toHaveValue("");
  await form.getByLabel("搜索会议主题", { exact: true }).fill(prefix);
  await form.getByRole("combobox", { name: "参与人", exact: true }).fill(participant.person.displayName);
  await page.getByRole("option", { name: new RegExp(participant.person.displayName) }).click();
  await form.getByLabel("创建人", { exact: true }).selectOption("1");
  await form.getByLabel("排序", { exact: true }).selectOption("updatedAt");
  await form.getByLabel("工作区间", { exact: true }).selectOption("custom");
  await form.getByLabel("开始日期（北京时间）").fill("2026-09-02");
  await form.getByLabel("结束日期（北京时间）").fill("2026-09-02");
  await form.getByLabel("关联项目", { exact: true }).selectOption("none");
  await form.getByLabel("关联任务", { exact: true }).selectOption("none");
  await form.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(page).toHaveURL(/personId=/);
  await expect(page.getByRole("region", { name: "会议列表", exact: true }).locator("article")).toHaveCount(25);
  const next = page.getByRole("link", { name: "下一页会议" });
  const nextUrl = new URL((await next.getAttribute("href"))!, page.url());
  for (const [key, value] of Object.entries({ q: prefix, personId: participant.person.id, mine: "1", sort: "updatedAt", projectId: "none", taskId: "none", dateFrom: "2026-09-02", dateTo: "2026-09-02" })) expect(nextUrl.searchParams.get(key)).toBe(value);
  await next.click();
  await expect(page.getByRole("region", { name: "会议列表", exact: true }).locator("article")).toHaveCount(1);
  await page.reload();
  await expect(form.getByLabel("搜索会议主题", { exact: true })).toHaveValue(prefix);
  await expect(form.getByLabel("排序", { exact: true })).toHaveValue("updatedAt");
  await expect(form.getByRole("combobox", { name: "参与人", exact: true })).toHaveValue(participant.person.displayName);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectHealthyPage(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await form.getByLabel("搜索会议主题", { exact: true }).fill(`${prefix} 不存在`);
  await form.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(page.getByText("没有符合条件的会议", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
  await form.getByRole("link", { name: "重置", exact: true }).click();
  await expect(page).toHaveURL(/\/progress\/meetings$/);
  await expect(form.getByLabel("搜索会议主题", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("工作区间", { exact: true })).toHaveValue("all");
  await expect(page.getByRole("link", { name: "创建会议", exact: true })).toHaveCount(0);
  expect(await prisma.meetingRecord.count({ where: { id: { in: records.map((entry) => entry.id) } } })).toBe(26);
  expect(errors).toEqual([]);
});

test("会议日期错误聚焦字段，非法URL可重置，筛选等待时禁止重复提交", async ({ page, context, baseURL }) => {
  const owner = await createAccountPerson(`会议筛选校验 ${randomUUID()}`);
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  await page.goto("/progress/meetings");
  const form = page.getByRole("form", { name: "会议筛选" });
  await form.getByLabel("工作区间", { exact: true }).selectOption("custom");
  await form.getByLabel("开始日期（北京时间）").fill("2026-09-03");
  await form.getByLabel("结束日期（北京时间）").fill("2026-09-01");
  await form.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("结束日期不能早于开始日期");
  await expect(form.getByLabel("结束日期（北京时间）")).toBeFocused();
  await page.goto("/progress/meetings?personId=invalid");
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await form.getByRole("link", { name: "重置", exact: true }).click();
  await expect(page).toHaveURL(/\/progress\/meetings$/);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/progress/meetings?**", async (route) => { await gate; await route.continue(); });
  await form.getByLabel("搜索会议主题", { exact: true }).fill("等待回归");
  try {
    await form.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(form.getByRole("button", { name: "筛选中…", exact: true })).toBeDisabled();
    await expect(form).toHaveAttribute("aria-busy", "true");
  } finally {
    release();
  }
  await expect(page).toHaveURL(/q=/);
  await expectHealthyPage(page);
});

test("会议关联项目任务异步搜索、回显及详情导航", async ({ page, context, baseURL }, testInfo) => {
  const owner = await createAccountPerson(`会议关联筛选 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: owner.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const project = await prisma.project.create({ data: { name: `关联筛选项目 ${randomUUID()}`, description: "", requesterAccountId: owner.account.id } });
  const task = await createTask({ ownerAccountId: owner.account.id, title: `关联筛选任务 ${randomUUID()}`, team: "英雄", techGroup: "电控", members: [{ personId: owner.person.id, role: "OWNER" }] });
  const taskTitle = (await prisma.task.findUniqueOrThrow({ where: { id: task.taskId } })).title;
  const topic = `关联筛选会议 ${randomUUID()} ${"长会议名称".repeat(20)}`;
  const meeting = await prisma.meetingRecord.create({ data: { topic, createdByAccountId: owner.account.id, rangeStart: new Date("2026-09-01T00:00:00Z"), rangeEnd: new Date("2026-09-03T00:00:00Z"), participants: { create: { personId: owner.person.id } }, timelineDisplay: { projectIds: [project.id], taskIds: [task.taskId] } } });
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/progress/meetings");
  const form = page.getByRole("form", { name: "会议筛选" });
  await form.getByRole("combobox", { name: "选择关联项目", exact: true }).fill(project.name);
  await page.getByRole("option", { name: project.name, exact: true }).click();
  await form.getByRole("combobox", { name: "选择关联任务", exact: true }).fill(taskTitle);
  await page.getByRole("option", { name: new RegExp(taskTitle) }).click();
  await form.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`projectId=${project.id}`));
  await expect(page.getByRole("region", { name: "会议列表", exact: true }).locator("article")).toHaveCount(1);
  await page.reload();
  await expect(form.getByRole("combobox", { name: "选择关联项目", exact: true })).toHaveValue(project.name);
  await expect(form.getByRole("combobox", { name: "选择关联任务", exact: true })).toHaveValue(taskTitle);
  await expectHealthyPage(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("meeting-filters-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("meeting-filters-narrow.png"), fullPage: true });
  await page.getByRole("link", { name: topic, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/progress/meetings/${meeting.id}$`));
  await expectHealthyPage(page);
});
