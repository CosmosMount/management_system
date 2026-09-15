// @playwright-project ui
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { expect, test, type Page, type Request, type APIRequestContext } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import { removeUploadByPublicPath, saveGeneratedOrderAttachment, saveUserSignature, storagePathToAbsolute } from "../lib/file-upload";
import { drainUploadCleanupTasks } from "../lib/upload-cleanup";
import { canViewFileAsset } from "../lib/file-asset-permissions";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

let fixture: Awaited<ReturnType<typeof createFixture>>;

test.beforeEach(async () => {
  fixture = await createFixture();
});

test.afterEach(async () => {
  if (!fixture) return;
  const assets = await prisma.fileAsset.findMany({ where: { orderId: fixture.order.id }, select: { publicPath: true } });
  for (const filePath of new Set([...assets.map((asset) => asset.publicPath), ...fixture.invoices, fixture.signature])) {
    await removeUploadByPublicPath(filePath);
  }
});

test("删除可撤销或取消，保存后同步列表、旧字段和审计，旧链接失效", async ({ page, context, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAsTestUser(context, baseURL, fixture.user);
  const invoiceResponse = await context.request.get(fixture.invoices[0]);
  expect(invoiceResponse.status()).toBe(200);
  expect(invoiceResponse.headers()["cache-control"]).toBe("private, no-store, max-age=0");
  await openEditor(page);
  await page.getByRole("button", { name: "删除第 1 张发票", exact: true }).click();
  await expect(page.getByText("待删除", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "撤销删除第 1 张发票" }).click();
  await expect(page.getByText("待删除", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "删除第 1 张发票", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await currentOrder()).invoicePaths).toBe(JSON.stringify(fixture.invoices));
  await page.getByRole("button", { name: "修改凭证", exact: true }).click();
  await expect(page.getByText("待删除", { exact: true })).toHaveCount(0);
  await expectHealthyPage(page);
  await page.setViewportSize({ width: 393, height: 851 });
  await page.getByRole("button", { name: "删除第 1 张发票", exact: true }).click();
  await page.getByRole("button", { name: "删除第 2 张发票", exact: true }).click();
  await expectHealthyPage(page);
  const outboxCount = await prisma.notificationOutbox.count();
  await saveEditor(page);
  const order = await currentOrder();
  expect(order.invoicePaths).toBe(JSON.stringify([fixture.invoices[2]]));
  expect(order.invoicePath).toBe(fixture.invoices[2]);
  expect(order.status).toBe("PENDING_FINANCE_REVIEW");
  expect(await prisma.notificationOutbox.count()).toBe(outboxCount);
  const audit = await prisma.domainAuditEvent.findFirstOrThrow({ where: { entityId: order.id, action: "procurement.invoices.remove" } });
  expect(audit.actorAccountId).toBe(fixture.identity.account.id);
  expect(audit.actorPersonId).toBe(fixture.identity.person.id);
  expect(audit.before).toEqual({ status: "PENDING_FINANCE_REVIEW", invoiceReferences: fixture.invoices.map(reference) });
  expect(audit.after).toEqual({ status: "PENDING_FINANCE_REVIEW", invoiceReferences: [reference(fixture.invoices[2])], removedInvoiceReferences: fixture.invoices.slice(0, 2).map(reference) });
  expect((await context.request.get(fixture.invoices[0])).status()).toBe(404);
  await expect(stat(storagePathToAbsolute(fixture.invoices[0].slice("/uploads/".length)))).rejects.toMatchObject({ code: "ENOENT" });
  await page.reload();
  await page.getByRole("button", { name: "修改凭证", exact: true }).click();
  await expect(page.getByTestId("saved-invoice")).toHaveCount(1);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("全部删除被拦截，历史单字段无资产记录可用新发票替换，退回提交仍推进流程", async ({ page, context, baseURL }) => {
  await prisma.purchaseOrder.update({ where: { id: fixture.order.id }, data: { status: "PENDING_APPLICANT_DOCS", invoicePaths: "[]", invoicePath: fixture.invoices[0] } });
  await prisma.fileAsset.delete({ where: { publicPath: fixture.invoices[0] } });
  await loginAsTestUser(context, baseURL, fixture.user);
  await openEditor(page);
  await expect(page.getByTestId("saved-invoice")).toHaveCount(1);
  await page.getByRole("button", { name: "删除第 1 张发票", exact: true }).click();
  await page.getByRole("button", { name: "提交给报销员" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "请至少上传一张发票" })).toBeVisible();
  await expect(page.locator('input[name="invoices"]')).toBeFocused();
  expect((await currentOrder()).invoicePath).toBe(fixture.invoices[0]);
  await page.locator('input[name="invoices"]').setInputFiles(pdfUpload("replacement.pdf"));
  await saveEditor(page, "提交给报销员");
  const order = await currentOrder();
  expect(JSON.parse(order.invoicePaths)).toEqual([order.invoicePath]);
  expect(order.invoicePath).not.toBe(fixture.invoices[0]);
  expect(order.status).toBe("PENDING_FINANCE_REVIEW");
  expect((await context.request.get(fixture.invoices[0])).status()).toBe(404);
  await expect(stat(storagePathToAbsolute(fixture.invoices[0].slice("/uploads/".length)))).rejects.toMatchObject({ code: "ENOENT" });
});

test("20张上限按保留数量计算，可删除一张再上传替代发票", async ({ page, context, baseURL }) => {
  const extra: string[] = [];
  for (let index = 3; index < 20; index++) extra.push(await invoiceFile(fixture.order.id, `invoice-${index}`));
  await prisma.purchaseOrder.update({ where: { id: fixture.order.id }, data: { invoicePaths: JSON.stringify([...fixture.invoices, ...extra]) } });
  await loginAsTestUser(context, baseURL, fixture.user);
  await openEditor(page);
  await page.locator('input[name="invoices"]').setInputFiles(pdfUpload("replacement.pdf"));
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "发票最多上传 20 张" })).toBeVisible();
  await page.getByRole("button", { name: "删除第 1 张发票", exact: true }).click();
  await saveEditor(page);
  const invoices: string[] = JSON.parse((await currentOrder()).invoicePaths);
  expect(invoices).toHaveLength(20);
  expect(invoices).not.toContain(fixture.invoices[0]);
});

