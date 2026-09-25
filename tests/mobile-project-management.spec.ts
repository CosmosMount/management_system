// @playwright-project ui
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createMeeting } from "../lib/project-management/meetings/service";
import { createTaskDraft } from "../lib/project-management/application/lifecycle-service";
import { createWorkSegment } from "../lib/project-management/application/segment-service";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";
import { actor, atHour, createAccountPerson, createUiFixture, milestoneInput, terminationInput } from "./helpers/project-management-ui-fixtures";

test("项目域手机卡片、详情和已有工作流保持可达并生成视觉证据", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await createUiFixture();
  const project = await prisma.project.create({ data: {
    name: `手机项目 ${"长名称".repeat(18)}`,
    description: "项目简介和完整任务能力保持可达。".repeat(8),
    status: "ACTIVE", requesterAccountId: fixture.member.account.id,
    members: { create: { personId: fixture.member.person.id, role: "OWNER", createdByAccountId: fixture.member.account.id } },
  } });
  const taskTitle = `手机任务 ${"长名称".repeat(20)}`;
  await prisma.task.update({ where: { id: fixture.taskId }, data: { projectId: project.id, title: taskTitle } });
  await prisma.systemRoleAssignment.create({ data: { accountId: fixture.admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const meeting = await createMeeting(actor(fixture.admin), {
    requestId: randomUUID(), topic: `手机会议 ${"会议主题".repeat(12)}`,
    personIds: [fixture.member.person.id], rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(),
    minutes: "会议纪要长内容与参与人投入检查。".repeat(30),
    timelineDisplay: { projectIds: [project.id], taskIds: [fixture.taskId] },
  });
  await loginAsTestUser(context, baseURL, { openId: fixture.member.openId, name: fixture.member.person.displayName });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const routes = [
    { name: "projects", url: `/progress/projects?q=${encodeURIComponent(project.name)}`, ready: `[data-testid="project-list-item-${project.id}"]` },
    { name: "tasks", url: `/progress/tasks?q=${encodeURIComponent(taskTitle)}`, ready: `[data-testid="task-list-item-${fixture.taskId}"]` },
    { name: "project-detail", url: `/progress/projects/${project.id}`, ready: '[data-testid="project-task-workspace"]' },
    { name: "task-detail", url: `/progress/tasks/${fixture.taskId}`, ready: '[data-testid="task-execution-view"]' },
    { name: "approvals", url: "/progress/approvals", ready: '[data-testid="action-inbox"]' },
    { name: "notifications", url: "/progress/notifications", ready: 'h2:has-text("P6 UI 通知")' },
    { name: "meetings", url: `/progress/meetings?q=${encodeURIComponent(meeting.topic)}`, ready: '[aria-label="会议列表"]' },
    { name: "meeting-detail", url: `/progress/meetings/${meeting.id}`, ready: '[data-testid="meeting-timeline"]' },
  ];
  for (const width of [1440, 393, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
    for (const route of routes) {
      if (width === 360 && !["projects", "tasks", "task-detail"].includes(route.name)) continue;
      await page.goto(route.url);
      const ready = route.name === "meetings"
        ? page.getByRole("region", { name: "会议列表" })
        : page.locator(route.ready);
      await expect(ready).toBeVisible();
      await expectHealthyPage(page);
      if (width < 1024 && ["projects", "tasks"].includes(route.name)) {
        const card = ready;
        const box = await card.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeLessThanOrEqual(width);
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.getByRole("button", { name: "收起筛选条件", exact: true }).click();
        await expect(page.getByRole("form", { name: /筛选/ })).toBeHidden();
        await page.getByRole("button", { name: "展开筛选条件", exact: true }).click();
        await expect(page.getByRole("form", { name: /筛选/ })).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath(`${route.name}-${width}.png`), fullPage: true, animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 393, height: 851 });
  await page.goto(`/progress/meetings/${meeting.id}`);
  await expect(page.getByRole("link", { name: "编辑", exact: true })).toHaveCount(0);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await page.getByRole("button", { name: "导出会议纪要", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "复制会议纪要" })).toBeVisible();
  await expect(page.getByLabel("会议纪要文本", { exact: true })).toHaveValue(/手机会议/);
  await expectHealthyPage(page);
  await page.screenshot({ path: testInfo.outputPath("meeting-export-393.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("触摸 Composer 勾选整体移动、边界拒绝、撤销和旋转保留同一草稿", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const owner = await createAccountPerson(`手机计划负责人 ${randomUUID()}`);
  const draft = await createTaskDraft(actor(owner), {
    title: `手机计划 ${randomUUID()}`, description: "手机计划操作回归", team: "英雄", techGroup: "电控", priority: "MEDIUM",
    members: [{ personId: owner.person.id, role: "OWNER" }],
    plannedStartAt: "2026-07-31T10:00:00.000Z",
    milestones: [milestoneInput("手机第一阶段", "第一阶段完成", 1), milestoneInput("手机第二阶段", "第二阶段完成", 2)],
    termination: terminationInput(5), idempotencyKey: randomUUID(),
  });
  const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });
  try {
    await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/progress/tasks/${draft.taskId}/edit`);
    const selection = page.getByTestId("task-composer-touch-selection");
    await selection.locator("summary").tap();
    for (const checkbox of await selection.getByRole("checkbox").all()) {
      if (await checkbox.isChecked()) await checkbox.uncheck();
    }
    await selection.getByRole("checkbox", { name: "选择节点 Terminal", exact: true }).check();
    await selection.getByLabel("移动天数", { exact: true }).fill("100000000");
    await selection.getByRole("button", { name: "推迟所选节点", exact: true }).tap();
    await expect(selection.getByRole("status")).toContainText("移动天数超出支持的日期范围，计划未发生任何变化");
    await expect(page.getByLabel("计划结束时间")).toHaveValue("2026-08-05T18:00");
    await selection.getByRole("checkbox", { name: "选择节点 Terminal", exact: true }).uncheck();
    await selection.getByRole("checkbox", { name: "选择节点 Start", exact: true }).check();
    await selection.getByRole("button", { name: "提前所选节点", exact: true }).tap();
    await expect(selection.getByRole("status")).toContainText("移动天数超出支持的日期范围，计划未发生任何变化");
    await expect(page.getByLabel("计划开始时间")).toHaveValue("2026-07-31T18:00");
    await selection.getByLabel("移动天数", { exact: true }).fill("2000000");
    await selection.getByRole("button", { name: "提前所选节点", exact: true }).tap();
    await expect(selection.getByRole("status")).toContainText("移动天数超出支持的日期范围，计划未发生任何变化");
    await expect(page.getByLabel("计划开始时间")).toHaveValue("2026-07-31T18:00");
    await selection.getByRole("checkbox", { name: "选择节点 Start", exact: true }).uncheck();
    await selection.getByLabel("移动天数", { exact: true }).fill("1");
    await selection.getByRole("checkbox", { name: "选择节点 手机第一阶段", exact: true }).check();
    await selection.getByRole("checkbox", { name: "选择节点 手机第二阶段", exact: true }).check();
    await expect(page.getByTestId("task-composer-anchor-multi-selection")).toContainText("已选 2 个可编辑节点");
    await expect(page.getByLabel("预期完成时间")).toHaveValue("2026-08-02T18:00");
    await selection.getByRole("button", { name: "推迟所选节点", exact: true }).tap();
    await expect(page.getByLabel("预期完成时间")).toHaveValue("2026-08-03T18:00");
    await selection.getByLabel("移动天数", { exact: true }).fill("4");
    await selection.getByRole("button", { name: "推迟所选节点", exact: true }).tap();
    await expect(selection.getByRole("status")).toContainText("所有节点均已保留在原处");
    await expect(page.getByLabel("预期完成时间")).toHaveValue("2026-08-03T18:00");
    await page.getByRole("button", { name: "撤销", exact: true }).tap();
    await expect(page.getByLabel("预期完成时间")).toHaveValue("2026-08-02T18:00");
    await page.getByLabel("Task 名称").fill("手机旋转后保留的计划名称");
    await page.setViewportSize({ width: 851, height: 393 });
    await expect(page.getByLabel("Task 名称")).toHaveValue("手机旋转后保留的计划名称");
    await expect(page.getByTestId("task-composer")).toHaveCount(1);
    await page.setViewportSize({ width: 393, height: 851 });
    const marker = page.getByTestId("time-canvas-root").getByRole("button", { name: /^计划节点 手机第二阶段/ });
    await swipeOnCanvasObject(page, marker);
    await expect(page.getByLabel("预期完成时间")).toHaveValue("2026-08-02T18:00");
    await expect(page.getByTestId("time-canvas-anchor-marquee")).toHaveCount(0);
    await expectHealthyPage(page);
    await page.getByTestId("task-composer-anchor-multi-selection").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("composer-touch-393.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "打开项目管理导航", exact: true }).tap();
    const navigation = page.getByRole("dialog", { name: "项目管理导航", exact: true });
    await navigation.getByRole("link", { name: "任务", exact: true }).tap();
    const leaveGuard = page.getByRole("dialog", { name: "离开 Task 编辑？", exact: true });
    await expect(leaveGuard).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("composer-leave-guard-393.png"), animations: "disabled" });
    await leaveGuard.getByRole("button", { name: "继续编辑", exact: true }).tap();
    await expect(leaveGuard).toBeHidden();
    await expect(navigation).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/progress/tasks/${draft.taskId}/edit`));
    await navigation.getByRole("button", { name: "关闭项目管理导航", exact: true }).tap();
    await expect(page.getByRole("button", { name: "打开项目管理导航", exact: true })).toBeFocused();
    await expect(page.getByLabel("Task 名称")).toHaveValue("手机旋转后保留的计划名称");
    expect(errors).toEqual([]);
  } finally {
    if (context.pages().length > 0) await context.close();
  }
});

test("触摸投入支持显式打开和保存，滑动不会改变日期或产生业务写入", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await createUiFixture();
  // A nonoverlapping block isolates real touch scrolling from subpixel lane hit areas.
  // The later edit still selects the original tiny block through its accessible list.
  const gestureSegment = await createWorkSegment(actor(fixture.member), {
    personId: fixture.member.person.id,
    startAt: "2026-08-11T09:00:00.000Z", endAt: "2026-08-13T09:00:00.000Z",
    content: "手机手势安全验证投入", taskId: null,
  });
  const context = await browser.newContext({ baseURL, viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });
  try {
    await loginAsTestUser(context, baseURL, { openId: fixture.member.openId, name: fixture.member.person.displayName });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/progress/resources?all=0&people=${fixture.member.person.id}&focus=${gestureSegment.segment.id}`);
    const dialog = page.getByRole("dialog", { name: "投入详情" });
    const edit = dialog.getByRole("form", { name: "编辑投入详情" });
    await expect(edit).toBeVisible();
    const before = await prisma.workSegment.findUniqueOrThrow({ where: { id: gestureSegment.segment.id } });
    const startValue = await edit.getByLabel("开始", { exact: true }).inputValue();
    const endValue = await edit.getByLabel("结束", { exact: true }).inputValue();
    await swipeOnCanvasObject(page, dialog.getByTestId(`segment-block-${gestureSegment.segment.id}`));
    await expect(edit.getByLabel("开始", { exact: true })).toHaveValue(startValue);
    await expect(edit.getByLabel("结束", { exact: true })).toHaveValue(endValue);
    const afterSwipe = await prisma.workSegment.findUniqueOrThrow({ where: { id: gestureSegment.segment.id } });
    expect(afterSwipe.updatedAt).toEqual(before.updatedAt);
    expect(afterSwipe.startAt).toEqual(before.startAt);
    expect(afterSwipe.endAt).toEqual(before.endAt);
    await dialog.getByRole("button", { name: "Close", exact: true }).tap();
    await page.goto(`/progress/resources?all=0&people=${fixture.member.person.id}&center=2026-08-10T09%3A30%3A00.000Z&scale=week`);
    const objectList = page.getByTestId("time-canvas-object-list");
    await objectList.locator("summary").tap();
    await objectList.getByRole("button", { name: /P6 UI 可确认计划/ }).first().tap();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("segment-selected-touch-393.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "编辑投入", exact: true }).tap();
    await expect(edit).toBeVisible();
    const content = `手机显式编辑 ${randomUUID()}`;
    await edit.getByLabel("内容", { exact: true }).fill(content);
    await edit.getByRole("button", { name: "保存基本信息", exact: true }).tap();
    await expect.poll(async () => (await prisma.workSegment.findUniqueOrThrow({ where: { id: fixture.confirmableSegmentId } })).content).toBe(content);
    await expectHealthyPage(page);
    await page.screenshot({ path: testInfo.outputPath("segment-edit-touch-393.png"), fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
  } finally {
    if (context.pages().length > 0) await context.close();
  }
});

async function swipeOnCanvasObject(page: Page, object: Locator) {
  await object.evaluate((element) => {
    element.closest('[data-testid="time-canvas-root"]')?.scrollIntoView({ block: "center", inline: "nearest" });
    document.documentElement.removeAttribute("data-test-pointer-type");
    element.addEventListener("pointerdown", (event) => document.documentElement.setAttribute("data-test-pointer-type", (event as PointerEvent).pointerType), { once: true });
  });
  await expect.poll(async () => object.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-testid="time-canvas-scroll"]');
    const row = element.closest('[data-canvas-row]');
    const headerWidth = row?.previousElementSibling?.getBoundingClientRect().width ?? 0;
    if (!scroller) throw new Error("缺少画布滚动区域");
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const targetX = scroller.getBoundingClientRect().left + headerWidth + (scroller.clientWidth - headerWidth) / 2;
    if (Math.abs(centerX - targetX) > 2) {
      scroller.scrollLeft += centerX - targetX;
      return false;
    }
    const hit = document.elementFromPoint(centerX, rect.top + rect.height / 2);
    return hit === element || (hit !== null && element.contains(hit));
  }), { timeout: 10_000, message: "手势起点必须真正命中时间对象，不能落在固定人员表头后" }).toBe(true);
  const box = await object.boundingBox();
  if (!box) throw new Error("时间画布对象不可见");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("触摸测试缺少视口");
  const x = Math.min(viewport.width - 24, box.x + box.width / 2);
  const y = Math.max(1, Math.min(viewport.height - 24, box.y + box.height / 2));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.max(8, x - step * 10), y }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator("html")).toHaveAttribute("data-test-pointer-type", "touch");
  } finally {
    await session.detach();
  }
}
