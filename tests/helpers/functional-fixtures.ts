import fs from "node:fs";
import path from "node:path";
import { decode, encode } from "@auth/core/jwt";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { Cookie } from "@playwright/test";
import {
  FeedbackStatus,
  FileAssetKind,
  OrderStatus,
  Prisma,
  UserRoleType,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { resolveFeishuIdentityForUser } from "../../lib/project-management/identity";
import { storagePathToAbsolute } from "../../lib/upload-paths";

const SESSION_COOKIE_NAME = "authjs.session-token";
const TEST_PREFIX = "PW全功能";
const FALLBACK_NORMAL_OPEN_ID = "ou_playwright_liqixuan";
const FALLBACK_NORMAL_UNION_ID = "on_playwright_liqixuan";
const FALLBACK_ADMIN_OPEN_ID = "ou_playwright_admin";
const FALLBACK_ADMIN_UNION_ID = "on_playwright_admin";
const FALLBACK_OTHER_OPEN_ID = "ou_playwright_other";
const FALLBACK_OTHER_UNION_ID = "on_playwright_other";
const FALLBACK_NORMAL_NAME = "李棋轩";
const FALLBACK_ADMIN_NAME = "Playwright 管理员";
const FALLBACK_OTHER_NAME = "Playwright 旁观者";
const NORMAL_SIGNATURE_PUBLIC_PATH = "/uploads/playwright/signature-normal.png";
const ADMIN_SIGNATURE_PUBLIC_PATH = "/uploads/playwright/signature-admin.png";
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

type AuthMaterial = {
  openId: string;
  name: string;
  cookies?: Cookie[];
};

export type FunctionalFixtureIds = {
  normalOpenId: string;
  adminOpenId: string;
  otherOpenId: string;
  draftOrderId: string;
  reviewOrderId: string;
  managementRejectOrderId: string;
  teacherRejectOrderId: string;
  reimbursementOrderId: string;
  uploadPublicPath: string;
  openFeedbackId: string;
  closedFeedbackId: string;
};

export async function resolveNormalAuthMaterial(): Promise<AuthMaterial> {
  if (process.env.PLAYWRIGHT_USE_STORAGE_NORMAL === "true") {
    const storagePath =
      process.env.PLAYWRIGHT_NORMAL_STORAGE_STATE ??
      path.join(process.cwd(), ".tmp/playwright-liqixuan-storage.json");
    const storage = readStorageState(storagePath);
    if (!storage) {
      throw new Error(
        `PLAYWRIGHT_USE_STORAGE_NORMAL=true 但无法读取 storage state: ${storagePath}`,
      );
    }
    const openId = await readOpenIdFromStorageState(storage.cookies);
    if (!openId) {
      throw new Error(
        `PLAYWRIGHT_USE_STORAGE_NORMAL=true 但 storage state 未包含有效 openId: ${storagePath}`,
      );
    }
    return { openId, name: FALLBACK_NORMAL_NAME, cookies: storage.cookies };
  }

  return { openId: FALLBACK_NORMAL_OPEN_ID, name: FALLBACK_NORMAL_NAME };
}

export async function ensureFallbackAdminFixture(): Promise<void> {
  assertTestDatabase();
  const identity = await resolveFeishuIdentityForUser({
    openId: FALLBACK_ADMIN_OPEN_ID,
    unionId: FALLBACK_ADMIN_UNION_ID,
    name: FALLBACK_ADMIN_NAME,
  });
  await prisma.user.upsert({
    where: { openId: FALLBACK_ADMIN_OPEN_ID },
    update: {
      accountId: identity.account.id,
      name: FALLBACK_ADMIN_NAME,
      unionId: FALLBACK_ADMIN_UNION_ID,
      signaturePath: ADMIN_SIGNATURE_PUBLIC_PATH,
    },
    create: {
      accountId: identity.account.id,
      openId: FALLBACK_ADMIN_OPEN_ID,
      unionId: FALLBACK_ADMIN_UNION_ID,
      name: FALLBACK_ADMIN_NAME,
      signaturePath: ADMIN_SIGNATURE_PUBLIC_PATH,
    },
  });
  const existingRole = await prisma.systemRoleAssignment.findFirst({
    where: {
      accountId: identity.account.id,
      role: "SUPER_ADMINISTRATOR",
      revokedAt: null,
    },
  });
  if (!existingRole) {
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: identity.account.id,
        role: "SUPER_ADMINISTRATOR",
      },
    });
  }
}

