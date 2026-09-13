// @playwright-project ui
import { expect, test } from "@playwright/test";
import {
  ensureFallbackAdminFixture,
  expectHealthyPage,
  loginAsAdminUser,
} from "./helpers/functional-fixtures";
import { prisma } from "../lib/prisma";

test.describe("采购管理侧栏", { tag: "@smoke" }, () => {
  test("默认进入看板且统一侧栏可用", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await ensureFallbackAdminFixture();
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { openId: "ou_playwright_admin" },
      select: { id: true },
    });
    const order = await prisma.purchaseOrder.create({
      data: {
        orderNo: `PW-SHELL-${testInfo.project.name}-${Date.now()}`,
        initiatorId: adminUser.id,
        initiatorName: "Playwright 管理员",
        team: "英雄",
        techGroup: "电控",
        totalPrice: 12.5,
        status: "DRAFT",
        items: {
          create: {
            name: "采购命令栏测试明细",
            spec: "PW-SHELL-SPEC",
            purchaseLink: "https://example.com/procurement-shell",
            quantity: 1,
            unitPrice: 12.5,
          },
        },
      },
    });
    try {
      await loginAsAdminUser(context, baseURL);

      await page.goto("/procurement", { waitUntil: "networkidle" });
      await expect.poll(() => new URL(page.url()).pathname).toBe(
        "/procurement/dashboard",
      );
      await expect(page.getByRole("heading", { name: "采购看板" })).toBeVisible();
      await expect(page.getByTestId("procurement-command-bar")).toContainText(
        "采购管理",
      );
      await expect(
        page.getByRole("link", { name: /^返回/ }),
      ).toHaveCount(0);
      await expect(page.getByRole("main")).toHaveCount(1);
      await expectHealthyPage(page);

      {
        const sidebar = page.getByTestId("procurement-sidebar");
        const navigation = page.getByRole("navigation", {
          name: "采购管理导航",
        });
        await expect(sidebar).toBeVisible();
        await expect(
          navigation.getByRole("link", { name: "采购看板" }),
        ).toHaveAttribute("aria-current", "page");
        await expect
          .poll(() =>
            navigation.locator("a").evaluateAll((links) =>
              links.map((link) => link.getAttribute("href")),
            ),
          )
          .toEqual([
            "/procurement/dashboard",
            "/procurement/summary",
            "/procurement/pending",
            "/procurement/new",
            "/procurement/list",
          ]);
        await expect(
          navigation.getByRole("link", { name: "工坊加工费" }),
        ).toHaveCount(0);

        const collapseButton = page.getByRole("button", {
          name: "折叠采购管理导航",
        });
        await collapseButton.focus();
        await page.keyboard.press("Enter");
        await expect(sidebar).toHaveAttribute("data-state", "collapsed");
        await expect(
          page.getByRole("button", { name: "展开采购管理导航" }),
        ).toBeFocused();

        await navigation.getByRole("link", { name: "待办与最近" }).click();
        await expect(page).toHaveURL(/\/procurement\/pending$/);
        await expect(
          navigation.getByRole("link", { name: "待办与最近" }),
        ).toHaveAttribute("aria-current", "page");
      }

      for (const panel of [
        { path: "/procurement/dashboard", heading: "采购看板" },
        { path: "/procurement/summary", heading: "明细汇总" },
        { path: "/procurement/pending", heading: "待办与最近" },
        { path: "/procurement/new", heading: "采购申请" },
        { path: "/procurement/list", heading: "订单列表" },
      ]) {
        await page.goto(panel.path, { waitUntil: "networkidle" });
        const commandBar = page.getByTestId("procurement-command-bar");
        await expect(commandBar).toBeVisible();
        await expect(commandBar).toContainText("采购管理");
        await expect(
          commandBar.getByRole("heading", { name: panel.heading }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: /^返回/ }),
        ).toHaveCount(0);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth + 1,
          ),
        ).toBe(true);
      }

      await page.goto(`/procurement/${order.id}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("main")).toHaveCount(1);
      const detailCommandBar = page.getByTestId("procurement-command-bar");
      await expect(detailCommandBar).toBeVisible();
      await expect(
        detailCommandBar.getByRole("heading", {
          name: `订单 ${order.orderNo}`,
        }),
      ).toBeVisible();
      await expect(
        detailCommandBar.getByText("草稿", { exact: true }),
      ).toBeVisible();
      await expect(
        detailCommandBar.getByRole("link", { name: "继续编辑" }),
      ).toBeVisible();
      await expect(
        detailCommandBar.getByRole("button", { name: "提交申请" }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: /^返回/ })).toHaveCount(0);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);

      {
        await expect(
          page
            .getByTestId("procurement-sidebar")
            .getByRole("link", { name: "订单列表" }),
        ).toHaveAttribute("aria-current", "page");
      }

      await page.goto(`/procurement/${order.id}/edit`, {
        waitUntil: "networkidle",
      });
      const editCommandBar = page.getByTestId("procurement-command-bar");
      await expect(editCommandBar).toBeVisible();
      await expect(
        editCommandBar.getByRole("heading", {
          name: `编辑采购清单 ${order.orderNo}`,
        }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: /^返回/ })).toHaveCount(0);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);

      await expectHealthyPage(page);
      expect(browserErrors).toEqual([]);
    } finally {
      await prisma.purchaseOrder.deleteMany({ where: { id: order.id } });
    }
  });
});
