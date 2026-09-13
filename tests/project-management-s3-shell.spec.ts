// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { createTaskDraft } from "../lib/project-management/application/lifecycle-service";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";
import { createAccountPerson, grantRole } from "./helpers/project-management-ui-fixtures";

test.describe("project management S3 shell", { tag: "@smoke" }, () => {
  test("窄窗口仍使用完整侧栏、导航和时间线", async ({ context, page, baseURL }) => {
    const fixture = await createShellFixture();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await loginAsTestUser(context, baseURL, {
      openId: fixture.openId,
      name: fixture.displayName,
    });
    for (const width of [1440, 560]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/progress");
      const sidebar = page.getByTestId("project-management-sidebar");
      await expect(sidebar).toBeVisible();
      await expect(sidebar.getByRole("link", { name: "会议", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "个人中心", exact: true }).first()).toBeVisible();
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
      await page.getByRole("button", { name: "折叠项目管理导航" }).click();
      await expect(sidebar).toHaveCSS("width", "64px");
      await page.getByRole("button", { name: "展开项目管理导航" }).focus();
      await page.getByRole("button", { name: "展开项目管理导航" }).press("Enter");
      await expect(sidebar).toHaveCSS("width", "224px");
      await sidebar.getByRole("link", { name: "会议", exact: true }).click();
      await expect(page).toHaveURL(/\/progress\/meetings(?:\?|$)/);
      await expectHealthyPage(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  test("shared sidebar keep navigation accessible and healthy", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createShellFixture();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.openId,
      name: fixture.displayName,
    });

    await page.goto("/progress");
    await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
    await expectHealthyPage(page);

    {
      const sidebar = page.getByTestId("project-management-sidebar");
      const navigation = page.getByRole("navigation", {
        name: "项目管理导航",
      });
      await expect(sidebar).toBeVisible();
      await expect(
        navigation.getByRole("link", { name: "工作台" }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        navigation.getByRole("link", {
          name: `通知，${fixture.unreadCount} 条未读`,
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          navigation.locator("a").evaluateAll((links) =>
            links.map((link) => link.getAttribute("href")),
          ),
        )
        .toEqual([
          "/progress",
          "/progress/projects",
          "/progress/tasks",
          "/progress/meetings",
          "/progress/approvals",
          "/progress/resources",
          "/progress/kanban",
          "/progress/notifications",
        ]);
      for (const group of ["工作空间", "团队排期", "消息中心"]) {
        await expect(navigation.getByText(group, { exact: true })).toBeVisible();
      }

      const collapseButton = page.getByRole("button", {
        name: "折叠项目管理导航",
      });
      await collapseButton.focus();
      await page.keyboard.press("Enter");
      await expect(sidebar).toHaveAttribute("data-state", "collapsed");
      await expect(
        page.getByRole("button", { name: "展开项目管理导航" }),
      ).toBeFocused();

      await navigation.getByRole("link", { name: "任务", exact: true }).click();
      await expect(page).toHaveURL(/\/progress\/tasks$/);
      await expect(
        navigation.getByRole("link", { name: "任务", exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(
      page
        .getByTestId("project-management-command-bar")
        .getByRole("heading", { name: fixture.taskTitle, exact: true }),
    ).toBeVisible();
    {
      await expect(
        page
          .getByTestId("project-management-sidebar")
          .getByRole("link", { name: "任务", exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }
    await expectHealthyPage(page);
    const commandBar = page.getByTestId("project-management-command-bar");
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    await page.getByTestId("task-plan-view").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    await expect(page.getByTestId(`time-canvas-row-header-plan:${fixture.taskId}`)).toContainText("计划轨道 · 草稿");
    await expect(commandBar.getByRole("navigation", { name: "面包屑" }).getByRole("link", { name: "任务", exact: true })).toHaveAttribute("href", "/progress/tasks");
    const heading = commandBar.getByRole("heading", { name: fixture.taskTitle, exact: true });
    await expect.poll(() => heading.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(64);
    const collapsedHeight = await heading.evaluate((element) => element.getBoundingClientRect().height);
    await commandBar.getByRole("button", { name: "展开完整标题" }).click();
    await expect(commandBar.getByRole("button", { name: "收起完整标题" })).toHaveAttribute("aria-expanded", "true");
    await expect(heading).toHaveText(fixture.taskTitle);
    await expect.poll(() => heading.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight);
    await commandBar.getByRole("button", { name: "收起完整标题" }).click();
    await expect.poll(() => heading.evaluate((element) => element.getBoundingClientRect().height)).toBe(collapsedHeight);
    await expect(commandBar.getByRole("button", { name: "展开完整标题" })).toBeFocused();
    await expectHealthyPage(page);

    await page.goto(`/progress/tasks/${randomUUID()}`);
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
    await expect(page.getByText(fixture.taskTitle)).toHaveCount(0);
    await expectHealthyPage(page);
    expect(browserErrors).toEqual([
      "Failed to load resource: the server responded with a status of 404 (Not Found)",
    ]);
    browserErrors.length = 0;

    for (const route of [
      "/progress",
      "/progress/tasks",
      "/progress/resources",
      "/progress/notifications",
    ]) {
      await page.goto(route);
      await expect(
        page.getByTestId("project-management-command-bar"),
      ).toBeVisible();
      await expectHealthyPage(page);
    }

    const removedConflictRoute = await context.request.get(
      "/progress/resources/conflicts",
    );
    expect(removedConflictRoute.status()).toBe(404);

    expect(browserErrors).toEqual([]);
  });

  test("统一布局中的超长标题仍可展开和收起", async ({ context, page, baseURL }) => {
    const title = "需要确认接口和安全联锁的任务标题".repeat(10);
    const fixture = await createShellFixture(title);
    await loginAsTestUser(context, baseURL, { openId: fixture.openId, name: fixture.displayName });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    const commandBar = page.getByTestId("project-management-command-bar");
    const heading = commandBar.getByRole("heading", { name: title, exact: true });
    for (const width of [1440, 393]) {
      await page.setViewportSize({ width, height: 1000 });
      const expand = commandBar.getByRole("button", { name: "展开完整标题" });
      await expect(expand).toBeVisible();
      const clippedHeight = await heading.evaluate((element) => element.getBoundingClientRect().height);
      await expand.click();
      await expect.poll(() => heading.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(clippedHeight);
      await commandBar.getByRole("button", { name: "收起完整标题" }).click();
      await expect.poll(() => heading.evaluate((element) => element.getBoundingClientRect().height)).toBe(clippedHeight);
      await expect(expand).toBeFocused();
    }
    await expectHealthyPage(page);
  });

  test("notification settings are separate, preserve filters and keep disabled accounts read-only", async ({ context, page, baseURL }) => {
    const user = await createAccountPerson(`通知设置用户 ${randomUUID()}`);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
    await page.goto("/progress/notifications?category=TASK&unread=1");
    await expect(page.getByText("当前没有站内通知。", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "通知偏好" })).toHaveCount(0);
    const views = page.getByRole("navigation", { name: "通知页面" });
    await views.getByRole("link", { name: "通知设置" }).click();
    await expect(page.getByRole("heading", { name: "通知设置", exact: true })).toBeVisible();
    await expect(views.getByRole("link", { name: "通知设置" })).toHaveAttribute("aria-current", "page");
    expect(new URL(page.url()).searchParams.get("category")).toBe("TASK");
    expect(new URL(page.url()).searchParams.get("unread")).toBe("1");
    await expect(page.getByRole("button", { name: "全部已读" })).toHaveCount(0);
    const checkbox = page.getByRole("checkbox", { name: "任务飞书通知", exact: true });
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(page.getByRole("status")).toContainText("通知偏好已保存");
    await expect.poll(async () => (await prisma.notificationPreference.findUnique({
      where: { accountId_category_channel: { accountId: user.account.id, category: "TASK", channel: "FEISHU" } },
    }))?.enabled).toBe(false);
    await views.getByRole("link", { name: "通知列表" }).click();
    await expect(page).toHaveURL(/notifications\?category=TASK&unread=1$/);
    await page.goBack();
    await expect(checkbox).not.toBeChecked();
    await page.reload();
    await expect(checkbox).not.toBeChecked();

    await page.route("**/progress/notifications*", async (route) => {
      if (route.request().method() === "POST") await route.abort("failed");
      else await route.continue();
    });
    await checkbox.check();
    await expect(page.getByRole("status")).toContainText("网络异常，偏好未保存。");
    await expect(checkbox).not.toBeChecked();
    await page.unroute("**/progress/notifications*");
    await checkbox.check();
    await expect(page.getByRole("status")).toContainText("通知偏好已保存");

    await prisma.person.update({ where: { id: user.person.id }, data: { status: "INACTIVE" } });
    await page.reload();
    await expect(page.getByText("人员已停用，通知偏好仅供查看。", { exact: true })).toBeVisible();
    for (const preference of await page.getByRole("checkbox").all()) await expect(preference).toBeDisabled();
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);
  });

  test("long notification content and compact navigation stay reachable", async ({ context, page, baseURL }) => {
    const user = await createAccountPerson(`长内容用户 ${randomUUID()}`);
    const title = "超长通知标题".repeat(30);
    await prisma.inAppNotification.create({ data: {
      eventKey: `shell-long-notification-${randomUUID()}`,
      recipientAccountId: user.account.id,
      category: "TASK",
      title,
      summary: "无空格长通知摘要".repeat(100),
      entityType: "Task",
      entityId: randomUUID(),
      linkPath: "/progress/tasks",
      payload: {},
    } });
    await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expectHealthyPage(page);

  });
});

async function createShellFixture(requestedTitle?: string) {
  const administrator = await createAccountPerson(`Shell 独立审批管理员 ${randomUUID()}`);
  await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
  const openId = `ou_pm_s3_shell_${randomUUID()}`;
  const displayName = "S3 Shell 用户";
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
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("S3 Shell 测试账号缺少 Person");
  const taskTitle = requestedTitle ?? `超长 Task 标题 ${"用于验证命令栏不会撑破页面边界".repeat(8)}`;
  const plannedStartAt = new Date("2026-08-01T00:00:00.000+08:00");
  const task = await createTaskDraft(
    shellActor({
      accountId: account.id,
      personId: account.person.id,
      openId,
    }),
    {
      title: taskTitle,
      description: "S3 Shell 长标题与路由归属测试",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      members: [{ personId: account.person.id, role: "OWNER" }],
      plannedStartAt: plannedStartAt.toISOString(),
      milestones: [
        {
          goal: "验证 Shell",
          completionCriteria: "桌面与移动导航均可使用",
          expectedCompletedAt: new Date(
            "2026-08-02T00:00:00.000+08:00",
          ).toISOString(),
          reviewRequirements: "自动化测试通过",
          businessDescription: "Shell 测试节点",
        },
      ],
      termination: {
        name: "Terminal",
        plannedOutcomeCriteria: "Shell 验证完成",
        plannedAt: new Date(
          "2026-08-03T00:00:00.000+08:00",
        ).toISOString(),
        businessDescription: "结束测试",
      },
      idempotencyKey: `s3-shell-${randomUUID()}`,
    },
  );
  await prisma.inAppNotification.create({
    data: {
      eventKey: `s3-shell-notification-${randomUUID()}`,
      recipientAccountId: account.id,
      category: "TASK",
      title: "S3 Shell 未读通知",
      summary: "用于验证模块导航未读计数",
      entityType: "Task",
      entityId: task.taskId,
      taskId: task.taskId,
      linkPath: `/progress/tasks/${task.taskId}`,
      payloadVersion: 1,
      payload: {},
    },
  });
  const unreadCount = await prisma.inAppNotification.count({
    where: { recipientAccountId: account.id, readAt: null },
  });

  return {
    openId,
    displayName,
    taskId: task.taskId,
    taskTitle,
    unreadCount,
  };
}

function shellActor(input: {
  accountId: string;
  personId: string;
  openId: string;
}): ProjectManagementActor {
  return {
    ...input,
    unionId: null,
    systemRoles: [],
  };
}
