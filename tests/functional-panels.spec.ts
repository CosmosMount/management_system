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

    await accountsCard.getByRole("button", { name: "查看记录" }).click();
    const historyDialog = page.getByTestId("account-history-dialog");
    await expect(historyDialog).toBeVisible();
    await expect(historyDialog.getByText("项目管理员").first()).toBeVisible();
    await expect(historyDialog.getByText(/授予项目角色/).first()).toBeVisible();
    await expect(historyDialog.getByText(/撤销项目角色/).first()).toBeVisible();
    await expectHealthyPage(page);
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
      await page.goto(`/admin/accounts?q=${encodeURIComponent(suffix)}`, {
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
      await accountSelect.fill(suffix);
      await page.getByRole("option", { name: displayName, exact: true }).click();
      await accountsCard
        .getByRole("combobox", { name: "选择角色" })
        .click();
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
    await financePicker.fill("李棋轩");
    await page.getByRole("option", { name: "李棋轩", exact: true }).click();
    await page.getByRole("button", { name: "添加工程报销员" }).click();
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
      await emailInput.fill(`  ${normalizedEmail.toUpperCase()}  `);
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
