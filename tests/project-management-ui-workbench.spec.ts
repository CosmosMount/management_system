// @playwright-project ui
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { formatDateTime } from "../lib/project-management/labels";
import { createTimeScale } from "../lib/project-management/time-canvas/time-math";
import {
  activateTask,
  approveRevision,
  createRevision,
  createTaskDraft,
  rejectRevision,
  reviewMilestone,
  submitMilestoneForReview,
} from "../lib/project-management/application/lifecycle-service";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

import {
  actor,
  createAccountPerson,
  createDraftWorkbenchFixture,
  createUiFixture,
  grantRole,
  milestoneInput,
  terminationInput,
} from "./helpers/project-management-ui-fixtures";
import { openTaskComposerDisclosure, updateDraftMetadataThroughCurrentInterface } from "./helpers/project-management-plan-mutation-fixtures";

async function revealTaskArea(page: Page, name: "节点执行" | "计划与投入" | "风险与讨论" | "活动记录") {
  const areas = { "节点执行": "task-execution-view", "计划与投入": "task-plan-view", "风险与讨论": "task-collaboration-view", "活动记录": "task-activity-view" };
  const area = page.getByTestId(areas[name]);
  await expect(area).toBeVisible();
  await area.scrollIntoViewIfNeeded();
}

async function selectExecutionNode(page: Page, name: RegExp) {
  const node = page.getByTestId("task-plan-node-navigator").getByRole("button", { name });
  await node.click();
  await expect(node).toHaveAttribute("aria-pressed", "true");
  await page.locator("#task-selected-node-detail").scrollIntoViewIfNeeded();
}

