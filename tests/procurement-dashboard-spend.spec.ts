import { expect, test } from "@playwright/test";
import { buildDashboardChartsData } from "../lib/procurement-dashboard-stats";
import {
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

test("看板支出统计同时提供已完成与全部已提交口径", () => {
  const now = new Date("2026-07-24T10:00:00.000Z");
  const data = buildDashboardChartsData([
    {
      id: "o1",
      orderNo: "PW-SPEND-1",
      initiatorName: "甲",
      team: "英雄",
      techGroup: "电控",
      status: "COMPLETED",
      totalPrice: 100,
      statusEnteredAt: now,
    },
    {
      id: "o2",
      orderNo: "PW-SPEND-2",
      initiatorName: "乙",
      team: "工程",
      techGroup: "机械",
      status: "MANAGEMENT_REVIEW",
      totalPrice: 50,
      statusEnteredAt: now,
    },
    {
      id: "o3",
      orderNo: "PW-SPEND-3",
      initiatorName: "丙",
      team: "英雄",
      techGroup: "电控",
      status: "DRAFT",
      totalPrice: 999,
      statusEnteredAt: now,
    },
    {
      id: "o4",
      orderNo: "PW-SPEND-4",
      initiatorName: "丁",
      team: "英雄",
      techGroup: "电控",
      status: "REJECTED",
      totalPrice: 888,
      statusEnteredAt: now,
    },
  ]);

  expect(data.spendByScope.completed.total).toBe(100);
  expect(data.spendByScope.all.total).toBe(150);
  expect(data.completedTotal).toBe(100);
  expect(data.activeOrderCount).toBe(1);
  expect(data.spendByScope.completed.teamSpending.map((s) => s.label)).toEqual([
    "英雄",
  ]);
  expect(data.spendByScope.all.teamSpending.map((s) => s.label).sort()).toEqual(
    ["工程", "英雄"].sort(),
  );
});

test("采购看板可切换仅已完成与全部支出", async ({ page, context, baseURL }) => {
  const normalAuth = await resolveNormalAuthMaterial();
  await loginAsNormalUser(context, baseURL, normalAuth);

  await page.goto("/procurement/dashboard", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "采购看板" })).toBeVisible();
  await expect(page.getByTestId("procurement-spend-total-label")).toHaveText(
    "已完成支出",
  );

  const completedText = await page
    .getByTestId("procurement-spend-total")
    .innerText();

  await page.getByTestId("procurement-spend-scope").click();
  await page.getByRole("option", { name: "全部已提交" }).click();

  await expect(page.getByTestId("procurement-spend-total-label")).toHaveText(
    "全部支出",
  );
  await expect(page.getByText("支出统计口径：全部已提交")).toBeVisible();

  const allText = await page.getByTestId("procurement-spend-total").innerText();
  const parseMoney = (text: string) => Number(text.replace(/[¥,\s]/g, ""));
  expect(parseMoney(allText)).toBeGreaterThanOrEqual(parseMoney(completedText));

  await page.getByTestId("procurement-spend-scope").click();
  await page.getByRole("option", { name: "仅已完成" }).click();
  await expect(page.getByTestId("procurement-spend-total-label")).toHaveText(
    "已完成支出",
  );
});
