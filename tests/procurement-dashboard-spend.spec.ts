// @playwright-project ui
import { expect, test } from "@playwright/test";
import { buildDashboardChartsData } from "../lib/procurement-dashboard-stats";
import {
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

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

test("采购看板状态分布与通知使用相同的责任人文案", () => {
  const now = new Date("2026-07-24T10:00:00.000Z");
  const statuses = [
    "PENDING_APPLICANT_DOCS",
    "PENDING_FINANCE_REVIEW",
    "PENDING_APPLICANT_CONFIRM",
  ] as const;
  const data = buildDashboardChartsData(
    statuses.map((status, index) => ({
      id: `status-${index}`,
      orderNo: `PW-STATUS-${index}`,
      initiatorName: "测试申请人",
      team: "英雄",
      techGroup: "电控",
      status,
      totalPrice: 100,
      statusEnteredAt: now,
    })),
    [],
    "",
    new Map(statuses.map((_, index) => [`status-${index}`, "当前处理人"])),
  );

  expect(data.statusDistribution.map((slice) => slice.label).sort()).toEqual(
    ["待申请人上传凭证", "待报销员处理", "待申请人确认"].sort(),
  );
  expect(data.delayRanking.map((row) => row.sublabel).join("\n")).toContain(
    "待报销员处理 · 处理人：当前处理人",
  );
  expect(data.delayRanking.map((row) => row.sublabel).join("\n")).not.toContain(
    "待报销截图",
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
