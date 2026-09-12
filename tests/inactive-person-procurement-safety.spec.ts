// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  filterActiveFeishuOpenIds,
  lockActiveFeedbackUserTx,
  lockActiveProcurementUserTx,
  requireActiveProcurementUser,
} from "../lib/active-account";
import { approveProcurementByOpenId } from "../lib/procurement-approve-by-open-id";
import { refreshProcurementFeishuCards } from "../lib/feishu-procurement-card-sync";
import { feedbackNotificationChannel } from "../lib/notification-channels/feedback";
import { confirmProcurementByOpenId } from "../lib/procurement-confirm-by-open-id";
import { collectOrderInitiatorOpenIds } from "../lib/procurement-notification-recipients";
import { ensureProcurementOrderEditableDraft } from "../lib/procurement-order-draft";
import { deletePurchaseOrderAsSuperAdministrator } from "../lib/procurement-order-deletion";
import { rejectProcurementByOpenId } from "../lib/procurement-reject-by-open-id";
import { prisma } from "../lib/prisma";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await prisma.notificationOutbox.deleteMany({
    where: { eventKey: { startsWith: "inactive-safety:" } },
  });
  const orders = await prisma.purchaseOrder.findMany({
    where: { orderNo: { startsWith: "INACTIVE-" } },
    select: { id: true },
  });
  const orderIds = orders.map((order) => order.id);
  if (orderIds.length > 0) {
    await prisma.procurementFeishuCard.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.purchaseOrder.deleteMany({
      where: { id: { in: orderIds } },
    });
  }
  await prisma.processingVendor.deleteMany({
    where: { name: { startsWith: "采购停用并发锁-" } },
  });
  const feedbackIds = (
    await prisma.feedback.findMany({
      where: { submitterOpenId: { startsWith: "ou_inactive_feedback_" } },
      select: { id: true },
    })
  ).map((feedback) => feedback.id);
  if (feedbackIds.length > 0) {
    await prisma.fileAsset.deleteMany({
      where: { feedbackId: { in: feedbackIds } },
    });
    await prisma.feedback.deleteMany({
      where: { id: { in: feedbackIds } },
    });
  }
  const identities = await prisma.accountIdentity.findMany({
    where: {
      OR: [
        { openId: { startsWith: "ou_inactive_" } },
        { openId: { startsWith: "ou_active_lock_" } },
      ],
    },
    select: { accountId: true },
  });
  const accountIds = [
    ...new Set(identities.map((identity) => identity.accountId)),
  ];
  if (accountIds.length === 0) return;
  await prisma.systemRoleAssignment.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.userRole.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.user.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.accountIdentity.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.person.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.account.deleteMany({
    where: { id: { in: accountIds } },
  });
});

test("停用人员不能写采购或接收订单通知，但历史订单仍保留", async () => {
  const suffix = randomUUID();
  const openId = `ou_inactive_procurement_${suffix}`;
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
        create: { displayName: "停用采购安全测试", status: "ACTIVE" },
      },
      reimbursementUser: {
        create: { openId, name: "停用采购安全测试" },
      },
    },
    include: { person: true, reimbursementUser: true },
  });
  if (!account.person || !account.reimbursementUser) {
    throw new Error("停用采购安全测试 fixture 不完整");
  }
  const order = await prisma.purchaseOrder.create({
    data: {
      orderNo: `INACTIVE-SAFETY-${suffix}`,
      initiatorId: account.reimbursementUser.id,
      initiatorName: account.reimbursementUser.name,
      team: `停用测试-${suffix}`,
      techGroup: "",
      status: "DRAFT",
    },
  });

  await expect(requireActiveProcurementUser(openId)).resolves.toBeUndefined();
  await expect(collectOrderInitiatorOpenIds(order)).resolves.toEqual([openId]);

  await prisma.person.update({
    where: { id: account.person.id },
    data: { status: "INACTIVE" },
  });

  await expect(filterActiveFeishuOpenIds([openId])).resolves.toEqual([]);
  await expect(requireActiveProcurementUser(openId)).rejects.toThrow(
    "人员已停用，无法执行采购操作",
  );
  await expect(collectOrderInitiatorOpenIds(order)).resolves.toEqual([]);
  await expect(
    ensureProcurementOrderEditableDraft(order.id, openId),
  ).rejects.toThrow("人员已停用，无法执行采购操作");
  await expect(confirmProcurementByOpenId(openId, order.id)).rejects.toThrow(
    "人员已停用，无法执行采购操作",
  );
  await expect(approveProcurementByOpenId(openId, order.id)).rejects.toThrow(
    "人员已停用，无法执行采购操作",
  );
  await expect(
    rejectProcurementByOpenId(
      openId,
      order.id,
      "停用人员不能驳回",
      "terminate",
    ),
  ).rejects.toThrow("人员已停用，无法执行采购操作");

  await expect(
    prisma.purchaseOrder.findUnique({
      where: { id: order.id },
      select: { status: true, initiatorId: true },
    }),
  ).resolves.toEqual({
    status: "DRAFT",
    initiatorId: account.reimbursementUser.id,
  });
});

