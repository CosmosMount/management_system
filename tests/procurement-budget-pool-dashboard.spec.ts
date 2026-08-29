// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";
import { buildDashboardChartsData } from "../lib/procurement-dashboard-stats";
import {
  getBudgetUsage,
  listBudgetPoolViews,
} from "../lib/procurement-budget";
import { checkBudgetAlertsForGroup } from "../lib/procurement-budget-alerts";
import { prisma } from "../lib/prisma";
import {
  mergeBudgetPoolImportRows,
  parseBudgetPoolsFromBuffer,
} from "../lib/import-procurement-budget";
import {
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

test("预算池看板按兵种组展示项目并汇总总量", () => {
  const data = buildDashboardChartsData(
    [],
    [
      {
        id: "p1",
        description: "第一版整车；减重与重画",
        projects: ["第一版整车", "减重与重画"],
        team: "英雄",
        label: "英雄",
        period: "2026",
        budgetAmount: 1000,
        usedAmount: 200,
        usagePercent: 20,
        lastAlertThreshold: 0,
        poolIds: ["p1", "p2"],
      },
      {
        id: "p3",
        description: "玻纤验证",
        projects: ["玻纤验证"],
        team: "工程",
        label: "工程",
        period: "2026",
        budgetAmount: 500,
        usedAmount: 100,
        usagePercent: 20,
        lastAlertThreshold: 0,
        poolIds: ["p3"],
      },
    ],
    "2026",
  );

  expect(data.budgetPools.map((row) => row.name)).toEqual(["英雄", "工程"]);
  expect(data.budgetPools.map((row) => row.projects)).toEqual([
    ["第一版整车", "减重与重画"],
    ["玻纤验证"],
  ]);
  expect(
    data.budgetPools.reduce((sum, row) => sum + row.budget, 0),
  ).toBe(1500);
  expect(
    data.budgetPools.reduce((sum, row) => sum + row.used, 0),
  ).toBe(300);
});

test("预算池导入不要求技术方向，同兵种组同项目合并", () => {
  const merged = mergeBudgetPoolImportRows([
    {
      description: "减重+重画",
      team: "步兵",
      techGroup: "",
      budgetAmount: 20000,
      period: "2026",
    },
    {
      description: "第一版整车",
      team: "步兵",
      techGroup: "",
      budgetAmount: 13000,
      period: "2026",
    },
    {
      description: "减重+重画",
      team: "步兵",
      techGroup: "",
      budgetAmount: 1000,
      period: "2026",
    },
  ]);
  expect(merged).toEqual([
    {
      description: "减重+重画",
      team: "步兵",
      techGroup: "",
      budgetAmount: 21000,
      period: "2026",
    },
    {
      description: "第一版整车",
      team: "步兵",
      techGroup: "",
      budgetAmount: 13000,
      period: "2026",
    },
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([
    ["项目", "兵种组", "预算", "周期"],
    ["减重+重画", "步兵", 20000, "2026"],
    ["第一版整车", "步兵", 13000, "2026"],
    ["玻纤验证", "哨兵", 8000, "2026"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "预算池");
  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Buffer;
  const parsed = parseBudgetPoolsFromBuffer(Uint8Array.from(buffer).buffer);
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows.map((row) => row.description)).toEqual([
    "减重+重画",
    "第一版整车",
    "玻纤验证",
  ]);
  expect(parsed.rows.every((row) => row.techGroup === "")).toBe(true);
});

test("历史技术方向预算行在读取时合并为一个兵种组", async () => {
  const period = `team-only-${randomUUID()}`;
  try {
    await prisma.procurementBudgetPool.createMany({
      data: [
        {
          description: "第一版整车",
          team: "英雄",
          techGroup: "机械",
          period,
          budgetAmount: 200,
          sortOrder: 0,
        },
        {
          description: "减重与重画",
          team: "英雄",
          techGroup: "电控",
          period,
          budgetAmount: 300,
          sortOrder: 1,
        },
      ],
    });

    const views = await listBudgetPoolViews(period);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      team: "英雄",
      label: "英雄",
      projects: ["第一版整车", "减重与重画"],
      budgetAmount: 500,
    });
  } finally {
    await prisma.procurementBudgetPool.deleteMany({ where: { period } });
  }
});

test("旧技术方向高阈值不会抑制兵种组新口径告警", async () => {
  const suffix = randomUUID();
  const team = "雷达";
  const period = `threshold-${suffix}`;
  const openId = `ou_budget_threshold_${suffix}`;
  const orderNo = `BUDGET-THRESHOLD-${suffix}`;
  const eventKey = `procurement:budget:${team}:70:${period}`;
  const originalDeliveryDisabled =
    process.env.NOTIFICATION_DELIVERY_DISABLED;
  let accountId: string | null = null;
  process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
  try {
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
        person: { create: { displayName: "预算阈值组长", status: "ACTIVE" } },
        reimbursementUser: {
          create: { openId, name: "预算阈值组长" },
        },
        reimbursementRoles: {
          create: { openId, role: "TEAM_ADMIN", team, techGroup: "" },
        },
      },
      include: { reimbursementUser: true },
    });
    accountId = account.id;
    if (!account.reimbursementUser) {
      throw new Error("预算告警测试缺少采购用户");
    }
    const existingUsedAmount = await getBudgetUsage(team);
    const groupBudgetAmount = (existingUsedAmount + 75) / 0.75;
    await prisma.procurementBudgetPool.createMany({
      data: [
        {
          description: "整车项目",
          team,
          techGroup: "机械",
          period,
          budgetAmount: groupBudgetAmount / 2,
          lastAlertThreshold: 100,
        },
        {
          description: "减重项目",
          team,
          techGroup: "电控",
          period,
          budgetAmount: groupBudgetAmount / 2,
          lastAlertThreshold: 0,
        },
      ],
    });
    await prisma.purchaseOrder.create({
      data: {
        orderNo,
        initiatorId: account.reimbursementUser.id,
        initiatorName: account.reimbursementUser.name,
        team,
        techGroup: "",
        totalPrice: 75,
        status: "COMPLETED",
      },
    });

    await expect(checkBudgetAlertsForGroup(team, period)).resolves.toBe(1);
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey },
      select: { payload: true },
    });
    expect(outbox.payload).toContain(openId);
    expect(outbox.payload).not.toContain("机械");
    expect(outbox.payload).not.toContain("电控");
    await expect(
      prisma.procurementBudgetPool.findMany({
        where: { team, period },
        orderBy: { techGroup: "asc" },
        select: { lastAlertThreshold: true },
      }),
    ).resolves.toEqual([
      { lastAlertThreshold: 70 },
      { lastAlertThreshold: 70 },
    ]);
    await expect(checkBudgetAlertsForGroup(team, period)).resolves.toBe(0);
    await expect(listBudgetPoolViews(period)).resolves.toEqual([
      expect.objectContaining({
        team,
        lastAlertThreshold: 70,
      }),
    ]);
  } finally {
    try {
      await prisma.notificationOutbox.deleteMany({ where: { eventKey } });
      await prisma.purchaseOrder.deleteMany({ where: { orderNo } });
      await prisma.procurementBudgetPool.deleteMany({ where: { team, period } });
      if (accountId) {
        await prisma.$transaction([
          prisma.userRole.deleteMany({ where: { accountId } }),
          prisma.user.deleteMany({ where: { accountId } }),
          prisma.accountIdentity.deleteMany({ where: { accountId } }),
          prisma.person.deleteMany({ where: { accountId } }),
          prisma.account.deleteMany({ where: { id: accountId } }),
        ]);
      }
    } finally {
      if (originalDeliveryDisabled === undefined) {
        delete process.env.NOTIFICATION_DELIVERY_DISABLED;
      } else {
        process.env.NOTIFICATION_DELIVERY_DISABLED = originalDeliveryDisabled;
      }
    }
  }
});

test("采购看板预算池按兵种组显示项目与总量", async ({ page, context, baseURL }) => {
  const normalAuth = await resolveNormalAuthMaterial();
  await loginAsNormalUser(context, baseURL, normalAuth);

  await page.goto("/procurement/dashboard", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "采购看板" })).toBeVisible();
  await expect(page.getByText("预算池使用率")).toBeVisible();
  await expect(page.getByText(/按兵种组汇总/)).toBeVisible();

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