test("伪造删除、越权、停用、审批后及重复请求在服务端拒绝", async ({ page, context, baseURL }) => {
  await loginAsTestUser(context, baseURL, fixture.user);
  await openEditor(page);
  await page.getByRole("button", { name: "删除第 1 张发票", exact: true }).click();
  const outgoing = page.waitForRequest(isSaveRequest);
  await saveEditor(page);
  const request = await outgoing;
  await expectRejected(context.request, request, baseURL, fixture.invoices[0], "待删除发票不属于当前订单");
  for (const invalidPath of ["/uploads/other-order/invoice.pdf", fixture.photo, (await currentOrder()).listDocPath!, "/uploads/../invoice.pdf"]) {
    await expectRejected(context.request, request, baseURL, invalidPath, "待删除发票不属于当前订单");
  }
  const stranger = await resolveFeishuIdentityForUser({ openId: `ou_invoice_other_${randomUUID()}`, name: "其他采购人" });
  await loginAsTestUser(context, baseURL, { openId: stranger.reimbursementUser.openId, name: "其他采购人" });
  await expectRejected(context.request, request, baseURL, fixture.invoices[1], "无上传权限");
  await prisma.userRole.create({ data: { accountId: stranger.account.id, openId: stranger.reimbursementUser.openId, role: "FINANCE", team: "英雄", techGroup: "" } });
  await expectRejected(context.request, request, baseURL, fixture.invoices[1], "无上传权限");
  await prisma.systemRoleAssignment.create({ data: { accountId: stranger.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  await expectRejected(context.request, request, baseURL, fixture.invoices[1], "无上传权限");
  await loginAsTestUser(context, baseURL, fixture.user);
  await prisma.person.update({ where: { id: fixture.identity.person.id }, data: { status: "INACTIVE" } });
  await expectRejected(context.request, request, baseURL, fixture.invoices[1], "人员已停用");
  await prisma.person.update({ where: { id: fixture.identity.person.id }, data: { status: "ACTIVE" } });
  for (const status of ["PENDING_APPLICANT_CONFIRM", "COMPLETED", "REJECTED"] as const) {
    await prisma.purchaseOrder.update({ where: { id: fixture.order.id }, data: { status } });
    await expectRejected(context.request, request, baseURL, fixture.invoices[1], status === "PENDING_APPLICANT_CONFIRM" ? "当前状态不允许删除发票" : "无上传权限");
    await page.goto(`/procurement/${fixture.order.id}`);
    if (status === "PENDING_APPLICANT_CONFIRM") {
      await page.getByRole("button", { name: "修改凭证", exact: true }).click();
      await expect(page.getByRole("button", { name: /删除第/ })).toHaveCount(0);
      await expect(page.locator('input[name="invoices"]')).toBeEnabled();
    } else {
      await expect(page.getByRole("button", { name: "修改凭证", exact: true })).toHaveCount(0);
    }
  }
  expect(JSON.parse((await currentOrder()).invoicePaths)).toEqual(fixture.invoices.slice(1));
  expect(await prisma.domainAuditEvent.count({ where: { entityId: fixture.order.id, action: "procurement.invoices.remove" } })).toBe(1);
});

test("审计写入失败回滚发票与清理标记，清理失败保留可重试任务且旧链接拒绝", async ({ page, context, baseURL }) => {
  await loginAsTestUser(context, baseURL, fixture.user);
  await openEditor(page);
  await page.getByRole("button", { name: "删除第 1 张发票", exact: true }).click();
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `invoice_audit_fail_${suffix}`;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$ BEGIN IF NEW."entityId" = '${fixture.order.id}' AND NEW."action" = 'procurement.invoices.remove' THEN RAISE EXCEPTION 'injected invoice audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${functionName}" BEFORE INSERT ON "DomainAuditEvent" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
  const beforeAssets = await assetPaths();
  try {
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByText("凭证保存失败，请稍后重试", { exact: true })).toBeVisible();
    expect((await currentOrder()).invoicePaths).toBe(JSON.stringify(fixture.invoices));
    expect(await assetPaths()).toEqual(beforeAssets);
    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { publicPath: fixture.invoices[0] } })).cleanupRequestedAt).toBeNull();
    expect((await context.request.get(fixture.invoices[0])).status()).toBe(200);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${functionName}" ON "DomainAuditEvent"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
  }
  // 用非空目录模拟不可立即删除的文件，避免依赖运行用户的 chmod 权限。
  const absolutePath = storagePathToAbsolute(fixture.invoices[0].slice("/uploads/".length));
  await rm(absolutePath);
  await mkdir(absolutePath);
  await writeFile(`${absolutePath}/blocked`, "cleanup fixture");
  try {
    await saveEditor(page);
    const asset = await prisma.fileAsset.findUniqueOrThrow({ where: { publicPath: fixture.invoices[0] } });
    expect(asset.cleanupRequestedAt).not.toBeNull();
    expect(asset.cleanupAttempts).toBeGreaterThanOrEqual(2);
    expect((await context.request.get(fixture.invoices[0])).status()).toBe(404);
    expect(await canViewFileAsset({ asset, userOpenId: fixture.user.openId, roles: [{ role: "SUPER_ADMIN", team: "", techGroup: "" }] })).toBe(false);
    expect((await currentOrder()).invoicePaths).toBe(JSON.stringify(fixture.invoices.slice(1)));
  } finally {
    await rm(`${absolutePath}/blocked`);
    await rm(absolutePath, { recursive: true });
  }
  await drainUploadCleanupTasks();
  expect(await prisma.fileAsset.findUnique({ where: { publicPath: fixture.invoices[0] } })).toBeNull();
});