test("停用人员不能写反馈或接收反馈通知", async ({
  context,
  page,
  baseURL,
}) => {
  const suffix = randomUUID();
  const openId = `ou_inactive_feedback_${suffix}`;
  const displayName = "停用反馈安全测试";
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
        create: { displayName, status: "INACTIVE" },
      },
      reimbursementUser: {
        create: { openId, name: displayName },
      },
    },
  });
  const feedback = await prisma.feedback.create({
    data: {
      submitterOpenId: openId,
      submitterName: displayName,
      status: "OPEN",
      messages: {
        create: {
          authorOpenId: openId,
          authorName: displayName,
          body: "停用前已存在的反馈",
        },
      },
    },
  });

  await expect(
    prisma.$transaction((tx) => lockActiveFeedbackUserTx(tx, openId)),
  ).rejects.toThrow("人员已停用，无法提交反馈");

  const before = {
    feedbacks: await prisma.feedback.count({
      where: { submitterOpenId: openId },
    }),
    messages: await prisma.feedbackMessage.count({
      where: { feedback: { submitterOpenId: openId } },
    }),
    assets: await prisma.fileAsset.count({
      where: { kind: "FEEDBACK_ATTACHMENT" },
    }),
    outbox: await prisma.notificationOutbox.count(),
  };

  await loginAsTestUser(context, baseURL, { openId, name: displayName });
  await page.goto("/feedback?new=1", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "提交反馈" });
  await dialog.getByPlaceholder("请输入反馈内容").fill("停用后尝试新建反馈");
  await dialog.locator("input[type=file]").setInputFiles({
    name: "inactive-feedback.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await dialog.getByRole("button", { name: "提交反馈" }).click();
  await expect(
    page.getByText("人员已停用，无法提交反馈").last(),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();

  await page
    .getByPlaceholder("继续补充情况，或回复处理结果")
    .fill("停用后尝试回复反馈");
  await page.getByRole("button", { name: "发送回复" }).click();
  await expect(
    page.getByText("人员已停用，无法提交反馈").last(),
  ).toBeVisible();
  await expectHealthyPage(page);

  await expect(
    Promise.all([
      prisma.feedback.count({ where: { submitterOpenId: openId } }),
      prisma.feedbackMessage.count({
        where: { feedback: { submitterOpenId: openId } },
      }),
      prisma.fileAsset.count({ where: { kind: "FEEDBACK_ATTACHMENT" } }),
      prisma.notificationOutbox.count(),
    ]),
  ).resolves.toEqual([
    before.feedbacks,
    before.messages,
    before.assets,
    before.outbox,
  ]);
  await expect(
    prisma.feedback.findUniqueOrThrow({
      where: { id: feedback.id },
      select: { status: true },
    }),
  ).resolves.toEqual({ status: "OPEN" });

  const row = await prisma.notificationOutbox.create({
    data: {
      eventKey: `inactive-safety:feedback:${suffix}`,
      channel: "feedback",
      type: "status",
      payload: JSON.stringify({
        kind: "status",
        payload: {
          feedbackId: `feedback-${suffix}`,
          actorName: "测试管理员",
          status: "CLOSED",
          submitterOpenId: openId,
        },
      }),
    },
  });
  await expect(
    feedbackNotificationChannel.resolveRecipientPlan(row),
  ).resolves.toEqual({ supported: true, openIds: [] });
  await expect(
    feedbackNotificationChannel.sendToRecipient(row, openId),
  ).rejects.toThrow("收件人已停用，取消本次投递");
});

test("历史采购卡片不再向停用人员刷新", async () => {
  const suffix = randomUUID();
  const openId = `ou_inactive_card_${suffix}`;
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
        create: { displayName: "停用历史卡片测试", status: "INACTIVE" },
      },
      reimbursementUser: {
        create: { openId, name: "停用历史卡片测试" },
      },
    },
    include: { reimbursementUser: true },
  });
  if (!account.reimbursementUser) {
    throw new Error("停用历史卡片 fixture 不完整");
  }
  const order = await prisma.purchaseOrder.create({
    data: {
      orderNo: `INACTIVE-CARD-${suffix}`,
      initiatorId: account.reimbursementUser.id,
      initiatorName: account.reimbursementUser.name,
      team: `停用卡片测试-${suffix}`,
      techGroup: "",
      status: "DRAFT",
    },
  });
  const snapshot = await prisma.procurementFeishuCard.create({
    data: {
      orderId: order.id,
      openId,
      cardId: `inactive-card-${suffix}`,
      botKind: "notification",
      cardStage: "DRAFT",
      sequence: 1,
    },
  });
  const originalFetch = globalThis.fetch;
  let externalAttempts = 0;
  globalThis.fetch = (async () => {
    externalAttempts += 1;
    throw new Error("停用卡片不应发起外部请求");
  }) as typeof fetch;
  try {
    await refreshProcurementFeishuCards(order.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(externalAttempts).toBe(0);
  await expect(
    prisma.procurementFeishuCard.findUniqueOrThrow({
      where: { id: snapshot.id },
      select: { sequence: true },
    }),
  ).resolves.toEqual({ sequence: 1 });
});