export async function prepareFunctionalFixtures(
  normalAuth: AuthMaterial,
): Promise<FunctionalFixtureIds> {
  assertTestDatabase();

  const normalOpenId = normalAuth.openId;
  const adminOpenId = FALLBACK_ADMIN_OPEN_ID;
  const otherOpenId = FALLBACK_OTHER_OPEN_ID;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  await cleanupFunctionalFixtures([normalOpenId, adminOpenId, otherOpenId]);
  await createPlaywrightSignatureFiles({ normalOpenId, adminOpenId });

  const [normalIdentity, otherIdentity, adminIdentity] = await Promise.all([
    resolveFeishuIdentityForUser({
      openId: normalOpenId,
      unionId: FALLBACK_NORMAL_UNION_ID,
      name: FALLBACK_NORMAL_NAME,
    }),
    resolveFeishuIdentityForUser({
      openId: otherOpenId,
      unionId: FALLBACK_OTHER_UNION_ID,
      name: FALLBACK_OTHER_NAME,
    }),
    resolveFeishuIdentityForUser({
      openId: adminOpenId,
      unionId: FALLBACK_ADMIN_UNION_ID,
      name: FALLBACK_ADMIN_NAME,
    }),
  ]);

  await Promise.all([
    prisma.user.upsert({
      where: { openId: normalOpenId },
      update: {
        accountId: normalIdentity.account.id,
        name: FALLBACK_NORMAL_NAME,
        unionId: FALLBACK_NORMAL_UNION_ID,
        signaturePath: NORMAL_SIGNATURE_PUBLIC_PATH,
      },
      create: {
        accountId: normalIdentity.account.id,
        openId: normalOpenId,
        unionId: FALLBACK_NORMAL_UNION_ID,
        name: FALLBACK_NORMAL_NAME,
        signaturePath: NORMAL_SIGNATURE_PUBLIC_PATH,
      },
    }),
    prisma.user.upsert({
      where: { openId: otherOpenId },
      update: {
        accountId: otherIdentity.account.id,
        name: FALLBACK_OTHER_NAME,
        unionId: FALLBACK_OTHER_UNION_ID,
      },
      create: {
        accountId: otherIdentity.account.id,
        openId: otherOpenId,
        unionId: FALLBACK_OTHER_UNION_ID,
        name: FALLBACK_OTHER_NAME,
      },
    }),
    prisma.user.upsert({
      where: { openId: adminOpenId },
      update: {
        accountId: adminIdentity.account.id,
        name: FALLBACK_ADMIN_NAME,
        unionId: FALLBACK_ADMIN_UNION_ID,
        signaturePath: ADMIN_SIGNATURE_PUBLIC_PATH,
      },
      create: {
        accountId: adminIdentity.account.id,
        openId: adminOpenId,
        unionId: FALLBACK_ADMIN_UNION_ID,
        name: FALLBACK_ADMIN_NAME,
        signaturePath: ADMIN_SIGNATURE_PUBLIC_PATH,
      },
    }),
  ]);

  await prisma.userRole.deleteMany({
    where: { openId: { in: [normalOpenId, adminOpenId, otherOpenId] } },
  });
  await prisma.userRole.createMany({
    data: [
      { accountId: adminIdentity.account.id, openId: adminOpenId, role: UserRoleType.TEAM_ADMIN, team: "英雄" },
      {
        accountId: adminIdentity.account.id,
        openId: adminOpenId,
        role: UserRoleType.TECH_GROUP_ADMIN,
        techGroup: "电控",
      },
      { accountId: adminIdentity.account.id, openId: adminOpenId, role: UserRoleType.FINANCE, team: "英雄" },
      { accountId: adminIdentity.account.id, openId: adminOpenId, role: UserRoleType.TEACHER, techGroup: "电控" },
    ],
  });
  const existingSuperAdmin = await prisma.systemRoleAssignment.findFirst({
    where: {
      accountId: adminIdentity.account.id,
      role: "SUPER_ADMINISTRATOR",
      revokedAt: null,
    },
  });
  if (!existingSuperAdmin) {
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: adminIdentity.account.id,
        role: "SUPER_ADMINISTRATOR",
      },
    });
  }

  await prisma.procurementBudgetPool.upsert({
    where: {
      description_team_techGroup_period: {
        description: `${TEST_PREFIX}-预算池`,
        team: "英雄",
        techGroup: "电控",
        period: "playwright",
      },
    },
    update: { budgetAmount: 10000, sortOrder: 0 },
    create: {
      description: `${TEST_PREFIX}-预算池`,
      team: "英雄",
      techGroup: "电控",
      period: "playwright",
      budgetAmount: 10000,
      sortOrder: 0,
    },
  });

  const initiator = await prisma.user.findUniqueOrThrow({
    where: { openId: normalOpenId },
    select: { id: true },
  });
  const createOrder = (
    orderNo: string,
    itemName: string,
    totalPrice: number,
    status: OrderStatus,
    approved = false,
  ) =>
    prisma.purchaseOrder.create({
      data: {
        orderNo,
        initiatorId: initiator.id,
        initiatorName: FALLBACK_NORMAL_NAME,
        team: "英雄",
        techGroup: "电控",
        totalPrice,
        status,
        teamApproved: approved,
        techGroupApproved: approved,
        teamApproverOpenId: approved ? adminOpenId : null,
        techGroupApproverOpenId: approved ? adminOpenId : null,
        items: {
          create: {
            name: itemName,
            spec: "PW-SPEC",
            purchaseLink: "https://example.com/playwright-item",
            quantity: 1,
            unitPrice: totalPrice,
          },
        },
      },
    });

  const [
    draftOrder,
    reviewOrder,
    managementRejectOrder,
    teacherRejectOrder,
    reimbursementOrder,
  ] = await Promise.all([
    createOrder(
      "PW-FULL-DRAFT",
      `${TEST_PREFIX}-草稿物料`,
      128,
      OrderStatus.DRAFT,
    ),
    createOrder(
      "PW-FULL-REVIEW",
      `${TEST_PREFIX}-审核物料`,
      256,
      OrderStatus.MANAGEMENT_REVIEW,
    ),
    createOrder(
      "PW-FULL-MGMT-REJECT",
      `${TEST_PREFIX}-管理驳回物料`,
      96,
      OrderStatus.MANAGEMENT_REVIEW,
    ),
    createOrder(
      "PW-FULL-TEACHER-REJECT",
      `${TEST_PREFIX}-老师驳回物料`,
      144,
      OrderStatus.TEACHER_REVIEW,
      true,
    ),
    createOrder(
      "PW-FULL-REIMBURSE",
      `${TEST_PREFIX}-报销物料`,
      188,
      OrderStatus.PENDING_APPLICANT_DOCS,
      true,
    ),
  ]);

  const [openFeedback, closedFeedback, uploadPublicPath] = await Promise.all([
    prisma.feedback.create({
      data: {
        submitterOpenId: normalOpenId,
        submitterName: FALLBACK_NORMAL_NAME,
        status: FeedbackStatus.OPEN,
        lastMessageAt: now,
        messages: {
          create: {
            authorOpenId: normalOpenId,
            authorName: FALLBACK_NORMAL_NAME,
            body: `${TEST_PREFIX}-活动反馈`,
          },
        },
      },
    }),
    prisma.feedback.create({
      data: {
        submitterOpenId: normalOpenId,
        submitterName: FALLBACK_NORMAL_NAME,
        status: FeedbackStatus.CLOSED,
        lastMessageAt: yesterday,
        closedAt: yesterday,
        messages: {
          create: {
            authorOpenId: normalOpenId,
            authorName: FALLBACK_NORMAL_NAME,
            body: `${TEST_PREFIX}-已关闭反馈`,
          },
        },
      },
    }),
    createUploadFixture(normalOpenId),
  ]);

  return {
    normalOpenId,
    adminOpenId,
    otherOpenId,
    draftOrderId: draftOrder.id,
    reviewOrderId: reviewOrder.id,
    managementRejectOrderId: managementRejectOrder.id,
    teacherRejectOrderId: teacherRejectOrder.id,
    reimbursementOrderId: reimbursementOrder.id,
    uploadPublicPath,
    openFeedbackId: openFeedback.id,
    closedFeedbackId: closedFeedback.id,
  };
}

