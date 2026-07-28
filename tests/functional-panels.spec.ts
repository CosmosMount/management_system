import { expect, test } from "@playwright/test";
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
      page.getByRole("link", { name: /项目(?:管理（重构中）|重构)/ }).first(),
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
      .getByRole("link", { name: /项目管理（重构中） 旧版功能已下线/ })
      .click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByRole("heading", { name: "项目管理正在重构" })).toBeVisible();
    await expectHealthyPage(page);

    for (const legacyUrl of ["/progress/list", "/progress/task/legacy-task"]) {
      await page.goto(legacyUrl, { waitUntil: "networkidle" });
      await expect(page).toHaveURL(/\/progress$/);
      await expect(
        page.getByRole("heading", { name: "项目管理正在重构" }),
      ).toBeVisible();
      await expectHealthyPage(page);
    }

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

  test("管理员首页和三个子面板都能进入", async ({ page }) => {
    await page.goto("/admin", { waitUntil: "networkidle" });
    await expect(page.getByRole("main").getByText("管理员面板")).toBeVisible();
    await expect(page.getByText("通讯录用户")).toBeVisible();
    await expectHealthyPage(page);

    const panels = [
      { name: /系统同步/, url: /\/admin\/system$/, text: /飞书|同步|通讯录/ },
      { name: /用户与角色/, url: /\/admin\/roles$/, text: /角色|用户/ },
      { name: /采购预算池/, url: /\/admin\/budget-pools$/, text: /预算|导入/ },
    ];

    for (const panel of panels) {
      await page.goto("/admin", { waitUntil: "networkidle" });
      await page.getByRole("link", { name: panel.name }).last().click();
      await expect(page).toHaveURL(panel.url);
      await expect(page.getByText(panel.text).first()).toBeVisible();
      await expectHealthyPage(page);
    }
  });

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
