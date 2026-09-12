// @playwright-project ui
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createTask } from "./helpers/project-management-canvas-security-fixtures";
import { createRisk } from "../lib/project-management/application/collaboration-service";
import { markInAppNotificationRead as markInAppNotificationReadService } from "../lib/project-management/application/notification-service";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

import {
  actor,
  createAccountPerson,
  createLargeTaskWorkbenchFixture,
  createUiFixture,
  grantRole,
} from "./helpers/project-management-ui-fixtures";

async function expectTaskExecutionLayout(page: Page) {
  await expect(page.getByTestId("task-execution-view")).toBeVisible();
  await expect(page.getByTestId("task-execution-view")).toBeVisible();
  await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  const columnBox = await page.getByTestId("task-detail-main-column").boundingBox();
  const detailBox = await page.locator("#task-selected-node-detail").boundingBox();
  if (!columnBox || !detailBox) throw new Error("无法读取任务执行主表单尺寸");
  expect(detailBox.width).toBeGreaterThanOrEqual(columnBox.width * 0.9);
  expect(detailBox.width).toBeGreaterThan(280);
  await expectHealthyPage(page);
}

test.describe("project management UI project-management-ui-routes-responsive", () => {
  test.beforeAll(async () => {
      const administrator = await createAccountPerson(
        `S5 UI Global Approval Administrator ${randomUUID()}`,
      );
      await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
    });

  test("dashboard, Task workbench, resource timeline and notifications work", async ({
      context,
      page,
      baseURL,
    }, testInfo) => {
      test.setTimeout(120_000);
      const pageErrors: Error[] = [];
      page.on("pageerror", (error) => pageErrors.push(error));
      const fixture = await createUiFixture();
      await loginAsTestUser(context, baseURL, {
        openId: fixture.member.openId,
        name: fixture.member.person.displayName,
      });

      await page.goto(
        `/progress?timelineDate=2026-08-03&timelineFocus=legacy&start=2026-08-01&end=2026-09-01&zoom=month&personId=${fixture.member.person.id}&taskId=${fixture.taskId}&focusSegmentIds=${fixture.taskId}`,
      );
      await expect(page).toHaveURL(/\/progress$/);
      await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
      await expect(
        page
          .getByLabel("参与任务")
          .getByRole("link", { name: fixture.taskTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByText("未读通知")).toBeVisible();
      const metrics = page.getByRole("region", { name: "工作指标", exact: true });
      const timeline = page.getByRole("region", { name: "我的日程与投入", exact: true });
      const workbenchContent = page.getByTestId("workbench-priority-content");
      await expect(timeline.getByTestId("time-canvas-root")).toBeVisible();
      const metricBox = await metrics.boundingBox();
      const workbenchTimelineBox = await timeline.boundingBox();
      const contentBox = await workbenchContent.boundingBox();
      if (!metricBox || !workbenchTimelineBox || !contentBox) throw new Error("无法读取工作台布局尺寸");
      expect(workbenchTimelineBox.y).toBeGreaterThanOrEqual(metricBox.y + metricBox.height);
      expect(contentBox.y).toBeGreaterThanOrEqual(workbenchTimelineBox.y + workbenchTimelineBox.height);
      await expect(workbenchContent.getByRole("table", { name: "参与任务列表" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /待确认投入|到期投入/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /^确认投入：/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "资源冲突" })).toHaveCount(0);
      await expectHealthyPage(page);

      await expect(page.getByRole("navigation", { name: "工作台视图" })).toHaveCount(0);
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
      const personalTaskPlanLink = page
        .getByTestId(`time-canvas-row-header-plan:${fixture.taskId}`)
        .getByRole("link", { name: fixture.taskTitle, exact: true });
      await expect(personalTaskPlanLink).toHaveAttribute(
        "href",
        `/progress/tasks/${fixture.taskId}`,
      );
      await page.getByRole("button", { name: "新增投入" }).click();
      const personalQuickCreate = page.getByRole("form", {
        name: "投入快速创建",
      });
      const unsavedTaskContent = `未保存的 Task 行导航内容 ${randomUUID()}`;
      await personalQuickCreate.getByLabel("内容").fill(unsavedTaskContent);
      const personalUrl = page.url();
      let rowNavigationConfirmation = "";
      page.once("dialog", async (dialog) => {
        rowNavigationConfirmation = dialog.message();
        await dialog.dismiss();
      });
      await personalTaskPlanLink.click();
      await expect.poll(() => rowNavigationConfirmation).toBe(
        "创建内容尚未保存，确认放弃？",
      );
      await expect(page).toHaveURL(personalUrl);
      await expect(personalQuickCreate.getByLabel("内容")).toHaveValue(
        unsavedTaskContent,
      );
      let acceptedRowNavigation = false;
      page.once("dialog", async (dialog) => {
        acceptedRowNavigation = true;
        await dialog.accept();
      });
      await personalTaskPlanLink.click();
      await expect.poll(() => acceptedRowNavigation).toBe(true);
      await expect(page).toHaveURL((url) => url.pathname === `/progress/tasks/${fixture.taskId}`);
      await expectTaskExecutionLayout(page);
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();

      await page.goto("/progress/tasks");
      await expect(page.getByRole("heading", { level: 1, name: "任务", exact: true })).toBeVisible();
      await expect(page.getByLabel("任务状态")).toHaveValue("ACTIVE");
      await expect(page.getByRole("combobox", { name: "任务范围", exact: true })).toHaveValue("1");
      await expect(page.getByRole("link", { name: fixture.taskTitle, exact: true })).toBeVisible();
      await page.getByLabel("任务状态").selectOption("");
      await page.getByRole("combobox", { name: "任务范围", exact: true }).selectOption("0");
      await page.getByRole("button", { name: "筛选", exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === "/progress/tasks" && url.searchParams.get("mine") === "0" && !url.searchParams.get("status"));
      await expect(page.getByLabel("任务状态")).toHaveValue("");
      await expect(page.getByRole("combobox", { name: "任务范围", exact: true })).toHaveValue("0");
      await expectHealthyPage(page);

      await page.goto(`/progress/tasks/${fixture.taskId}?focus=task-detail-start`);
      await expect(
        page
          .getByTestId("project-management-command-bar")
          .getByRole("heading", { name: fixture.taskTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
      await expect(page.getByTestId("task-overview")).toBeVisible();
      await expect(page.getByRole("heading", { name: fixture.taskTitle, exact: true })).toHaveCount(1);
      await expectTaskExecutionLayout(page);
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();

      await expect(page.getByRole("navigation", { name: "任务详情分区" })).toHaveCount(0);
      const metadata = page.locator("details").filter({ has: page.locator("summary", { hasText: "任务资料与成员" }) });
      await expect(metadata).not.toHaveAttribute("open", "");
      await metadata.locator("summary").click();
      await expect(metadata).toHaveAttribute("open", "");
      await expectHealthyPage(page);
      await metadata.locator("summary").click();
      if (testInfo.project.name === "desktop") {
        await page.setViewportSize({ width: 1279, height: 1000 });
        await expectTaskExecutionLayout(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await expectTaskExecutionLayout(page);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await expectTaskExecutionLayout(page);
      }
      await expect(page.getByRole("heading", { name: "任务风险", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
      await page.getByTestId("task-collaboration-view").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("task-collaboration-view")).toBeVisible();

      expect(new URL(page.url()).searchParams.get("focus")).toBe("task-detail-start");
      await expect(page.getByRole("heading", { name: "任务风险", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "任务评论", exact: true })).toBeVisible();
      await expect(page.getByText("从未记录风险")).toBeVisible();
      await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
      await expectHealthyPage(page);
      await page.getByTestId("task-activity-view").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("task-activity-view")).toBeVisible();

      await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "任务评论", exact: true })).toBeVisible();
      await expectHealthyPage(page);
      await page.getByTestId("task-plan-view").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("task-plan-view")).toBeVisible();

      await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
      await expect(
        page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /开始节点/ }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("tab")).toHaveCount(0);
      await expect(page.getByText("人员投入", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "计划与人员投入" })).toBeVisible();
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
      await expect.poll(() => {
        const taskDetailUrl = new URL(page.url());
        return {
          pathname: taskDetailUrl.pathname,
          validCenter: Number.isFinite(Date.parse(taskDetailUrl.searchParams.get("center") ?? "")),
          validScale: ["week", "month", "quarter", "year"].includes(taskDetailUrl.searchParams.get("scale") ?? ""),
        };
      }).toEqual({
        pathname: `/progress/tasks/${fixture.taskId}`,
        validCenter: true,
        validScale: true,
      });
      const taskCurrentPlanLink = page
        .getByTestId(`time-canvas-row-header-plan:${fixture.taskId}`)
        .getByRole("link", { name: fixture.taskTitle, exact: true });
      await expect(taskCurrentPlanLink).toHaveAttribute(
        "href",
        `/progress/tasks/${fixture.taskId}`,
      );
      await page.getByRole("button", { name: "复制链接", exact: true }).click();
      const globalNotice = page.getByTestId("task-global-notice");
      await expect(globalNotice).toBeVisible();
      await globalNotice.evaluate((element) => {
        element.textContent = "长".repeat(1_000);
      });
      const [overviewBox, noticeBox, timelineBox] = await Promise.all([
        page.getByTestId("task-overview").boundingBox(),
        globalNotice.boundingBox(),
        page.getByTestId("task-timeline-layer").boundingBox(),
      ]);
      if (!overviewBox || !noticeBox || !timelineBox) {
        throw new Error("无法读取 Task 全局反馈的布局位置");
      }
      expect(noticeBox.y).toBeGreaterThan(overviewBox.y + overviewBox.height);
      expect(timelineBox.y).toBeGreaterThan(noticeBox.y + noticeBox.height);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      await expect(
        page.getByTestId(`milestone-marker-plan-start:${fixture.taskId}`),
      ).toHaveAttribute("aria-pressed", "true");
      const canvasRoot = page.getByTestId("time-canvas-root");
      await canvasRoot.getByRole("button", { name: "月", exact: true }).click();
      await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
      await canvasRoot.evaluate((element) => {
        const state = window as typeof window & {
          __taskCanvasRoot?: Element;
          __taskCanvasZoomHistory?: string[];
          __taskCanvasZoomObserver?: MutationObserver;
        };
        state.__taskCanvasZoomObserver?.disconnect();
        state.__taskCanvasRoot = element;
        state.__taskCanvasZoomHistory = [element.dataset.zoom ?? ""];
        state.__taskCanvasZoomObserver = new MutationObserver(() => {
          state.__taskCanvasZoomHistory?.push(element.dataset.zoom ?? "");
        });
        state.__taskCanvasZoomObserver.observe(element, {
          attributes: true,
          attributeFilter: ["data-zoom"],
        });
      });
      const canvasScroll = page.getByTestId("time-canvas-scroll");
      const terminalNavigatorButton = page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ });
      await terminalNavigatorButton.click();
      await expectTaskExecutionLayout(page);
      await expect(
        page
          .getByTestId("task-execution-view")
          .getByRole("heading", { name: "Terminal", exact: true }),
      ).toBeVisible();
      await page.getByTestId("task-plan-view").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("task-plan-view")).toBeVisible();
      await expect(canvasRoot).toBeVisible();
      await expect(terminalNavigatorButton).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() => canvasScroll.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(1);
      await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
      expect(
        await canvasRoot.evaluate(
          (element) => element === (
            window as typeof window & { __taskCanvasRoot?: Element }
          ).__taskCanvasRoot,
        ),
      ).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
          }),
      );
      expect(
        await page.evaluate(() =>
          (window as typeof window & { __taskCanvasZoomHistory?: string[] })
            .__taskCanvasZoomHistory ?? [],
        ),
      ).toEqual(["MONTH"]);
      const firstMilestoneMarker = page.getByRole("button", {
        name: /计划节点 P6 UI 第一阶段/,
      });
      await firstMilestoneMarker.focus();
      await firstMilestoneMarker.press("Enter");
      await expect(page.getByTestId("task-plan-view")).toBeVisible();
      await expect(canvasRoot).toBeVisible();
      await expect(firstMilestoneMarker).toHaveAttribute("aria-pressed", "true");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      await expectHealthyPage(page);

      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
      );
      await expect(page.getByRole("heading", { name: "资源计划" })).toBeVisible();
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
      await expect(page.getByText("只看冲突")).toHaveCount(0);
      await expect(page.getByText("投入比例")).toHaveCount(0);
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.inactiveHistory.person.id}&zoom=hour&center=${encodeURIComponent("2026-08-10T15:30:00.000Z")}&scale=week`,
      );
      await expect(
        page.getByText(
          `${fixture.inactiveHistory.person.displayName}（已停用）`,
          { exact: true },
        ).first(),
      ).toBeVisible();
      await expect(
        page.getByTestId(`segment-block-${fixture.inactiveHistorySegmentId}`),
      ).toBeVisible();
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
      );
      await expect(
        page.getByRole("button", { name: `移除${fixture.member.person.displayName}` }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
      ).toBeVisible();
      const peoplePicker = page.getByLabel("筛选人员", { exact: true });
      await page
        .getByRole("button", { name: `移除${fixture.owner.person.displayName}` })
        .click();
      await expect(
        page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
      ).toHaveCount(0);
      await peoplePicker.fill(fixture.owner.person.displayName);
      const ownerOption = page.getByRole("option", {
        name: fixture.owner.person.displayName,
        exact: true,
      });
      await expect(ownerOption.locator(".sr-only")).toHaveText("已绑定账号");
      const ownerLabelBox = await ownerOption
        .getByText(fixture.owner.person.displayName, { exact: true })
        .boundingBox();
      expect(ownerLabelBox?.width ?? 0).toBeGreaterThan(80);
      await ownerOption.click();
      await expect(
        page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
      ).toBeVisible();
      const taskPicker = page.getByLabel("筛选任务", { exact: true });
      await taskPicker.fill(fixture.taskTitle);
      const taskOption = page.getByRole("option", {
        name: fixture.taskTitle,
        exact: true,
      });
      await expect(taskOption.locator(".sr-only")).toContainText("进行中 · 高");
      await expect(taskOption.locator(".sr-only")).toContainText("英雄 / 电控");
      const taskTitleBox = await taskOption
        .getByText(fixture.taskTitle, { exact: true })
        .boundingBox();
      expect(taskTitleBox?.width ?? 0).toBeGreaterThan(120);
      await taskOption.click();
      await expect(
        page.getByRole("button", { name: `移除${fixture.taskTitle}` }),
      ).toBeVisible();
      await page.getByRole("button", { name: "应用选择" }).click();
      await expect(page).toHaveURL(new RegExp(`tasks=${fixture.taskId}`));
      await page.reload();
      await expect(
        page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: `移除${fixture.taskTitle}` }),
      ).toBeVisible();
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&tasks=${fixture.taskId}&group=task&zoom=hour`,
      );
      await expect(page.getByText(fixture.taskTitle, { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "新增投入" })).toBeVisible();
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
      );
      if (testInfo.project.name === "desktop") {
        await loginAsTestUser(context, baseURL, {
          openId: fixture.admin.openId,
          name: fixture.admin.person.displayName,
        });
        await page.goto(
          `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id},${fixture.reviewer.person.id}&zoom=hour`,
        );
        await page.getByRole("button", { name: "新增投入" }).click();
        const crossRowCreate = page.getByRole("form", { name: "投入快速创建" });
        const crossRowPerson = crossRowCreate.locator('input[name="personId"]');
        const firstDraftPersonId = await crossRowPerson.inputValue();
        const crossRowRange = page.getByTestId("time-canvas-creation-range");
        const pointerTargetRow = page.getByLabel(
          `${fixture.owner.person.displayName} 时间行`,
          { exact: true },
        );
        const [crossRowRangeBox, pointerTargetRowBox, crossRowScrollBox] =
          await Promise.all([
            crossRowRange.boundingBox(),
            pointerTargetRow.boundingBox(),
            page.getByTestId("time-canvas-scroll").boundingBox(),
          ]);
        if (!crossRowRangeBox || !pointerTargetRowBox || !crossRowScrollBox) {
          throw new Error("未找到创建草稿跨行拖动坐标");
        }
        const pointerX = crossRowRangeBox.x + crossRowRangeBox.width / 2;
        await page.mouse.move(pointerX, crossRowRangeBox.y + crossRowRangeBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(pointerX, pointerTargetRowBox.y + pointerTargetRowBox.height / 2);
        await expect(pointerTargetRow).toHaveAttribute("data-creation-drop-state", "valid");
        await page.mouse.move(pointerX, crossRowScrollBox.y + 4);
        await expect(crossRowRange).toHaveAttribute("data-drop-state", "invalid");
        await page.mouse.up();
        await crossRowRange.focus();
        await crossRowRange.press("Alt+ArrowDown");
        await expect(crossRowRange).toBeFocused();
        await expect(crossRowPerson).not.toHaveValue(firstDraftPersonId);
        const secondDraftPersonId = await crossRowPerson.inputValue();
        await crossRowRange.press("Alt+ArrowDown");
        await expect(crossRowRange).toBeFocused();
        await expect(crossRowPerson).not.toHaveValue(secondDraftPersonId);
        await crossRowCreate.getByRole("button", { name: "取消", exact: true }).click();
        await loginAsTestUser(context, baseURL, {
          openId: fixture.member.openId,
          name: fixture.member.person.displayName,
        });
        await page.goto(
          `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id}&zoom=hour`,
        );
        const emptyCanvasScroll = page.getByTestId("time-canvas-scroll");
        await emptyCanvasScroll.evaluate((element) => {
          element.scrollLeft = 1_200;
          element.dispatchEvent(new Event("scroll"));
        });
        const emptyRow = page.getByLabel(`${fixture.member.person.displayName} 时间行`, { exact: true });
        const emptyScrollBox = await emptyCanvasScroll.boundingBox();
        const emptyRowBox = await emptyRow.boundingBox();
        if (!emptyScrollBox || !emptyRowBox) throw new Error("未找到空人员行拖选坐标");
        const brushStartX = emptyScrollBox.x + Math.min(emptyScrollBox.width - 140, 760);
        const brushY = emptyRowBox.y + emptyRowBox.height - 8;
        await page.mouse.click(brushStartX, brushY);
        const clickCreate = page.getByRole("form", { name: "投入快速创建" });
        await expect(clickCreate).toBeVisible();
        const minimumRange = page.getByTestId("time-canvas-creation-range");
        await expect(minimumRange).toBeVisible();
        expect((await minimumRange.boundingBox())?.width ?? 0).toBeGreaterThan(0);
        await clickCreate.getByRole("button", { name: "取消", exact: true }).click();
        await expect(minimumRange).toHaveCount(0);
        await emptyRow.scrollIntoViewIfNeeded();
        const dragScrollBox = await emptyCanvasScroll.boundingBox();
        const dragRowBox = await emptyRow.boundingBox();
        if (!dragScrollBox || !dragRowBox) {
          throw new Error("取消快速创建后未找到空人员行拖选坐标");
        }
        const dragStartX =
          dragScrollBox.x + Math.min(dragScrollBox.width - 140, 760);
        const dragY = dragRowBox.y + dragRowBox.height - 8;
        await page.mouse.move(dragStartX, dragY);
        await page.mouse.down();
        await page.mouse.move(dragStartX + 72, dragY, { steps: 4 });
        await page.mouse.up();
        const brushCreate = page.getByRole("form", { name: "投入快速创建" });
        await expect(brushCreate).toBeVisible();
        await expect(page.getByTestId("time-canvas-creation-range")).toBeVisible();
        await expect(page.getByTestId("time-canvas-creation-range")).toHaveCSS(
          "border-top-style",
          "dashed",
        );
        const draftStartBeforeMove = await brushCreate.getByLabel("开始").inputValue();
        await page.getByTestId("time-canvas-creation-range").focus();
        await page.getByTestId("time-canvas-creation-range").press("Shift+ArrowRight");
        await expect(brushCreate.getByLabel("开始")).not.toHaveValue(draftStartBeforeMove);
        await expect(brushCreate.getByLabel("投入比例")).toHaveCount(0);
        await expect(brushCreate.getByLabel("完成比例")).toHaveCount(0);
        await brushCreate.getByLabel("任务", { exact: true }).fill(fixture.taskTitle);
        await page
          .getByRole("option", { name: fixture.taskTitle, exact: true })
          .click();
        await brushCreate.getByLabel("内容").fill(fixture.brushCreateContent);
        await expect(brushCreate.getByLabel("预期输出")).toHaveCount(0);
        await brushCreate.getByRole("button", { name: "创建", exact: true }).click();
        await expect(page.getByText("已创建投入记录")).toBeVisible();
        await expect(page.getByTestId("time-canvas-creation-range")).toHaveCount(0);
        await expect.poll(() => prisma.workSegment.findFirst({
          where: {
            personId: fixture.member.person.id,
            content: fixture.brushCreateContent,
          },
          select: { taskId: true, content: true },
        })).toEqual({
          taskId: fixture.taskId,
          content: fixture.brushCreateContent,
        });
        await page.goto(
          `/progress/resources?people=${fixture.member.person.id},${fixture.owner.person.id}&all=0&center=2026-08-10T10%3A30%3A00.000Z&scale=week`,
        );
        const canvasScroll = page.getByTestId("time-canvas-scroll");
        await expect(canvasScroll).toBeVisible();
        const originalRange = await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.movableSegmentId },
          select: { startAt: true, endAt: true },
        });
        const movable = page.getByTestId(`segment-block-${fixture.movableSegmentId}`);
        await expect(movable.locator("[data-resize-handle]")).toHaveCount(0);
        await movable.focus();
        await movable.press("Shift+ArrowRight");
        expect(
          await prisma.workSegment.findUniqueOrThrow({
            where: { id: fixture.movableSegmentId },
            select: { startAt: true, endAt: true },
          }),
        ).toMatchObject(originalRange);
        await movable.press("Enter");
        const movedInspector = page.getByTestId("segment-inspector");
        await expect(
          movedInspector.getByRole("heading", { name: "P6 UI 重叠计划 A" }),
        ).toBeVisible();
        await expect(movedInspector.getByLabel("投入比例")).toHaveCount(0);
        await expect(movedInspector.getByLabel("职责", { exact: true })).toHaveCount(0);
        await expect(movedInspector.getByLabel("自定义职责")).toHaveCount(0);
        const inspectorStart = movedInspector.getByLabel("开始", { exact: true });
        const inspectorEnd = movedInspector.getByLabel("结束", { exact: true });
        const originalStartValue = await inspectorStart.inputValue();
        const originalEndValue = await inspectorEnd.inputValue();
        await inspectorStart.fill("2026-08-20T10:00");
        await expect(inspectorStart).toHaveValue("2026-08-20T10:00");
        await expect(movedInspector.locator("#inspect-range-error")).toContainText(
          "结束时间必须晚于开始时间",
        );
        await inspectorEnd.fill("2026-08-20T11:00");
        await expect(movedInspector.locator("#inspect-range-error")).toHaveCount(0);
        await inspectorStart.fill(originalStartValue);
        await inspectorEnd.fill(originalEndValue);
        await prisma.workSegment.update({
          where: { id: fixture.movableSegmentId },
          data: { content: "P6 UI Inspector 并发权威内容" },
        });
        await movedInspector
          .getByLabel("内容", { exact: true })
          .fill("P6 UI 不应覆盖并发内容");
        await movedInspector.getByRole("button", { name: "保存基本信息", exact: true }).click();
        await expect(page.getByText(/正在读取服务器最新版本/)).toBeVisible();
        await expect(movedInspector.getByLabel("内容", { exact: true })).toHaveValue(
          "P6 UI Inspector 并发权威内容",
        );
        await expect(movedInspector.getByRole("heading", { name: "P6 UI Inspector 并发权威内容", exact: true })).toBeVisible();
        await expect(movedInspector.getByRole("button", { name: "保存基本信息", exact: true })).toBeEnabled();
        await movedInspector
          .getByLabel("内容", { exact: true })
          .fill("P6 UI Inspector 更新不覆盖画布时间");
        await movedInspector.getByRole("button", { name: "保存基本信息", exact: true }).click();
        await expect(page.getByText("已更新投入详情")).toBeVisible();
        await expect.poll(async () => {
          const row = await prisma.workSegment.findUniqueOrThrow({
            where: { id: fixture.movableSegmentId },
            select: { content: true, startAt: true, endAt: true },
          });
          return {
            content: row.content,
            startAt: row.startAt.toISOString(),
            endAt: row.endAt.toISOString(),
          };
        }).toEqual({
          content: "P6 UI Inspector 更新不覆盖画布时间",
          startAt: originalRange.startAt.toISOString(),
          endAt: originalRange.endAt.toISOString(),
        });
        await expect(page.getByRole("dialog", { name: "投入详情" })).toBeHidden();
        await expect(page.getByRole("button", { name: "新增投入", exact: true })).toBeEnabled();
        const confirmableSegment = page.getByTestId(
          `segment-block-${fixture.confirmableSegmentId}`,
        );
        await expect(confirmableSegment).toBeVisible();
        await confirmableSegment.focus();
        await confirmableSegment.press("Enter");
      } else {
        await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
        await page.getByRole("button", { name: "新增投入" }).click();
        const quickCreate = page.getByRole("form", { name: "投入快速创建" });
        await expect(quickCreate.getByLabel("投入比例")).toHaveCount(0);
        await expect(quickCreate.getByLabel("完成比例")).toHaveCount(0);
        await expect(page.getByTestId("time-canvas-creation-range")).toHaveCSS(
          "pointer-events",
          "none",
        );
        await quickCreate.getByLabel("内容").fill(fixture.mobileCreateContent);
        await expect(quickCreate.getByLabel("预期输出")).toHaveCount(0);
        const actionUrl = "**/progress/resources**";
        let actionAborted = false;
        const abortFirstAction = async (route: import("@playwright/test").Route) => {
          if (!actionAborted && route.request().method() === "POST") {
            actionAborted = true;
            await route.abort();
            return;
          }
          await route.continue();
        };
        await page.route(actionUrl, abortFirstAction);
        await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
        await expect(page.getByText("网络异常，未能保存；输入仍保留，可直接重试。")).toBeVisible();
        await expect(quickCreate.getByLabel("内容")).toHaveValue(fixture.mobileCreateContent);
        await page.unroute(actionUrl, abortFirstAction);
        await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
        await expect(page.getByText("已创建投入记录")).toBeVisible();
        await expect
          .poll(() => prisma.workSegment.findFirst({
            where: { content: fixture.mobileCreateContent },
            select: { content: true },
          }))
          .toEqual({ content: fixture.mobileCreateContent });
        await expect(
          page.getByRole("button", {
            name: new RegExp(fixture.mobileCreateContent),
          }),
        ).toBeVisible();
        const confirmableUrl = new URL(page.url());
        confirmableUrl.searchParams.set(
          "center",
          "2026-08-10T09:30:00.000Z",
        );
        confirmableUrl.searchParams.set("scale", "week");
        await page.goto(
          `${confirmableUrl.pathname}?${confirmableUrl.searchParams.toString()}`,
        );
        const confirmableSegment = page.getByTestId(
          `segment-block-${fixture.confirmableSegmentId}`,
        );
        await expect(confirmableSegment).toBeVisible({ timeout: 15_000 });
        await confirmableSegment.focus();
        await confirmableSegment.press("Enter");
      }
      await expect(page.getByTestId("segment-inspector")).toBeVisible();
      await expect(
        page
          .getByTestId("segment-inspector")
          .getByRole("heading", { name: "P6 UI 可确认计划" }),
      ).toBeVisible();
      const commonInspector = page.getByTestId("segment-inspector");
      await expect(commonInspector.getByText("类型", { exact: true })).toHaveCount(0);
      await expect(commonInspector.getByText("状态", { exact: true })).toHaveCount(0);
      await expect(commonInspector.getByText("所属人员", { exact: true })).toBeVisible();
      await expect(commonInspector.getByRole("term").filter({ hasText: /^关联任务$/ })).toBeVisible();
      await expect(
        commonInspector.getByRole("link", { name: fixture.taskTitle, exact: true }),
      ).toHaveAttribute("href", `/progress/tasks/${fixture.taskId}`);
      if (testInfo.project.name === "desktop") {
        const editableContent = commonInspector.getByLabel("内容", { exact: true });
        await editableContent.fill("P6 UI 未保存 Task 导航保护");
        page.once("dialog", (dialog) => {
          expect(dialog.message()).toContain("当前投入有未保存修改");
          void dialog.dismiss();
        });
        await commonInspector
          .getByRole("link", { name: fixture.taskTitle, exact: true })
          .click();
        await expect(page).toHaveURL(/\/progress\/resources/);
        await expect(page.getByRole("dialog", { name: "投入详情" })).toBeVisible();
        await expect(editableContent).toHaveValue("P6 UI 未保存 Task 导航保护");
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const editForm = commonInspector.getByRole("form", { name: "编辑投入详情" });
      for (const removedLabel of ["预期输出", "实际输出", "优先级", "修改原因"]) {
        await expect(editForm.getByLabel(removedLabel)).toHaveCount(0);
      }
      await expect(commonInspector.getByRole("button", { name: "完整确认", exact: true })).toHaveCount(0);
      const content = editForm.getByLabel("内容", { exact: true });
      await content.fill("");
      await editForm.getByRole("button", { name: "保存基本信息", exact: true }).click();
      await expect(content).toHaveAttribute("aria-invalid", "true");
      await expect(content).toBeFocused();
      const updatedContent = `P6 UI ${testInfo.project.name} 更新工作内容`;
      await content.fill(updatedContent);
      await expect(content).not.toHaveAttribute("aria-invalid", "true");
      await editForm.getByRole("button", { name: "保存基本信息", exact: true }).click();
      await expect(page.getByText("已更新投入详情")).toBeVisible();
      await expect.poll(() => prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.confirmableSegmentId },
        select: { content: true, taskId: true, deletedAt: true },
      })).toEqual({ content: updatedContent, taskId: fixture.taskId, deletedAt: null });
      await expectHealthyPage(page);
      expect(pageErrors).toEqual([]);

      await page.goto("/progress/notifications");
      await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
      await expect(page.getByText("P6 UI 通知")).toBeVisible();
      await expect(
        page
          .locator("article")
          .filter({ hasText: "P6 UI 通知" })
          .getByText("任务", { exact: true }),
      ).toBeVisible();
      await page
        .locator("article")
        .filter({ hasText: "P6 UI 通知" })
        .getByRole("button", { name: "标记已读" })
        .click();
      await expect(page.getByText("已标记通知为已读")).toBeVisible();
      await expect
        .poll(async () => {
          const row = await prisma.inAppNotification.findUniqueOrThrow({
            where: { id: fixture.notificationId },
            select: { readAt: true },
          });
          return row.readAt !== null;
        })
        .toBe(true);
      await expectHealthyPage(page);
    });

  test("non-member can view the full Task workbench but cannot mutate it", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createUiFixture();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const visibleTaskRisk = `非成员可见 Task 风险 ${randomUUID()}`;
      await createRisk(actor(fixture.owner), {
        targetType: "TASK",
        targetId: fixture.taskId,
        content: visibleTaskRisk,
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.outsider.openId,
        name: fixture.outsider.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await expect(
        page
          .getByTestId("project-management-command-bar")
          .getByRole("heading", { name: fixture.taskTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
      await expectTaskExecutionLayout(page);
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();

      await page.getByTestId("task-plan-view").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("task-plan-view")).toBeVisible();
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
      await expectHealthyPage(page);
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /开始节点/ })
        .click();
      await expect(
        page
          .getByTestId("task-execution-view")
          .getByRole("heading", { name: "开始节点", exact: true }),
      ).toBeVisible();
      await expectTaskExecutionLayout(page);
      await expect(page.getByRole("button", { name: "修改任务基本信息" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "发起计划修订" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "提交验收" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "申请结束任务" })).toHaveCount(0);
      await page.getByTestId("task-activity-view").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("task-activity-view")).toBeVisible();
      await expect(page.getByRole("heading", { name: "近期动态", exact: true })).toBeVisible();
      await expectHealthyPage(page);
      await page.getByTestId("task-collaboration-view").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("task-collaboration-view")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "任务风险", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "任务评论", exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByTestId("task-collaboration-view")
          .getByText(visibleTaskRisk, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "提出风险", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "解决风险", exact: true }),
      ).toHaveCount(0);
      const comment = page.getByLabel("发表评论");
      await expect(comment).toBeEnabled();
      await comment.fill("非成员仍可发表评论");
      await expect(
        page.getByRole("button", { name: "发布评论", exact: true }),
      ).toBeEnabled();
      await expectHealthyPage(page);
      expect(pageErrors).toEqual([]);

      await page.goto("/progress/notifications");
      await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
      await expect(page.getByText("P6 UI 通知")).toHaveCount(0);
      await expect(
        markInAppNotificationReadService(actor(fixture.outsider), {
          notificationId: fixture.notificationId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

  test("200 Milestone Task 工作台在桌面与移动端保持可用", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const fixture = await createLargeTaskWorkbenchFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(
      page
        .getByTestId("project-management-command-bar")
        .getByRole("heading", { name: fixture.taskTitle, exact: true }),
    ).toBeVisible();
    await expectTaskExecutionLayout(page);
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();

    await page.getByTestId("task-plan-view").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("task-plan-view")).toBeVisible();
    const navigator = page.getByTestId("task-plan-node-navigator");
    await expect(navigator).toBeVisible();
    await expect(navigator.getByRole("button")).toHaveCount(202);
    await expectHealthyPage(page);
    const finalMilestone = navigator
      .getByRole("button")
      .filter({ hasText: fixture.finalMilestoneGoal });
    await finalMilestone.click();
    await expectTaskExecutionLayout(page);
    await expect(finalMilestone).toHaveAttribute("aria-pressed", "true");
    await expect(
      page
        .getByTestId("task-execution-view")
        .getByRole("heading", {
          name: fixture.finalMilestoneGoal,
          exact: true,
        }),
    ).toBeVisible();
    const terminalButton = navigator.getByRole("button").filter({ hasText: fixture.terminalName });
    await terminalButton.click();
    await expect(terminalButton).toHaveAttribute("aria-pressed", "true");
    await expect(
      page
        .getByTestId("task-execution-view")
        .getByRole("heading", { name: fixture.terminalName, exact: true }),
    ).toBeVisible();
    await expectTaskExecutionLayout(page);
    await page.getByTestId("task-plan-view").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("task-plan-view")).toBeVisible();
    await expect(navigator).toBeVisible();
    await expect(navigator.getByRole("button").filter({ hasText: fixture.terminalName })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);
  });

  test("S8 dashboard, action inbox and notification preferences work on desktop and mobile", async ({
      context,
      page,
      baseURL,
    }) => {
      const user = await createAccountPerson("S8 驾驶舱用户");
      await loginAsTestUser(context, baseURL, {
        openId: user.openId,
        name: user.person.displayName,
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto("/progress");
      await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
      await expect(page.getByLabel("工作指标")).toBeVisible();
      await expect(page.getByTestId("action-inbox")).toHaveCount(0);
      await expectHealthyPage(page);

      await page.goto("/progress/approvals");
      await expect(page.getByRole("heading", { name: "待办与审批" })).toBeVisible();
      await expect(page.getByText("当前没有需要你处理的事项。")).toBeVisible();

      await page.goto("/progress/notifications?view=settings");
      await expect(page.getByRole("heading", { name: "通知偏好" })).toBeVisible();
      const taskFeishu = page.getByRole("checkbox", { name: "任务飞书通知" });
      await expect(taskFeishu).toBeChecked();
      await taskFeishu.uncheck();
      await expect(page.getByText(/通知偏好已保存/)).toBeVisible();
      await expect
        .poll(async () => {
          return prisma.notificationPreference.findUnique({
            where: {
              accountId_category_channel: {
                accountId: user.account.id,
                category: "TASK",
                channel: "FEISHU",
              },
            },
            select: { enabled: true },
          });
        })
        .toEqual({ enabled: false });
      await prisma.person.update({
        where: { id: user.person.id },
        data: { status: "INACTIVE" },
      });
      await page.reload();
      await expect(page.getByText("人员已停用，通知偏好仅供查看。")).toBeVisible();
      await expect(taskFeishu).toBeDisabled();
      await expectHealthyPage(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    });

  test("action inbox and notification center render Chinese business labels", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    const fixture = await createUiFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto("/progress/approvals");
    await expect(
      page.getByRole("heading", { name: "待办与审批" }),
    ).toBeVisible();
    await expect(page.getByTestId("action-inbox")).toBeVisible();
    await expect(page.getByRole("link", { name: /^确认投入：/ })).toHaveCount(0);
    await expect(page.getByText("下一个节点", { exact: true })).toBeVisible();
    await expect(
      page.getByText("P6 UI 第一阶段", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("完成标准：完成第一阶段")).toBeVisible();
    await expect(page.getByText("节点：里程碑 · 进行中")).toBeVisible();
    await expect(page.getByText(`任务：${fixture.taskTitle}`)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "查看节点：P6 UI 第一阶段" }),
    ).toBeVisible();
    await expect(page.getByText("任务结束申请", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText("Termination", { exact: true })).toHaveCount(0);
    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
  });

  test("action inbox recovers invalid cursors, retries network failures and limits the dashboard preview", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const user = await createAccountPerson(`S8 Inbox UI ${randomUUID()}`);
    const baseTime = Date.now() - 60 * 60_000;
    const longContent = "超长待办内容".repeat(80);
    const tasks = [];
    for (let index = 0; index < 55; index += 1) {
      const content = index === 0 ? longContent : `分页待办 ${String(index + 1).padStart(2, "0")}`;
      const task = await createTask({
        ownerAccountId: user.account.id,
        title: `S8 分页 Task ${index}`,
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: user.person.id, role: "OWNER" }],
      });
      await prisma.milestoneNode.update({
        where: { nodeId: task.milestoneNodeId },
        data: { goal: content, expectedCompletedAt: new Date(baseTime + (index + 1) * 60_000) },
      });
      tasks.push({ id: task.taskId, content });
    }
    await loginAsTestUser(context, baseURL, {
      openId: user.openId,
      name: user.person.displayName,
    });

    await page.goto("/progress/approvals");
    const inbox = page.getByTestId("action-inbox");
    await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(50);
    await expect(inbox.getByText(longContent, { exact: true })).toBeVisible();
    await expect(inbox.getByText("全部 55 项", { exact: true })).toBeVisible();
    await expect(
      inbox.getByText("已加载 50 / 55", { exact: true }),
    ).toBeVisible();

    const retiredNonAnchor = tasks[0]!;
    await prisma.task.update({
      where: { id: retiredNonAnchor.id },
      data: { status: "COMPLETED" },
    });
    await inbox.getByRole("button", { name: "加载更多" }).click();
    await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(55);
    await expect(inbox.getByText("全部 55 项", { exact: true })).toBeVisible();
    await expect(
      inbox.getByText("已加载 55 / 55", { exact: true }),
    ).toBeVisible();
    await expect(
      inbox.getByText("已加载全部 55 项", { exact: true }),
    ).toBeVisible();
    await expect(
      inbox.getByText(retiredNonAnchor.content, { exact: true }),
    ).toBeVisible();
    expect(
      new Set(
        await inbox
          .getByRole("link", { name: /^查看节点：/ })
          .evaluateAll((links) =>
            links.map((link) => link.getAttribute("aria-label")),
          ),
      ).size,
    ).toBe(55);

    await page.reload();
    await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(50);
    await expect(inbox.getByText("全部 54 项", { exact: true })).toBeVisible();
    await expect(
      inbox.getByText("已加载 50 / 54", { exact: true }),
    ).toBeVisible();
    await expect(
      inbox.getByText(retiredNonAnchor.content, { exact: true }),
    ).toHaveCount(0);

    const staleAnchor = tasks[50]!;
    await prisma.task.update({
      where: { id: staleAnchor.id },
      data: { status: "COMPLETED" },
    });
    const invalidCursorResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/progress/approvals"),
    );
    const loadMore = inbox.getByRole("button", { name: "加载更多" });
    await loadMore.focus();
    await expect(loadMore).toBeFocused();
    await page.keyboard.press("Enter");
    const actionResponse = await invalidCursorResponse;
    const actionResponseBytes = await actionResponse.body();
    expect(actionResponse.status()).toBe(200);
    for (const sensitiveAscii of [
      "ZodError",
      "ProjectManagementServiceError",
      '"stack"',
      "node_modules",
      "action-inbox-queries.ts",
    ]) {
      expect(
        actionResponseBytes.includes(Buffer.from(sensitiveAscii, "ascii")),
        `Flight response leaked ${sensitiveAscii}`,
      ).toBe(false);
    }
    await expect(inbox.getByRole("alert")).toHaveText(
      "加载失败：分页游标无效或已不再匹配当前待办队列",
    );
    await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(50);
    await expect(
      inbox.getByText(staleAnchor.content, { exact: true }),
    ).toBeVisible();
    await expect(
      inbox.getByRole("button", { name: "重新加载队列" }),
    ).toBeVisible();
    await expect(
      inbox.getByRole("button", { name: "重试加载" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);

    await inbox.getByRole("button", { name: "重新加载队列" }).click();
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(50);
    await expect(
      inbox.getByText(staleAnchor.content, { exact: true }),
    ).toHaveCount(0);
    await expect(inbox.getByText("全部 53 项", { exact: true })).toBeVisible();
    await expect(
      inbox.getByText("已加载 50 / 53", { exact: true }),
    ).toBeVisible();

    let failedOnce = false;
    const abortFirstLoadMore = async (
      route: import("@playwright/test").Route,
    ) => {
      if (!failedOnce && route.request().method() === "POST") {
        failedOnce = true;
        await route.abort("failed");
        return;
      }
      await route.continue();
    };
    await page.route("**/progress/approvals", abortFirstLoadMore);
    await inbox.getByRole("button", { name: "加载更多" }).click();
    await expect(inbox.getByRole("alert")).toContainText(
      "网络异常，请稍后重试",
    );
    await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(50);
    await page.unroute("**/progress/approvals", abortFirstLoadMore);
    await inbox.getByRole("button", { name: "重试加载" }).click();
    await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(53);
    await expect(
      inbox.getByText("已加载全部 53 项", { exact: true }),
    ).toBeVisible();
    const actionLabels = await inbox
      .getByRole("link", { name: /^查看节点：/ })
      .evaluateAll((links) =>
        links.map((link) => link.getAttribute("aria-label")),
      );
    expect(actionLabels).toEqual(
      tasks
        .filter(
          (segment) =>
            segment.id !== retiredNonAnchor.id && segment.id !== staleAnchor.id,
        )
        .map((segment) => `查看节点：${segment.content}`),
    );
    expect(new Set(actionLabels).size).toBe(actionLabels.length);
    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.goto("/progress");
    await expect(
      page.getByTestId("action-inbox").getByTestId("action-inbox-item"),
    ).toHaveCount(8);
    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(
      consoleErrors.filter(
        (message) => !message.includes("net::ERR_FAILED"),
      ),
    ).toEqual([]);
    expect(
      consoleErrors.filter((message) => message.includes("net::ERR_FAILED"))
        .length,
    ).toBeLessThanOrEqual(1);
  });
});