export async function loginAsNormalUser(
  context: BrowserContext,
  baseURL: string | undefined,
  auth: AuthMaterial,
) {
  if (auth.cookies && auth.cookies.length > 0) {
    await replaceContextSessionCookies(
      context,
      normalizeCookiesForBaseUrl(auth.cookies, baseURL),
    );
    return;
  }
  await replaceContextSessionCookies(context, [
    await createSessionCookie(auth.openId, auth.name, baseURL),
  ]);
}

export async function loginAsAdminUser(
  context: BrowserContext,
  baseURL: string | undefined,
) {
  await replaceContextSessionCookies(context, [
    await createSessionCookie(
      FALLBACK_ADMIN_OPEN_ID,
      FALLBACK_ADMIN_NAME,
      baseURL,
    ),
  ]);
}

export async function loginAsOtherUser(
  context: BrowserContext,
  baseURL: string | undefined,
) {
  await replaceContextSessionCookies(context, [
    await createSessionCookie(
      FALLBACK_OTHER_OPEN_ID,
      FALLBACK_OTHER_NAME,
      baseURL,
    ),
  ]);
}

export async function loginAsTestUser(
  context: BrowserContext,
  baseURL: string | undefined,
  user: { openId: string; name: string },
) {
  await replaceContextSessionCookies(context, [
    await createSessionCookie(user.openId, user.name, baseURL),
  ]);
}

