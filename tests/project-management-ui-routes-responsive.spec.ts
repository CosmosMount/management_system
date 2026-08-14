import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { markInAppNotificationRead as markInAppNotificationReadService } from "../lib/project-management/application/notification-service";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

import {
  actor,
  createAccountPerson,
  createUiFixture,
  grantRole,
} from "./helpers/project-management-ui-fixtures";

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
      await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
      await expect(
        page.getByRole("link", { name: fixture.taskTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByText("未读通知")).toBeVisible();
      await expect(page.getByRole("link", { name: "资源冲突" })).toHaveCount(0);
      await expectHealthyPage(page);

      await page.goto("/progress/tasks");
      await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
      await expect(page.getByLabel("Task 状态")).toHaveValue("ACTIVE");
      await expect(page.getByRole("checkbox", { name: "只看我参与" })).toBeChecked();
      await expect(page.getByText(fixture.taskTitle)).toBeVisible();
      await page.getByLabel("Task 状态").selectOption("");
      await page.getByRole("checkbox", { name: "只看我参与" }).uncheck();
      await page.getByRole("button", { name: "筛选", exact: true }).click();
      await expect(page.getByLabel("Task 状态")).toHaveValue("");
      await expect(page.getByRole("checkbox", { name: "只看我参与" })).not.toBeChecked();
      await expectHealthyPage(page);

      await page.goto(`/progress/tasks/${fixture.taskId}?focus=task-detail-start`);
      await expect(
        page
          .getByTestId("task-workbench-v2")
          .getByRole("heading", { name: fixture.taskTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
      await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
      await expect(
        page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /Start/ }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("heading", { name: "Task 风险", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Task 评论", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
      await expect(page.getByText("从未记录风险")).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(0);
      await expect(page.getByText("人员投入", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "计划与人员投入" })).toBeVisible();
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
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
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
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
      await page.waitForTimeout(500);
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
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.inactiveHistory.person.id}&zoom=hour`,
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
      const taskPicker = page.getByLabel("筛选 Task", { exact: true });
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
        await brushCreate.getByLabel("Task", { exact: true }).fill(fixture.taskTitle);
        await page
          .getByRole("option", { name: fixture.taskTitle, exact: true })
          .click();
        await brushCreate.getByLabel("内容").fill(fixture.brushCreateContent);
        await brushCreate.getByLabel("预期输出").fill("P6 UI 桌面创建预期产出");
        await brushCreate.getByRole("button", { name: "创建", exact: true }).click();
        await expect(page.getByText("已创建投入记录")).toBeVisible();
        await expect(page.getByTestId("time-canvas-creation-range")).toHaveCount(0);
        await expect.poll(() => prisma.workSegment.findFirst({
          where: {
            personId: fixture.member.person.id,
            content: fixture.brushCreateContent,
          },
          select: { taskId: true, expectedOutput: true },
        })).toEqual({
          taskId: fixture.taskId,
          expectedOutput: "P6 UI 桌面创建预期产出",
        });
        await page.goto(
          `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
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
        await page.waitForTimeout(800);
        const confirmableSegment = page.getByTestId(
          `segment-block-${fixture.confirmableSegmentId}`,
        );
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
        await quickCreate.getByLabel("预期输出").fill("P6 UI 移动端创建预期产出");
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
            select: { expectedOutput: true },
          }))
          .toEqual({ expectedOutput: "P6 UI 移动端创建预期产出" });
        await expect(
          page.getByRole("button", {
            name: new RegExp(fixture.mobileCreateContent),
          }),
        ).toBeVisible();
        const confirmableSegment = page.getByTestId(
          `segment-block-${fixture.confirmableSegmentId}`,
        );
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
      await expect(commonInspector.getByText("类型", { exact: true })).toBeVisible();
      await expect(commonInspector.getByText("状态", { exact: true })).toBeVisible();
      await expect(commonInspector.getByText("所属人员", { exact: true })).toBeVisible();
      await expect(commonInspector.getByText("关联 Task", { exact: true })).toBeVisible();
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
      await page.getByRole("button", { name: "完整确认", exact: true }).click();
      await expect(page.getByText("已完整确认并生成 Actual")).toBeVisible();
      await expect
        .poll(async () => {
          const row = await prisma.workSegment.findUniqueOrThrow({
            where: { id: fixture.confirmableSegmentId },
            select: { status: true },
          });
          return row.status;
        })
        .toBe("CONFIRMED");
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
      await loginAsTestUser(context, baseURL, {
        openId: fixture.outsider.openId,
        name: fixture.outsider.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await expect(
        page
          .getByTestId("task-workbench-v2")
          .getByRole("heading", { name: fixture.taskTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
      await expect(page.getByRole("button", { name: "修改 Task 基本信息" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "发起 Revision" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "提交验收" })).toHaveCount(0);
      await expectHealthyPage(page);

      await page.goto("/progress/notifications");
      await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
      await expect(page.getByText("P6 UI 通知")).toHaveCount(0);
      await expect(
        markInAppNotificationReadService(actor(fixture.outsider), {
          notificationId: fixture.notificationId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
      await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
      await expect(page.getByLabel("工作指标")).toBeVisible();
      await expect(page.getByTestId("action-inbox")).toHaveCount(0);
      await expectHealthyPage(page);

      await page.goto("/progress/approvals");
      await expect(page.getByRole("heading", { name: "待办与审批" })).toBeVisible();
      await expect(page.getByText("当前没有需要你处理的事项。")).toBeVisible();

      await page.goto("/progress/notifications");
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
    await expect(page.getByRole("heading", { name: "待办与审批" })).toBeVisible();
    await expect(page.getByTestId("action-inbox")).toBeVisible();
    await expect(page.getByText("任务结束确认", { exact: true })).toBeVisible();
    await expect(page.getByText("结束节点：所有 Milestone 完成并完成总结")).toBeVisible();
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
});
