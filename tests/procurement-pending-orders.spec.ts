import { expect, test } from "@playwright/test";
import { OrderStatus } from "@prisma/client";
import {
  canHandleProcurementOrder,
  getProcurementPendingOrders,
} from "../lib/procurement-pending-orders";
import { getUserRoles } from "../lib/permissions";
import {
  formatPrismaError,
  loginAsAdminUser,
  loginAsNormalUser,
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
  type FunctionalFixtureIds,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

let fixtures: FunctionalFixtureIds;
let normalOpenId: string;
let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;

test.beforeAll(async () => {
  normalAuth = await resolveNormalAuthMaterial();
  normalOpenId = normalAuth.openId;
  try {
    fixtures = await prepareFunctionalFixtures(normalAuth);
  } catch (error) {
    throw new Error(`采购待处理订单 fixture 准备失败：${formatPrismaError(error)}`);
  }
});

test("canHandleProcurementOrder 按当前环节处理人过滤", () => {
  const adminRoles = [
    { role: "TEAM_ADMIN" as const, team: "英雄", techGroup: "" },
    { role: "TECH_GROUP_ADMIN" as const, team: "", techGroup: "电控" },
    { role: "TEACHER" as const, team: "", techGroup: "电控" },
    { role: "FINANCE" as const, team: "英雄", techGroup: "" },
  ];

  expect(
    canHandleProcurementOrder(
      {
        status: OrderStatus.MANAGEMENT_REVIEW,
        team: "英雄",
        techGroup: "电控",
        teamApproved: false,
        techGroupApproved: false,
        initiatorOpenId: normalOpenId,
      },
      "ou_admin",
      adminRoles,
    ),
  ).toBe(true);

  expect(
    canHandleProcurementOrder(
      {
        status: OrderStatus.PENDING_APPLICANT_DOCS,
        team: "英雄",
        techGroup: "电控",
        teamApproved: true,
        techGroupApproved: true,
        initiatorOpenId: normalOpenId,
      },
      normalOpenId,
      [],
    ),
  ).toBe(true);

  expect(
    canHandleProcurementOrder(
      {
        status: OrderStatus.PENDING_APPLICANT_DOCS,
        team: "英雄",
        techGroup: "电控",
        teamApproved: true,
        techGroupApproved: true,
        initiatorOpenId: normalOpenId,
      },
      "ou_other",
      [],
    ),
  ).toBe(false);
});

test("getProcurementPendingOrders 返回当前用户需要处理的订单", async () => {
  const adminRoles = await getUserRoles("ou_playwright_admin");
  const adminPending = await getProcurementPendingOrders({
    userOpenId: "ou_playwright_admin",
    roles: adminRoles,
  });
  const adminOrderNos = adminPending.map((order) => order.orderNo);

  expect(adminOrderNos).toContain("PW-FULL-REVIEW");
  expect(adminOrderNos).toContain("PW-FULL-TEACHER-REJECT");
  expect(adminOrderNos).not.toContain("PW-FULL-REIMBURSE");

  const normalRoles = await getUserRoles(normalOpenId);
  const normalPending = await getProcurementPendingOrders({
    userOpenId: normalOpenId,
    roles: normalRoles,
  });
  const normalOrderNos = normalPending.map((order) => order.orderNo);

  expect(normalOrderNos).toContain("PW-FULL-REIMBURSE");
  expect(normalOrderNos).not.toContain("PW-FULL-REVIEW");
});

test("采购首页展示待处理订单汇总", async ({ page, context, baseURL }) => {
  await loginAsAdminUser(context, baseURL);
  await page.goto("/procurement", { waitUntil: "networkidle" });

  await expect(page.getByText(/待处理订单/)).toBeVisible();
  const pendingList = page.getByTestId("procurement-pending-orders");
  await expect(pendingList.getByRole("link", { name: /PW-FULL-REVIEW/ })).toBeVisible();
  await expect(
    pendingList.getByRole("link", { name: /PW-FULL-TEACHER-REJECT/ }),
  ).toBeVisible();
});

test("采购人首页能看到待上传凭证的订单", async ({ page, context, baseURL }) => {
  await loginAsNormalUser(context, baseURL, normalAuth);
  await page.goto("/procurement", { waitUntil: "networkidle" });

  const pendingList = page.getByTestId("procurement-pending-orders");
  await expect(
    pendingList.getByRole("link", { name: /PW-FULL-REIMBURSE/ }),
  ).toBeVisible();
});
