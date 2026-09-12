// @playwright-project ui
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createMeeting } from "../lib/project-management/meetings/service";
import { actor, atHour, createAccountPerson, createSegment, createTask } from "./helpers/project-management-canvas-security-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test("会议时间线项目名称只展示一次并保留独立任务链接", async ({ page, context, baseURL }) => {
  const admin = await createAccountPerson(`会议表头超管 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const project = await prisma.project.create({ data: { name: `会议表头项目 ${randomUUID()}`, description: "", requesterAccountId: admin.account.id } });
  const taskTitle = "会议表头任务";
  const task = await createTask({ ownerAccountId: admin.account.id, title: taskTitle, team: "英雄", techGroup: "电控", members: [{ personId: admin.person.id, role: "OWNER" }] });
  await prisma.task.update({ where: { id: task.taskId }, data: { projectId: project.id } });
  const meeting = await createMeeting(actor(admin), { requestId: randomUUID(), topic: "会议表头回归", personIds: [admin.person.id], rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(), minutes: "", timelineDisplay: { projectIds: [project.id], taskIds: [task.taskId] } });
  await loginAsTestUser(context, baseURL, { openId: admin.openId, name: admin.person.displayName });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/progress/meetings/${meeting.id}`);
  const header = page.getByTestId(`time-canvas-row-header-plan:${task.taskId}`);
  await expect(header.getByRole("link", { name: project.name, exact: true })).toHaveAttribute("href", `/progress/projects/${project.id}`);
  await expect(header.getByRole("link", { name: taskTitle, exact: true })).toHaveAttribute("href", `/progress/tasks/${task.taskId}`);
  expect((await header.innerText()).split(project.name)).toHaveLength(2);
  await expect(header.getByRole("link")).toHaveCount(2);
  await prisma.task.update({ where: { id: task.taskId }, data: { projectId: null } });
  await page.getByRole("button", { name: "刷新时间线", exact: true }).click();
  await expect(header.getByRole("link")).toHaveCount(1);
  await expect(header.getByRole("link", { name: taskTitle, exact: true })).toHaveAttribute("href", `/progress/tasks/${task.taskId}`);
  await expect(header).not.toContainText(project.name);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("完整会议时间范围直接加载，现有滑块可浏览第31天之后的工作", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("会议测试缺少隔离服务地址");
  const admin = await createAccountPerson(`会议全范围超管 ${randomUUID()}`);
  const member = await createAccountPerson(`会议全范围参与人 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const rangeStart = "2026-01-01T00:00:00.000Z";
  const rangeEnd = "2026-04-01T00:00:00.000Z";
  const late = await createSegment({ accountId: member.account.id, personId: member.person.id,
    startAt: new Date("2026-03-30T09:00:00.000Z"), endAt: new Date("2026-03-30T17:00:00.000Z"), content: "第31天之后的会议工作" });
  const meeting = await createMeeting(actor(admin), { requestId: randomUUID(), topic: "完整时间范围会议", personIds: [member.person.id], rangeStart, rangeEnd, minutes: "" });
  await loginAsTestUser(context, baseURL, { openId: member.openId, name: member.person.displayName });
  const requestPromise = page.waitForRequest((request) => request.method() === "POST" && Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes('"kind":"SAVED"')));
  await page.goto(`/progress/meetings/${meeting.id}`);
  const timelineRequest = await requestPromise;
  expect(timelineRequest.postData()).toContain(rangeStart);
  expect(timelineRequest.postData()).toContain(rangeEnd);
  await expect(page.getByTestId("meeting-timeline")).toBeVisible();
  for (const label of ["查看开始时间", "查看结束时间"]) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  for (const name of ["前一区间", "后一区间"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  const slider = page.getByLabel("时间轴横向滚动", { exact: true });
  await expect(slider).toBeVisible();
  const canvas = page.getByTestId("time-canvas-root");
  const startMs = Number(await canvas.getAttribute("data-range-start-ms"));
  const endMs = Number(await canvas.getAttribute("data-range-end-ms"));
  await slider.evaluate((element, fraction) => { element.scrollLeft = element.scrollWidth * fraction - element.clientWidth / 2; element.dispatchEvent(new Event("scroll")); }, (Date.parse("2026-03-30T12:00:00Z") - startMs) / (endMs - startMs));
  await page.getByTestId(`segment-block-${late.id}`).dblclick();
  await expect(page.getByTestId("segment-inspector")).toContainText("第31天之后的会议工作");
  await expectHealthyPage(page);
});

test("超管创建独立会议、预览只读时间线、保存及补充纪要；非参与人可读不可写", async ({ page, context, request, baseURL }) => {
  if (!baseURL) throw new Error("会议测试缺少隔离服务地址");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const anonymous = await request.get(`${baseURL}/progress/meetings`, { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(anonymous.status());
  const admin = await createAccountPerson(`会议 UI 超管 ${randomUUID()}`);
  const member = await createAccountPerson(`会议 UI 参与人 ${randomUUID()}`);
  const viewer = await createAccountPerson(`会议 UI 旁观者 ${randomUUID()}`);
  const project = await prisma.project.create({ data: { name: `会议展示 UI ${randomUUID()}`, description: "会议展示", requesterAccountId: admin.account.id } });
  const task = await createTask({ ownerAccountId: admin.account.id, title: `会议任务 UI ${randomUUID()}`, team: "英雄", techGroup: "电控", members: [{ personId: admin.person.id, role: "OWNER" }] });
  const taskRecord = await prisma.task.update({ where: { id: task.taskId }, data: { projectId: project.id } });
  await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const segment = await createSegment({ accountId: member.account.id, personId: member.person.id, startAt: atHour(9), endAt: atHour(10), content: "会议只读工作" });
  await loginAsTestUser(context, baseURL, { openId: admin.openId, name: admin.person.displayName });
  await page.goto("/progress/meetings");
  await page.getByRole("link", { name: "创建会议", exact: true }).click();
  await expect(page.getByRole("heading", { name: "创建会议", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "创建会议记录", exact: true }).click();
  await expect(page.getByText("请输入会议主题", { exact: true })).toBeVisible();
  await expect(page.getByLabel("会议主题", { exact: true })).toBeFocused();
  const topic = `会议 UI ${randomUUID()}`;
  await page.getByLabel("会议主题", { exact: true }).fill(topic);
  const picker = page.getByRole("combobox", { name: "会议参与人", exact: true });
  await picker.fill(member.person.displayName);
  await page.getByRole("option").filter({ hasText: member.person.displayName }).click();
  await page.getByLabel("工作开始时间（北京时间）", { exact: true }).fill("2026-08-10T08:00");
  await page.getByLabel("工作结束时间（北京时间）", { exact: true }).fill("2026-08-10T18:00");
  await page.getByRole("combobox", { name: "展示项目", exact: true }).fill(project.name);
  await page.getByRole("option").filter({ hasText: project.name }).click();
  await page.getByRole("combobox", { name: "展示任务", exact: true }).fill(taskRecord.title);
  await page.getByRole("option").filter({ hasText: taskRecord.title }).click();
  await page.getByRole("button", { name: "预览工作时间线", exact: true }).click();
  await expect(page.getByTestId("meeting-timeline")).toBeVisible();
  await expect(page.getByTestId(`timeline-row-person:${member.person.id}`)).toBeVisible();
  await expect(page.getByTestId(`timeline-row-plan:${task.taskId}`)).toBeVisible();
  await expect(page.getByTestId("resource-planner-workbench")).toBeVisible();
  await expect(page.getByRole("button", { name: "新增投入", exact: true })).toHaveCount(0);
  await expect.poll(async () => Number(await page.getByTestId("time-canvas-root").getAttribute("data-range-end-ms"))).toBeGreaterThan(atHour(18).getTime());
  const createRequestPromise = page.waitForRequest((outgoing) => outgoing.method() === "POST" && Boolean(outgoing.headers()["next-action"]) && Boolean(outgoing.postData()?.includes(topic)));
  await page.getByRole("button", { name: "创建会议记录", exact: true }).click();
  const createRequest = await createRequestPromise;
  await expect(page).toHaveURL(/\/progress\/meetings\/[a-f0-9-]+\?saved=1$/);
  await expect(page.getByText("暂未填写会议纪要", { exact: true })).toBeVisible();
  const detailUrl = page.url().split("?")[0];
  await page.getByRole("link", { name: "编辑会议", exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(page.getByRole("button", { name: `移除${taskRecord.title}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `移除${taskRecord.title}`, exact: true }).click();
  await page.getByRole("combobox", { name: "展示任务", exact: true }).press("Escape");
  await page.getByRole("textbox", { name: "会议纪要", exact: true }).fill("讨论：公开透明\n结论：后续工作继续跟进");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText("讨论：公开透明", { exact: false })).toBeVisible();
  await expectHealthyPage(page);
  await loginAsTestUser(context, baseURL, { openId: viewer.openId, name: viewer.person.displayName });
  await page.goto(detailUrl);
  await expect(page.getByRole("heading", { name: topic, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "编辑会议", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("meeting-timeline")).toBeVisible();
  await expect(page.getByTestId("meeting-display-summary")).toContainText(project.name);
  await expect(page.getByTestId(`timeline-row-plan:${task.taskId}`)).toBeVisible();
  await expect(page.getByTestId(`segment-block-${segment.id}`)).toBeVisible();
  await page.getByTestId(`segment-block-${segment.id}`).dblclick();
  await expect(page.getByTestId("segment-inspector")).toContainText("会议只读工作");
  await expect(page.getByRole("dialog")).toContainText("当前投入与其他对象均为只读");
  await expect(page.getByRole("form", { name: "编辑投入详情" })).toHaveCount(0);
  await expectHealthyPage(page);
  const forged = await page.request.post(`${baseURL}/progress/meetings/new`, {
    headers: { "next-action": createRequest.headers()["next-action"], "content-type": createRequest.headers()["content-type"], origin: baseURL },
    data: createRequest.postData() ?? "",
  });
  expect(await forged.text()).toContain("FORBIDDEN");
  await page.goto(`${detailUrl}/edit`);
  await expect(page.getByRole("alert").filter({ hasText: "只有全局超级管理员" })).toBeVisible();
  await page.goto("/progress/meetings/new");
  await expect(page.getByRole("alert").filter({ hasText: "只有全局超级管理员" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("会议复用完整时间线，跨年计划本地定位且预览不丢失纪要", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("会议测试缺少隔离服务地址");
  const admin = await createAccountPerson(`会议导航超管 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const task = await createTask({ ownerAccountId: admin.account.id, title: `跨年展示 ${randomUUID()}`, team: "英雄", techGroup: "电控", members: [{ personId: admin.person.id, role: "OWNER" }] });
  await prisma.taskPlanVersion.update({ where: { id: task.planVersionId }, data: { plannedStartAt: new Date("2020-01-01T00:00:00Z") } });
  await prisma.milestoneNode.update({ where: { nodeId: task.milestoneNodeId }, data: { expectedCompletedAt: new Date("2035-06-01T00:00:00Z") } });
  const segment = await createSegment({ accountId: admin.account.id, personId: admin.person.id, taskId: task.taskId, startAt: atHour(9), endAt: atHour(10), content: "超管自身投入也只读" });
  const meeting = await createMeeting(actor(admin), { requestId: randomUUID(), topic: "跨年会议预览", personIds: [admin.person.id], rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(), minutes: "", timelineDisplay: { projectIds: [], taskIds: [task.taskId] } });
  await loginAsTestUser(context, baseURL, { openId: admin.openId, name: admin.person.displayName });
  await page.goto(`/progress/meetings/${meeting.id}/edit`);
  await page.getByLabel("会议纪要", { exact: true }).fill("尚未保存的讨论内容");
  await page.getByRole("button", { name: "预览工作时间线", exact: true }).click();
  const canvas = page.getByTestId("meeting-timeline").getByTestId("time-canvas-root");
  await expect(canvas).toBeVisible();
  await page.getByTestId(`segment-block-${segment.id}`).dblclick();
  await expect(page.getByTestId("segment-inspector")).toContainText("超管自身投入也只读");
  await expect(page.getByRole("form", { name: "编辑投入详情" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const beforeUrl = page.url();
  await page.getByRole("button", { name: "最新内容", exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-viewport-start-ms"))).toBeGreaterThan(Date.parse("2034-01-01T00:00:00Z"));
  await expect(page.locator(`[data-anchor-id="${task.milestoneNodeId}"]`)).toBeVisible();
  await page.locator(`[data-anchor-id="${task.milestoneNodeId}"]`).click();
  await expect(page.getByTestId("time-canvas-inspector")).toContainText("只读详情");
  await page.getByRole("button", { name: "最早内容", exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-viewport-end-ms"))).toBeLessThan(Date.parse("2021-01-01T00:00:00Z"));
  await expect(page.getByLabel("会议纪要", { exact: true })).toHaveValue("尚未保存的讨论内容");
  expect(page.url()).toBe(beforeUrl);
  await expectHealthyPage(page);
});

test("会议时间线加载失败可重试，刷新显示原任务更新且不展示已删除对象", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("会议测试缺少隔离服务地址");
  const admin = await createAccountPerson(`会议刷新超管 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const task = await createTask({ ownerAccountId: admin.account.id, title: `会议刷新任务 ${randomUUID()}`, team: "英雄", techGroup: "电控", members: [{ personId: admin.person.id, role: "OWNER" }] });
  const meeting = await createMeeting(actor(admin), { requestId: randomUUID(), topic: "刷新会议", personIds: [admin.person.id], rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(), minutes: "", timelineDisplay: { projectIds: [], taskIds: [task.taskId] } });
  await loginAsTestUser(context, baseURL, { openId: admin.openId, name: admin.person.displayName });
  let failNext = true;
  await page.route(`**/progress/meetings/${meeting.id}`, async (route) => {
    const request = route.request();
    if (failNext && request.method() === "POST" && request.postData()?.includes('"kind":"SAVED"')) {
      failNext = false;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto(`/progress/meetings/${meeting.id}`);
  await expect(page.getByRole("alert").filter({ hasText: "时间线加载失败" })).toBeVisible();
  await page.getByRole("button", { name: "刷新时间线", exact: true }).click();
  await expect(page.getByTestId("resource-planner-workbench")).toBeVisible();
  await prisma.task.update({ where: { id: task.taskId }, data: { title: "更新后的会议展示任务" } });
  await page.getByRole("button", { name: "刷新时间线", exact: true }).click();
  await expect(page.getByTestId("meeting-display-summary")).toContainText("更新后的会议展示任务");
  await prisma.task.update({ where: { id: task.taskId }, data: { deletedAt: new Date() } });
  await page.getByRole("button", { name: "刷新时间线", exact: true }).click();
  await expect(page.getByTestId("meeting-display-summary")).toContainText("1 个任务已不可用");
  await expect(page.getByTestId(`timeline-row-plan:${task.taskId}`)).toHaveCount(0);
  await expectHealthyPage(page);
});

test("长主题、密集人员及纪要不溢出，空工作行支持刷新", async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("会议测试缺少隔离服务地址");
  const admin = await createAccountPerson(`会议长内容超管 ${randomUUID()}`);
  const member = await createAccountPerson(`人员${"长".repeat(200)}${randomUUID()}`);
  const extraPeople = Array.from({ length: 49 }, (_, index) => ({ id: randomUUID(), displayName: `会议额外参与人 ${index}` }));
  await prisma.person.createMany({ data: extraPeople });
  await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const meeting = await createMeeting(actor(admin), {
    requestId: randomUUID(), topic: "长主题".repeat(60), minutes: "长纪要".repeat(1000),
    personIds: [member.person.id, ...extraPeople.map((person) => person.id)], rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(),
  });
  await loginAsTestUser(context, baseURL, { openId: member.openId, name: member.person.displayName });
  await page.goto(`/progress/meetings/${meeting.id}`);
  await expect(page.getByTestId(`timeline-row-person:${member.person.id}`)).toBeVisible();
  await expectHealthyPage(page);
  await expect(page.getByTestId("time-canvas-root")).toHaveAttribute("data-zoom", "WEEK");
  for (const name of ["周", "月", "季", "年"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const axis = page.getByRole("img", { name: new RegExp(`Asia/Shanghai ${name}级时间轴`) });
    await expect.poll(() => axis.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("span")).some((label) => {
        const rectangle = label.getBoundingClientRect();
        return Boolean(label.textContent?.trim()) && rectangle.right > bounds.left && rectangle.left < Math.min(bounds.right, window.innerWidth);
      });
    })).toBe(true);
  }
  await expect(page.getByLabel("查看结束时间", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "刷新时间线", exact: true }).click();
  await expect(page.getByTestId("meeting-timeline")).toBeVisible();
  await expectHealthyPage(page);
  await page.screenshot({ path: testInfo.outputPath("meeting-detail.png"), fullPage: true });
});

test("参会者可选择未填写人员并发送会议提醒", async ({ page, context, baseURL }) => {
  const admin = await createAccountPerson(`提醒管理员 ${randomUUID()}`);
  const participant = await createAccountPerson(`提醒参会者 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const meeting = await createMeeting(actor(admin), { requestId: randomUUID(), topic: "投入填写提醒测试", personIds: [participant.person.id], rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(), minutes: "" });
  await loginAsTestUser(context, baseURL, { openId: participant.openId, name: participant.person.displayName });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/progress/meetings/${meeting.id}`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole("button", { name: "提醒填写投入", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    await expect(dialog).toContainText(meeting.topic);
    await dialog.getByRole("button", { name: "清空", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "发送提醒", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "选择未填写人员", exact: true }).click();
    await dialog.getByRole("button", { name: "发送提醒", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "已为 1 人创建站内通知" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(await prisma.inAppNotification.count({ where: { entityId: meeting.id } })).toBe(2);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});
