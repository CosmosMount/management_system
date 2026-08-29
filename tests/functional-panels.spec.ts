// @playwright-project ui
import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  expectHealthyPage,
  formatPrismaError,
  loginAsAdminUser,
  loginAsNormalUser,
  loginAsOtherUser,
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
  type FunctionalFixtureIds,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

let fixtures: FunctionalFixtureIds;
let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;

test.beforeAll(async () => {
  normalAuth = await resolveNormalAuthMaterial();
  try {
    fixtures = await prepareFunctionalFixtures(normalAuth);
  } catch (error) {
    throw new Error(`Playwright fixture 准备失败：${formatPrismaError(error)}`);
  }
});

test.describe("普通用户主功能面板", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await loginAsNormalUser(context, baseURL, normalAuth);
  });

  test("首页能进入采购、进度和反馈入口", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expectHealthyPage(page);
    await expect(
      page.getByRole("link", { name: "采购管理", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /项目管理/ }).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /反馈/ })).toBeVisible();

    await page
      .getByRole("link", { name: /采购管理 采购申请、订单审批、报销与统计看板/ })
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(
      "/procurement/dashboard",
    );
    await expect(page.getByRole("heading", { name: "采购看板" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await page
      .getByRole("link", {
        name: /项目管理 Task 工作台、资源计划与站内通知/,
      })
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/progress");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expectHealthyPage(page);

    const legacyTaskResponse = await page.goto("/progress/task/legacy-task", { waitUntil: "networkidle" });
    expect(legacyTaskResponse?.status()).toBe(404);
    await expect(page).toHaveURL(/\/progress\/task\/legacy-task$/);
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
    await expectHealthyPage(page);

    const legacyKanbanResponse = await page.goto("/progress/kanban", { waitUntil: "networkidle" });
    expect(legacyKanbanResponse?.status()).toBe(404);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/progress/kanban");
    await expect(page.getByRole("heading", { name: "页面不存在或无权访问" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/projects/legacy-project", {
      waitUntil: "networkidle",
    });
    await expect(page).toHaveURL(/\/progress\/projects\/legacy-project$/);
    await expect(page.getByRole("heading", { name: "页面不存在或无权访问" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/list", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: /反馈/ }).first().click();
    await expect(page).toHaveURL(/\/feedback\?new=1/);
    await expect(page.getByText("反馈中心")).toBeVisible();
    await expectHealthyPage(page);
  });

  test("采购面板能进入新建、列表、详情和看板且旧工坊入口已下线", async ({ page }, testInfo) => {
    await page.goto("/procurement", { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    if (testInfo.project.name === "mobile") {
      await page.getByRole("button", { name: "打开采购管理导航" }).click();
      await page
        .getByTestId("procurement-drawer")
        .getByRole("link", { name: "新建申请" })
        .click();
    } else {
      await page
        .getByTestId("procurement-sidebar")
        .getByRole("link", { name: "新建申请" })
        .click();
    }
    await expect(page).toHaveURL(/\/procurement\/new$/);
    await expect(page.getByText("基本信息")).toBeVisible();
    await page.getByRole("button", { name: "提交申请" }).click();
    await expect(page.getByText("请选择车组", { exact: true }).last()).toBeVisible();
    await expect(
      page.getByText("请选择技术组", { exact: true }).last(),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/procurement/list", { waitUntil: "networkidle" });
    await expect(page.getByText("PW-FULL-DRAFT")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "PW-FULL-REVIEW" }),
    ).toBeVisible();
    await page
      .getByRole("row")
      .filter({ hasText: "PW-FULL-DRAFT" })
      .getByRole("button")
      .first()
      .click();
    await expect(page.getByText("明细条目")).toBeVisible();
    await expect(page.getByText("PW全功能-草稿物料")).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/procurement/${fixtures.draftOrderId}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("PW-FULL-DRAFT")).toBeVisible();
    await expect(page.getByText("PW全功能-草稿物料")).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/procurement/dashboard", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "采购看板" })).toBeVisible();
    await expect(page.getByText(/处理人：/).first()).toBeVisible();
    const summaryTeamFilter = page.locator("#procurement-summary-team");
    await expect(summaryTeamFilter).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "导出该车组 BOM" }).click();
    await expect(summaryTeamFilter).toHaveAttribute("aria-invalid", "true");
    await expect(summaryTeamFilter).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "请先选择要导出的车组" })).toBeVisible();
    await summaryTeamFilter.click();
    await page.getByRole("option", { name: "英雄", exact: true }).click();
    await expect(summaryTeamFilter).not.toHaveAttribute("aria-invalid", "true");
    await expectHealthyPage(page);

    const workshopResponse = await page.goto("/procurement/workshop-fee", {
      waitUntil: "networkidle",
    });
    expect(workshopResponse?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
    await expectHealthyPage(page);
  });


  test("既有工坊加工费订单仍按原权限在列表和详情中只读可见", async ({ page }) => {
    const before = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: fixtures.workshopOrderId },
      include: { items: true },
    });
    expect(before.isWorkshopFee).toBe(true);
    expect(before.status).toBe("COMPLETED");

    await page.goto("/procurement/list", { waitUntil: "networkidle" });
    const row = page
      .getByRole("row")
      .filter({ hasText: "PW-FULL-WORKSHOP-HISTORY" });
    await expect(row).toBeVisible();
    await row.getByRole("button").first().click();
    await expect(page.getByText("PW全功能-历史工坊加工费")).toBeVisible();
    await expect(page.getByText("加工费", { exact: true })).toBeVisible();

    await row
      .getByRole("link", { name: "PW-FULL-WORKSHOP-HISTORY" })
      .click();
    await expect(
      page.getByRole("heading", { name: "订单 PW-FULL-WORKSHOP-HISTORY" }),
    ).toBeVisible();
    const commandBar = page.getByTestId("procurement-command-bar");
    await expect(
      commandBar.getByText("工坊加工费", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("PW全功能-历史工坊加工费")).toBeVisible();
    await expect(page.getByText("加工费", { exact: true })).toBeVisible();
    await expect(page.getByText("PW历史工坊", { exact: true })).toBeVisible();
    for (const actionName of [
      "修改清单",
      "确认报销",
      "上传凭证",
      "催促当前审批人",
    ]) {
      await expect(
        commandBar.getByRole("button", { name: actionName, exact: true }),
      ).toHaveCount(0);
    }
    await expectHealthyPage(page);

    const after = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: fixtures.workshopOrderId },
      include: { items: true },
    });
    expect(after).toEqual(before);
  });
  test("采购订单详情能通过 live refresh 自动看到状态变化", async ({ page }) => {
    await page.goto(`/procurement/${fixtures.reviewOrderId}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("PW-FULL-REVIEW")).toBeVisible();
    await expect(page.getByText("管理审核")).toBeVisible();

    await prisma.purchaseOrder.update({
      where: { id: fixtures.reviewOrderId },
      data: {
        status: "TEACHER_REVIEW",
        teamApproved: true,
        techGroupApproved: true,
        teamApproverOpenId: fixtures.adminOpenId,
        techGroupApproverOpenId: fixtures.adminOpenId,
      },
    });

    await expect(page.getByText("老师审核")).toBeVisible({ timeout: 15000 });
    await expectHealthyPage(page);
  });


  test("反馈全部筛选下点击关闭和活动反馈不会切换筛选", async ({ page }) => {
    await page.goto("/feedback", { waitUntil: "networkidle" });
    await expect(page.getByText("反馈中心")).toBeVisible();
    await page.getByRole("button", { name: "全部" }).click();

    await page.getByRole("button", { name: /PW全功能-已关闭反馈/ }).click();
    await expect(page).toHaveURL(new RegExp(`selected=${fixtures.closedFeedbackId}`));
    await expect(page.getByText("PW全功能-已关闭反馈").last()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /PW全功能-活动反馈/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: /PW全功能-活动反馈/ }).click();
    await expect(page).toHaveURL(new RegExp(`selected=${fixtures.openFeedbackId}`));
    await expect(page.getByText("PW全功能-活动反馈").last()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /PW全功能-已关闭反馈/ }),
    ).toBeVisible();
    await expectHealthyPage(page);
  });

  test("反馈中心能通过 live refresh 自动看到新反馈", async ({ page }) => {
    await page.goto("/feedback", { waitUntil: "networkidle" });
    await expect(page.getByText("反馈中心")).toBeVisible();
    const body = `PW全功能-live刷新反馈-${Date.now()}`;

    await prisma.feedback.create({
      data: {
        submitterOpenId: fixtures.normalOpenId,
        submitterName: "李棋轩",
        status: "OPEN",
        lastMessageAt: new Date(),
        messages: {
          create: {
            authorOpenId: fixtures.normalOpenId,
            authorName: "李棋轩",
            body,
          },
        },
      },
    });

    await expect(page.getByText(body).first()).toBeVisible({
      timeout: 15000,
    });
    await expectHealthyPage(page);
  });

  test("旧项目访问禁用页已移除", async ({ page }) => {
    const response = await page.goto("/project-access-disabled");
    expect(response?.status()).toBe(404);
  });
});

test.describe("管理员面板", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await loginAsAdminUser(context, baseURL);
  });

  test("管理员首页和四个子面板都能进入", async ({ page }) => {
    await page.goto("/admin", { waitUntil: "networkidle" });
    await expect(page.getByRole("main").getByText("管理员面板")).toBeVisible();
    await expect(page.getByText("统一账号")).toBeVisible();
    await expectHealthyPage(page);

    const panels = [
      { name: /系统同步/, url: /\/admin\/system$/, text: /飞书|同步|通讯录/ },
      { name: /账号与权限/, url: /\/admin\/accounts$/, text: /账号|权限/ },
      { name: /采购预算池/, url: /\/admin\/budget-pools$/, text: /预算|导入/ },
      { name: /关键时间点/, url: /\/admin\/time-markers$/, text: /时间点|时间线/ },
    ];

    for (const panel of panels) {
      await page.goto("/admin", { waitUntil: "networkidle" });
      await page.getByRole("link", { name: panel.name }).last().click();
      await expect(page).toHaveURL(panel.url);
      await expect(page.getByText(panel.text).first()).toBeVisible();
      await expectHealthyPage(page);
    }
  });

  test("飞书通讯录请求失败时显示安全提示而不是 Server Components 通用错误", async ({
    page,
  }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto("/admin/system", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "同步飞书通讯录" }).click();

    await expect(
      page.getByText(
        "无法读取飞书通讯录，请检查应用凭证、通讯录权限和网络连接后重试。",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(/An error occurred in the Server Components render/i),
    ).toHaveCount(0);
    expect(browserErrors).toEqual([]);
    await expectHealthyPage(page);
  });

  test("关键时间点可通过表单和时间线拖动后统一保存", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const markerName = `PW关键时间点-${Date.now()}`;
    const denseMarkers = Array.from({ length: 6 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `${`PW密集关键时间点${index + 1}`.repeat(10)}`.slice(0, 100),
      markedAt: new Date(),
    }));
    await prisma.globalTimeMarker.createMany({ data: denseMarkers });
    try {
    await page.goto("/admin/time-markers", { waitUntil: "networkidle" });
    await expect(page.getByTestId("admin-global-time-markers")).toBeVisible();
    const markerStage = page.getByTestId("time-canvas-global-marker-stage");
    const stageGrid = markerStage.getByTestId("time-canvas-time-grid");
    const axisTodayLine = page.getByTestId("time-canvas-today-axis");
    const stageTodayLine = markerStage.getByTestId("time-canvas-today-line");
    await expect(stageGrid).toBeVisible();
    expect(await stageGrid.locator(":scope > span").count()).toBeGreaterThan(1);
    await expect(axisTodayLine).toBeVisible();
    await expect(stageTodayLine).toBeVisible();
    const overflowMarker = markerStage.getByTestId("global-time-marker-overflow");
    await expect(overflowMarker).toBeVisible();
    await expect(overflowMarker).toContainText("+3 个关键点");
    await expect(overflowMarker).toHaveAttribute(
      "aria-label",
      /PW密集关键时间点/,
    );
    await overflowMarker.click();
    const overflowDialog = page.getByTestId("global-time-marker-overflow-dialog");
    const firstOverflowItem = overflowDialog
      .locator("[data-testid^='global-time-marker-overflow-item-']")
      .first();
    const overflowItemTestId = await firstOverflowItem.getAttribute("data-testid");
    const revealedMarkerId = overflowItemTestId?.replace(
      "global-time-marker-overflow-item-",
      "",
    );
    if (!revealedMarkerId) throw new Error("重叠关键时间点详情缺少标识");
    await firstOverflowItem.click();
    const revealedHandle = page.getByTestId(`global-time-marker-${revealedMarkerId}`);
    await expect(revealedHandle).toBeVisible();
    await expect(revealedHandle).toHaveCSS("pointer-events", "auto");
    const overflowZIndex = await overflowMarker.evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10),
    );
    const initialTodayLineZIndex = await stageTodayLine.evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10),
    );
    expect(initialTodayLineZIndex).toBeGreaterThan(overflowZIndex);
    const axisTodayBox = await axisTodayLine.boundingBox();
    const stageTodayBox = await stageTodayLine.boundingBox();
    if (!axisTodayBox || !stageTodayBox) {
      throw new Error("无法读取管理员时间线的当前时间位置");
    }
    expect(stageTodayBox.x).toBeCloseTo(axisTodayBox.x, 0);
    expect(
      Math.abs(stageTodayBox.y - (axisTodayBox.y + axisTodayBox.height)),
    ).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "新增时间点" }).click();
    const newEditor = page.getByTestId(/^global-time-marker-editor-/).last();
    const newNameInput = newEditor.getByLabel(/名称/);
    await expect(newNameInput).not.toHaveAttribute("aria-invalid", "true");
    await expect(newEditor.getByText("请输入关键时间点名称")).toHaveCount(0);
    await newNameInput.fill(markerName);
    const newTimeInput = newEditor.getByLabel("时间（上海）");
    await newTimeInput.fill("");
    await expect(newTimeInput).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "保存全部" })).toBeEnabled();
    await page.getByRole("button", { name: "保存全部" }).click();
    await expect(newTimeInput).toHaveAttribute("aria-invalid", "true");
    await expect(newTimeInput).toBeFocused();
    await expect(newEditor.getByText("请选择关键时间点时间")).toBeVisible();
    await newTimeInput.fill("2026-09-18T10:30");
    await expect(newTimeInput).not.toHaveAttribute("aria-invalid", "true");
    await expect(newEditor.getByText("请选择关键时间点时间")).toHaveCount(0);
    await newEditor.getByRole("button", { name: /在时间线定位/ }).click();
    await page.getByRole("button", { name: "保存全部" }).click();
    await expect(page.getByText("有未保存修改")).toHaveCount(0);
    const savedToast = page.getByText("关键时间点已保存", { exact: true });
    await expect(savedToast).toBeVisible();
    await expect(savedToast).toHaveCount(0, { timeout: 10_000 });

    const persisted = await prisma.globalTimeMarker.findFirstOrThrow({
      where: { name: markerName, deletedAt: null },
    });
    expect(persisted.markedAt.toISOString()).toBe("2026-09-18T02:30:00.000Z");

    const editor = page.getByTestId(`global-time-marker-editor-${persisted.id}`);
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: /在时间线定位/ }).click();
    const handle = page.getByTestId(`global-time-marker-${persisted.id}`);
    await expect(handle).toBeVisible();
    await expect(handle).toContainText("09-18 10:30");
    const handleZIndex = await handle.evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10),
    );
    const todayLineZIndex = await stageTodayLine.evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10),
    );
    expect(todayLineZIndex).toBeGreaterThan(handleZIndex);
    await expect(page.getByText("全局关键节点")).toHaveCount(0);
    await expect(page.getByTestId(`global-time-marker-line-${persisted.id}`)).toBeVisible();
    const beforeDrag = await editor.getByLabel("时间（上海）").inputValue();
    await dragTimelineMarker(page, handle, 45, testInfo.project.name === "mobile");
    await expect(editor.getByLabel("时间（上海）")).not.toHaveValue(beforeDrag);

    const pendingValue = await editor.getByLabel("时间（上海）").inputValue();
    await page.route("**/admin/time-markers", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "保存全部" }).click();
    await expect(page.getByRole("button", { name: "正在保存…" })).toBeVisible();
    await expect(editor.getByLabel("时间（上海）")).toBeDisabled();
    await expect(handle).toHaveCSS("pointer-events", "none");
    await page.getByRole("link", { name: "概览", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/time-markers$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/time-markers$/);
    await dragTimelineMarker(page, handle, 45, testInfo.project.name === "mobile");
    await expect(editor.getByLabel("时间（上海）")).toHaveValue(pendingValue);
    await expect(page.getByText("有未保存修改")).toHaveCount(0);
    await page.unroute("**/admin/time-markers");
    const moved = await prisma.globalTimeMarker.findUniqueOrThrow({
      where: { id: persisted.id },
    });
    expect(moved.markedAt.getTime()).not.toBe(persisted.markedAt.getTime());

    const beforeKeyboard = await editor.getByLabel("时间（上海）").inputValue();
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(editor.getByLabel("时间（上海）")).not.toHaveValue(beforeKeyboard);
    await page.getByRole("button", { name: "保存全部" }).click();
    await expect(page.getByText("有未保存修改")).toHaveCount(0);

    await editor.getByRole("button", { name: /暂存删除/ }).click();
    await page.getByRole("button", { name: "保存全部" }).click();
    await expect(page.getByText("有未保存修改")).toHaveCount(0);
    await expect
      .poll(async () =>
        (await prisma.globalTimeMarker.findUniqueOrThrow({
          where: { id: persisted.id },
        })).deletedAt,
      )
      .not.toBeNull();

    await page.getByRole("button", { name: "新增时间点" }).click();
    const extremeEditor = page.getByTestId(/^global-time-marker-editor-/).last();
    const extremeEditorTestId = await extremeEditor.getAttribute("data-testid");
    const extremeMarkerId = extremeEditorTestId?.replace(
      "global-time-marker-editor-",
      "",
    );
    if (!extremeMarkerId) throw new Error("极远日期关键时间点缺少标识");
    await extremeEditor.getByLabel(/名称/).fill("极远日期范围回归");
    await extremeEditor.getByLabel("时间（上海）").fill("9999-12-31T23:59");
    await extremeEditor.getByRole("button", { name: /在时间线定位/ }).click();
    const canvasRoot = page.getByTestId("time-canvas-root");
    await expect(extremeEditor.getByText("请选择关键时间点时间")).toHaveCount(0);
    await expect(page.getByTestId(`global-time-marker-${extremeMarkerId}`)).toBeVisible();
    const rangeStart = Number(await canvasRoot.getAttribute("data-range-start-ms"));
    const rangeEnd = Number(await canvasRoot.getAttribute("data-range-end-ms"));
    expect((rangeEnd - rangeStart) / (24 * 60 * 60 * 1000)).toBeLessThanOrEqual(
      1_100,
    );
    await extremeEditor.getByRole("button", { name: /暂存删除/ }).click();
    await expect(page.getByText("有未保存修改")).toHaveCount(0);
    await expectHealthyPage(page);
    } finally {
      await prisma.globalTimeMarker.updateMany({
        where: {
          OR: [
            { name: markerName },
            { id: { in: denseMarkers.map((marker) => marker.id) } },
          ],
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });
    }
  });

  test("关键时间点并发冲突会保留草稿并提供最新集合", async ({ page }) => {
    test.setTimeout(60_000);
    const savedName = `PW关键时间点-并发已保存-${Date.now()}`;
    const conflictingDraftName = `PW关键时间点-并发草稿-${Date.now()}`;
    const conflictingPage = await page.context().newPage();
    try {
      await Promise.all([
        page.goto("/admin/time-markers", { waitUntil: "networkidle" }),
        conflictingPage.goto("/admin/time-markers", { waitUntil: "networkidle" }),
      ]);

      await conflictingPage.getByRole("button", { name: "新增时间点" }).click();
      const conflictingEditor = conflictingPage
        .getByTestId(/^global-time-marker-editor-/)
        .last();
      await conflictingEditor.getByLabel(/名称/).fill(conflictingDraftName);
      await expect(conflictingPage.getByText("有未保存修改")).toBeVisible();

      await page.getByRole("button", { name: "新增时间点" }).click();
      const savedEditor = page.getByTestId(/^global-time-marker-editor-/).last();
      await savedEditor.getByLabel(/名称/).fill(savedName);
      await page.getByRole("button", { name: "保存全部" }).click();
      await expect(page.getByText("有未保存修改")).toHaveCount(0);

      await conflictingPage.getByRole("button", { name: "保存全部" }).click();
      const conflictAlert = conflictingPage.getByRole("alert").filter({
        hasText: "关键时间点已被其他管理员修改",
      });
      await expect(conflictAlert).toBeVisible();
      await expect(conflictingEditor.getByLabel(/名称/)).toHaveValue(
        conflictingDraftName,
      );
      await conflictAlert
        .getByRole("button", { name: "放弃草稿并重新加载" })
        .click();
      await expect
        .poll(() => pageHasInputValue(conflictingPage, conflictingDraftName))
        .toBe(false);
      await expect
        .poll(() => pageHasInputValue(conflictingPage, savedName))
        .toBe(true);
      await expect(conflictAlert).toHaveCount(0);
      await expectHealthyPage(conflictingPage);
    } finally {
      await prisma.globalTimeMarker.updateMany({
        where: {
          name: { in: [savedName, conflictingDraftName] },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });
      await conflictingPage.close();
    }
  });

  test("关键时间点未保存草稿会拦截站内链接和浏览器后退", async ({ page }) => {
    await page.goto("/admin");
    await page.goto("/admin/time-markers", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "新增时间点" }).click();
    const editor = page.getByTestId(/^global-time-marker-editor-/).last();
    await editor.getByLabel(/名称/).fill("仅用于导航保护的未保存草稿");

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("还有未保存的修改");
      await dialog.dismiss();
    });
    await page.getByRole("link", { name: "概览", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/time-markers$/);
    await expect(editor.getByLabel(/名称/)).toHaveValue(
      "仅用于导航保护的未保存草稿",
    );

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("还有未保存的修改");
      await dialog.dismiss();
    });
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/time-markers$/);
    await expect(editor.getByLabel(/名称/)).toHaveValue(
      "仅用于导航保护的未保存草稿",
    );

    page.once("dialog", async (dialog) => dialog.accept());
    await page.getByRole("link", { name: "概览", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expectHealthyPage(page);
  });

  test("账号与权限页使用三块职责布局并就地管理项目角色", async ({ page }) => {
    await page.goto("/admin/accounts?q=lqx", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "车组职责配置" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "技术组职责配置" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "用户与角色" })).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) < 768) {
      await expect(page.getByTestId("mobile-team-responsibilities")).toBeVisible();
      await expect(page.getByTestId("mobile-tech-responsibilities")).toBeVisible();
      await expect(page.getByTestId("mobile-account-list")).toBeVisible();
    } else {
      await expect(page.getByTestId("mobile-team-responsibilities")).toBeHidden();
      await expect(
        page.getByRole("columnheader", { name: "车组", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("columnheader", { name: "技术组", exact: true }),
      ).toBeVisible();
    }
    const accountsCard = page.getByTestId("accounts-and-roles-card");
    const visibleAccountList = (page.viewportSize()?.width ?? 0) < 768
      ? accountsCard.getByTestId("mobile-account-list")
      : accountsCard.locator("table");
    await expect(
      visibleAccountList.getByText("李棋轩", { exact: true }).first(),
    ).toBeVisible();

    const accountSelect = accountsCard.getByRole("combobox", {
      name: "选择要配置角色的用户",
    });
    await accountSelect.fill("李棋轩");
    await page.getByRole("option", { name: "李棋轩", exact: true }).click();
    await accountsCard
      .getByRole("combobox", { name: "选择角色" })
      .click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "超级管理员", exact: true })
      .click();
    page.once("dialog", (dialog) => dialog.dismiss());
    await accountsCard.getByRole("button", { name: "添加", exact: true }).click();
    await expect(
      prisma.systemRoleAssignment.count({
        where: {
          account: { reimbursementUser: { openId: fixtures.normalOpenId } },
          role: "SUPER_ADMINISTRATOR",
          revokedAt: null,
        },
      }),
    ).resolves.toBe(0);
    await accountsCard
      .getByRole("combobox", { name: "选择角色" })
      .click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "项目管理员", exact: true })
      .click();
    await accountsCard.getByRole("button", { name: "添加", exact: true }).click();

    const target = await prisma.user.findUniqueOrThrow({
      where: { openId: fixtures.normalOpenId },
      select: { accountId: true },
    });
    expect(target.accountId).toBeTruthy();
    await expect
      .poll(() =>
        prisma.systemRoleAssignment.count({
          where: {
            accountId: target.accountId!,
            role: "PROJECT_ADMINISTRATOR",
            revokedAt: null,
          },
        }),
      )
      .toBe(1);
    await expect(
      accountsCard.getByRole("button", {
        name: "撤销 李棋轩 的 项目管理员 角色",
      }),
    ).toBeVisible();

    await expect(page.getByText("项目访问状态")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "禁用项目访问" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "启用项目访问" })).toHaveCount(0);

    page.once("dialog", (dialog) => dialog.accept());
    await accountsCard
      .getByRole("button", { name: "撤销 李棋轩 的 项目管理员 角色" })
      .click();
    await expect
      .poll(() =>
        prisma.systemRoleAssignment.count({
          where: {
            accountId: target.accountId!,
            role: "PROJECT_ADMINISTRATOR",
            revokedAt: null,
          },
        }),
      )
      .toBe(0);
    await expect(
      accountsCard.getByRole("button", {
        name: "撤销 李棋轩 的 项目管理员 角色",
      }),
    ).toHaveCount(0);

    const archivedAt = new Date().toISOString();
    await prisma.domainAuditEvent.create({
      data: {
        id: `migration:pm-history:v1:system-role:e2e-${Date.now()}`,
        action: "account.legacy_project_role.archived",
        entityType: "Account",
        entityId: target.accountId!,
        before: {
          assignmentId: `legacy-assignment-${Date.now()}`,
          accountId: target.accountId!,
          role: "GROUP_LEADER",
          team: "英雄",
          techGroup: "",
          createdAt: "2025-01-02T03:04:05.000Z",
          revokedAt: archivedAt,
        },
        after: { archived: true, assignmentDeleted: true },
        reason: "端到端验证迁移归档角色可查询",
        source: "MIGRATION",
      },
    });
    await page.reload({ waitUntil: "networkidle" });
    const refreshedAccountsCard = page.getByTestId("accounts-and-roles-card");
    const refreshedAccountList = (page.viewportSize()?.width ?? 0) < 768
      ? refreshedAccountsCard.getByTestId("mobile-account-list")
      : refreshedAccountsCard.locator("table");

    await refreshedAccountList
      .getByRole("button", { name: "查看记录" })
      .click();
    const historyDialog = page.getByTestId("account-history-dialog");
    await expect(historyDialog).toBeVisible();
    await expect(historyDialog.getByText("项目管理员").first()).toBeVisible();
    await expect(historyDialog.getByText("旧组长 · 英雄").first()).toBeVisible();
    await expect(historyDialog.getByText(/已于 .* 归档/).first()).toBeVisible();
    await expect(historyDialog.getByText(/归档旧项目角色 · 系统迁移/).first()).toBeVisible();
    await expect(historyDialog.getByText(/数据迁移/).first()).toBeVisible();
    await expect(historyDialog.getByText(/授予项目角色/).first()).toBeVisible();
    await expect(historyDialog.getByText(/撤销项目角色/).first()).toBeVisible();
    await expectHealthyPage(page);
  });

  test("账号后台当前成员与职责矩阵不展示停用人员", async ({ page }) => {
    const suffix = Date.now().toString(36);
    const displayName = `已离职后台隐藏-${suffix}`;
    const openId = `ou_inactive_admin_${suffix}`;
    const account = await prisma.account.create({
      data: {
        identities: {
          create: {
            provider: "FEISHU",
            tenantId: "default",
            providerSubject: `open:${openId}`,
            openId,
          },
        },
        person: {
          create: { displayName, status: "INACTIVE" },
        },
        reimbursementUser: {
          create: { openId, name: displayName },
        },
        reimbursementRoles: {
          create: {
            openId,
            role: "TEAM_ADMIN",
            team: "英雄",
            techGroup: "",
          },
        },
      },
    });
    try {
      await page.goto(
        `/admin/accounts?q=${encodeURIComponent(displayName)}`,
        { waitUntil: "networkidle" },
      );
      await expect(page.getByText("没有符合条件的账号。")).toBeVisible();
      await expect(page.getByText(displayName, { exact: true })).toHaveCount(0);
      await expect(
        prisma.account.findUnique({
          where: { id: account.id },
          select: {
            person: { select: { status: true } },
            reimbursementRoles: {
              where: { revokedAt: null },
              select: { role: true, team: true },
            },
          },
        }),
      ).resolves.toEqual({
        person: { status: "INACTIVE" },
        reimbursementRoles: [{ role: "TEAM_ADMIN", team: "英雄" }],
      });
      await expectHealthyPage(page);
    } finally {
      await prisma.userRole.deleteMany({ where: { accountId: account.id } });
      await prisma.user.deleteMany({ where: { accountId: account.id } });
      await prisma.accountIdentity.deleteMany({
        where: { accountId: account.id },
      });
      await prisma.person.deleteMany({ where: { accountId: account.id } });
      await prisma.account.delete({ where: { id: account.id } });
    }
  });

  test("长姓名记录弹窗不溢出且缺少报销资料会在选择阶段拒绝", async ({ page }) => {
    const suffix = Date.now().toString(36);
    const displayName = `超长账号${suffix}${"无空格姓名".repeat(24)}`;
    const account = await prisma.account.create({
      data: {
        person: { create: { displayName } },
      },
      select: { id: true },
    });
    try {
      await page.goto(`/admin/accounts?q=${encodeURIComponent(displayName)}`, {
        waitUntil: "networkidle",
      });
      const accountsCard = page.getByTestId("accounts-and-roles-card");
      const visibleAccountList = (page.viewportSize()?.width ?? 0) < 768
        ? accountsCard.getByTestId("mobile-account-list")
        : accountsCard.getByRole("table");
      await expect(visibleAccountList.getByText(displayName, { exact: true })).toBeVisible();
      await expect(visibleAccountList.getByText("缺少飞书身份")).toBeVisible();
      await visibleAccountList.getByRole("button", { name: "查看记录" }).click();
      await expect(page.getByTestId("account-history-dialog")).toContainText(
        displayName,
      );
      await expectHealthyPage(page);
      await page.keyboard.press("Escape");

      const accountSelect = accountsCard.getByRole("combobox", {
        name: "选择要配置角色的用户",
      });
      const roleSelect = accountsCard.locator("#general-role-role");
      await expect(accountSelect).not.toHaveAttribute("aria-invalid", "true");
      await accountsCard.getByRole("button", { name: "添加", exact: true }).click();
      await expect(accountSelect).toHaveAttribute("aria-invalid", "true");
      await expect(roleSelect).toHaveAttribute("aria-invalid", "true");
      await expect(accountSelect).toBeFocused();
      await expect(accountsCard.locator("#general-role-account-error")).toHaveText("请选择用户");
      await accountSelect.fill(suffix);
      await page.getByRole("option", { name: displayName, exact: true }).click();
      await expect(accountSelect).not.toHaveAttribute("aria-invalid", "true");
      await roleSelect.click();
      await page
        .getByRole("listbox")
        .getByRole("option", { name: "报销员", exact: true })
        .click();
      await expect(
        page.getByText("该账号缺少报销用户资料，请重新选择已同步账号"),
      ).toBeVisible();
      await expect(accountSelect).toHaveValue("");
      await expectHealthyPage(page);
    } finally {
      await prisma.person.deleteMany({ where: { accountId: account.id } });
      await prisma.accountIdentity.deleteMany({ where: { accountId: account.id } });
      await prisma.account.delete({ where: { id: account.id } });
    }
  });

  test("账号筛选组合与空结果保持服务端 URL 状态", async ({ page }) => {
    await page.goto("/admin/accounts", { waitUntil: "networkidle" });
    await page.getByLabel("角色类型").selectOption("TEAM_ADMIN");
    await page.getByLabel("车组", { exact: true }).selectOption("英雄");
    await page.getByRole("button", { name: "筛选" }).click();
    await expect(page).toHaveURL(/role=TEAM_ADMIN/);
    await expect(page).toHaveURL(/team=%E8%8B%B1%E9%9B%84/);
    await expect(page.getByTestId("accounts-and-roles-card")).toContainText(
      "Playwright 管理员",
    );
    await expectHealthyPage(page);

    await page.goto("/admin/accounts?q=绝不可能存在的账号名称", {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("没有符合条件的账号。")).toBeVisible();
    await expectHealthyPage(page);
  });

  test("职责矩阵可快捷增删报销角色并编辑指导老师邮箱", async ({ page }) => {
    await page.goto("/admin/accounts?q=李棋轩", { waitUntil: "networkidle" });
    const target = await prisma.user.findUniqueOrThrow({
      where: { openId: fixtures.normalOpenId },
      select: { accountId: true },
    });
    if (!target.accountId) throw new Error("职责矩阵测试账号缺少统一账号");

    const financePicker = page.getByRole("combobox", {
      name: "为工程选择报销员",
    });
    const addFinanceButton = page.getByRole("button", { name: "添加工程报销员" });
    await expect(financePicker).not.toHaveAttribute("aria-invalid", "true");
    await addFinanceButton.click();
    await expect(financePicker).toHaveAttribute("aria-invalid", "true");
    await expect(financePicker).toBeFocused();
    await expect(
      page.getByRole("alert").filter({ hasText: "请选择要添加的账号" }),
    ).toBeVisible();
    await financePicker.fill("李棋轩");
    await page.getByRole("option", { name: "李棋轩", exact: true }).click();
    await expect(financePicker).not.toHaveAttribute("aria-invalid", "true");
    await addFinanceButton.click();
    await expect(
      page.getByRole("button", {
        name: "移除 李棋轩 的 报销员 · 工程",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        prisma.userRole.findFirst({
          where: {
            accountId: target.accountId,
            role: "FINANCE",
            team: "工程",
            techGroup: "",
            revokedAt: null,
          },
          select: { id: true },
        }),
      )
      .not.toBeNull();
    const activeAssignment = await prisma.userRole.findFirstOrThrow({
      where: {
        accountId: target.accountId,
        role: "FINANCE",
        team: "工程",
        revokedAt: null,
      },
      select: { id: true },
    });
    await expect(
      prisma.notificationOutbox.findUnique({
        where: {
          eventKey: `account-security:account.reimbursement_role.granted:${activeAssignment.id}:feishu`,
        },
      }),
    ).resolves.not.toBeNull();

    await page
      .getByRole("button", {
        name: "移除 李棋轩 的 报销员 · 工程",
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        prisma.userRole.findUnique({
          where: { id: activeAssignment.id },
          select: { revokedAt: true },
        }),
      )
      .toEqual({ revokedAt: expect.any(Date) });
    await expect(
      page.getByRole("button", {
        name: "移除 李棋轩 的 报销员 · 工程",
        exact: true,
      }),
    ).toHaveCount(0);

    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { openId: fixtures.adminOpenId },
      select: { accountId: true, email: true },
    });
    const emailAuditStartedAt = new Date();
    const normalizedEmail = `admin-ui-${Date.now()}@example.com`;
    const emailInput = page.locator(
      'input[aria-label="Playwright 管理员 的指导老师审批邮箱"]:visible',
    );
    try {
      await emailInput.fill("not-an-email");
      await emailInput.locator("..").getByRole("button", { name: "保存" }).click();
      await expect(emailInput).toHaveAttribute("aria-invalid", "true");
      await expect(emailInput).toBeFocused();
      await expect(page.getByRole("alert").filter({ hasText: "邮箱格式不正确" })).toBeVisible();
      await emailInput.fill(`  ${normalizedEmail.toUpperCase()}  `);
      await expect(emailInput).not.toHaveAttribute("aria-invalid", "true");
      await emailInput.locator("..").getByRole("button", { name: "保存" }).click();
      await expect(emailInput).toHaveValue(normalizedEmail);
      await expect
        .poll(() =>
          prisma.user.findUnique({
            where: { openId: fixtures.adminOpenId },
            select: { email: true },
          }),
        )
        .toEqual({ email: normalizedEmail });
      await emailInput.fill("");
      await emailInput.locator("..").getByRole("button", { name: "保存" }).click();
      await expect(emailInput).toHaveValue("");
      await expect
        .poll(() =>
          prisma.user.findUnique({
            where: { openId: fixtures.adminOpenId },
            select: { email: true },
          }),
        )
        .toEqual({ email: null });
      await expect
        .poll(() =>
          prisma.domainAuditEvent.findFirst({
            where: {
              action: "account.teacher_email.updated",
              entityType: "Account",
              entityId: adminUser.accountId,
              createdAt: { gte: emailAuditStartedAt },
            },
            select: { actorAccountId: true },
          }),
        )
        .not.toBeNull();
    } finally {
      await prisma.user.update({
        where: { openId: fixtures.adminOpenId },
        data: { email: adminUser.email },
      });
    }

    // Wait for all mutation-triggered RSC refreshes before opening local dialog state.
    await page.reload({ waitUntil: "networkidle" });
    const accountsCard = page.getByTestId("accounts-and-roles-card");
    const visibleAccountList = (page.viewportSize()?.width ?? 0) < 768
      ? accountsCard.getByTestId("mobile-account-list")
      : accountsCard.getByRole("table");
    await visibleAccountList.getByRole("button", { name: "查看记录" }).click();
    const historyDialog = page.getByTestId("account-history-dialog");
    await expect(historyDialog.getByText("报销员 · 工程").first()).toBeVisible();
    await expect(historyDialog.getByText(/授予报销角色/).first()).toBeVisible();
    await expect(historyDialog.getByText(/撤销报销角色/).first()).toBeVisible();
    await expect(page.getByText("项目访问状态")).toHaveCount(0);
    await expect(page.getByText("组长", { exact: true })).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("同一指导老师跨技术组只显示一个账号级邮箱编辑器", async ({ page }) => {
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { openId: fixtures.adminOpenId },
      select: { accountId: true },
    });
    const extraTeacherRole = await prisma.userRole.create({
      data: {
        accountId: adminUser.accountId,
        openId: fixtures.adminOpenId,
        role: "TEACHER",
        techGroup: "机械",
      },
    });
    try {
      await page.goto("/admin/accounts", { waitUntil: "networkidle" });
      await expect(
        page.locator(
          'input[aria-label="Playwright 管理员 的指导老师审批邮箱"]:visible',
        ),
      ).toHaveCount(1);
      await expect(
        page.locator("p:visible").filter({ hasText: /审批邮箱与.+职责共用：/ }),
      ).toBeVisible();
      await expectHealthyPage(page);
    } finally {
      await prisma.userRole.delete({ where: { id: extraTeacherRole.id } });
    }
  });

  test("账号与权限页可显示飞书 CDN 头像", async ({ page }) => {
    const target = await prisma.user.findUniqueOrThrow({
      where: { openId: fixtures.normalOpenId },
      select: { accountId: true },
    });
    if (!target.accountId) throw new Error("头像测试账号缺少统一账号");
    const person = await prisma.person.findUniqueOrThrow({
      where: { accountId: target.accountId },
      select: { avatar: true },
    });
    const avatarUrl =
      "https://s3-imfile.feishucdn.com/static-resource/v1/playwright-avatar~?image_size=72x72&format=png";
    const optimizedAvatarRequests: string[] = [];

    await page.route("**/_next/image?*", async (route) => {
      const requestedAvatarUrl = new URL(route.request().url()).searchParams.get(
        "url",
      );
      if (requestedAvatarUrl !== avatarUrl) {
        await route.continue();
        return;
      }
      optimizedAvatarRequests.push(requestedAvatarUrl);
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2563eb" /></svg>',
      });
    });
    await prisma.person.update({
      where: { accountId: target.accountId },
      data: { avatar: avatarUrl },
    });

    try {
      const response = await page.goto("/admin/accounts?q=李棋轩", {
        waitUntil: "networkidle",
      });
      expect(response?.status()).toBe(200);
      const avatar = page
        .locator('img[src*="s3-imfile.feishucdn.com"]:visible')
        .first();
      await expect(avatar).toBeVisible();
      await avatar.scrollIntoViewIfNeeded();
      await expect.poll(() => optimizedAvatarRequests.length).toBeGreaterThan(0);
      await expect
        .poll(() =>
          avatar.evaluate((element) => {
            const image = element as HTMLImageElement;
            return image.complete && image.naturalWidth > 0;
          }),
        )
        .toBe(true);
      await expectHealthyPage(page);
    } finally {
      await prisma.person.update({
        where: { accountId: target.accountId },
        data: { avatar: person.avatar },
      });
    }
  });

});

test("管理员账号与指导老师 Server Action 实际执行会话鉴权", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsOtherUser(context, baseURL);
  await page.goto("/admin-account-action-fixtures", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "调用账号搜索" }).click();
  await expect(page.getByLabel("账号搜索调用结果")).toHaveText("无管理权限");
  await page.getByRole("button", { name: "调用账号解析" }).click();
  await expect(page.getByLabel("账号解析调用结果")).toHaveText("无管理权限");
  await page
    .getByRole("button", { name: "调用指导老师邮箱更新" })
    .click();
  await expect(page.getByLabel("指导老师邮箱调用结果")).toHaveText(
    "无管理权限",
  );

  await loginAsAdminUser(context, baseURL);
  await page.goto("/admin-account-action-fixtures", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "调用账号搜索" }).click();
  await expect(page.getByLabel("账号搜索调用结果")).toHaveText(/^成功：/);
  await page.getByRole("button", { name: "调用账号解析" }).click();
  await expect(page.getByLabel("账号解析调用结果")).toHaveText("成功：1");
  await page
    .getByRole("button", { name: "调用指导老师邮箱更新" })
    .click();
  await expect(page.getByLabel("指导老师邮箱调用结果")).toHaveText(/^成功：/);
  await expectHealthyPage(page);
});

test("非管理员访问管理员面板会被重定向到首页", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsOtherUser(context, baseURL);
  await page.goto("/admin", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("link", { name: /采购管理 采购申请、订单审批、报销与统计看板/ }),
  ).toBeVisible();
  await expect(page.getByText("管理员面板")).toHaveCount(0);
  await expectHealthyPage(page);
});

test("项目管理员仍不能进入账号与权限后台", async ({
  page,
  context,
  baseURL,
}) => {
  const target = await prisma.user.findUniqueOrThrow({
    where: { openId: fixtures.otherOpenId },
    select: { accountId: true },
  });
  if (!target.accountId) throw new Error("项目管理员测试账号缺少统一账号");
  const assignment = await prisma.systemRoleAssignment.create({
    data: {
      accountId: target.accountId,
      role: "PROJECT_ADMINISTRATOR",
    },
  });
  try {
    await loginAsOtherUser(context, baseURL);
    await page.goto("/admin/accounts", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("账号与权限")).toHaveCount(0);
    await expectHealthyPage(page);
  } finally {
    await prisma.systemRoleAssignment.update({
      where: { id: assignment.id },
      data: { revokedAt: new Date() },
    });
  }
});

async function dragTimelineMarker(
  page: Page,
  marker: Locator,
  deltaX: number,
  touch: boolean,
) {
  await marker.scrollIntoViewIfNeeded();
  const box = await marker.boundingBox();
  if (!box) throw new Error("无法读取关键时间点拖动位置");
  const start = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
  if (!touch) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + deltaX, start.y, { steps: 5 });
    await page.mouse.up();
    return;
  }

  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...start, id: 1 }],
    });
    for (let step = 1; step <= 5; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x + (deltaX * step) / 5, y: start.y, id: 1 }],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

async function pageHasInputValue(page: Page, value: string) {
  return page.locator("input").evaluateAll(
    (inputs, expected) =>
      inputs.some(
        (input) => input instanceof HTMLInputElement && input.value === expected,
      ),
    value,
  );
}