test("并发追加不得复活已删除发票，保存期间报销处理完成则拒绝删除", async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  await loginAsTestUser(context, baseURL, fixture.user);
  await openEditor(page);
  const requestPromise = page.waitForRequest(isSaveRequest);
  await saveEditor(page);
  const request = await requestPromise;
  const connection = new Client({ connectionString: process.env.DATABASE_URL });
  await connection.connect();
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `invoice_save_gate_${suffix}`;
  const lockKey = `invoice-save-${suffix}`;
  // 生成清单资产时已读取旧订单，但尚未进入保存事务；通过独立连接可观测地暂停。
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$ BEGIN IF NEW."orderId" = '${fixture.order.id}' AND NEW."publicPath" LIKE '%/list-%' AND pg_try_advisory_xact_lock(hashtext('${lockKey}-first')) THEN PERFORM pg_advisory_xact_lock(hashtext('${lockKey}')); END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${functionName}" BEFORE INSERT ON "FileAsset" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
  try {
    for (const transition of [false, true]) {
      await connection.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      const pending = replay(context.request, request, baseURL, transition ? fixture.invoices[1] : undefined);
      await expect.poll(async () => {
        const result = await connection.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))");
        return result.rows[0].count as number;
      }).toBeGreaterThan(0);
      if (transition) {
        await prisma.purchaseOrder.update({ where: { id: fixture.order.id }, data: { status: "PENDING_APPLICANT_CONFIRM" } });
      } else {
        const deletion = await replay(context.request, request, baseURL, fixture.invoices[0]);
        expect(deletion.status()).toBe(200);
        expect(JSON.parse((await currentOrder()).invoicePaths)).toEqual(fixture.invoices.slice(1));
      }
      await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      expect(await (await pending).text()).toContain("凭证或订单状态已更新，请刷新后重试");
      expect(JSON.parse((await currentOrder()).invoicePaths)).toEqual(fixture.invoices.slice(1));
    }
  } finally {
    await connection.query("SELECT pg_advisory_unlock_all()");
    await connection.end();
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${functionName}" ON "FileAsset"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
  }
});

