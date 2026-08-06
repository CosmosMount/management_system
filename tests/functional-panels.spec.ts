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
      page.getByRole("link", { name: /项目管理/ }).first(),
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
      .getByRole("link", {
        name: /项目管理 Task 工作台、人员计划与站内通知/,
      })
      .click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/task/legacy-task", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/progress\/tasks\/legacy-task$/);
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/kanban", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/projects/legacy-project", {
      waitUntil: "networkidle",
    });
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
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

  test("旧项目访问禁用页已移除", async ({ page }) => {
    const response = await page.goto("/project-access-disabled");
    expect(response?.status()).toBe(404);
  });
});

test.describe("管理员面板", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await loginAsAdminUser(context, baseURL);
  });

  test("管理员首页和三个子面板都能进入", async ({ page }) => {
    await page.goto("/admin", { waitUntil: "networkidle" });
    await expect(page.getByRole("main").getByText("管理员面板")).toBeVisible();
    await expect(page.getByText("统一账号")).toBeVisible();
    await expectHealthyPage(page);

    const panels = [
      { name: /系统同步/, url: /\/admin\/system$/, text: /飞书|同步|通讯录/ },
      { name: /账号与权限/, url: /\/admin\/accounts$/, text: /账号|权限/ },
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

  test("账号与权限页只授予全局项目角色且没有项目访问状态入口", async ({ page }) => {
    await page.goto("/admin/accounts?q=lqx", { waitUntil: "networkidle" });
    if ((page.viewportSize()?.width ?? 0) < 768) {
      const accountCard = page.getByRole("button", { name: "管理 李棋轩" });
      await expect(accountCard).toBeVisible();
      await accountCard.click();
    } else {
      await expect(page.getByText("李棋轩").first()).toBeVisible();
      await page.getByRole("button", { name: "管理" }).first().click();
    }
    const detail = page.getByTestId("account-permission-detail");
    await expect(detail).toBeVisible();

    await expect(page.getByLabel("项目角色").locator("option")).toHaveText([
      "超级管理员",
      "项目管理员",
    ]);
    await page.getByLabel("项目角色").selectOption("PROJECT_ADMINISTRATOR");
    await page.getByRole("button", { name: /授予$/ }).click();
    await expect(detail.getByText("项目管理员").first()).toBeVisible();

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

    await expect(page.getByText("项目访问状态")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "禁用项目访问" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "启用项目访问" })).toHaveCount(0);

    page.once("dialog", (dialog) => dialog.accept());
    await detail.getByRole("button", { name: "撤销项目管理员" }).click();
    await expect(detail.getByText("普通成员（无系统角色）")).toBeVisible();
    await expectHealthyPage(page);
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
