import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { loginAsTestUser } from "./helpers/functional-fixtures";

test.describe("time segment allocation UI", () => {
  test("我的时间默认从今天开始并可通过滑杆向左进入过去", async ({
    context,
    page,
    baseURL,
  }) => {
    const openId = `ou_pm_timeline_${randomUUID()}`;
    const name = `时间线验收用户 ${randomUUID()}`;
    await prisma.account.create({
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
          create: { displayName: name, status: "ACTIVE" },
        },
      },
    });
    await loginAsTestUser(context, baseURL, { openId, name });

    await page.goto("/progress/my-timeline");
    const dateInput = page.getByLabel("选择日期");
    const initialDate = await dateInput.inputValue();
    expect(initialDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByText("当前没有有效参与的 Task。", { exact: true })).toBeVisible();

    const panBar = page.getByTestId("time-canvas-range-pan-bar");
    await expect(panBar).toBeVisible();
    await panBar.fill("-1");
    await panBar.blur();

    const previousDate = shiftDate(initialDate, -1);
    await expect(page).toHaveURL(new RegExp(`date=${previousDate}`));
    await expect(page.getByLabel("选择日期")).toHaveValue(previousDate);
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});

function shiftDate(date: string, days: number) {
  const value = Date.parse(`${date}T00:00:00.000+08:00`) + days * 24 * 60 * 60 * 1_000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