async function createFixture() {
  const user = { openId: `ou_invoice_${randomUUID()}`, name: "发票删除测试申请人" };
  const identity = await resolveFeishuIdentityForUser(user);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
  const signature = await saveUserSignature(user.openId, new File([png], "signature.png", { type: "image/png" }));
  await prisma.user.update({ where: { id: identity.reimbursementUser.id }, data: { signaturePath: signature } });
  const order = await prisma.purchaseOrder.create({ data: {
    orderNo: `PW-INVOICE-${randomUUID()}`, initiatorId: identity.reimbursementUser.id, initiatorName: user.name,
    team: "英雄", techGroup: "电控", totalPrice: 10, status: "PENDING_FINANCE_REVIEW",
    teamApproved: true, techGroupApproved: true,
    teamApproverAccountId: identity.account.id, techGroupApproverAccountId: identity.account.id,
    items: { create: { name: "发票删除测试物品", spec: "规格", quantity: 1, unitPrice: 10 } },
  } });
  const invoices: string[] = [];
  for (let index = 0; index < 3; index++) invoices.push(await invoiceFile(order.id, index === 0 ? `invoice-${"长文件名".repeat(8)}` : `invoice-${index}`));
  const photo = await saveGeneratedOrderAttachment(order.id, png, "item-photo", "image/png", ".png");
  await prisma.purchaseItem.updateMany({ where: { orderId: order.id }, data: { photoPath: photo } });
  await prisma.purchaseOrder.update({ where: { id: order.id }, data: { invoicePaths: JSON.stringify(invoices), invoicePath: invoices[0] } });
  return { user, identity, order, invoices, photo, signature };
}

function pdfUpload(name: string) {
  return { name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n") };
}

async function invoiceFile(orderId: string, prefix: string) {
  return saveGeneratedOrderAttachment(orderId, pdfUpload("invoice.pdf").buffer, prefix, "application/pdf", ".pdf");
}

function reference(value: string) { return createHash("sha256").update(value).digest("hex"); }
function currentOrder() { return prisma.purchaseOrder.findUniqueOrThrow({ where: { id: fixture.order.id } }); }
async function assetPaths() { return (await prisma.fileAsset.findMany({ where: { orderId: fixture.order.id }, orderBy: { publicPath: "asc" }, select: { publicPath: true } })).map((asset) => asset.publicPath); }
async function openEditor(page: Page) {
  await page.goto(`/procurement/${fixture.order.id}`);
  await page.getByRole("button", { name: "修改凭证", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function saveEditor(page: Page, buttonName = "保存修改") {
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
function isSaveRequest(request: Request) {
  return request.method() === "POST" && Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes("removedInvoicePaths"));
}
function replay(client: APIRequestContext, request: Request, baseURL: string | undefined, removedPath?: string) {
  let data = request.postData()!;
  if (removedPath) {
    data = data.replace(/(name="_?\d+_removedInvoicePaths"\r\n\r\n)[^\r]*/, `$1${JSON.stringify([removedPath])}`);
    if (!data.includes(JSON.stringify([removedPath]))) throw new Error("未匹配发票删除 FormData 字段");
  }
  return client.post(request.url(), { headers: { "next-action": request.headers()["next-action"], "content-type": request.headers()["content-type"], origin: baseURL! }, data });
}
async function expectRejected(client: APIRequestContext, request: Request, baseURL: string | undefined, removedPath: string, message: string) {
  expect(await (await replay(client, request, baseURL, removedPath)).text()).toContain(message);
}
