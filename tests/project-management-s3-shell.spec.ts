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

test.describe("project management S3 shell", { tag: "@smoke" }, () => {
  test("desktop sidebar and mobile drawer keep navigation accessible and healthy", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
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
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expectHealthyPage(page);

    if (testInfo.project.name === "desktop") {
      const sidebar = page.getByTestId("project-management-sidebar");
      const navigation = page.getByRole("navigation", {
        name: "项目管理导航",
      });
      await expect(sidebar).toBeVisible();
      await expect(
        navigation.getByRole("link", { name: "我的工作" }),
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
          "/progress/kanban",
          "/progress/projects",
          "/progress/tasks",
          "/progress/resources",
          "/progress/approvals",
          "/progress/notifications",
        ]);

      const collapseButton = page.getByRole("button", {
        name: "折叠项目管理导航",
      });
      await collapseButton.focus();
      await page.keyboard.press("Enter");
      await expect(sidebar).toHaveAttribute("data-state", "collapsed");
      await expect(
        page.getByRole("button", { name: "展开项目管理导航" }),
      ).toBeFocused();

      await navigation.getByRole("link", { name: "Task" }).click();
      await expect(page).toHaveURL(/\/progress\/tasks$/);
      await expect(
        navigation.getByRole("link", { name: "Task" }),
      ).toHaveAttribute("aria-current", "page");
    } else {
      await expect(
        page.getByTestId("project-management-sidebar"),
      ).toBeHidden();
      const menuButton = page.getByRole("button", {
        name: "打开项目管理导航",
      });
      await menuButton.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByTestId("project-management-drawer");
      await expect(drawer).toBeVisible();
      await expect(
        drawer.getByRole("heading", { name: "项目管理导航" }),
      ).toBeVisible();
      await expect(
        drawer.getByRole("link", {
          name: `通知，${fixture.unreadCount} 条未读`,
        }),
      ).toBeVisible();
      await expect(
        drawer.getByRole("link", { name: "资源冲突" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "我的工作" }),
      ).toHaveCount(0);

      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(menuButton).toBeFocused();

      await page.keyboard.press("Enter");
      await drawer.getByRole("link", { name: "Task" }).click();
      await expect(page).toHaveURL(/\/progress\/tasks$/);
      await expect(drawer).toBeHidden();
      await expect(
        page.getByTestId("project-management-mobile-bar").getByText("Task"),
      ).toBeVisible();
    }

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(
      page
        .getByTestId("task-workbench-v2")
        .getByRole("heading", { name: fixture.taskTitle, exact: true }),
    ).toBeVisible();
    if (testInfo.project.name === "desktop") {
      await expect(
        page
          .getByTestId("project-management-sidebar")
          .getByRole("link", { name: "Task", exact: true }),
      ).toHaveAttribute("aria-current", "page");
    } else {
      await expect(
        page.getByTestId("project-management-mobile-bar").getByText("Task"),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "打开项目管理导航" })
        .click();
      await expect(
        page
          .getByTestId("project-management-drawer")
          .getByRole("link", { name: "Task" }),
      ).toHaveAttribute("aria-current", "page");
      await page
        .getByRole("button", { name: "关闭项目管理导航" })
        .click();
    }
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
});

async function createShellFixture() {
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
  const taskTitle = `超长 Task 标题 ${"用于验证命令栏不会撑破页面边界".repeat(8)}`;
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
