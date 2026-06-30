import { expect, type Locator, type Page, test } from "@playwright/test";
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
      page.getByRole("link", { name: "进度管理", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /反馈/ })).toBeVisible();

    await page
      .getByRole("link", { name: /采购管理 采购申请、订单审批、报销与统计看板/ })
      .click();
    await expect(page).toHaveURL(/\/procurement$/);
    await expect(
      page.getByRole("link", { name: /新建申请 填写采购明细并提交审批/ }),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await page
      .getByRole("link", { name: /进度管理 项目与任务跟踪、周报、验收与归档/ })
      .click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(
      page.getByRole("link", { name: /项目列表 查看全部进行中的项目/ }),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: /反馈/ }).first().click();
    await expect(page).toHaveURL(/\/feedback\?new=1/);
    await expect(page.getByText("反馈中心")).toBeVisible();
    await expectHealthyPage(page);
  });

  test("采购面板能进入新建、列表、详情、看板和工坊加工费", async ({ page }) => {
    await page.goto("/procurement", { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    await page.getByRole("link", { name: /新建申请/ }).click();
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
    await expectHealthyPage(page);

    await page.goto("/procurement/workshop-fee", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "工坊加工费" })).toBeVisible();
    await expectHealthyPage(page);
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

  test("进度项目列表、任务看板、详情和归档可操作基础筛选", async ({ page }) => {
    await page.goto("/progress/list", { waitUntil: "networkidle" });
    await expect(page.getByText("项目列表")).toBeVisible();
    await expect(page.getByText("PW全功能-逾期项目")).toBeVisible();
    await page.locator('a[href="/progress/list?deadline=overdue"]').click();
    await expect(page).toHaveURL(/deadline=overdue/);
    await expect(page.getByText("PW全功能-逾期项目")).toBeVisible();
    await page.locator('a[href="/progress/list"]').first().click();
    await expect(page).not.toHaveURL(/deadline=overdue/);
    await page.getByRole("link", { name: /只看自己/ }).click();
    await expect(page).toHaveURL(/mine=1/);
    await expect(page.getByText("PW全功能-逾期项目")).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/progress/${fixtures.projectId}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("PW全功能-逾期项目")).toBeVisible();
    await expect(page.getByText("PW全功能-当前阶段").first()).toBeVisible();
    await expect(page.getByText(/DDL|已超期|延期|任务/).first()).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/dashboard", { waitUntil: "networkidle" });
    await expect(page.getByText("任务看板")).toBeVisible();
    await page.getByRole("button", { name: /已超时/ }).first().click();
    await expect(
      page.getByRole("link", { name: /PW全功能-逾期任务/ }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: /^高$/ }).click();
    await expect(
      page.getByRole("link", { name: /PW全功能-逾期任务/ }).first(),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/progress/task/${fixtures.taskId}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("PW全功能-逾期任务")).toBeVisible();
    await expect(page.getByText("宣运")).toBeVisible();
    await expect(page.getByText("风险同步", { exact: true })).toBeVisible();
    await expect(page.getByText("PW全功能-活动风险", { exact: true })).toBeVisible();
    await expect(page.getByText(/周报|本周周报/).first()).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/archive", { waitUntil: "networkidle" });
    await expect(page.getByText("归档检索", { exact: true })).toBeVisible();
    await expectHealthyPage(page);
  });

  test("任务详情能通过 live refresh 自动看到风险变化", async ({ page }) => {
    await page.goto(`/progress/task/${fixtures.taskId}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("PW全功能-逾期任务")).toBeVisible();
    const riskNote = `PW全功能-live风险-${Date.now()}`;

    await prisma.task.update({
      where: { id: fixtures.taskId },
      data: {
        riskNote,
        riskUpdatedAt: new Date(),
      },
    });

    await expect(page.getByText(`最新风险：${riskNote}`)).toBeVisible({
      timeout: 15000,
    });
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
});

test.describe("管理员面板", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await loginAsAdminUser(context, baseURL);
  });

  test("管理员首页和六个子面板都能进入", async ({ page }) => {
    await page.goto("/admin", { waitUntil: "networkidle" });
    await expect(page.getByRole("main").getByText("管理员面板")).toBeVisible();
    await expect(page.getByText("通讯录用户")).toBeVisible();
    await expectHealthyPage(page);

    const panels = [
      { name: /系统同步/, url: /\/admin\/system$/, text: /飞书|同步|通讯录/ },
      { name: /用户与角色/, url: /\/admin\/roles$/, text: /角色|用户/ },
      { name: /采购预算池/, url: /\/admin\/budget-pools$/, text: /预算|导入/ },
      { name: /进度提醒/, url: /\/admin\/reminders$/, text: /提醒|扫描|outbox/i },
      { name: /项目模板/, url: /\/admin\/project-templates$/, text: /模板|阶段/ },
      { name: /验收条例/, url: /\/admin\/acceptance$/, text: /验收|条例/ },
    ];

    for (const panel of panels) {
      await page.goto("/admin", { waitUntil: "networkidle" });
      await page.getByRole("link", { name: panel.name }).last().click();
      await expect(page).toHaveURL(panel.url);
      await expect(page.getByText(panel.text).first()).toBeVisible();
      await expectHealthyPage(page);
    }
  });

  test("管理员可进入新建项目页并触发表单校验", async ({ page }) => {
    await page.goto("/progress/new", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "提交立项" })).toBeVisible();
    await expect(page.getByText("项目名称", { exact: true })).toBeVisible();
    await expect(page.getByText("本阶段耗时（天）").first()).toBeVisible();
    await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);

    const stageCards = page.getByTestId("project-stage-editor");
    await stageCards.nth(0).getByLabel("阶段 1 耗时").fill("2");
    await stageCards.nth(1).getByLabel("阶段 2 耗时").fill("5");
    await stageCards.nth(2).getByLabel("阶段 3 耗时").fill("1");
    await expect(stageCards.nth(0)).toContainText("累计第 2 天");
    await expect(stageCards.nth(1)).toContainText("累计第 7 天");
    await expect(stageCards.nth(2)).toContainText("累计第 8 天");

    await dragCardTo(page, stageCards.nth(2), stageCards.nth(0));
    await expect(stageCards.nth(0)).toContainText("累计第 1 天");
    await expect(stageCards.nth(1)).toContainText("累计第 3 天");
    await expect(stageCards.nth(2)).toContainText("累计第 8 天");

    await page.getByRole("button", { name: /提交立项|保存/ }).first().click();
    await expect(page.getByText(/项目名称|负责人|阶段|请选择/).first()).toBeVisible();
    await expectHealthyPage(page);
  });

  test("管理员可查看详情、排序并删除非默认项目模板", async ({ page }) => {
    const templateName = `PW全功能-模板管理-${Date.now()}`;
    await prisma.projectTemplate.deleteMany({ where: { name: templateName } });

    await page.goto("/admin/project-templates", { waitUntil: "networkidle" });
    await expect(page.getByTestId("project-template-list")).toBeVisible();
    await expect(page.getByTestId("project-template-detail-card")).toBeVisible();
    await expect(page.getByRole("button", { name: /删除/ }).first()).toBeDisabled();

    await page.getByRole("button", { name: "新建模板" }).click();
    await page.getByLabel("模板名称").fill(templateName);
    await page.getByLabel("模板描述").fill("PW全功能-模板管理描述");
    await page.getByLabel("阶段 1 名称").fill("模板阶段 A");
    await page.getByLabel("阶段 1 耗时").fill("2");
    await page.getByLabel("阶段 1 目标").fill("A goal");
    await page.getByLabel("阶段 2 名称").fill("模板阶段 B");
    await page.getByLabel("阶段 2 耗时").fill("5");
    await page.getByLabel("阶段 2 目标").fill("B goal");
    await page.getByLabel("阶段 3 名称").fill("模板阶段 C");
    await page.getByLabel("阶段 3 耗时").fill("1");
    await page.getByLabel("阶段 3 目标").fill("C goal");
    await page.getByRole("button", { name: "创建模板" }).click();
    await expect(page.getByRole("button", { name: new RegExp(templateName) })).toBeVisible();

    await page.getByRole("button", { name: new RegExp(templateName) }).click();
    await page.getByRole("button", { name: "编辑" }).click();
    const templateStageCards = page.getByTestId("project-template-stage-editor");
    await dragCardTo(page, templateStageCards.nth(2), templateStageCards.nth(0));
    await expect(templateStageCards.nth(0).getByLabel("阶段 1 名称")).toHaveValue(
      "模板阶段 C",
    );
    await page.getByRole("button", { name: "保存模板" }).click();

    await expect
      .poll(async () => {
        const template = await prisma.projectTemplate.findUnique({
          where: { name: templateName },
          include: { stages: { orderBy: { sortOrder: "asc" } } },
        });
        return template?.stages.map((stage) => ({
          name: stage.name,
          durationDays: stage.dueOffsetDays,
        }));
      })
      .toEqual([
        { name: "模板阶段 C", durationDays: 1 },
        { name: "模板阶段 A", durationDays: 2 },
        { name: "模板阶段 B", durationDays: 5 },
      ]);

    await page.getByRole("button", { name: new RegExp(templateName) }).click();
    await expect(page.getByTestId("project-template-detail-card")).toContainText(
      "耗时 1 天",
    );
    await page.getByRole("button", { name: "删除" }).click();
    await page.getByRole("button", { name: "删除模板" }).click();

    await expect
      .poll(async () =>
        prisma.projectTemplate.count({ where: { name: templateName } }),
      )
      .toBe(0);
    await expect(page.getByRole("button", { name: new RegExp(templateName) })).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("管理员可手动扫描进度提醒且同日重复扫描不重复入队", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "进度提醒扫描使用全局服务端锁，desktop 已覆盖按钮与幂等行为。",
    );

    const beforeCount = await prisma.notificationOutbox.count({
      where: { channel: "progress", type: "progress_reminder" },
    });

    await page.goto("/admin/reminders", { waitUntil: "networkidle" });
    const firstScanStartedAt = new Date();
    await page.getByRole("button", { name: "立即扫描一次" }).click();

    await expect
      .poll(async () => {
        return countEnabledRulesNotRunSince(firstScanStartedAt);
      })
      .toBe(0);
    await expect
      .poll(async () => {
        return prisma.notificationOutbox.count({
          where: { channel: "progress", type: "progress_reminder" },
        });
      })
      .toBeGreaterThan(beforeCount);
    const afterFirstScanCount = await prisma.notificationOutbox.count({
      where: { channel: "progress", type: "progress_reminder" },
    });

    await expect(page.getByRole("button", { name: "立即扫描一次" })).toBeEnabled();
    await page.waitForTimeout(500);
    await expect
      .poll(async () => {
        return prisma.notificationOutbox.count({
          where: { channel: "progress", type: "progress_reminder" },
        });
      })
      .toBe(afterFirstScanCount);
    await expectHealthyPage(page);
  });
});

async function dragCardTo(page: Page, source: Locator, target: Locator) {
  const handle = source.locator("[data-sortable-grip]").first();
  await handle.scrollIntoViewIfNeeded();
  const sourceBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("无法定位拖拽阶段卡片");
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + Math.min(12, targetBox.height / 4),
    { steps: 14 },
  );
  await page.mouse.up();
}

async function countEnabledRulesNotRunSince(since: Date): Promise<number> {
  const [enabledCount, scannedCount] = await Promise.all([
    prisma.progressReminderRule.count({ where: { enabled: true } }),
    prisma.progressReminderRule.count({
      where: { enabled: true, lastRunAt: { gte: since } },
    }),
  ]);
  return enabledCount - scannedCount;
}

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