test.describe("project management UI project-management-ui-workbench", () => {
  test.beforeAll(async () => {
      const administrator = await createAccountPerson(
        `S5 UI Global Approval Administrator ${randomUUID()}`,
      );
      await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
    });

  test("server-rendered Task workbench shows timeline and all panels without client JavaScript", async ({
      browser,
      baseURL,
    }, testInfo) => {
      if (!baseURL) throw new Error("无脚本回归缺少 Playwright baseURL");
      const owner = await createAccountPerson(
        `P6 UI No-JS Owner ${testInfo.project.name} ${randomUUID()}`,
      );
      const task = await createTaskDraft(actor(owner), {
        title: `P6 UI No-JS Task ${randomUUID()}`,
        description: "验证客户端脚本加载失败时的工作台导航",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: owner.person.id, role: "OWNER" }],
        milestones: [milestoneInput("No-JS Milestone", "完成无脚本回归", 1)],
        plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
        termination: terminationInput(5),
        idempotencyKey: `p6-ui-no-js-${randomUUID()}`,
      });
      await activateTask(actor(owner), {
        taskId: task.taskId,
        expectedLockVersion: task.lockVersion,
      });

      const context = await browser.newContext({
        baseURL,
        javaScriptEnabled: false,
        viewport:
          testInfo.project.name === "mobile"
            ? { width: 393, height: 727 }
            : { width: 1_440, height: 1_000 },
      });
      try {
        await loginAsTestUser(context, baseURL, {
          openId: owner.openId,
          name: owner.person.displayName,
        });
        const page = await context.newPage();
        await page.goto(`/progress/tasks/${task.taskId}`);
        await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
        await expect(page.getByTestId("task-execution-view")).toBeVisible();
        await expect(page.getByTestId("time-canvas-root")).toBeVisible();
        await expect(page.getByRole("heading", { name: "No-JS Milestone" })).toBeVisible();
        await revealTaskArea(page, "计划与投入");

        await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
        await expect(page.getByTestId("time-canvas-root")).toBeVisible();
        await revealTaskArea(page, "风险与讨论");

        await expect(page.getByRole("heading", { name: "任务风险", exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: "任务评论", exact: true })).toBeVisible();
        await expect(page.getByLabel("风险内容")).toBeVisible();
        await revealTaskArea(page, "活动记录");

        await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
        await revealTaskArea(page, "节点执行");

        await expect(page.getByRole("heading", { name: "No-JS Milestone" })).toBeVisible();
        await expect(page.getByTestId("time-canvas-root")).toBeVisible();
        await expect(page.getByRole("tab")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

  test("Revision nodes toggle cached read-only base-plan rows in the Task timeline", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const fixture = await createUiFixture();
    const firstReason = `第一次计划调整 ${randomUUID()}`;
    const secondReason = `第二次计划调整 ${randomUUID()}`;
    const firstTaskState = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const originalTerminalEntry = await prisma.planVersionNode.findFirstOrThrow({
      where: {
        planVersionId: firstTaskState.currentPlanVersionId,
        node: { type: "TERMINATION" },
      },
      select: {
        node: { select: { termination: { select: { id: true } } } },
      },
    });
    if (!originalTerminalEntry.node.termination) {
      throw new Error("Revision 历史 UI fixture 缺少 Terminal");
    }
    await prisma.terminationNode.update({
      where: { id: originalTerminalEntry.node.termination.id },
      data: { plannedAt: new Date("2035-08-05T12:00:00.000Z") },
    });
    await prisma.workSegment.update({
      where: { id: fixture.confirmableSegmentId },
      data: {
        startAt: new Date("2026-10-29T09:00:00.000Z"),
        endAt: new Date("2026-10-29T10:00:00.000Z"),
      },
    });
    const firstRevision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: firstTaskState.currentPlanVersionId,
      baseTaskLockVersion: firstTaskState.lockVersion,
      reason: firstReason,
      description: "第一次调整后的候选计划",
      revisionAt: new Date(Date.UTC(2026, 6, 31, 12, 0, 0)).toISOString(),
      replacementMilestones: [
        milestoneInput("第一次调整后的 Milestone", "完成第一次调整", 3),
      ],
      termination: terminationInput(6),
      idempotencyKey: `revision-history-ui-first-${randomUUID()}`,
    });
    await approveRevision(actor(fixture.admin), {
      revisionNodeId: firstRevision.revisionNodeId,
      comment: "批准第一次调整",
    });
    const secondTaskState = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const secondRevision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: secondTaskState.currentPlanVersionId,
      baseTaskLockVersion: secondTaskState.lockVersion,
      reason: secondReason,
      description: "第二次调整后的候选计划",
      revisionAt: new Date(Date.UTC(2026, 7, 1, 12, 0, 0)).toISOString(),
      replacementMilestones: [
        milestoneInput("第二次调整后的 Milestone", "完成第二次调整", 4),
      ],
      termination: terminationInput(8),
      idempotencyKey: `revision-history-ui-second-${randomUUID()}`,
    });
    await approveRevision(actor(fixture.admin), {
      revisionNodeId: secondRevision.revisionNodeId,
      comment: "批准第二次调整",
    });

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(
      `/progress/tasks/${fixture.taskId}?center=${encodeURIComponent("2026-08-03T09:30:00.000Z")}`,
    );
    await revealTaskArea(page, "计划与投入");

    const firstCheckbox = page.getByRole("checkbox", {
      name: `显示计划修订「${firstReason}」之前的计划`,
    });
    const secondCheckbox = page.getByRole("checkbox", {
      name: `显示计划修订「${secondReason}」之前的计划`,
    });
    const firstSwitchTrack = firstCheckbox
      .locator("..")
      .locator('[data-slot="revision-history-switch-track"]');
    const secondSwitchTrack = secondCheckbox
      .locator("..")
      .locator('[data-slot="revision-history-switch-track"]');
    await expect(firstCheckbox).not.toBeChecked();
    await expect(secondCheckbox).not.toBeChecked();
    await expect(firstSwitchTrack).toBeVisible();
    await expect(secondSwitchTrack).toBeVisible();
    await expect(firstSwitchTrack).toHaveAttribute("data-state", "unchecked");
    await expect(secondSwitchTrack).toHaveAttribute("data-state", "unchecked");
    const secondCheckboxHandle = await secondCheckbox.elementHandle();
    if (!secondCheckboxHandle) {
      throw new Error("Revision 历史 UI fixture 缺少第二个复选框");
    }
    await expect(
      page.getByTestId(
        `time-canvas-row-header-history-plan:${firstRevision.revisionNodeId}`,
      ),
    ).toHaveCount(0);

    let releaseFirstRequest!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let markFirstRequestIntercepted!: () => void;
    const firstRequestIntercepted = new Promise<void>((resolve) => {
      markFirstRequestIntercepted = resolve;
    });
    let failFirstRevisionRequest = true;
    let historyRequestCount = 0;
    let historyActionId: string | null = null;
    let observePresentationNavigation = false;
    let presentationNavigationActionRequests = 0;
    const taskUrl = `**/progress/tasks/${fixture.taskId}**`;
    await page.route(taskUrl, async (route) => {
      const request = route.request();
      const nextAction = request.headers()["next-action"] ?? null;
      const actionRequestBody =
        request.method() === "POST" && nextAction
          ? request.postData()
          : null;
      if (
        !historyActionId &&
        nextAction &&
        actionRequestBody?.includes(firstRevision.revisionNodeId)
      ) {
        historyActionId = nextAction;
      }
      if (
        observePresentationNavigation &&
        request.method() === "POST" &&
        nextAction !== historyActionId
      ) {
        presentationNavigationActionRequests += 1;
      }
      if (!historyActionId || nextAction !== historyActionId) {
        await route.continue();
        return;
      }
      historyRequestCount += 1;
      if (historyRequestCount === 1) {
        markFirstRequestIntercepted();
        await firstRequestGate;
      }
      if (historyRequestCount === 1 && failFirstRevisionRequest) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await firstCheckbox.check();
    await firstRequestIntercepted;
    await expect(firstCheckbox).toBeChecked();
    await expect(firstCheckbox).toBeDisabled();
    await expect(firstSwitchTrack).toHaveAttribute("data-state", "checked");
    await expect(
      firstCheckbox.locator("..").getByText("正在加载修订前计划…"),
    ).toBeVisible();
    releaseFirstRequest();
    await expect(
      page.getByRole("alert").filter({
        hasText: "网络或服务暂时不可用，请重试。",
      }),
    ).toBeVisible();

    failFirstRevisionRequest = false;
    await page
      .getByRole("button", {
        name: `重新加载计划修订「${firstReason}」之前的计划`,
      })
      .click();
    const firstHistoryHeader = page.getByTestId(
      `time-canvas-row-header-history-plan:${firstRevision.revisionNodeId}`,
    );
    await expect(firstHistoryHeader).toContainText(
      `计划修订「${firstReason}」之前`,
    );
    await expect(firstHistoryHeader).toContainText("计划 v1");
    await expect(firstHistoryHeader.getByLabel("只读")).toBeVisible();
    await expect(firstHistoryHeader.getByRole("link")).toHaveCount(0);
    const firstHistoryRow = page.getByTestId(
      `timeline-row-history-plan:${firstRevision.revisionNodeId}`,
    );
    // The 2035 legacy Terminal must not expand the interactive canvas beyond
    // its supported three-year window or trigger out-of-range block requests.
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toHaveCount(0);
    const canvasRoot = page
      .getByTestId("resource-planner-workbench")
      .getByTestId("time-canvas-root");
    const presentationRange = await canvasRoot.evaluate((element) => ({
      startMs: Number(element.dataset.rangeStartMs),
      endMs: Number(element.dataset.rangeEndMs),
    }));
    expect(presentationRange.endMs - presentationRange.startMs).toBeLessThanOrEqual(
      3 * 366 * 24 * 60 * 60 * 1_000,
    );
    await page.waitForLoadState("networkidle");
    const urlBeforeHistoryNavigation = page.url();
    observePresentationNavigation = true;
    await page.getByRole("button", { name: "最新内容" }).click();
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toBeVisible();
    const remoteHistoryRange = await canvasRoot.evaluate((element) => ({
      startMs: Number(element.dataset.rangeStartMs),
      endMs: Number(element.dataset.rangeEndMs),
    }));
    expect(Date.parse("2035-08-05T12:00:00.000Z")).toBeGreaterThanOrEqual(
      remoteHistoryRange.startMs,
    );
    expect(Date.parse("2035-08-05T12:00:00.000Z")).toBeLessThan(
      remoteHistoryRange.endMs,
    );
    await page.getByRole("button", { name: "年", exact: true }).click();
    await expect(canvasRoot).toHaveAttribute("data-zoom", "YEAR");
    await page.waitForLoadState("networkidle");
    expect(presentationNavigationActionRequests).toBe(0);
    expect(page.url()).toBe(urlBeforeHistoryNavigation);
    observePresentationNavigation = false;
    await page.getByRole("button", { name: "最早内容" }).click();
    await expect(firstHistoryHeader).toBeVisible();
    await expect
      .poll(async () => {
        const range = await canvasRoot.evaluate((element) => ({
          startMs: Number(element.dataset.rangeStartMs),
          endMs: Number(element.dataset.rangeEndMs),
        }));
        const target = Date.parse("2026-10-29T09:30:00.000Z");
        return range.startMs <= target && target < range.endMs;
      })
      .toBe(true);

    await page.getByRole("button", { name: "最新内容" }).click();
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toBeVisible();
    const startNodeButton = page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /^开始节点，开始节点，/ });
    await startNodeButton.click();
    await expect(page.getByTestId("task-execution-view")).toBeVisible();
    await expect(page.getByTestId("task-plan-node-navigator").getByRole("button", { name: /开始节点/ })).toHaveAttribute("aria-pressed", "true");
    await revealTaskArea(page, "计划与投入");
    const currentPlanStartMarker = page.getByTestId(
      `milestone-marker-plan-start:${fixture.taskId}`,
    );
    await expect(startNodeButton).toHaveAttribute("aria-pressed", "true");
    await expect(currentPlanStartMarker).toBeVisible();
    await expect(currentPlanStartMarker).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => {
      const start = Number(
        await canvasRoot.getAttribute("data-viewport-start-ms"),
      );
      const end = Number(await canvasRoot.getAttribute("data-viewport-end-ms"));
      const plannedStart = Date.parse("2026-07-31T10:00:00.000Z");
      return start <= plannedStart && plannedStart < end;
    }).toBe(true);

    await page.getByRole("button", { name: "最新内容" }).click();
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toBeVisible();
    const firstRevisionNodeButton = page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: new RegExp(firstReason) });
    await firstRevisionNodeButton.click();
    await expect(page.locator("#task-selected-node-detail")).toContainText(firstReason);
    await revealTaskArea(page, "计划与投入");
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toHaveCount(0);
    await expect(firstRevisionNodeButton).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "最新内容" }).click();
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toBeVisible();
    await firstRevisionNodeButton.click();
    await expect(page.locator("#task-selected-node-detail")).toContainText(firstReason);
    await revealTaskArea(page, "计划与投入");
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toHaveCount(0);

    const urlBeforePopstate = page.url();
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("presentationHistoryProbe", "1");
      window.history.pushState({}, "", url);
    });
    await page.getByRole("button", { name: "最新内容" }).click();
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(urlBeforePopstate);
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toHaveCount(0);

    await page.getByTestId("time-canvas-scroll").evaluate((element) => {
      const root = element.closest<HTMLElement>(
        '[data-testid="time-canvas-root"]',
      );
      const rangeStart = Number(root?.dataset.rangeStartMs);
      const rangeEnd = Number(root?.dataset.rangeEndMs);
      const target = Date.parse("2026-10-29T09:30:00.000Z");
      const ratio = (target - rangeStart) / (rangeEnd - rangeStart);
      element.scrollLeft = Math.max(
        0,
        ratio * element.scrollWidth - element.clientWidth / 2,
      );
      element.dispatchEvent(new Event("scroll"));
    });
    const segmentBlock = page.getByTestId(
      `segment-block-${fixture.confirmableSegmentId}`,
    );
    await expect(segmentBlock).toBeVisible({ timeout: 30_000 });
    await segmentBlock.focus();
    await segmentBlock.press("Enter");
    const detailDialog = page.getByRole("dialog", { name: "投入详情" });
    const editForm = detailDialog.getByRole("form", {
      name: "编辑投入详情",
    });
    await expect(editForm).toBeVisible();
    const unsavedContent = `Revision 历史切换未保存内容 ${randomUUID()}`;
    await editForm.getByLabel("内容").fill(unsavedContent);

    const restoredBrowserCenter = "2026-09-10T09:00:00.000Z";
    await page.evaluate(
      ({ restoredCenter, newerCenter }) => {
        const restoredUrl = new URL(window.location.href);
        restoredUrl.searchParams.set("center", restoredCenter);
        restoredUrl.searchParams.set("scale", "week");
        window.history.pushState({}, "", restoredUrl);
        window.dispatchEvent(new PopStateEvent("popstate"));

        const newerUrl = new URL(window.location.href);
        newerUrl.searchParams.set("center", newerCenter);
        window.history.pushState({}, "", newerUrl);
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      {
        restoredCenter: restoredBrowserCenter,
        newerCenter: "2026-09-20T09:00:00.000Z",
      },
    );
    await expect(canvasRoot).toHaveAttribute("data-zoom", "WEEK");
    await page
      .getByTestId("task-plan-node-navigator")
      .locator("button")
      .filter({ hasText: firstReason })
      .evaluate((element) => {
        if (!(element instanceof HTMLButtonElement)) {
          throw new Error("Revision 节点控件不是按钮");
        }
        element.click();
      });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("center"))
      .toBe(restoredBrowserCenter);
    await expect.poll(async () => {
      const start = Number(
        await canvasRoot.getAttribute("data-viewport-start-ms"),
      );
      const end = Number(await canvasRoot.getAttribute("data-viewport-end-ms"));
      return Math.abs((start + end) / 2 - Date.parse(restoredBrowserCenter));
    }).toBeLessThan(12 * 60 * 60 * 1_000);

    await secondCheckboxHandle.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) {
        throw new Error("Revision 历史控件不是复选框");
      }
      element.click();
    });
    await expect(
      page.locator(
        '[data-slot="revision-history-switch-track"][data-state="checked"]',
      ),
    ).toHaveCount(2);
    const secondHistoryHeader = page.getByTestId(
      `time-canvas-row-header-history-plan:${secondRevision.revisionNodeId}`,
    );
    await expect(secondHistoryHeader).toContainText(
      `计划修订「${secondReason}」之前`,
    );
    await expect(secondHistoryHeader).toContainText("计划 v2");
    const historyHeaders = page.locator(
      '[data-testid^="time-canvas-row-header-history-plan:"]',
    );
    await expect(historyHeaders).toHaveCount(2);
    await expect(historyHeaders.nth(0)).toContainText(secondReason);
    await expect(historyHeaders.nth(1)).toContainText(firstReason);
    await expect(detailDialog).toBeVisible();
    await expect(editForm.getByLabel("内容")).toHaveValue(unsavedContent);

    let discardConfirmed = false;
    page.once("dialog", async (dialog) => {
      discardConfirmed = true;
      await dialog.accept();
    });
    await detailDialog.getByRole("button", { name: "Close" }).click();
    await expect.poll(() => discardConfirmed).toBe(true);
    await expect(detailDialog).toHaveCount(0);
    await expect.poll(async () => {
      const start = Number(
        await canvasRoot.getAttribute("data-viewport-start-ms"),
      );
      const end = Number(await canvasRoot.getAttribute("data-viewport-end-ms"));
      return Math.abs((start + end) / 2 - Date.parse(restoredBrowserCenter));
    }).toBeLessThan(12 * 60 * 60 * 1_000);

    await page.getByRole("button", { name: "最新内容" }).click();
    await expect(
      firstHistoryRow.getByRole("button", {
        name: /终止节点 Terminal.+状态 历史计划/,
      }),
    ).toBeVisible();
    await firstCheckbox.uncheck();
    await expect(firstSwitchTrack).toHaveAttribute("data-state", "unchecked");
    await expect(firstHistoryHeader).toHaveCount(0);
    await expect(secondHistoryHeader).toBeVisible();
    await expect
      .poll(async () => {
        const range = await canvasRoot.evaluate((element) => ({
          startMs: Number(element.dataset.rangeStartMs),
          endMs: Number(element.dataset.rangeEndMs),
        }));
        const target = Date.parse("2026-10-29T09:30:00.000Z");
        return range.startMs <= target && target < range.endMs;
      })
      .toBe(true);
    await firstCheckbox.focus();
    await expect(firstCheckbox).toBeFocused();
    await page.keyboard.press("Space");
    await expect(firstCheckbox).toBeChecked();
    await expect(firstSwitchTrack).toHaveAttribute("data-state", "checked");
    await expect(firstHistoryHeader).toBeVisible();
    expect(historyRequestCount).toBe(3);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await page.unroute(taskUrl);
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);
  });

  test("pending Revision automatically compares its candidate Plan before approval", async ({
    context,
    page,
    baseURL,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const fixture = await createUiFixture();
    const historicalRevisionReason = `已生效计划调整 ${randomUUID()}`;
    const revisionReason = `待审批计划对比 ${randomUUID()}`;
    const candidateMilestone = `修改后 Milestone ${randomUUID()}`;
    const initialTask = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const historicalRevision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: initialTask.currentPlanVersionId,
      baseTaskLockVersion: initialTask.lockVersion,
      reason: historicalRevisionReason,
      description: "用于验证候选 Plan 与历史 Plan 的稳定顺序",
      revisionAt: "2026-07-31T12:00:00.000Z",
      replacementMilestones: [
        milestoneInput("第一次修改后的 Milestone", "完成第一次修改", 3),
      ],
      termination: terminationInput(8),
      idempotencyKey: `revision-before-candidate-${randomUUID()}`,
    });
    await approveRevision(actor(fixture.admin), {
      revisionNodeId: historicalRevision.revisionNodeId,
      comment: "先形成一条可选历史计划",
    });
    const taskBefore = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: taskBefore.currentPlanVersionId,
      baseTaskLockVersion: taskBefore.lockVersion,
      reason: revisionReason,
      description: "审批人需要直接比较 Revision 修改前后的计划",
      revisionAt: "2026-08-01T12:00:00.000Z",
      replacementMilestones: [
        milestoneInput(candidateMilestone, "完成修改后的目标", 4),
      ],
      termination: terminationInput(9),
      idempotencyKey: `revision-candidate-timeline-${randomUUID()}`,
    });
    const targetPlan = await prisma.taskPlanVersion.findUniqueOrThrow({
      where: { id: revision.targetPlanVersionId ?? "" },
      select: { id: true, versionNo: true },
    });
    const candidateHeaderTestId =
      `time-canvas-row-header-revision-candidate:${revision.revisionNodeId}`;
    const candidateRowTestId =
      `timeline-row-revision-candidate:${revision.revisionNodeId}`;
    const historyHeaderTestId =
      `time-canvas-row-header-history-plan:${historicalRevision.revisionNodeId}`;

    await loginAsTestUser(context, baseURL, {
      openId: fixture.outsider.openId,
      name: fixture.outsider.person.displayName,
    });
    await page.goto(
      `/progress/tasks/${fixture.taskId}?center=${encodeURIComponent("2026-08-04T10:00:00.000Z")}&scale=month`,
    );
    const currentHeader = page.getByTestId(
      `time-canvas-row-header-plan:${fixture.taskId}`,
    );
    await revealTaskArea(page, "计划与投入");
    const candidateHeader = page.getByTestId(candidateHeaderTestId);
    const candidateRow = page.getByTestId(candidateRowTestId);
    await expect(currentHeader).toBeVisible();
    await expect(candidateHeader.getByRole("link")).toHaveCount(0);
    await expect(candidateHeader).toContainText(
      `计划修订「${revisionReason}」修改后`,
    );
    await expect(candidateHeader).toContainText(
      `计划 v${targetPlan.versionNo} · 待审批候选（只读）`,
    );
    await page
      .getByRole("checkbox", {
        name: `显示计划修订「${historicalRevisionReason}」之前的计划`,
      })
      .check();
    await expect(page.getByTestId(historyHeaderTestId)).toBeVisible();
    const rowHeaderIds = await page
      .locator('[data-testid^="time-canvas-row-header-"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-testid")),
      );
    expect(rowHeaderIds.indexOf(candidateHeaderTestId)).toBe(
      rowHeaderIds.indexOf(`time-canvas-row-header-plan:${fixture.taskId}`) + 1,
    );
    expect(rowHeaderIds.indexOf(historyHeaderTestId)).toBe(
      rowHeaderIds.indexOf(candidateHeaderTestId) + 1,
    );
    await expect(
      candidateRow.getByRole("button", {
        name: new RegExp(`计划节点 ${candidateMilestone}.+状态 待审批候选`),
      }),
    ).toBeVisible();
    await revealTaskArea(page, "节点执行");
    await expect(page.getByRole("heading", { name: "当前计划修订候选" })).toBeVisible();
    await expect(
      page
        .getByRole("heading", { name: "当前计划修订候选" })
        .locator("../..")
        .getByRole("button", { name: "批准" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(
      `/progress/tasks/${fixture.taskId}?center=${encodeURIComponent("2026-08-04T10:00:00.000Z")}&scale=month`,
    );
    const approvalCard = page
      .getByRole("heading", { name: "当前计划修订候选" })
      .locator("../..");
    await revealTaskArea(page, "计划与投入");
    await expect(page.getByTestId(candidateHeaderTestId)).toBeVisible();
    await revealTaskArea(page, "节点执行");
    await approvalCard.getByLabel("处理说明").fill("对比确认后批准候选计划");
    await approvalCard.getByRole("button", { name: "批准" }).click();
    await expect(page.getByText("计划修订已批准并应用。")).toBeVisible();
    await expect(page.getByTestId(candidateHeaderTestId)).toHaveCount(0);
    await revealTaskArea(page, "计划与投入");
    await expect(page.getByText(`当前计划 v${targetPlan.versionNo}`)).toBeVisible();
    await expect(
      page
        .getByTestId(`timeline-row-plan:${fixture.taskId}`)
        .getByRole("button", {
          name: new RegExp(`计划节点 ${candidateMilestone}`),
        }),
    ).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { currentPlanVersionId: true },
        }),
      )
      .toEqual({ currentPlanVersionId: targetPlan.id });
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);
  });

  test("invalid pending Revision comparison disables approval but keeps rejection available", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    const taskBefore = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: taskBefore.currentPlanVersionId,
      baseTaskLockVersion: taskBefore.lockVersion,
      reason: `失效基线 ${randomUUID()}`,
      description: "验证异常候选计划不会被误批",
      revisionAt: "2026-07-31T12:00:00.000Z",
      replacementMilestones: [
        milestoneInput("失效候选 Milestone", "不得被批准", 4),
      ],
      termination: terminationInput(9),
      idempotencyKey: `revision-invalid-comparison-${randomUUID()}`,
    });
    await prisma.revisionNode.update({
      where: { id: revision.revisionNodeId },
      data: { baseTaskLockVersion: taskBefore.lockVersion + 1 },
    });

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await revealTaskArea(page, "计划与投入");
    await expect(page.getByTestId("pending-revision-plan-warning")).toContainText(
      "基线已失效",
    );
    await revealTaskArea(page, "节点执行");
    await expect(page.getByTestId("revision-approval-plan-warning")).toContainText(
      "批准已禁用",
    );
    await expect(
      page.getByTestId(
        `time-canvas-row-header-revision-candidate:${revision.revisionNodeId}`,
      ),
    ).toHaveCount(0);
    const approvalCard = page
      .getByRole("heading", { name: "当前计划修订候选" })
      .locator("../..");
    await expect(
      approvalCard.getByRole("button", { name: "批准" }),
    ).toBeDisabled();
    await expect(
      approvalCard.getByRole("button", { name: "驳回" }),
    ).toBeEnabled();
    await approvalCard.getByLabel("处理说明").fill("候选计划基线失效，请重新提交");
    await approvalCard.getByRole("button", { name: "驳回" }).click();
    await expect(page.getByText("计划修订已驳回。")).toBeVisible();
    await expect(page.getByTestId("pending-revision-plan-warning")).toHaveCount(0);
    await expect
      .poll(() =>
        prisma.revisionNode.findUnique({
          where: { id: revision.revisionNodeId },
          select: { status: true },
        }),
      )
      .toEqual({ status: "REJECTED" });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);
  });

  test("completed Milestone details render empty, link, and unsafe material states", async ({
    context,
    page,
    baseURL,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const admin = await createAccountPerson(
      `P6 Completed Material Admin ${randomUUID()}`,
    );
    const owner = await createAccountPerson(
      `P6 Completed Material Owner ${randomUUID()}`,
    );
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

    const createCompletedTask = async ({
      label,
      evidences,
    }: {
      label: string;
      evidences: Array<
        | { kind: "TEXT"; note: string }
        | { kind: "LINK"; externalUrl: string; note?: string }
      >;
    }) => {
      const draft = await createTaskDraft(actor(owner), {
        title: `P6 ${label} ${randomUUID()}`,
        description: `验证${label}`,
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: owner.person.id, role: "OWNER" }],
        milestones: [milestoneInput(label, `完成${label}`, 1)],
        plannedStartAt: new Date(
          Date.UTC(2026, 6, 31, 10, 0, 0),
        ).toISOString(),
        termination: terminationInput(5),
        idempotencyKey: `p6-completed-material-${randomUUID()}`,
      });
      await activateTask(actor(owner), {
        taskId: draft.taskId,
        expectedLockVersion: draft.lockVersion,
      });
      const activeTask = await prisma.task.findUniqueOrThrow({
        where: { id: draft.taskId },
        select: { activeMilestoneNodeId: true },
      });
      if (!activeTask.activeMilestoneNodeId) {
        throw new Error("完成材料 UI fixture 缺少 Active Milestone");
      }
      const submitted = await submitMilestoneForReview(actor(owner), {
        milestoneNodeId: activeTask.activeMilestoneNodeId,
        idempotencyKey: `p6-completed-review-${randomUUID()}`,
        evidences,
      });
      await reviewMilestone(actor(admin), {
        reviewId: submitted.reviewId,
        result: "APPROVED",
      });
      return {
        taskId: draft.taskId,
        milestoneLabel: label,
        milestoneNodeId: activeTask.activeMilestoneNodeId,
        reviewId: submitted.reviewId,
      };
    };

    const emptyTask = await createCompletedTask({
      label: "空验收材料 Milestone",
      evidences: [],
    });
    const linkTask = await createCompletedTask({
      label: "链接验收材料 Milestone",
      evidences: [
        {
          kind: "LINK",
          externalUrl: "https://example.com/completed-evidence",
          note: "安全链接说明",
        },
      ],
    });
    await prisma.reviewEvidence.create({
      data: {
        reviewId: linkTask.reviewId,
        kind: "LINK",
        externalUrl: "javascript:alert('unsafe')",
        note: "历史不安全链接",
        sortOrder: 1,
      },
    });

    await loginAsTestUser(context, baseURL, {
      openId: owner.openId,
      name: owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${emptyTask.taskId}`);
    let releaseFailedRequest!: () => void;
    const failedRequestGate = new Promise<void>((resolve) => {
      releaseFailedRequest = resolve;
    });
    let markRequestIntercepted!: () => void;
    const requestIntercepted = new Promise<void>((resolve) => {
      markRequestIntercepted = resolve;
    });
    let failCompletionRequests = true;
    const emptyTaskUrl = (url: URL) => url.pathname === `/progress/tasks/${emptyTask.taskId}`;
    await page.route(emptyTaskUrl, async (route) => {
      const request = route.request();
      const isCompletionAction =
        request.method() === "POST" &&
        Boolean(request.headers()["next-action"]) &&
        request.postData()?.includes(emptyTask.milestoneNodeId);
      if (!isCompletionAction || !failCompletionRequests) {
        await route.continue();
        return;
      }
      markRequestIntercepted();
      await failedRequestGate;
      await route.abort("failed");
    });
    await selectExecutionNode(page, new RegExp(emptyTask.milestoneLabel));
    await requestIntercepted;
    const emptyMaterials = page.getByTestId("milestone-completion-evidences");
    await expect(emptyMaterials.getByRole("status")).toHaveText(
      "正在加载实际提交材料…",
    );
    releaseFailedRequest();
    await expect(emptyMaterials.getByRole("alert")).toHaveText(
      "网络或服务暂时不可用，请重试。",
    );
    failCompletionRequests = false;
    await emptyMaterials.getByRole("button", { name: "重新加载材料" }).click();
    await expect(emptyMaterials).toContainText(
      "本次验收未提交材料。",
    );
    await page.unroute(emptyTaskUrl);
    await expectHealthyPage(page);

    await page.goto(`/progress/tasks/${linkTask.taskId}`);
    await selectExecutionNode(page, new RegExp(linkTask.milestoneLabel));
    const materials = page.getByTestId("milestone-completion-evidences");
    const safeLink = materials.getByRole("link", {
      name: "https://example.com/completed-evidence",
    });
    await expect(safeLink).toHaveAttribute(
      "href",
      "https://example.com/completed-evidence",
    );
    await expect(safeLink).toHaveAttribute("target", "_blank");
    await expect(safeLink).toHaveAttribute("rel", "noreferrer");
    await expect(materials).toContainText("安全链接说明");
    await expect(materials).toContainText("链接不可用");
    await expect(materials).toContainText("历史不安全链接");
    await expect(materials.getByRole("link")).toHaveCount(1);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);
  });

  test("pending Milestone approval shows link, empty, and legacy file evidence to reviewers and submitters", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const admin = await createAccountPerson(
      `P6 Pending Material Admin ${randomUUID()}`,
    );
    const owner = await createAccountPerson(
      `P6 Pending Material Owner ${randomUUID()}`,
    );
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

    const createPendingTask = async ({
      label,
      evidences,
    }: {
      label: string;
      evidences: Array<
        | { kind: "TEXT"; note: string }
        | { kind: "LINK"; externalUrl: string; note?: string }
      >;
    }) => {
      const draft = await createTaskDraft(actor(owner), {
        title: `P6 待审批材料 ${label} ${randomUUID()}`,
        description: `验证待审批${label}`,
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: owner.person.id, role: "OWNER" }],
        milestones: [milestoneInput(label, `完成${label}`, 1)],
        plannedStartAt: new Date(
          Date.UTC(2026, 6, 31, 10, 0, 0),
        ).toISOString(),
        termination: terminationInput(5),
        idempotencyKey: `p6-pending-material-${randomUUID()}`,
      });
      await activateTask(actor(owner), {
        taskId: draft.taskId,
        expectedLockVersion: draft.lockVersion,
      });
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: draft.taskId },
        select: { activeMilestoneNodeId: true },
      });
      if (!task.activeMilestoneNodeId) {
        throw new Error("待审批材料 UI fixture 缺少 Active Milestone");
      }
      const submitted = await submitMilestoneForReview(actor(owner), {
        milestoneNodeId: task.activeMilestoneNodeId,
        idempotencyKey: `p6-pending-review-${randomUUID()}`,
        evidences,
      });
      return { taskId: draft.taskId, reviewId: submitted.reviewId };
    };

    const emptyTask = await createPendingTask({
      label: "空验收证据 Milestone",
      evidences: [],
    });
    const longLinkNote = `安全链接说明${"很长的补充内容".repeat(100)}`;
    const linkTask = await createPendingTask({
      label: "链接验收证据 Milestone",
      evidences: [
        {
          kind: "LINK",
          externalUrl: "https://example.com/pending-evidence",
          note: longLinkNote,
        },
      ],
    });
    const legacyFileAsset = await prisma.fileAsset.create({
      data: {
        publicPath: `/uploads/project-management-evidence/${randomUUID()}.txt`,
        storagePath: `project-management-evidence/${randomUUID()}.txt`,
        kind: "TEMP_UPLOAD",
        mimeType: "text/plain",
        size: 128,
        ownerOpenId: owner.openId,
      },
    });
    await prisma.reviewEvidence.createMany({
      data: [
        {
          reviewId: linkTask.reviewId,
          kind: "LINK",
          externalUrl: "javascript:alert('unsafe')",
          note: "历史不安全待审批链接",
          sortOrder: 1,
        },
        {
          reviewId: linkTask.reviewId,
          kind: "FILE",
          fileAssetId: legacyFileAsset.id,
          note: `历史文件材料${"无法在线查看".repeat(100)}`,
          sortOrder: 2,
        },
      ],
    });

    await loginAsTestUser(context, baseURL, {
      openId: owner.openId,
      name: owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${linkTask.taskId}`);
    const submitterMaterials = page.getByTestId(
      "milestone-pending-review-evidences",
    );
    await expect(
      submitterMaterials.getByRole("heading", { name: "本次提交材料" }),
    ).toBeVisible();
    const safeLink = submitterMaterials.getByRole("link", {
      name: "https://example.com/pending-evidence",
    });
    await expect(safeLink).toHaveAttribute(
      "href",
      "https://example.com/pending-evidence",
    );
    await expect(safeLink).toHaveAttribute("target", "_blank");
    await expect(safeLink).toHaveAttribute("rel", "noreferrer");
    await expect(submitterMaterials).toContainText(longLinkNote);
    await expect(submitterMaterials).toContainText("链接不可用");
    await expect(submitterMaterials).toContainText("历史不安全待审批链接");
    await expect(submitterMaterials).toContainText("文件材料当前不可查看");
    await expect(submitterMaterials).toContainText("历史文件材料");
    await expect(submitterMaterials.getByRole("link")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "通过", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);

    await loginAsTestUser(context, baseURL, {
      openId: admin.openId,
      name: admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${linkTask.taskId}`);
    const reviewerMaterials = page.getByTestId(
      "milestone-pending-review-evidences",
    );
    await expect(reviewerMaterials).toContainText(longLinkNote);
    await expect(page.getByLabel("审批说明")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "通过", exact: true }),
    ).toBeVisible();

    await page.goto(`/progress/tasks/${emptyTask.taskId}`);
    const emptyMaterials = page.getByTestId(
      "milestone-pending-review-evidences",
    );
    await expect(emptyMaterials).toContainText("未提交验收证据。");
    await expect(emptyMaterials.getByRole("list")).toHaveCount(0);
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);
  });

  test("Task workbench uses the unified Draft editor and locks it after activation", async ({
      context,
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await createDraftWorkbenchFixture();
      const addedMember = await createAccountPerson(
        `S6 Unified Editor Member ${randomUUID()}`,
      );
      const inactiveCurrentMember = await createAccountPerson(
        "S6 Unified Editor Inactive Member",
      );
      await prisma.taskMember.create({
        data: {
          taskId: fixture.taskId,
          personId: inactiveCurrentMember.person.id,
          role: "PARTICIPANT",
          createdByAccountId: fixture.admin.account.id,
        },
      });
      await prisma.person.update({
        where: { id: inactiveCurrentMember.person.id },
        data: { status: "INACTIVE" },
      });
      const updatedTitle = `S6 Unified Edited ${randomUUID()}`;
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
      await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
      await expect(page.getByTestId("task-execution-view")).toBeVisible();
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
      await revealTaskArea(page, "计划与投入");
      await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
      const taskTimelineHeader = page.getByTestId(
        `time-canvas-row-header-plan:${fixture.taskId}`,
      );
      await expect(
        taskTimelineHeader.getByRole("link", {
          name: fixture.taskTitle,
          exact: true,
        }),
      ).toHaveAttribute("href", `/progress/tasks/${fixture.taskId}`);
      await expect(
        page
          .getByTestId(
            `time-canvas-row-header-person:${fixture.owner.person.id}`,
          )
          .getByRole("link"),
      ).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "编辑草稿计划" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "编辑任务" })).toBeVisible();
      await expect(page.getByRole("button", { name: "修改任务基本信息" })).toHaveCount(0);

      await page.getByRole("link", { name: "编辑任务" }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByRole("heading", { name: "编辑任务" })).toBeVisible();
      await expect(page.getByTestId("task-composer")).toHaveAttribute(
        "data-composer-mode",
        "EDIT_DRAFT",
      );
      await expect(page.getByLabel("任务名称")).toHaveValue(fixture.taskTitle);
      await expect(page.getByText(inactiveCurrentMember.person.displayName)).toBeVisible();
      await expect(page.getByRole("button", { name: "保存任务" }).first()).toBeDisabled();
      if (testInfo.project.name === "mobile") {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      } else {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      }
      await expect(page.getByRole("button", { name: "保存任务" }).first()).toBeDisabled();

      await openTaskComposerDisclosure(page, "补充说明与优先级");
      await page.getByLabel("描述").fill("会被撤销的本地修改");
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await page.getByRole("button", { name: "撤销" }).click();
      await expect(page.getByLabel("描述")).toHaveValue("S6 Draft 工作台测试");
      await expect(page.getByRole("button", { name: "保存任务" }).first()).toBeDisabled();
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).every(
              (key) => !key.startsWith("task-edit-draft:") || !key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(
        new RegExp(`/progress/tasks/${fixture.taskId}(?:\\?.*)?$`),
      );
      await page.getByRole("link", { name: "编辑任务" }).click();
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toHaveCount(0);

      await page.getByLabel("任务名称").fill(updatedTitle);
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      const editDraftStorageKey = await page.evaluate((taskId) =>
        Object.keys(window.localStorage).find(
          (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
        ) ?? null,
      fixture.taskId);
      expect(editDraftStorageKey).not.toBeNull();
      await page.reload();
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByLabel("任务名称")).toHaveValue(updatedTitle);

      await page.getByLabel("搜索参与人员", { exact: true }).fill(addedMember.person.displayName);
      await page
        .getByRole("option", {
          name: addedMember.person.displayName,
          exact: true,
        })
        .click();

      if (testInfo.project.name === "mobile") {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      } else {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      }
      await page.getByLabel("目标").fill("S6 Draft 持久化目标");
      await page.getByRole("button", { name: "添加里程碑", exact: true }).first().click();
      const draftInspector = page.getByTestId("task-composer-inspector");
      await draftInspector
        .getByRole("textbox", { name: /^目标/ })
        .fill("S6 新增 Milestone");
      await draftInspector
        .getByRole("textbox", { name: /^完成条件/ })
        .fill("新增节点保存到数据库");
      await draftInspector
        .getByRole("textbox", { name: /^验收要求/ })
        .fill("提交文本证据");
      await page.getByLabel("预期完成时间").fill("2026-08-03T18:00");
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
      await page.getByLabel("结束节点名称").fill("S6 Edited Terminal");
      await page.getByRole("button", { name: "保存任务" }).first().click();
      await page.getByRole("dialog", { name: "任务已保存" }).getByRole("button", { name: "暂不激活", exact: true }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => {
          const task = await prisma.task.findUniqueOrThrow({
            where: { id: fixture.taskId },
            include: {
              currentPlanVersion: {
                include: {
                  nodes: {
                    include: {
                      node: { include: { milestone: true, termination: true } },
                    },
                  },
                },
              },
              members: { where: { removedAt: null } },
            },
          });
          return {
            title: task.title,
            lockVersion: task.lockVersion,
            memberIds: task.members.map((member) => member.personId),
            milestones: task.currentPlanVersion.nodes
              .flatMap((entry) => entry.node.milestone?.goal ?? [])
              .sort(),
            terminal: task.currentPlanVersion.nodes.find(
              (entry) => entry.node.termination,
            )?.node.termination?.name,
          };
        })
        .toEqual({
          title: updatedTitle,
          lockVersion: 1,
          memberIds: expect.arrayContaining([addedMember.person.id]),
          milestones: [
            "S6 Draft 持久化目标",
            "S6 Draft 第二阶段",
            "S6 新增 Milestone",
          ].sort(),
          terminal: "S6 Edited Terminal",
        });
      expect(
        await page.evaluate((key) => key ? window.localStorage.getItem(key) : null, editDraftStorageKey),
      ).toBeNull();

      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "激活任务" }).click();
      await expect(page.getByText("任务已激活。")).toBeVisible();
      await expect(page.getByRole("button", { name: "修改任务基本信息" })).toBeVisible();
      await expect(page.getByRole("link", { name: "编辑任务" })).toHaveCount(0);
      await expect
        .poll(() =>
          prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { status: true, lockVersion: true },
          }),
        )
        .toEqual({ status: "ACTIVE", lockVersion: 2 });
      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expectHealthyPage(page);
    });

  test("Draft defers OWNER completeness while Active member validation remains strict", async ({
      context,
      page,
      baseURL,
    }) => {
      const browserErrors: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
      });
      const editor = await createAccountPerson(
        `S6 Member Group Validation ${randomUUID()}`,
      );
      await grantRole(editor.account.id, "PROJECT_ADMINISTRATOR");
      const task = await createTaskDraft(actor(editor), {
        title: `S6 Member Group Task ${randomUUID()}`,
        description: "验证成员集合错误不会错误标红角色搜索框",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: editor.person.id, role: "OWNER" }],
        milestones: [],
        plannedStartAt: new Date(Date.UTC(2026, 7, 1, 10, 0, 0)).toISOString(),
        termination: terminationInput(5),
        idempotencyKey: `s6-member-group-${randomUUID()}`,
      });
      await loginAsTestUser(context, baseURL, {
        openId: editor.openId,
        name: editor.person.displayName,
      });

      await page.goto(`/progress/tasks/${task.taskId}/edit`);
      await openTaskComposerDisclosure(page, "补充说明与优先级");
      await page
        .getByLabel("描述", { exact: true })
        .fill("验证 DRAFT 成员集合错误不会错误标红角色搜索框");
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(window.localStorage).find((key) =>
              key.startsWith("task-edit-draft:"),
            ) ?? null,
          ),
        )
        .not.toBeNull();
      await page.evaluate((personId) => {
        const storageKey = Object.keys(window.localStorage).find((key) =>
          key.startsWith("task-edit-draft:"),
        );
        if (!storageKey) throw new Error("DRAFT 成员集合回归缺少本地草稿 key");
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) throw new Error("DRAFT 成员集合回归缺少本地草稿内容");
        const draft = JSON.parse(raw) as {
          savedAt: string;
          task: { members: Array<{ personId: string; role: string }> };
        };
        draft.savedAt = new Date().toISOString();
        draft.task.members = [{ personId, role: "PARTICIPANT" }];
        window.localStorage.setItem(storageKey, JSON.stringify(draft));
      }, editor.person.id);
      await page.reload();
      await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      const draftMembers = page.locator("#members");
      const draftOwnerPicker = page.getByLabel("搜索负责人", { exact: true });
      const draftParticipantPicker = page.getByLabel("搜索参与人员", {
        exact: true,
      });
      await expect(draftMembers).not.toHaveAttribute("aria-describedby");
      const draftMemberError = page
        .getByRole("alert")
        .filter({ hasText: "至少需要一名负责人" });
      await expect(draftMemberError).toHaveCount(0);
      await expect(draftOwnerPicker).not.toHaveAttribute("aria-invalid", "true");
      await expect(draftParticipantPicker).not.toHaveAttribute(
        "aria-invalid",
        "true",
      );
      await page.getByRole("button", { name: "保存任务" }).first().click();
      await page.getByRole("dialog", { name: "任务已保存" }).getByRole("button", { name: "暂不激活", exact: true }).click();
      await expect(page).toHaveURL(`/progress/tasks/${task.taskId}`);
      await expect
        .poll(() =>
          prisma.taskMember.findMany({
            where: { taskId: task.taskId, removedAt: null },
            select: { personId: true, role: true },
          }),
        )
        .toEqual([{ personId: editor.person.id, role: "PARTICIPANT" }]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);

      const savedTask = await prisma.task.findUniqueOrThrow({
        where: { id: task.taskId },
        select: { status: true, lockVersion: true, activeMilestoneNodeId: true },
      });
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "激活任务" }).click();
      await expect(
        page.getByRole("alert").filter({
          hasText: "激活 Task 前至少需要一名有效负责人",
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          prisma.task.findUnique({
            where: { id: task.taskId },
            select: { status: true, lockVersion: true, activeMilestoneNodeId: true },
          }),
        )
        .toEqual(savedTask);

      await page.goto(`/progress/tasks/${task.taskId}/edit`);
      const repairedOwnerPicker = page.getByLabel("搜索负责人", { exact: true });
      await repairedOwnerPicker.fill(editor.person.displayName);
      await page
        .getByRole("option", { name: editor.person.displayName, exact: true })
        .click();
      await page.getByRole("button", { name: "保存任务" }).first().click();
      await page.getByRole("dialog", { name: "任务已保存" }).getByRole("button", { name: "暂不激活", exact: true }).click();
      await expect(page).toHaveURL(`/progress/tasks/${task.taskId}`);
      await expect
        .poll(() =>
          prisma.taskMember.findMany({
            where: { taskId: task.taskId, removedAt: null },
            select: { personId: true, role: true },
          }),
        )
        .toEqual([{ personId: editor.person.id, role: "OWNER" }]);
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "激活任务" }).click();
      await expect(page.getByText("任务已激活。")).toBeVisible();
      await prisma.taskMember.updateMany({
        where: {
          taskId: task.taskId,
          personId: editor.person.id,
          removedAt: null,
        },
        data: { role: "PARTICIPANT" },
      });

      await page.goto(`/progress/tasks/${task.taskId}`);
      await page.getByRole("button", { name: "修改任务基本信息" }).click();
      const activeEditor = page.getByRole("dialog", {
        name: "修改任务基本信息",
      });
      const activeMembers = activeEditor.locator("#active-task-members");
      await expect(activeMembers).not.toHaveAttribute("aria-describedby");
      await activeEditor.getByRole("button", { name: "保存修改" }).click();

      const activeOwnerPicker = activeEditor.getByLabel("搜索负责人", {
        exact: true,
      });
      const activeParticipantPicker = activeEditor.getByLabel("搜索参与人员", {
        exact: true,
      });
      await expect(activeMembers).toBeFocused();
      const activeMemberError = activeEditor
        .getByRole("alert")
        .filter({ hasText: "至少需要一名负责人" });
      await expect(activeMemberError).toBeVisible();
      await expect(activeMembers).toHaveAttribute(
        "aria-describedby",
        (await activeMemberError.getAttribute("id")) ?? "",
      );
      await expect(activeOwnerPicker).not.toHaveAttribute("aria-invalid", "true");
      await expect(activeParticipantPicker).not.toHaveAttribute(
        "aria-invalid",
        "true",
      );

      await prisma.taskMember.updateMany({
        where: {
          taskId: task.taskId,
          personId: editor.person.id,
          removedAt: null,
        },
        data: { role: "OWNER" },
      });
      await activeOwnerPicker.fill(editor.person.displayName);
      await page
        .getByRole("option", { name: editor.person.displayName, exact: true })
        .click();
      await expect(activeMemberError).toHaveCount(0);
      await expect(activeMembers).not.toHaveAttribute("aria-describedby");
      await expect(
        activeEditor.getByRole("button", {
          name: `移除 ${editor.person.displayName} 参与人员`,
        }),
      ).toHaveCount(0);
      await activeEditor.getByRole("button", { name: "保存修改" }).click();
      await expect(activeEditor).toHaveCount(0);
      await expect
        .poll(() =>
          prisma.taskMember.findMany({
            where: { taskId: task.taskId, removedAt: null },
            select: { personId: true, role: true },
          }),
        )
        .toEqual([{ personId: editor.person.id, role: "OWNER" }]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      await expectHealthyPage(page);
      expect(browserErrors).toEqual([]);
    });

  test("Task Owner can delete an unactivated draft from the workbench", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();

      await loginAsTestUser(context, baseURL, {
        openId: fixture.reviewer.openId,
        name: fixture.reviewer.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await expect(page.getByRole("button", { name: "删除草稿" })).toHaveCount(0);

      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}`);
      const deleteButton = page.getByRole("button", { name: "删除草稿" });
      await expect(deleteButton).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toContain("确定删除这个任务草稿");
        await dialog.accept();
      });
      await deleteButton.click();
      await expect(page).toHaveURL("/progress/tasks");
      await expect
        .poll(() =>
          prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { deletedAt: true, lockVersion: true },
          }),
        )
        .toMatchObject({ deletedAt: expect.any(Date), lockVersion: 1 });
      await expect(
        prisma.domainAuditEvent.count({
          where: { taskId: fixture.taskId, action: "pm.task.draft.delete" },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.notificationOutbox.count({
          where: {
            eventKey: `pm:task:deleted:${fixture.taskId}:1:feishu`,
            type: "task_deleted",
            botKind: "notification",
          },
        }),
      ).resolves.toBe(1);
      const deletedResponse = await page.goto(`/progress/tasks/${fixture.taskId}`);
      expect(deletedResponse?.status()).toBe(404);
      await expectHealthyPage(page);
    });

  test("Draft editor omits unchanged members after a live ownership downgrade", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const replacementOwner = await createAccountPerson("S6 Replacement Draft Owner");
      const updatedTitle = `S6 Downgraded Draft Edited ${randomUUID()}`;
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByLabel("搜索负责人", { exact: true })).toBeVisible();
      await expect(page.getByLabel("搜索参与人员", { exact: true })).toBeVisible();
      await prisma.taskMember.updateMany({
        where: {
          taskId: fixture.taskId,
          personId: fixture.owner.person.id,
          role: "OWNER",
          removedAt: null,
        },
        data: { role: "PARTICIPANT" },
      });
      await prisma.taskMember.create({
        data: {
          taskId: fixture.taskId,
          personId: replacementOwner.person.id,
          role: "OWNER",
          createdByAccountId: fixture.admin.account.id,
        },
      });

      await page.getByLabel("任务名称").fill(updatedTitle);
      await page.getByRole("button", { name: "保存任务" }).first().click();
      await page.getByRole("dialog", { name: "任务已保存" }).getByRole("button", { name: "暂不激活", exact: true }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => {
          const task = await prisma.task.findUniqueOrThrow({
            where: { id: fixture.taskId },
            select: {
              title: true,
              lockVersion: true,
              members: {
                where: { removedAt: null },
                select: { personId: true, role: true },
                orderBy: [{ personId: "asc" }, { role: "asc" }],
              },
            },
          });
          return task;
        })
        .toEqual({
          title: updatedTitle,
          lockVersion: 1,
          members: [
            { personId: fixture.owner.person.id, role: "PARTICIPANT" },
            { personId: fixture.reviewer.person.id, role: "PARTICIPANT" },
            { personId: replacementOwner.person.id, role: "OWNER" },
          ].sort((left, right) =>
            left.personId.localeCompare(right.personId) ||
            left.role.localeCompare(right.role),
          ),
        });
      await expectHealthyPage(page);
    });

  test("Draft editor preserves stale local input without overwriting the server", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const serverTitle = `S6 Server Latest ${randomUUID()}`;
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await page.getByLabel("任务名称").fill("S6 尚未提交的本地版本");
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      const storageKey = await page.evaluate((taskId) =>
        Object.keys(window.localStorage).find(
          (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
        ) ?? null,
      fixture.taskId);
      expect(storageKey).not.toBeNull();

      await updateDraftMetadataThroughCurrentInterface(actor(fixture.owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
        title: serverTitle,
        description: "服务端并发更新",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        relatedTaskId: null,
      });
      await page.getByRole("button", { name: "保存任务" }).first().click();
      await expect(
        page.getByText(
          "任务已在服务端更新，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。",
        ),
      ).toBeVisible();
      await expect(page.getByLabel("任务名称")).toHaveValue("S6 尚未提交的本地版本");
      await expect(page.getByRole("button", { name: "导出原始草稿" })).toBeVisible();
      await expect
        .poll(() =>
          prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { title: true, lockVersion: true },
          }),
        )
        .toEqual({ title: serverTitle, lockVersion: 1 });

      await page.reload();
      await expect(
        page.getByText("任务已在服务端更新，旧本地草稿不能直接覆盖最新版本。"),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "导出原始草稿" })).toBeVisible();
      await page.getByRole("button", { name: "放弃并加载最新版本" }).click();
      await expect(page.getByLabel("任务名称")).toHaveValue(serverTitle);
      expect(
        await page.evaluate(
          (key) => (key ? window.localStorage.getItem(key) : null),
          storageKey,
        ),
      ).toBeNull();
      await expectHealthyPage(page);
    });

  test("Draft editor keeps Participant members read-only and denies unauthorized direct access", async ({
      context,
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await createDraftWorkbenchFixture();
      const outsider = await createAccountPerson("S6 Unified Editor Outsider");
      const searchFillerKey = randomUUID();
      await prisma.person.createMany({
        data: Array.from({ length: 55 }, (_, index) => ({
          displayName: `000 S6 permission search filler ${String(index).padStart(2, "0")} ${searchFillerKey}`,
          status: "ACTIVE" as const,
        })),
      });
      const localOnlyMember = await createAccountPerson(
        `S6 Permission Downgrade Local Member ${randomUUID()}`,
      );
      const temporaryAdministrator = await prisma.systemRoleAssignment.create({
        data: {
          accountId: fixture.reviewer.account.id,
          role: "PROJECT_ADMINISTRATOR",
          team: "",
          techGroup: "",
        },
      });
      const participantTitle = `S6 Participant Edited ${randomUUID()}`;
      const memberIdsBefore = (
        await prisma.taskMember.findMany({
          where: { taskId: fixture.taskId, removedAt: null },
          select: { personId: true },
          orderBy: { personId: "asc" },
        })
      ).map((member) => member.personId);
      await loginAsTestUser(context, baseURL, {
        openId: fixture.reviewer.openId,
        name: fixture.reviewer.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      const memberPicker = page.getByLabel("搜索参与人员", { exact: true });
      await memberPicker.click();
      await memberPicker.press("ControlOrMeta+A");
      await memberPicker.pressSequentially(localOnlyMember.person.displayName);
      await page
        .getByRole("option", {
          name: localOnlyMember.person.displayName,
          exact: true,
        })
        .click();
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await prisma.systemRoleAssignment.update({
        where: { id: temporaryAdministrator.id },
        data: {
          revokedAt: new Date(),
          revokedByAccountId: fixture.reviewer.account.id,
        },
      });
      await page.reload();
      await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByText("你可以编辑任务内容和计划，成员与角色为只读。")).toBeVisible();
      await expect(page.getByLabel("搜索负责人", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("搜索参与人员", { exact: true })).toHaveCount(0);
      await expect(page.getByText(localOnlyMember.person.displayName)).toHaveCount(0);
      await page.getByLabel("任务名称").fill(participantTitle);
      if (testInfo.project.name === "mobile") {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      } else {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      }
      await page.getByLabel("目标").fill("S6 Participant 更新计划");
      await page.getByRole("button", { name: "保存任务" }).first().click();
      await page.getByRole("dialog", { name: "任务已保存" }).getByRole("button", { name: "暂不激活", exact: true }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => {
          const task = await prisma.task.findUniqueOrThrow({
            where: { id: fixture.taskId },
            include: {
              members: {
                where: { removedAt: null },
                select: { personId: true },
                orderBy: { personId: "asc" },
              },
            },
          });
          return {
            title: task.title,
            lockVersion: task.lockVersion,
            memberIds: task.members.map((member) => member.personId),
          };
        })
        .toEqual({
          title: participantTitle,
          lockVersion: 1,
          memberIds: memberIdsBefore,
        });

      await loginAsTestUser(context, baseURL, {
        openId: outsider.openId,
        name: outsider.person.displayName,
      });
      const response = await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      expect(response?.status()).toBe(404);
      await expect(page.getByTestId("task-composer")).toHaveCount(0);
    });

  test("Draft editor isolates local recovery across Tasks and accounts", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const secondTitle = `S6 Isolated Draft ${randomUUID()}`;
      const secondTask = await createTaskDraft(actor(fixture.admin), {
        title: secondTitle,
        description: "用于验证编辑草稿按 Task 隔离",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        relatedTaskId: null,
        members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
        milestones: [],
        plannedStartAt: new Date(Date.UTC(2026, 7, 10, 10, 0, 0)).toISOString(),
        termination: terminationInput(12),
        idempotencyKey: `s6-edit-isolation-${randomUUID()}`,
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await page.getByLabel("任务名称").fill("S6 Owner Task One Local Draft");
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await page.getByRole("button", { name: "返回任务工作台" }).click();
      await page.getByRole("button", { name: "保存本地草稿并离开" }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);

      await page.goto(`/progress/tasks/${secondTask.taskId}/edit`);
      await expect(page.getByLabel("任务名称")).toHaveValue(secondTitle);
      await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);

      await loginAsTestUser(context, baseURL, {
        openId: fixture.reviewer.openId,
        name: fixture.reviewer.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByLabel("任务名称")).toHaveValue(fixture.taskTitle);
      await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);

      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByLabel("任务名称")).toHaveValue(
        "S6 Owner Task One Local Draft",
      );
      await expectHealthyPage(page);
    });

  test("Task workbench quick create skips an inactive first member", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      await prisma.person.update({
        where: { id: fixture.owner.person.id },
        data: { status: "INACTIVE" },
      });
      await prisma.person.update({
        where: { id: fixture.admin.person.id },
        data: { status: "INACTIVE" },
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.reviewer.openId,
        name: fixture.reviewer.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await revealTaskArea(page, "计划与投入");
      await page.getByRole("button", { name: "新增投入", exact: true }).click();
      const quickCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(quickCreate.locator('input[name="personId"]')).toHaveValue(
        fixture.reviewer.person.id,
      );
      await expect(
        quickCreate.getByLabel("人员", { exact: true }),
      ).toHaveValue(fixture.reviewer.person.displayName);
      await quickCreate
        .getByLabel("人员", { exact: true })
        .fill(fixture.owner.person.displayName);
      await expect(page.getByText("没有匹配项。")).toBeVisible();
      await expect(
        page.getByRole("option", {
          name: new RegExp(fixture.owner.person.displayName),
        }),
      ).toHaveCount(0);
      await quickCreate.getByLabel("人员", { exact: true }).press("Escape");
      await expect(quickCreate.getByLabel("任务", { exact: true })).toHaveValue(
        fixture.taskTitle,
      );
      await expect(quickCreate.getByLabel("任务", { exact: true })).toHaveAttribute(
        "readonly",
        "",
      );
      await expect(quickCreate.locator('input[name="taskId"]')).toHaveValue(
        fixture.taskId,
      );
      await expectHealthyPage(page);
    });

  test("Task workbench expands its range for an earlier Planned and preserves the latest user viewport", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await revealTaskArea(page, "计划与投入");
    const canvasRoot = page
      .getByTestId("resource-planner-workbench")
      .getByTestId("time-canvas-root");
    const waitForUrlCenterToMatchCanvasViewport = async (): Promise<number> => {
      let synchronizedCenter = Number.NaN;
      await expect
        .poll(async () => {
          const sample = await canvasRoot.evaluate((element) => ({
            urlCenter: Date.parse(
              new URL(window.location.href).searchParams.get("center") ?? "",
            ),
            viewportEnd: Number(element.dataset.viewportEndMs),
            viewportStart: Number(element.dataset.viewportStartMs),
          }));
          if (
            !Number.isFinite(sample.urlCenter) ||
            !Number.isFinite(sample.viewportStart) ||
            !Number.isFinite(sample.viewportEnd)
          ) {
            return Number.POSITIVE_INFINITY;
          }
          synchronizedCenter = sample.urlCenter;
          return Math.abs(
            sample.urlCenter -
              (sample.viewportStart + sample.viewportEnd) / 2,
          );
        })
        .toBeLessThan(60 * 60 * 1_000);
      return synchronizedCenter;
    };
    await expect(canvasRoot).toHaveAttribute("data-zoom", "WEEK");
    await canvasRoot.getByRole("button", { name: "月", exact: true }).click();
    await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect(page).toHaveURL(/scale=month/);
    await canvasRoot.getByRole("button", { name: "今天", exact: true }).click();
    const monthScale = createTimeScale({
      range: {
        startMs: Number(await canvasRoot.getAttribute("data-range-start-ms")),
        endMs: Number(await canvasRoot.getAttribute("data-range-end-ms")),
      },
      viewportWidthPx: 1,
      zoom: "MONTH",
    });
    let centerBefore = Number.NaN;
    await expect
      .poll(() => {
        centerBefore = Date.parse(
          new URL(page.url()).searchParams.get("center") ?? "",
        );
        return Math.abs(centerBefore - Date.now());
      })
      .toBeLessThan(monthScale.msPerPixel / 2 + 5_000);
    const originalRangeStart = Number(
      await canvasRoot.getAttribute("data-range-start-ms"),
    );

    const content = `范围扩展 Planned ${randomUUID()}`;
    const horizontalScroller = page.getByLabel("时间轴横向滚动");
    await expect(horizontalScroller).toBeVisible();
    const scrollBefore = await horizontalScroller.evaluate((element) => ({
      left: element.scrollLeft,
      maximum: element.scrollWidth - element.clientWidth,
    }));
    expect(scrollBefore.maximum).toBeGreaterThan(80);
    const panKey =
      scrollBefore.left < scrollBefore.maximum / 2 ? "ArrowRight" : "ArrowLeft";
    await horizontalScroller.focus();
    await horizontalScroller.evaluate(
      (element, direction) => {
        element.scrollLeft += direction * 48;
      },
      panKey === "ArrowRight" ? 1 : -1,
    );
    expect(
      Date.parse(new URL(page.url()).searchParams.get("center") ?? ""),
    ).toBe(centerBefore);
    await expect
      .poll(async () =>
        Math.abs(
          (await horizontalScroller.evaluate((element) => element.scrollLeft)) -
            scrollBefore.left,
        ),
      )
      .toBeGreaterThan(20);
    await page.getByRole("button", { name: "新增投入", exact: true }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await expect
      .poll(() => {
        const center = Date.parse(
          new URL(page.url()).searchParams.get("center") ?? "",
        );
        return Math.abs(center - centerBefore);
      })
      .toBeGreaterThan(60 * 60 * 1_000);
    const centerAfterUserPan = Date.parse(
      new URL(page.url()).searchParams.get("center") ?? "",
    );
    const draftScrollBefore = await horizontalScroller.evaluate((element) => ({
      left: element.scrollLeft,
      maximum: element.scrollWidth - element.clientWidth,
    }));
    const draftPanKey =
      draftScrollBefore.left < draftScrollBefore.maximum / 2
        ? "ArrowRight"
        : "ArrowLeft";
    await horizontalScroller.focus();
    await horizontalScroller.evaluate(
      (element, direction) => {
        element.scrollLeft += direction * 48;
      },
      draftPanKey === "ArrowRight" ? 1 : -1,
    );
    await expect
      .poll(async () =>
        Math.abs(
          (await horizontalScroller.evaluate((element) => element.scrollLeft)) -
            draftScrollBefore.left,
        ),
      )
      .toBeGreaterThan(10);
    await expect
      .poll(() => {
        const center = Date.parse(
          new URL(page.url()).searchParams.get("center") ?? "",
        );
        return Math.abs(center - centerAfterUserPan);
      })
      .toBeGreaterThan(60 * 60 * 1_000);
    const centerAfterDraftPan =
      await waitForUrlCenterToMatchCanvasViewport();
    await quickCreate
      .getByLabel("开始", { exact: true })
      .fill("2025-06-01T09:00");
    await quickCreate
      .getByLabel("结束", { exact: true })
      .fill("2025-06-02T09:00");
    await quickCreate.getByLabel("内容", { exact: true }).fill(content);
    await quickCreate
      .getByRole("button", { name: "创建", exact: true })
      .click();

    await expect(page.getByText("已创建投入记录")).toBeVisible();
    const expandedStart = Date.parse("2025-04-01T00:00:00.000+08:00");
    await expect(canvasRoot).toHaveAttribute(
      "data-range-start-ms",
      String(expandedStart),
    );
    expect(originalRangeStart).toBeGreaterThan(expandedStart);
    await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect(page).toHaveURL(/scale=month/);
    const centerAfterRangeExpansion =
      await waitForUrlCenterToMatchCanvasViewport();
    expect(
      Math.abs(centerAfterRangeExpansion - centerAfterDraftPan),
    ).toBeLessThan(60 * 60 * 1_000);
    await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect(page).toHaveURL(/scale=month/);
    await expect
      .poll(() =>
        prisma.workSegment.findFirst({
          where: { taskId: fixture.taskId, content },
          select: { startAt: true, endAt: true },
        }),
      )
      .toEqual({
        startAt: new Date("2025-06-01T09:00:00.000+08:00"),
        endAt: new Date("2025-06-02T09:00:00.000+08:00"),
      });

    const createdSegment = await prisma.workSegment.findFirstOrThrow({
      where: { taskId: fixture.taskId, content },
      select: { id: true },
    });
    const editedCanvasRoot = canvasRoot;
    await page.getByTestId("time-canvas-scroll").evaluate((element) => {
      const root = element.closest<HTMLElement>(
        '[data-testid="time-canvas-root"]',
      );
      const rangeStart = Number(root?.dataset.rangeStartMs);
      const rangeEnd = Number(root?.dataset.rangeEndMs);
      const target = Date.parse("2025-06-01T09:00:00.000+08:00");
      const ratio = (target - rangeStart) / (rangeEnd - rangeStart);
      element.scrollLeft = Math.max(
        0,
        ratio * element.scrollWidth - element.clientWidth / 2,
      );
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(
        async () =>
          (await canvasRoot.getAttribute("data-loaded-ranges"))
            ?.split("|")
            .some((range) => range.startsWith(`${expandedStart}:`)) ?? false,
        { timeout: 30_000 },
      )
      .toBe(true);
    const adjacentBlockStart = expandedStart + 180 * 24 * 60 * 60 * 1_000;
    await expect
      .poll(
        async () =>
          (await canvasRoot.getAttribute("data-loaded-ranges"))
            ?.split("|")
            .some((range) => range.startsWith(`${adjacentBlockStart}:`)) ??
          false,
        { timeout: 15_000 },
      )
      .toBe(true);
    await horizontalScroller.focus();
    await horizontalScroller.press("ArrowRight");
    const segmentBlock = page.getByTestId(`segment-block-${createdSegment.id}`);
    await expect(segmentBlock).toBeVisible({ timeout: 15_000 });
    await segmentBlock.focus();
    await segmentBlock.press("Enter");
    const editForm = page.getByRole("form", { name: "编辑投入详情" });
    await expect(editForm).toBeVisible();
    await expect
      .poll(
        async () => {
          const viewportStart = Number(
            await editedCanvasRoot.getAttribute("data-viewport-start-ms"),
          );
          const viewportEnd = Number(
            await editedCanvasRoot.getAttribute("data-viewport-end-ms"),
          );
          const urlCenter = Date.parse(
            new URL(page.url()).searchParams.get("center") ?? "",
          );
          if (
            !Number.isFinite(viewportStart) ||
            !Number.isFinite(viewportEnd) ||
            !Number.isFinite(urlCenter)
          ) {
            return Number.POSITIVE_INFINITY;
          }
          return Math.abs(urlCenter - (viewportStart + viewportEnd) / 2);
        },
        { timeout: 15_000 },
      )
      .toBeLessThan(48 * 60 * 60 * 1_000);
    const centerBeforeEdit = Date.parse(
      new URL(page.url()).searchParams.get("center") ?? "",
    );
    await editForm.getByLabel("开始", { exact: true }).fill("2024-06-01T09:00");
    await editForm.getByLabel("结束", { exact: true }).fill("2024-06-02T09:00");
    await editForm
      .getByRole("button", { name: "保存基本信息", exact: true })
      .click();

    await expect(page.getByText("已更新投入详情")).toBeVisible();
    const editedExpandedStart = Date.parse("2024-04-01T00:00:00.000+08:00");
    await expect(editedCanvasRoot).toHaveAttribute(
      "data-range-start-ms",
      String(editedExpandedStart),
    );
    await expect
      .poll(
        async () =>
          (await editedCanvasRoot.getAttribute("data-loaded-ranges"))
            ?.split("|")
            .some((range) => range.startsWith(`${editedExpandedStart}:`)) ??
          false,
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(editedCanvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect
      .poll(
        () => {
          const centerAfterEdit = Date.parse(
            new URL(page.url()).searchParams.get("center") ?? "",
          );
          return Math.abs(centerAfterEdit - centerBeforeEdit);
        },
        { timeout: 15_000 },
      )
      .toBeLessThan(60 * 60 * 1_000);
    await expect
      .poll(() =>
        prisma.workSegment.findUnique({
          where: { id: createdSegment.id },
          select: { startAt: true, endAt: true },
        }),
      )
      .toEqual({
        startAt: new Date("2024-06-01T09:00:00.000+08:00"),
        endAt: new Date("2024-06-02T09:00:00.000+08:00"),
      });
    await expectHealthyPage(page);
  });

  test("Task workbench Today loads the current window without changing scale", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const historicalTitle = `S6 Historical Today ${randomUUID()}`;
      const historicalTask = await createTaskDraft(actor(fixture.admin), {
        title: historicalTitle,
        description: "验证历史内容仍可定位今天",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
        milestones: [{
          goal: "历史 Milestone",
          completionCriteria: "历史节点完成",
          expectedCompletedAt: "2020-02-01T10:00:00.000Z",
          reviewRequirements: "提交历史证据",
          businessDescription: "历史 Milestone",
        }],
        plannedStartAt: "2020-01-01T10:00:00.000Z",
        termination: {
          name: "Historical Terminal",
          plannedOutcomeCriteria: "历史任务结束",
          plannedAt: "2020-03-01T10:00:00.000Z",
          businessDescription: "历史结束确认",
        },
        idempotencyKey: `s6-historical-today-${randomUUID()}`,
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(
        `/progress/tasks/${historicalTask.taskId}?center=${encodeURIComponent("2020-02-01T10:00:00.000Z")}`,
      );
      await revealTaskArea(page, "计划与投入");
      const canvasRoot = page.getByTestId("time-canvas-root");
      const nowBeforeNavigation = Date.now();
      expect(Number(await canvasRoot.getAttribute("data-range-end-ms")))
        .toBeLessThan(nowBeforeNavigation);
      await canvasRoot.getByRole("button", { name: "季", exact: true }).click();
      await expect(canvasRoot).toHaveAttribute("data-zoom", "QUARTER");

      await canvasRoot.getByRole("button", { name: "今天", exact: true }).click();
      await canvasRoot.getByRole("button", { name: "月", exact: true }).click();
      await expect.poll(() => {
        const center = Date.parse(new URL(page.url()).searchParams.get("center") ?? "");
        return Math.abs(center - Date.now());
      }).toBeLessThan(12 * 60 * 60 * 1_000);
      await expect.poll(async () => {
        const now = Date.now();
        const start = Number(await canvasRoot.getAttribute("data-range-start-ms"));
        const end = Number(await canvasRoot.getAttribute("data-range-end-ms"));
        return start <= now && now < end;
      }).toBe(true);
      await expect.poll(async () => {
        const now = Date.now();
        return (await canvasRoot.getAttribute("data-loaded-ranges"))
          ?.split("|")
          .some((value) => {
            const [start, end] = value.split(":").map(Number);
            return start <= now && now < end;
          }) ?? false;
      }).toBe(true);
      await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
      await expect.poll(() => new URL(page.url()).searchParams.get("scale"))
        .toBe("month");

      const historicalMilestoneMs = Date.parse("2020-02-01T10:00:00.000Z");
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /历史 Milestone/ })
        .click();
      await expect(page.getByTestId("task-execution-view")).toBeVisible();
      await expect(page.locator("#task-selected-node-detail")).toContainText("历史 Milestone");
      await expect(canvasRoot).toBeVisible();
      await expect
        .poll(
          () => {
            const center = Date.parse(
              new URL(page.url()).searchParams.get("center") ?? "",
            );
            return Math.abs(center - historicalMilestoneMs);
          },
          { timeout: 15_000 },
        )
        .toBeLessThan(60_000);
      await revealTaskArea(page, "计划与投入");
      await expect(canvasRoot).toBeVisible();
      await expect.poll(async () => {
        const start = Number(await canvasRoot.getAttribute("data-viewport-start-ms"));
        const end = Number(await canvasRoot.getAttribute("data-viewport-end-ms"));
        return start <= historicalMilestoneMs && historicalMilestoneMs < end;
      }).toBe(true);

      await page.goBack();
      await expect(page.getByTestId("task-execution-view")).toBeVisible();
      await expect(canvasRoot).toBeVisible();
      await expect.poll(() => {
        const center = Date.parse(new URL(page.url()).searchParams.get("center") ?? "");
        return Math.abs(center - Date.now());
      }).toBeLessThan(12 * 60 * 60 * 1_000);
      await page.goForward();
      await expect(page.getByTestId("task-execution-view")).toBeVisible();
      await expect(canvasRoot).toBeVisible();
      await expect.poll(() => {
        const center = Date.parse(new URL(page.url()).searchParams.get("center") ?? "");
        return Math.abs(center - historicalMilestoneMs);
      }).toBeLessThan(60_000);
      await expect.poll(async () => {
        const start = Number(await canvasRoot.getAttribute("data-viewport-start-ms"));
        const end = Number(await canvasRoot.getAttribute("data-viewport-end-ms"));
        return start <= historicalMilestoneMs && historicalMilestoneMs < end;
      }).toBe(true);
      await expectHealthyPage(page);
    });

  test("Task workbench keeps saved related Task and members across authoritative refreshes", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const addedMember = await createAccountPerson(
        `S6 Workbench Persisted Member ${randomUUID()}`,
      );
      const relatedTitle = `S6 Workbench Related ${randomUUID()}`;
      const related = await createTaskDraft(actor(fixture.admin), {
        title: relatedTitle,
        description: "验证 Workbench 保存后的 authoritative refresh",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
        milestones: [milestoneInput("关联 Task 阶段", "关联 Task 完成条件", 1)],
        plannedStartAt: new Date(Date.UTC(2026, 7, 1, 1, 0, 0)).toISOString(),
        termination: terminationInput(5),
        idempotencyKey: `s6-workbench-related-${randomUUID()}`,
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await revealTaskArea(page, "计划与投入");
      await page.getByRole("button", { name: "新增投入", exact: true }).click();
      const quickCreate = page.getByRole("form", { name: "投入快速创建" });
      const segmentPersonPicker = quickCreate.getByLabel("人员", { exact: true });
      await segmentPersonPicker.click();
      await expect(
        page.getByRole("option", {
          name: fixture.admin.person.displayName,
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("option", {
          name: fixture.reviewer.person.displayName,
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("option", {
          name: fixture.reviewer.person.displayName,
          exact: true,
        })
        .click();
      await expect(quickCreate.locator('input[name="personId"]')).toHaveValue(
        fixture.reviewer.person.id,
      );
      await quickCreate.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("link", { name: "编辑任务" }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}/edit`);
      await openTaskComposerDisclosure(page, "关联任务与项目（可选）");
      const relatedPicker = page.getByLabel("关联任务", { exact: true });
      await relatedPicker.fill(relatedTitle);
      await page
        .getByRole("option", { name: relatedTitle, exact: true })
        .click();
      const memberPicker = page.getByLabel("搜索参与人员", { exact: true });
      await memberPicker.fill(addedMember.person.displayName);
      await page
        .getByRole("option", {
          name: addedMember.person.displayName,
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "保存任务" }).first().click();
      await page.getByRole("dialog", { name: "任务已保存" }).getByRole("button", { name: "暂不激活", exact: true }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => ({
          task: await prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { relatedTaskId: true, lockVersion: true },
          }),
          memberCount: await prisma.taskMember.count({
            where: {
              taskId: fixture.taskId,
              personId: addedMember.person.id,
              role: "PARTICIPANT",
              removedAt: null,
            },
          }),
        }))
        .toEqual({
          task: { relatedTaskId: related.taskId, lockVersion: 1 },
          memberCount: 1,
        });
      await page.getByRole("link", { name: "编辑任务" }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}/edit`);
      await openTaskComposerDisclosure(page, "关联任务与项目（可选）");
      await expect(relatedPicker).toHaveValue(relatedTitle);
      await expect(page.getByText(addedMember.person.displayName)).toBeVisible();
      await expectHealthyPage(page);
    });

  test("cancelling a rejected Revision keeps an unrelated Milestone gate", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const reason = `S6 不相关门禁 ${randomUUID()}`;
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: task.currentPlanVersionId,
      baseTaskLockVersion: task.lockVersion,
      reason,
      description: reason,
      revisionAt: "2026-07-31T12:00:00.000Z",
      replacementMilestones: [
        milestoneInput("S6 不相关门禁候选", "候选完成条件", 2),
      ],
      termination: terminationInput(5),
      idempotencyKey: `s6-unrelated-gate-revision-${randomUUID()}`,
    });
    await rejectRevision(actor(fixture.admin), {
      revisionNodeId: revision.revisionNodeId,
      comment: "保留为可取消的已驳回 Revision",
    });
    const activeMilestone = await prisma.milestoneNode.findUniqueOrThrow({
      where: { nodeId: fixture.activeNodeId },
      select: { id: true },
    });
    await prisma.milestoneReview.create({
      data: {
        milestoneNodeId: activeMilestone.id,
        result: "PENDING",
        submittedByAccountId: fixture.owner.account.id,
        idempotencyKey: `s6-unrelated-gate-review-${randomUUID()}`,
      },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}?tab=revisions`);
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "里程碑",
    );
    const [overviewBox, approvalGateBox, executionBox] = await Promise.all([
      page.getByTestId("task-overview").boundingBox(),
      page.getByTestId("task-approval-gate").boundingBox(),
      page.getByTestId("task-execution-view").boundingBox(),
    ]);
    if (!overviewBox || !approvalGateBox || !executionBox) {
      throw new Error("无法读取 Task 审批门禁的布局位置");
    }
    expect(approvalGateBox.y).toBeGreaterThan(
      overviewBox.y + overviewBox.height,
    );
    expect(executionBox.y).toBeGreaterThan(
      approvalGateBox.y + approvalGateBox.height,
    );
    await page.evaluate(() => {
      const browserWindow = window as Window & {
        __taskApprovalGateRemoved?: boolean;
        __taskApprovalGateObserver?: MutationObserver;
      };
      browserWindow.__taskApprovalGateRemoved = false;
      browserWindow.__taskApprovalGateObserver = new MutationObserver(
        (records) => {
          for (const record of records) {
            for (const removedNode of record.removedNodes) {
              if (
                removedNode instanceof Element &&
                (removedNode.matches('[data-testid="task-approval-gate"]') ||
                  removedNode.querySelector(
                    '[data-testid="task-approval-gate"]',
                  ))
              ) {
                browserWindow.__taskApprovalGateRemoved = true;
              }
            }
          }
        },
      );
      browserWindow.__taskApprovalGateObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
    const revisionCard = page
      .getByRole("heading", { name: "当前计划修订候选" })
      .locator("../..");
    await expect(
      revisionCard.getByText(reason, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      revisionCard.getByRole("button", { name: "修改并重新送审" }),
    ).toBeDisabled();
    await revisionCard.getByRole("button", { name: "取消计划修订" }).click();
    await expect(page.getByText("计划修订已取消。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "里程碑",
    );
    expect(
      await page.evaluate(() => {
        const browserWindow = window as Window & {
          __taskApprovalGateRemoved?: boolean;
          __taskApprovalGateObserver?: MutationObserver;
        };
        browserWindow.__taskApprovalGateObserver?.disconnect();
        return browserWindow.__taskApprovalGateRemoved;
      }),
    ).toBe(false);
    await expect(
      page.getByRole("heading", { name: "当前待审批验收" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "提交验收" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "申请结束任务" }),
    ).toBeDisabled();
    await expectHealthyPage(page);
  });

  test("Task UI v2 edits active metadata in a dialog and exposes selected-node actions", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const renamedTitle = `${fixture.taskTitle} · v2`;
    const longTerminationReason = `R${"R".repeat(1_499)}`;
    const longTerminationSummary = `S${"S".repeat(2_999)}`;
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
    await expect(page.getByTestId("task-execution-view")).toBeVisible();
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await page.getByRole("button", { name: "修改任务基本信息" }).click();
    const editor = page.getByRole("dialog", { name: "修改任务基本信息" });
    await expect(editor).toBeVisible();
    await expect(
      editor.getByLabel("搜索负责人", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByLabel("搜索参与人员", { exact: true }),
    ).toBeVisible();
    await expect(editor.getByLabel("新增成员角色")).toHaveCount(0);
    const editForm = editor.getByRole("form", { name: "修改任务" });
    await editForm.getByLabel("标题").fill(renamedTitle);
    await expect(
      editForm.getByRole("button", { name: "保存修改" }),
    ).toHaveCount(1);
    await expect(
      editForm.getByRole("button", { name: /保存基本信息|保存 Tags|保存成员/ }),
    ).toHaveCount(0);
    await editForm.getByRole("button", { name: "保存修改" }).click();
    await expect(
      page.getByTestId("task-workbench-v2").getByText("任务修改已保存。"),
    ).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true },
        }),
      )
      .toEqual({ title: renamedTitle });
    await expect(editor).toHaveCount(0);

    await page.getByRole("button", { name: "修改任务基本信息" }).click();
    const staleEditor = page.getByRole("dialog", {
      name: "修改任务基本信息",
    });
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: {
        title: "其他用户并发保存的标题",
        lockVersion: { increment: 1 },
      },
    });
    await staleEditor.getByLabel("标题").fill("不应覆盖并发修改的标题");
    await staleEditor.getByRole("button", { name: "保存修改" }).click();
    await expect(staleEditor.getByRole("alert")).toContainText(
      "Task 已被他人修改，请刷新后重试",
    );
    await expect(staleEditor.getByRole("alert")).toContainText(
      "请关闭并重新打开编辑窗口",
    );
    await expect(
      staleEditor.getByRole("button", { name: "保存修改" }),
    ).toBeDisabled();
    await staleEditor.getByLabel("标题").press("Enter");
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true },
        }),
      )
      .toEqual({ title: "其他用户并发保存的标题" });
    await page.keyboard.press("Escape");
    await expect(staleEditor).toHaveCount(0);

    await page
      .getByRole("textbox", { name: "文本证据" })
      .fill("Task UI v2 验收证据");
    await page.getByRole("button", { name: "提交验收" }).click();
    await expect(page.getByText("里程碑已提交验收。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "里程碑",
    );
    const pendingMilestoneMaterials = page.getByTestId(
      "milestone-pending-review-evidences",
    );
    await expect(
      pendingMilestoneMaterials.getByRole("heading", { name: "本次提交材料" }),
    ).toBeVisible();
    await expect(pendingMilestoneMaterials).toContainText(
      "Task UI v2 验收证据",
    );

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(
      page.getByTestId("milestone-pending-review-evidences"),
    ).toContainText("Task UI v2 验收证据");
    await page.getByLabel("审批说明").fill("Task UI v2 管理员通过");
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect(page.getByText("验收已通过。")).toBeVisible();
    await selectExecutionNode(page, /P6 UI 第一阶段/);
    const completedMilestone = await prisma.milestoneNode.findUniqueOrThrow({
      where: { nodeId: fixture.activeNodeId },
      select: { completedAt: true },
    });
    expect(completedMilestone.completedAt).not.toBeNull();
    await expect(
      page.getByText("实际完成", { exact: true }).locator(".."),
    ).toContainText(formatDateTime(completedMilestone.completedAt));
    const milestoneMaterials = page.getByTestId(
      "milestone-completion-evidences",
    );
    await expect(
      milestoneMaterials.getByRole("heading", { name: "实际提交材料" }),
    ).toBeVisible();
    await expect(milestoneMaterials).toContainText("Task UI v2 验收证据");
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await selectExecutionNode(page, /Terminal/);
    await expect(page.getByLabel("结束结果")).toBeVisible();
    await page.getByLabel("结束结果").selectOption("CANCELLED");
    await expect(page.getByLabel("原因")).toHaveAttribute("maxlength", "2000");
    await expect(page.getByLabel("总结")).toHaveAttribute("maxlength", "4000");
    await page.getByLabel("原因").fill(longTerminationReason);
    await page.getByLabel("总结").fill(longTerminationSummary);
    await page.getByRole("button", { name: "提交结束审批" }).click();
    await expect(page.getByText("任务结束申请已提交审批。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Terminal",
    );
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true },
        }),
      )
      .toEqual({ status: "ACTIVE" });
    await expect(
      page.getByRole("heading", { name: "当前待审批结束申请" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "通过", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "驳回", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "要求修订", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await selectExecutionNode(page, /Terminal/);
    await expect(
      page.getByRole("heading", { name: "当前待审批结束申请" }),
    ).toBeVisible();
    await expect(page.getByLabel("审批说明")).toHaveAttribute(
      "maxlength",
      "2000",
    );
    const terminationComment = page.getByLabel("审批说明");
    await expect(terminationComment).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "要求修订" })).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "驳回", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "要求修订" }).click();
    await expect(terminationComment).toHaveAttribute("aria-invalid", "true");
    await expect(terminationComment).toBeFocused();
    await expect(
      page.getByRole("alert").filter({ hasText: "驳回或要求修订时必须填写说明" }),
    ).toBeVisible();
    await terminationComment.fill("请补充结束总结");
    await expect(terminationComment).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "要求修订" }).click();
    await expect(page.getByText("已要求修订任务结束申请。")).toBeVisible();
    await expect(page.getByText("上一轮结束申请需要修订")).toBeVisible();
    await expect(page.getByLabel("结束结果")).toHaveValue("CANCELLED");
    await expect(page.getByLabel("原因")).toHaveValue(longTerminationReason);
    await expect(page.getByLabel("总结")).toHaveValue(longTerminationSummary);
    await page.getByLabel("总结").fill("Task UI v2 已补充结束总结");
    await page.getByRole("button", { name: "提交结束审批" }).click();
    await expect(page.getByText("任务结束申请已提交审批。")).toBeVisible();
    await expect(page.getByLabel("审批说明")).toHaveValue("");
    await page.getByLabel("审批说明").fill("本轮仍不通过");
    await page.getByRole("button", { name: "驳回" }).click();
    await expect(page.getByText("任务结束申请已驳回。")).toBeVisible();
    await expect(page.getByText("上一轮结束申请已驳回")).toBeVisible();
    await expect(page.getByLabel("结束结果")).toHaveValue("CANCELLED");
    await expect(page.getByLabel("原因")).toHaveValue(longTerminationReason);
    await expect(page.getByLabel("总结")).toHaveValue(
      "Task UI v2 已补充结束总结",
    );
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await selectExecutionNode(page, /Terminal/);
    await expect(page.getByText("上一轮结束申请已驳回")).toBeVisible();
    await expect(page.getByLabel("总结")).toHaveValue(
      "Task UI v2 已补充结束总结",
    );
    await page.getByRole("button", { name: "提交结束审批" }).click();
    await expect(page.getByText("任务结束申请已提交审批。")).toBeVisible();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await selectExecutionNode(page, /Terminal/);
    await page.getByLabel("审批说明").fill("Task UI v2 管理员批准结束");
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect(page.getByText("任务结束申请已通过。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true },
        }),
      )
      .toEqual({ status: "CANCELLED" });
    const completedTermination = await prisma.terminationNode.findFirstOrThrow({
      where: { node: { taskId: fixture.taskId } },
      select: {
        confirmedAt: true,
        outcome: true,
        reason: true,
        summary: true,
      },
    });
    expect(completedTermination.confirmedAt).not.toBeNull();
    await page.locator("summary").filter({ hasText: "任务资料与成员" }).click();
    await expect(
      page.getByText("实际结束", { exact: true }).locator(".."),
    ).toContainText(formatDateTime(completedTermination.confirmedAt));
    const terminationMaterials = page.getByTestId(
      "termination-completion-materials",
    );
    await expect(
      terminationMaterials.getByRole("heading", { name: "实际提交材料" }),
    ).toBeVisible();
    await expect(terminationMaterials).toContainText("提前取消");
    await expect(terminationMaterials).toContainText(longTerminationReason);
    await expect(terminationMaterials).toContainText(
      "Task UI v2 已补充结束总结",
    );
    await expect(page.getByText("上一轮结束申请已驳回")).toHaveCount(0);
    await expect(page.getByText("上一轮结束申请需要修订")).toHaveCount(0);
    await revealTaskArea(page, "风险与讨论");
    await expect(
      page.getByRole("heading", { name: "任务风险", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "任务评论", exact: true }),
    ).toBeVisible();
    await revealTaskArea(page, "活动记录");
    await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);
  });

  test("Task UI v2 creates and resubmits a Revision through the vertical Composer", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const firstReason = `S6 v2 Revision ${randomUUID()}`;
    const firstDescription = "第一次 Revision 的详细变更内容";
    const secondReason = `${firstReason} 二次送审`;
    const secondDescription = "根据审批意见调整后的 Revision 详细内容";
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("link", { name: "发起计划修订" }).click();
    await expect(page.getByTestId("task-composer")).toHaveAttribute(
      "data-composer-mode",
      "CREATE_REVISION",
    );
    await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
    await page.getByRole("navigation", { name: "任务表单分区" })
      .getByRole("button", { name: "1. 基本资料", exact: true }).click();
    const revisionTaskInfo = page.getByLabel("任务基本信息");
    await expect(
      revisionTaskInfo.getByRole("heading", { name: "基本信息" }),
    ).toBeVisible();
    await expect(revisionTaskInfo.getByLabel("任务名称")).toHaveValue(
      fixture.taskTitle,
    );
    await expect(revisionTaskInfo.getByLabel("任务名称")).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "计划修订信息" }),
    ).toHaveCount(0);
    await expect(page.getByText("只读基线", { exact: true })).toHaveCount(0);
    await expect(page.getByText("问题列表", { exact: true })).toHaveCount(0);
    const currentRevisionButton = page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /当前计划修订/ });
    await expect(currentRevisionButton).toHaveAttribute("aria-pressed", "true");
    const revisionInspector = page.getByLabel("计划节点检查器");
    await expect(
      revisionInspector.getByText("不可删除", { exact: true }),
    ).toBeVisible();
    const multiSelection = page.getByTestId(
      "task-composer-anchor-multi-selection",
    );
    if (testInfo.project.name === "desktop") {
      await openTaskComposerDisclosure(page, "时间画布与批量调整（高级）");
      await expect(multiSelection).toContainText("已选 1 个可编辑节点");
      const canvas = page.getByTestId("time-canvas-root");
      const revisionMarker = canvas.getByRole("button", {
        name: /^计划节点 当前计划修订/,
      });
      const editableMilestoneMarker = canvas.getByRole("button", {
        name: /^计划节点 P6 UI 第一阶段/,
      });
      const readOnlyStartMarker = canvas.getByRole("button", {
        name: /^计划节点 开始节点/,
      });
      await editableMilestoneMarker.click({ modifiers: ["Shift"] });
      await expect(multiSelection).toContainText("已选 2 个可编辑节点");
      await expect(revisionMarker).toHaveAttribute(
        "data-anchor-multi-selected",
        "true",
      );
      await expect(editableMilestoneMarker).toHaveAttribute(
        "data-anchor-multi-selected",
        "true",
      );
      await expect(readOnlyStartMarker).toHaveAttribute(
        "data-anchor-editable",
        "false",
      );
      await readOnlyStartMarker.click({ modifiers: ["Shift"] });
      await expect(multiSelection).toContainText("已选 0 个可编辑节点");
      await expect(revisionInspector).toContainText("开始节点");
      await expect(
        multiSelection.getByRole("button", { name: "批量移动" }),
      ).toBeDisabled();
      await currentRevisionButton.click();
      await expect(
        multiSelection.getByRole("button", { name: "批量移动" }),
      ).toBeEnabled();
      await multiSelection
        .getByRole("button", { name: "批量移动" })
        .click();
      const revisionBatchMoveDialog = page.getByRole("dialog", {
        name: "批量移动计划节点",
      });
      await revisionBatchMoveDialog.getByLabel(/当前及后续节点/).check();
      await expect(revisionBatchMoveDialog).toContainText(
        /时间不早于它的 \d+ 个可编辑节点/,
      );
      await expect(revisionBatchMoveDialog).toContainText(
        "只读节点保持不变",
      );
      await revisionBatchMoveDialog.getByLabel("前移").check();
      await revisionBatchMoveDialog.getByLabel("移动天数").fill("365");
      await revisionBatchMoveDialog
        .getByRole("button", { name: "确认批量移动" })
        .click();
      await expect(
        revisionBatchMoveDialog.getByRole("alert").filter({
          hasText: "前移后节点时间冲突或超出合法范围",
        }),
      ).toBeVisible();
      await revisionBatchMoveDialog
        .getByRole("button", { name: "取消" })
        .click();
    } else {
      await expect(page.getByTestId("time-canvas-root")).toBeHidden();
      await expect(multiSelection).toBeHidden();
      await expect(
        page.getByRole("button", { name: "批量移动" }),
      ).toBeHidden();
    }
    const revisionReason = revisionInspector.getByLabel("计划修订名称");
    const revisionDescription = revisionInspector.getByLabel("计划修订详细内容");
    await expect(revisionReason).not.toHaveAttribute("aria-invalid", "true");
    await expect(revisionDescription).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "创建并送审" }).first().click();
    await expect(revisionReason).toHaveAttribute("aria-invalid", "true");
    await expect(revisionDescription).toHaveAttribute("aria-invalid", "true");
    await expect(revisionReason).toBeFocused();
    await expect(
      revisionInspector.getByRole("alert").filter({ hasText: "请输入计划修订名称" }),
    ).toBeVisible();
    await expect(
      revisionInspector.getByRole("alert").filter({ hasText: "请输入计划修订详细内容" }),
    ).toBeVisible();
    await revisionReason.fill(firstReason);
    await revisionInspector
      .getByLabel("计划修订详细内容")
      .fill(firstDescription);
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: new RegExp(firstReason) })
      .click();
    await page.getByLabel("计划修订时间").fill("2026-08-03T12:00");
    await expect(page.getByText(/^本地已保存/)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const storageKey = Object.keys(window.localStorage).find((key) =>
            key.startsWith("revision-create-draft:"),
          );
          const raw = storageKey
            ? window.localStorage.getItem(storageKey)
            : null;
          if (!raw) return null;
          const draft = JSON.parse(raw) as {
            task?: {
              revision?: {
                reason?: string;
                description?: string;
                revisionAt?: string;
              };
            };
          };
          return draft.task?.revision ?? null;
        }),
      )
      .toMatchObject({
        reason: firstReason,
        description: firstDescription,
        revisionAt: "2026-08-03T12:00",
      });
    await page.reload();
    await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("计划修订名称")).toHaveValue(firstReason);
    await expect(page.getByLabel("计划修订详细内容")).toHaveValue(
      firstDescription,
    );
    await page.getByRole("button", { name: "创建并送审" }).first().click();
    const firstRevisionCard = page
      .getByRole("heading", { name: "当前计划修订候选" })
      .locator("../..");
    await expect(firstRevisionCard).toContainText(firstReason);
    await expect(firstRevisionCard).toContainText(firstDescription);
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "计划修订",
    );

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByLabel("处理说明").fill("请调整候选计划");
    await page.getByRole("button", { name: "驳回" }).click();
    await expect(page.getByText("计划修订已驳回。")).toBeVisible();

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("link", { name: "修改并重新送审" }).click();
    await expect(page.getByTestId("task-composer")).toHaveAttribute(
      "data-composer-mode",
      "RESUBMIT_REVISION",
    );
    await page.getByLabel("计划修订名称").fill(secondReason);
    await page.getByLabel("计划修订详细内容").fill(secondDescription);
    await page.getByRole("button", { name: "修改并重新送审" }).first().click();
    const secondRevisionCard = page
      .getByRole("heading", { name: "当前计划修订候选" })
      .locator("../..");
    await expect(secondRevisionCard).toContainText(secondReason);
    await expect(secondRevisionCard).toContainText(secondDescription);
    await expect
      .poll(() =>
        prisma.revisionNode.findFirst({
          where: { node: { taskId: fixture.taskId } },
          orderBy: { node: { createdAt: "desc" } },
          select: {
            status: true,
            reviewRound: true,
            node: { select: { businessDescription: true } },
          },
        }),
      )
      .toEqual({
        status: "PENDING_APPROVAL",
        reviewRound: 2,
        node: { businessDescription: secondDescription },
      });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    const approvalCard = page
      .getByRole("heading", { name: "当前计划修订候选" })
      .locator("../..");
    await approvalCard.getByLabel("处理说明").fill("同意应用修订计划");
    await approvalCard.getByRole("button", { name: "批准" }).click();
    await expect(page.getByText("计划修订已批准并应用。")).toBeVisible();
    await selectExecutionNode(page, new RegExp(secondReason));
    const selectedRevision = page.locator("#task-selected-node-detail");
    await expect(selectedRevision).toContainText(secondReason);
    await expect(selectedRevision).toContainText(secondDescription);
    await expectHealthyPage(page);
  });
});