test("采购写事务与通讯录停用按 Person 行锁串行化", async () => {
  const suffix = randomUUID();
  const openId = `ou_active_lock_${suffix}`;
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
      person: { create: { displayName: "采购停用并发锁", status: "ACTIVE" } },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("采购停用并发锁 fixture 不完整");

  let releaseBusiness!: () => void;
  const businessGate = new Promise<void>((resolve) => {
    releaseBusiness = resolve;
  });
  let markBusinessLocked!: () => void;
  const businessLocked = new Promise<void>((resolve) => {
    markBusinessLocked = resolve;
  });
  const vendorName = `采购停用并发锁-${suffix}`;
  const businessWrite = prisma.$transaction(async (tx) => {
    await lockActiveProcurementUserTx(tx, openId);
    markBusinessLocked();
    await businessGate;
    await tx.processingVendor.create({ data: { name: vendorName } });
  });
  let released = false;
  let deactivation: Promise<void> | undefined;
  try {
    await businessLocked;

    let deactivationCommitted = false;
    deactivation = prisma.$transaction(async (tx) => {
      await tx.person.update({
        where: { id: account.person!.id },
        data: { status: "INACTIVE" },
      });
      deactivationCommitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deactivationCommitted).toBe(false);

    releaseBusiness();
    released = true;
    await businessWrite;
    await deactivation;
    expect(deactivationCommitted).toBe(true);
    await expect(
      prisma.$transaction((tx) => lockActiveProcurementUserTx(tx, openId)),
    ).rejects.toThrow("人员已停用，无法执行采购操作");
    await expect(
      prisma.processingVendor.count({ where: { name: vendorName } }),
    ).resolves.toBe(1);
  } finally {
    if (!released) releaseBusiness();
    await Promise.allSettled([
      businessWrite,
      ...(deactivation ? [deactivation] : []),
    ]);
  }
});

test("已停用超级管理员不能删除采购历史订单", async () => {
  const suffix = randomUUID();
  const openId = `ou_inactive_delete_${suffix}`;
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
      person: { create: { displayName: "停用采购删除超管", status: "INACTIVE" } },
      reimbursementUser: {
        create: { openId, name: "停用采购删除超管" },
      },
      systemRoles: {
        create: { role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" },
      },
    },
    include: { reimbursementUser: true },
  });
  if (!account.reimbursementUser) throw new Error("采购删除测试 fixture 不完整");
  const order = await prisma.purchaseOrder.create({
    data: {
      orderNo: `INACTIVE-DELETE-${suffix}`,
      initiatorId: account.reimbursementUser.id,
      initiatorName: account.reimbursementUser.name,
      team: `停用删除测试-${suffix}`,
      techGroup: "",
      status: "DRAFT",
    },
  });

  await expect(
    deletePurchaseOrderAsSuperAdministrator(openId, order.id),
  ).rejects.toThrow("人员已停用，无法执行采购操作");
  await expect(
    prisma.purchaseOrder.findUnique({
      where: { id: order.id },
      select: { id: true },
    }),
  ).resolves.toEqual({ id: order.id });
});

test("停用人员的采购页面只读且隐藏所有写入口", async ({
  context,
  page,
  baseURL,
}, testInfo) => {
  const suffix = randomUUID();
  const openId = `ou_inactive_procurement_ui_${suffix}`;
  const displayName = `停用采购界面测试 ${testInfo.project.name}`;
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
        create: { displayName, status: "INACTIVE" },
      },
      reimbursementUser: {
        create: { openId, name: displayName },
      },
    },
    include: { reimbursementUser: true },
  });
  if (!account.reimbursementUser) {
    throw new Error("停用采购界面测试 fixture 不完整");
  }
  const order = await prisma.purchaseOrder.create({
    data: {
      orderNo: `INACTIVE-UI-${suffix}`,
      initiatorId: account.reimbursementUser.id,
      initiatorName: account.reimbursementUser.name,
      team: `停用界面测试-${suffix}`,
      techGroup: "",
      status: "DRAFT",
    },
  });

  await loginAsTestUser(context, baseURL, { openId, name: displayName });

  await page.goto("/procurement/new", { waitUntil: "networkidle" });
  await expect.poll(() => new URL(page.url()).pathname).toBe(
    "/procurement/dashboard",
  );
  {
    const sidebar = page.getByTestId("procurement-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "新建申请" }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", { name: "工坊加工费" }),
    ).toHaveCount(0);
  }

  await page.goto(`/procurement/${order.id}`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: `订单 ${order.orderNo}` }),
  ).toBeVisible();
  for (const actionName of [
    "继续编辑",
    "提交申请",
    "修改清单",
    "上传凭证",
    "确认报销",
    "催促采购人上传凭证",
    "催促当前审批人",
  ]) {
    await expect(
      page.getByRole("button", { name: actionName, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: actionName, exact: true }),
    ).toHaveCount(0);
  }
  await expectHealthyPage(page);

  const editResponse = await page.goto(`/procurement/${order.id}/edit`, {
    waitUntil: "networkidle",
  });
  expect(editResponse?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "页面不存在或无权访问" }),
  ).toBeVisible();
});