async function replaceContextSessionCookies(
  context: BrowserContext,
  cookies: Cookie[],
) {
  await Promise.all(
    context
      .pages()
      .filter((page) => !page.isClosed())
      .map((page) => page.goto("about:blank", { waitUntil: "load" })),
  );
  await context.clearCookies();
  await context.addCookies(cookies);
}

export async function expectHealthyPage(page: Page) {
  await expect(
    page.getByText(
      /Application error|Internal Server Error|Unhandled Runtime Error/i,
    ),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
}

export type ThreeLayerDetailTestIds = {
  overview: string;
  timeline: string;
  lowerGrid: string;
  mainColumn: string;
  leftColumn: string;
  rightColumn: string;
};

export async function expectThreeLayerDetailLayout(
  page: Page,
  ids: ThreeLayerDetailTestIds,
  mode: "columns" | "stacked",
) {
  const [overview, timeline, lowerGrid, mainColumn, leftColumn, rightColumn] =
    await Promise.all([
      requiredBoundingBox(page, ids.overview),
      requiredBoundingBox(page, ids.timeline),
      requiredBoundingBox(page, ids.lowerGrid),
      requiredBoundingBox(page, ids.mainColumn),
      requiredBoundingBox(page, ids.leftColumn),
      requiredBoundingBox(page, ids.rightColumn),
    ]);

  expect(Math.abs(overview.x - timeline.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(overview.width - timeline.width)).toBeLessThanOrEqual(1);
  expect(timeline.y).toBeGreaterThan(overview.y + overview.height);
  expect(lowerGrid.y).toBeGreaterThan(timeline.y + timeline.height);

  for (const column of [mainColumn, leftColumn, rightColumn]) {
    expect(column.x).toBeGreaterThanOrEqual(lowerGrid.x - 1);
    expect(column.x + column.width).toBeLessThanOrEqual(
      lowerGrid.x + lowerGrid.width + 1,
    );
  }

  if (mode === "columns") {
    expect(Math.abs(leftColumn.y - mainColumn.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(rightColumn.y - mainColumn.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(leftColumn.width - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs(rightColumn.width - 300)).toBeLessThanOrEqual(1);
    expect(leftColumn.x).toBeLessThan(mainColumn.x);
    expect(mainColumn.x).toBeLessThan(rightColumn.x);
  } else {
    expect(mainColumn.y).toBeLessThan(leftColumn.y);
    expect(leftColumn.y).toBeLessThan(rightColumn.y);
  }

  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

async function requiredBoundingBox(page: Page, testId: string) {
  const locator = page.getByTestId(testId);
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`无法读取布局区域 ${testId} 的位置`);
  return box;
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function createUploadFixture(ownerOpenId: string): Promise<string> {
  const storagePath = "playwright/owned-note.txt";
  const publicPath = `/uploads/${storagePath}`;
  const filePath = storagePathToAbsolute(storagePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "playwright-owned-file\n", "utf8");
  await prisma.fileAsset.create({
    data: {
      publicPath,
      storagePath,
      kind: FileAssetKind.TEMP_UPLOAD,
      mimeType: "text/plain",
      size: Buffer.byteLength("playwright-owned-file\n"),
      ownerOpenId,
    },
  });
  return publicPath;
}

async function createPlaywrightSignatureFiles({
  normalOpenId,
  adminOpenId,
}: {
  normalOpenId: string;
  adminOpenId: string;
}) {
  const signatures = [
    {
      openId: normalOpenId,
      publicPath: NORMAL_SIGNATURE_PUBLIC_PATH,
      storagePath: "playwright/signature-normal.png",
    },
    {
      openId: adminOpenId,
      publicPath: ADMIN_SIGNATURE_PUBLIC_PATH,
      storagePath: "playwright/signature-admin.png",
    },
  ];

  for (const signature of signatures) {
    const filePath = storagePathToAbsolute(signature.storagePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, ONE_BY_ONE_PNG);
    await prisma.fileAsset.upsert({
      where: { publicPath: signature.publicPath },
      update: {
        storagePath: signature.storagePath,
        kind: FileAssetKind.USER_SIGNATURE,
        mimeType: "image/png",
        size: ONE_BY_ONE_PNG.length,
        signatureOwnerOpenId: signature.openId,
        ownerOpenId: signature.openId,
      },
      create: {
        publicPath: signature.publicPath,
        storagePath: signature.storagePath,
        kind: FileAssetKind.USER_SIGNATURE,
        mimeType: "image/png",
        size: ONE_BY_ONE_PNG.length,
        signatureOwnerOpenId: signature.openId,
        ownerOpenId: signature.openId,
      },
    });
  }
}

async function cleanupFunctionalFixtures(openIds: string[]) {
  await prisma.feedback.deleteMany({
    where: {
      OR: [
        { submitterOpenId: { in: openIds } },
        { messages: { some: { body: { startsWith: TEST_PREFIX } } } },
      ],
    },
  });
  await prisma.procurementFeishuCard.deleteMany({
    where: { openId: { in: openIds } },
  });
  await prisma.purchaseOrder.deleteMany({
    where: { orderNo: { startsWith: "PW-FULL-" } },
  });
  await prisma.notificationOutbox.deleteMany({
    where: { eventKey: { startsWith: "playwright:" } },
  });
  await prisma.fileAsset.deleteMany({
    where: { publicPath: { startsWith: "/uploads/playwright/" } },
  });
}

function readStorageState(storagePath: string): { cookies: Cookie[] } | null {
  if (!fs.existsSync(storagePath)) return null;
  const raw = fs.readFileSync(storagePath, "utf8");
  const parsed = JSON.parse(raw) as { cookies?: Cookie[] };
  return { cookies: parsed.cookies ?? [] };
}

async function readOpenIdFromStorageState(
  cookies: Cookie[],
): Promise<string | undefined> {
  const cookie = cookies.find((item) => item.name.includes("session-token"));
  if (!cookie) return undefined;
  const secret = authSecret();
  const salts = [
    cookie.name,
    SESSION_COOKIE_NAME,
    "__Secure-authjs.session-token",
    "next-auth.session-token",
  ];
  for (const salt of salts) {
    const decoded = await decode({ token: cookie.value, secret, salt }).catch(
      () => null,
    );
    const openId =
      (decoded?.openId as string | undefined) ??
      (decoded?.sub as string | undefined);
    if (openId) return openId;
  }
  return undefined;
}

function normalizeCookiesForBaseUrl(
  cookies: Cookie[],
  baseURL: string | undefined,
): Cookie[] {
  const url = new URL(baseURL ?? "http://127.0.0.1:3100");
  return cookies
    .filter((cookie) => cookie.name.includes("session-token"))
    .map((cookie) => ({
      ...cookie,
      domain: url.hostname,
      path: cookie.path || "/",
      secure: url.protocol === "https:",
      sameSite: cookie.sameSite ?? "Lax",
    }));
}

async function createSessionCookie(
  openId: string,
  name: string,
  baseURL: string | undefined,
): Promise<Cookie> {
  const url = new URL(baseURL ?? "http://127.0.0.1:3100");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expires = nowSeconds + 60 * 60 * 24;
  const value = await encode({
    secret: authSecret(),
    salt: SESSION_COOKIE_NAME,
    token: { sub: openId, openId, name, iat: nowSeconds, exp: expires },
  });

  return {
    name: SESSION_COOKIE_NAME,
    value,
    domain: url.hostname,
    path: "/",
    expires,
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
  };
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required for Playwright authenticated tests");
  }
  return secret;
}

function assertTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to seed functional fixtures outside a _test database: ${databaseName}`,
    );
  }
}

export function formatPrismaError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
