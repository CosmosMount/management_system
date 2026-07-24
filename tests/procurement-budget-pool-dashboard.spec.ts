import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";
import { buildDashboardChartsData } from "../lib/procurement-dashboard-stats";
import {
  mergeBudgetPoolImportRows,
  parseBudgetPoolsFromBuffer,
} from "../lib/import-procurement-budget";
import {
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

test("预算池看板按项目名展示并汇总总量", () => {
  const data = buildDashboardChartsData(
    [],
    [
      {
        id: "p1",
        description: "英雄电控项目",
        team: "英雄",
        techGroup: "电控",
        label: "英雄 · 电控",
        period: "2026",
        budgetAmount: 1000,
        usedAmount: 200,
        usagePercent: 20,
        lastAlertThreshold: 0,
      },
      {
        id: "p2",
        description: "",
        team: "工程",
        techGroup: "机械",
        label: "工程 · 机械",
        period: "2026",
        budgetAmount: 500,
        usedAmount: 100,
        usagePercent: 20,
        lastAlertThreshold: 0,
      },
    ],
    "2026",
  );

  expect(data.budgetPools.map((row) => row.name)).toEqual([
    "英雄电控项目",
    "工程 · 机械",
  ]);
  expect(data.budgetPools.map((row) => row.groupLabel)).toEqual([
    "英雄 · 电控",
    "工程 · 机械",
  ]);
  expect(
    data.budgetPools.reduce((sum, row) => sum + row.budget, 0),
  ).toBe(1500);
  expect(
    data.budgetPools.reduce((sum, row) => sum + row.used, 0),
  ).toBe(300);
});

test("预算池导入按项目分行，同组不同项目不合并", () => {
  const merged = mergeBudgetPoolImportRows([
    {
      description: "减重+重画",
      team: "步兵",
      techGroup: "机械",
      budgetAmount: 20000,
      period: "2026",
    },
    {
      description: "第一版整车",
      team: "步兵",
      techGroup: "机械",
      budgetAmount: 13000,
      period: "2026",
    },
    {
      description: "减重+重画",
      team: "步兵",
      techGroup: "机械",
      budgetAmount: 1000,
      period: "2026",
    },
  ]);
  expect(merged).toEqual([
    {
      description: "减重+重画",
      team: "步兵",
      techGroup: "机械",
      budgetAmount: 21000,
      period: "2026",
    },
    {
      description: "第一版整车",
      team: "步兵",
      techGroup: "机械",
      budgetAmount: 13000,
      period: "2026",
    },
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([
    ["项目", "车组", "技术组", "预算", "周期"],
    ["减重+重画", "步兵", "机械", 20000, "2026"],
    ["第一版整车", "步兵", "机械", 13000, "2026"],
    ["玻纤验证", "哨兵", "机械", 8000, "2026"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "预算池");
  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Buffer;
  const parsed = parseBudgetPoolsFromBuffer(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows.map((row) => row.description)).toEqual([
    "减重+重画",
    "第一版整车",
    "玻纤验证",
  ]);
});

test("采购看板预算池显示项目名与总量", async ({ page, context, baseURL }) => {
  const normalAuth = await resolveNormalAuthMaterial();
  await loginAsNormalUser(context, baseURL, normalAuth);

  await page.goto("/procurement/dashboard", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "采购看板" })).toBeVisible();
  await expect(page.getByText("预算池使用率")).toBeVisible();
  await expect(page.getByText(/按项目展示/)).toBeVisible();

  const totals = page.getByTestId("procurement-budget-pool-totals");
  const rows = page.getByTestId("procurement-budget-pool-row");
  if ((await rows.count()) > 0) {
    await expect(totals).toBeVisible();
    await expect(totals.getByText("预算池总量")).toBeVisible();
    await expect(totals.getByText(/\//)).toBeVisible();
  } else {
    await expect(page.getByText(/暂无预算池/)).toBeVisible();
  }
});
