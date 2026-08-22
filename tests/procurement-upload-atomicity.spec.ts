import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  fileAssetExists,
  removeUploadByPublicPath,
  saveGeneratedOrderAttachment,
  saveUserSignature,
  storagePathToAbsolute,
  uploadStorageRoot,
} from "../lib/file-upload";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import {
  cleanupUploadPaths,
  drainUploadCleanupTasks,
  reconcileStaleUploadArtifacts,
} from "../lib/upload-cleanup";
import {
  assertExistingItemImagesBelongToOrder,
  prepareItemReferenceImages,
} from "../lib/order-item-images";
import { saveGeneratedListDoc } from "../lib/generate-reimbursement-docx";
import { createRecoveryBackupPath } from "../lib/upload-recovery-marker";
import {
  ensureFallbackAdminFixture,
  loginAsAdminUser,
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

test("订单明细图片只允许沿用当前订单的 ORDER_ITEM_IMAGE 资产", async () => {
  const suffix = randomUUID();
  const ownPath = `/uploads/${suffix}/own.png`;
  const otherPath = `/uploads/${suffix}/other.png`;
  const wrongKindPath = `/uploads/${suffix}/signature.png`;
  await prisma.fileAsset.createMany({
    data: [
      {
        publicPath: ownPath,
        storagePath: `${suffix}/own.png`,
        kind: "ORDER_ITEM_IMAGE",
        mimeType: "image/png",
        size: 1,
        orderId: `order-own-${suffix}`,
      },
      {
        publicPath: otherPath,
        storagePath: `${suffix}/other.png`,
        kind: "ORDER_ITEM_IMAGE",
        mimeType: "image/png",
        size: 1,
        orderId: `order-other-${suffix}`,
      },
      {
        publicPath: wrongKindPath,
        storagePath: `${suffix}/signature.png`,
        kind: "USER_SIGNATURE",
        mimeType: "image/png",
        size: 1,
        orderId: `order-own-${suffix}`,
      },
    ],
  });
  try {
    await expect(
      assertExistingItemImagesBelongToOrder(
        `order-own-${suffix}`,
        [ownPath],
        [ownPath],
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertExistingItemImagesBelongToOrder(
        `order-own-${suffix}`,
        [ownPath],
        [otherPath],
      ),
    ).rejects.toThrow("明细图片不属于当前订单");
    await expect(
      assertExistingItemImagesBelongToOrder(
        `order-own-${suffix}`,
        [wrongKindPath],
        [wrongKindPath],
      ),
    ).rejects.toThrow("明细图片不属于当前订单");
  } finally {
    await prisma.fileAsset.deleteMany({
      where: { publicPath: { in: [ownPath, otherPath, wrongKindPath] } },
    });
  }
});

test("多图暂存第二张失败时清理第一张且不留下资产", async () => {
  const orderId = `staging-${randomUUID()}`;
  const valid = pngUpload("valid.png");
  const files = new Map<number, File>([
    [0, new File([valid.buffer], valid.name, { type: valid.mimeType })],
    [1, new File([Buffer.from("not-an-image")], "invalid.png", { type: "image/png" })],
  ]);
  await expect(
    prepareItemReferenceImages({
      orderId,
      itemKinds: ["PROCESSING_FEE", "PROCESSING_FEE"],
      itemImages: files,
    }),
  ).rejects.toThrow("文件内容");
  await expect(
    prisma.fileAsset.count({ where: { orderId } }),
  ).resolves.toBe(0);
  await expect(listStoredFiles(storagePathToAbsolute(orderId))).resolves.toEqual(
    [],
  );
});

test("生成清单资产注册失败时不会留下未登记普通文件", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const orderId = `generated-doc-${suffix}`;
  const functionName = `test_generated_doc_asset_fail_${suffix}`;
  const triggerName = `test_generated_doc_asset_fail_trigger_${suffix}`;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."publicPath" LIKE '%${orderId}%' THEN
          RAISE EXCEPTION 'injected generated document registration failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "FileAsset"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    await expect(
      saveGeneratedListDoc(orderId, Buffer.from("generated-doc")),
    ).rejects.toThrow("injected generated document registration failure");
    await expect(
      prisma.fileAsset.count({ where: { orderId } }),
    ).resolves.toBe(0);
    await expect(listStoredFiles(storagePathToAbsolute(orderId))).resolves.toEqual(
      [],
    );
  } finally {
    await dropTriggerAndFunction({
      functionName,
      tableName: "FileAsset",
      triggerName,
    });
  }
});

test("覆盖签名注册失败时恢复旧文件并保留原资产元数据", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const openId = `ou_signature_recovery_${suffix}`;
  const publicPath = `/uploads/signatures/${openId}/signature.png`;
  const storagePath = `signatures/${openId}/signature.png`;
  const fullPath = storagePathToAbsolute(storagePath);
  const oldSignature = pngUpload("old-signature.png").buffer;
  const newSignature = Buffer.concat([
    pngUpload("new-signature.png").buffer,
    Buffer.from("replacement"),
  ]);
  const functionName = `test_signature_registration_fail_${suffix}`;
  const triggerName = `test_signature_registration_fail_trigger_${suffix}`;

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, oldSignature);
  await prisma.fileAsset.create({
    data: {
      publicPath,
      storagePath,
      kind: "USER_SIGNATURE",
      mimeType: "image/png",
      size: oldSignature.length,
      signatureOwnerOpenId: openId,
      ownerOpenId: openId,
    },
  });
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."publicPath" = '${publicPath}' THEN
          RAISE EXCEPTION 'injected signature registration failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE UPDATE ON "FileAsset"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    await expect(
      saveUserSignature(
        openId,
        new File([newSignature], "signature.png", { type: "image/png" }),
      ),
    ).rejects.toThrow("injected signature registration failure");
    await expect(readFile(fullPath)).resolves.toEqual(oldSignature);
    await expect(
      prisma.fileAsset.findUniqueOrThrow({ where: { publicPath } }),
    ).resolves.toMatchObject({
      kind: "USER_SIGNATURE",
      size: oldSignature.length,
      cleanupRequestedAt: null,
    });
    await reconcileStaleUploadArtifacts({ limit: 1_000, olderThanMs: 0 });
  } finally {
    await dropTriggerAndFunction({
      functionName,
      tableName: "FileAsset",
      triggerName,
    });
    await removeUploadByPublicPath(publicPath);
    await rm(path.dirname(fullPath), { force: true, recursive: true });
  }
});

test("延迟覆盖恢复会隔离失败的新文件且不删除旧资产元数据", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const openId = `ou_deferred_signature_recovery_${suffix}`;
  const publicPath = `/uploads/signatures/${openId}/signature.png`;
  const storagePath = `signatures/${openId}/signature.png`;
  const fullPath = storagePathToAbsolute(storagePath);
  const oldSignature = pngUpload("old-signature.png").buffer;
  const failedReplacement = Buffer.concat([
    oldSignature,
    Buffer.from("failed-replacement"),
  ]);

  const asset = await prisma.fileAsset.create({
    data: {
      publicPath,
      storagePath,
      kind: "USER_SIGNATURE",
      mimeType: "image/png",
      size: oldSignature.length,
      signatureOwnerOpenId: openId,
      ownerOpenId: openId,
    },
  });
  const recoveryPath = createRecoveryBackupPath(fullPath, asset, suffix);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await Promise.all([
    writeFile(fullPath, failedReplacement),
    writeFile(recoveryPath, oldSignature),
  ]);
  await utimes(recoveryPath, new Date(0), new Date(0));
  try {
    const result = await reconcileStaleUploadArtifacts({
      limit: 1_000,
      olderThanMs: 0,
    });
    expect(result.restored).toBeGreaterThanOrEqual(1);
    await expect(readFile(fullPath)).resolves.toEqual(oldSignature);
    await expect(
      prisma.fileAsset.findUniqueOrThrow({ where: { id: asset.id } }),
    ).resolves.toMatchObject({
      publicPath,
      size: oldSignature.length,
      cleanupRequestedAt: null,
    });
  } finally {
    await removeUploadByPublicPath(publicPath);
    await rm(path.dirname(fullPath), { force: true, recursive: true });
  }
});

test("后续成功覆盖会使旧恢复标记失效且不得回滚新签名", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const openId = `ou_superseded_signature_recovery_${suffix}`;
  const publicPath = `/uploads/signatures/${openId}/signature.png`;
  const storagePath = `signatures/${openId}/signature.png`;
  const fullPath = storagePathToAbsolute(storagePath);
  const oldSignature = pngUpload("old-signature.png").buffer;
  const failedReplacement = Buffer.concat([
    oldSignature,
    Buffer.from("failed-replacement"),
  ]);
  const successfulReplacement = Buffer.concat([
    oldSignature,
    Buffer.from("successful-replacement"),
  ]);
  const asset = await prisma.fileAsset.create({
    data: {
      publicPath,
      storagePath,
      kind: "USER_SIGNATURE",
      mimeType: "image/png",
      size: oldSignature.length,
      signatureOwnerOpenId: openId,
      ownerOpenId: openId,
      writeGeneration: `old-${suffix}`,
    },
  });
  const staleRecoveryPath = createRecoveryBackupPath(fullPath, asset, suffix);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await Promise.all([
    writeFile(fullPath, failedReplacement),
    writeFile(staleRecoveryPath, oldSignature),
  ]);
  await utimes(staleRecoveryPath, new Date(0), new Date(0));
  try {
    await expect(
      saveUserSignature(
        openId,
        new File([successfulReplacement], "signature.png", {
          type: "image/png",
        }),
      ),
    ).resolves.toBe(publicPath);
    const successfulAsset = await prisma.fileAsset.findUniqueOrThrow({
      where: { id: asset.id },
    });
    expect(successfulAsset.writeGeneration).not.toBe(asset.writeGeneration);

    await reconcileStaleUploadArtifacts({ limit: 1_000, olderThanMs: 0 });
    await expect(readFile(fullPath)).resolves.toEqual(successfulReplacement);
    await expect(
      prisma.fileAsset.findUniqueOrThrow({ where: { id: asset.id } }),
    ).resolves.toMatchObject({
      size: successfulReplacement.length,
      writeGeneration: successfulAsset.writeGeneration,
    });
    await expect(readFile(staleRecoveryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removeUploadByPublicPath(publicPath);
    await rm(path.dirname(fullPath), { force: true, recursive: true });
  }
});

test("真实订单更新 action 拒绝跨订单路径并原子处理版本冲突和多图失败", async ({
  page,
  context,
  baseURL,
}) => {
  const auth = await resolveNormalAuthMaterial();
  await loginAsNormalUser(context, baseURL, auth);
  const target = await createDraftProcessingOrder(auth.openId, 2);
  const foreign = await createDraftProcessingOrder(auth.openId, 1);
  const own = await createDraftProcessingOrder(auth.openId, 1);
  const stale = await createDraftProcessingOrder(auth.openId, 1);
  const allOrderIds = [target.id, foreign.id, own.id, stale.id];
  try {
    const originalTargetNames = target.items.map((item) => item.name).sort();
    await page.goto(
      `/procurement/order-action-fixtures?orderId=${target.id}&mode=foreign&foreignPath=${encodeURIComponent(foreign.items[0].referenceImagePath!)}`,
    );
    await page.getByRole("button", { name: "执行订单更新" }).click();
    await expect(page.getByLabel("执行结果")).toContainText(
      "明细图片不属于当前订单",
    );
    await expect(orderItemNames(target.id)).resolves.toEqual(originalTargetNames);

    await page.goto(
      `/procurement/order-action-fixtures?orderId=${own.id}&mode=own`,
    );
    await page.getByRole("button", { name: "执行订单更新" }).click();
    await expect(page.getByLabel("执行结果")).toHaveText("成功");
    await expect(orderItemNames(own.id)).resolves.toEqual([
      `${own.items[0].name}-已更新`,
    ]);

    await page.goto(
      `/procurement/order-action-fixtures?orderId=${stale.id}&mode=stale-upload`,
    );
    const staleAssetCount = await prisma.fileAsset.count({
      where: { orderId: stale.id },
    });
    await prisma.purchaseOrder.update({
      where: { id: stale.id },
      data: { rejectionReason: "并发更新版本" },
    });
    await page.getByRole("button", { name: "执行订单更新" }).click();
    await expect(page.getByLabel("执行结果")).toContainText(
      "订单状态已更新",
    );
    await expect(orderItemNames(stale.id)).resolves.toEqual([
      stale.items[0].name,
    ]);
    await expect(
      prisma.fileAsset.count({ where: { orderId: stale.id } }),
    ).resolves.toBe(staleAssetCount);
    await expect(listStoredFiles(storagePathToAbsolute(stale.id))).resolves.toEqual(
      [],
    );

    const targetAssetCount = await prisma.fileAsset.count({
      where: { orderId: target.id },
    });
    await page.goto(
      `/procurement/order-action-fixtures?orderId=${target.id}&mode=two-upload`,
    );
    await page.getByRole("button", { name: "执行订单更新" }).click();
    await expect(page.getByLabel("执行结果")).toContainText("文件内容");
    await expect(orderItemNames(target.id)).resolves.toEqual(originalTargetNames);
    await expect(
      prisma.fileAsset.count({ where: { orderId: target.id } }),
    ).resolves.toBe(targetAssetCount);
    await expect(listStoredFiles(storagePathToAbsolute(target.id))).resolves.toEqual(
      [],
    );
  } finally {
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: allOrderIds } } });
    await prisma.fileAsset.deleteMany({ where: { orderId: { in: allOrderIds } } });
  }
});

test("管理员删除 action 的持续附件清理失败会持久化并由 cron 收敛", async ({
  page,
  context,
  baseURL,
}) => {
  const auth = await resolveNormalAuthMaterial();
  const order = await createDraftProcessingOrder(auth.openId, 1);
  const publicPath = await saveGeneratedOrderAttachment(
    order.id,
    Buffer.from("admin-delete"),
    "admin-delete",
    "application/octet-stream",
    ".bin",
  );
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `test_admin_delete_cleanup_${suffix}`;
  const triggerName = `test_admin_delete_cleanup_trigger_${suffix}`;
  const sequenceName = `test_admin_delete_cleanup_seq_${suffix}`;
  try {
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${sequenceName}"`);
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF OLD."publicPath" = '${publicPath}'
           AND nextval('"${sequenceName}"') <= 2 THEN
          RAISE EXCEPTION 'injected admin cleanup failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE DELETE ON "FileAsset"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    await ensureFallbackAdminFixture();
    await loginAsAdminUser(context, baseURL);
    await page.goto(`/procurement/${order.id}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("已删除")).toBeVisible();
    await expect(
      prisma.purchaseOrder.count({ where: { id: order.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.fileAsset.findUniqueOrThrow({ where: { publicPath } }),
    ).resolves.toMatchObject({
      cleanupRequestedAt: expect.any(Date),
      cleanupAttempts: 2,
    });
    await dropTriggerAndFunction({
      functionName,
      tableName: "FileAsset",
      triggerName,
    });
    await expect(drainUploadCleanupTasks()).resolves.toEqual({
      cleaned: 1,
      failed: 0,
    });
    await expect(prisma.fileAsset.count({ where: { publicPath } })).resolves.toBe(0);
  } finally {
    await dropTriggerAndFunction({
      functionName,
      tableName: "FileAsset",
      triggerName,
    });
    await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${sequenceName}"`);
    await prisma.purchaseOrder.deleteMany({ where: { id: order.id } });
    await removeUploadByPublicPath(publicPath);
  }
});

test("新建采购在通知入队失败时回滚订单并清理已暂存图片", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const suffix = randomUUID().replaceAll("-", "");
  const marker = `PW采购原子性-${testInfo.project.name}-${suffix}`;
  const functionName = `test_order_outbox_fail_${suffix}`;
  const triggerName = `test_order_outbox_fail_trigger_${suffix}`;
  const vendorName = `PW原子性加工商-${suffix}`;
  const filesBefore = await listStoredFiles();
  const assetCountBefore = await prisma.fileAsset.count({
    where: { kind: "ORDER_ITEM_IMAGE" },
  });
  const auth = await resolveNormalAuthMaterial();
  const originalUser = await prisma.user.findUnique({
    where: { openId: auth.openId },
    select: { signaturePath: true },
  });

  await prisma.processingVendor.create({ data: { name: vendorName } });
  try {
    if (originalUser) {
      await prisma.user.update({
        where: { openId: auth.openId },
        data: {
          signaturePath:
            originalUser.signaturePath ??
            "/uploads/playwright/atomicity-signature.png",
        },
      });
    } else {
      const identity = await resolveFeishuIdentityForUser({
        openId: auth.openId,
        name: auth.name,
      });
      await prisma.user.update({
        where: { openId: auth.openId },
        data: {
          accountId: identity.account.id,
          name: auth.name,
          signaturePath: "/uploads/playwright/atomicity-signature.png",
        },
      });
    }
    await createOutboxFailureTrigger({ functionName, marker, triggerName });
    await loginAsNormalUser(context, baseURL, auth);
    await fillProcessingFeeApplication(page, marker, vendorName);
    await page.getByRole("button", { name: "提交申请" }).click();
    await expect(page.getByRole("button", { name: "提交申请" })).toBeEnabled();

    await expect(
      prisma.purchaseOrder.count({
        where: { items: { some: { name: marker } } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.purchaseItem.count({ where: { name: marker } }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.count({
        where: { payload: { contains: marker } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.fileAsset.count({ where: { kind: "ORDER_ITEM_IMAGE" } }),
    ).resolves.toBe(assetCountBefore);
    await expect(listStoredFiles()).resolves.toEqual(filesBefore);
    await expect(page).toHaveURL(/\/procurement\/new$/);
  } finally {
    await dropTriggerAndFunction({
      functionName,
      tableName: "NotificationOutbox",
      triggerName,
    });
    await prisma.processingVendor.deleteMany({ where: { name: vendorName } });
    if (originalUser) {
      await prisma.user.update({
        where: { openId: auth.openId },
        data: { signaturePath: originalUser.signaturePath },
      });
    } else {
      await prisma.user.deleteMany({ where: { openId: auth.openId } });
    }
  }
});

test("反馈事务失败后附件清理首次失败会重试并收敛", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const suffix = randomUUID().replaceAll("-", "");
  const marker = `PW反馈原子性-${testInfo.project.name}-${suffix}`;
  const outboxFunction = `test_feedback_outbox_fail_${suffix}`;
  const outboxTrigger = `test_feedback_outbox_fail_trigger_${suffix}`;
  const cleanupFunction = `test_feedback_cleanup_retry_${suffix}`;
  const cleanupTrigger = `test_feedback_cleanup_retry_trigger_${suffix}`;
  const cleanupSequence = `test_feedback_cleanup_retry_seq_${suffix}`;
  const filesBefore = await listStoredFiles();
  const assetCountBefore = await prisma.fileAsset.count({
    where: { kind: "FEEDBACK_ATTACHMENT" },
  });

  try {
    await createOutboxFailureTrigger({
      functionName: outboxFunction,
      marker,
      triggerName: outboxTrigger,
    });
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${cleanupSequence}"`);
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${cleanupFunction}"() RETURNS trigger AS $$
      BEGIN
        IF OLD."kind" = 'FEEDBACK_ATTACHMENT'
           AND nextval('"${cleanupSequence}"') = 1 THEN
          RAISE EXCEPTION 'injected first feedback cleanup failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${cleanupTrigger}"
      BEFORE DELETE ON "FileAsset"
      FOR EACH ROW EXECUTE FUNCTION "${cleanupFunction}"()
    `);

    const auth = await resolveNormalAuthMaterial();
    await loginAsNormalUser(context, baseURL, auth);
    await page.goto("/feedback?new=1", { waitUntil: "networkidle" });
    const dialog = page.getByRole("dialog", { name: "提交反馈" });
    await dialog.getByPlaceholder("请输入反馈内容").fill(marker);
    await dialog.locator('input[type="file"]').setInputFiles([
      pngUpload("feedback-atomicity.png"),
    ]);
    await dialog.getByRole("button", { name: "提交反馈" }).click();
    await expect(dialog.getByRole("button", { name: "提交反馈" })).toBeEnabled();

    await expect(
      prisma.feedback.count({
        where: { messages: { some: { body: marker } } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.feedbackMessage.count({ where: { body: marker } }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.count({
        where: { payload: { contains: marker } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.fileAsset.count({ where: { kind: "FEEDBACK_ATTACHMENT" } }),
    ).resolves.toBe(assetCountBefore);
    await expect(listStoredFiles()).resolves.toEqual(filesBefore);
    const [{ lastValue }] = await prisma.$queryRawUnsafe<
      Array<{ lastValue: bigint }>
    >(`SELECT last_value AS "lastValue" FROM "${cleanupSequence}"`);
    expect(Number(lastValue)).toBe(2);
  } finally {
    await dropTriggerAndFunction({
      functionName: cleanupFunction,
      tableName: "FileAsset",
      triggerName: cleanupTrigger,
    });
    await dropTriggerAndFunction({
      functionName: outboxFunction,
      tableName: "NotificationOutbox",
      triggerName: outboxTrigger,
    });
    await prisma.$executeRawUnsafe(
      `DROP SEQUENCE IF EXISTS "${cleanupSequence}"`,
    );
  }
});

test("上传补偿连续失败后由持久化清理任务收敛", async ({}, testInfo) => {
  const suffix = randomUUID().replaceAll("-", "");
  const feedbackId = `cleanup-${testInfo.project.name}-${suffix}`;
  const publicPath = `/uploads/feedback/${feedbackId}/persistent.png`;
  const storagePath = `feedback/${feedbackId}/persistent.png`;
  const functionName = `test_upload_cleanup_defer_${suffix}`;
  const triggerName = `test_upload_cleanup_defer_trigger_${suffix}`;
  const sequenceName = `test_upload_cleanup_defer_seq_${suffix}`;
  const fullPath = storagePathToAbsolute(storagePath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, pngUpload("persistent.png").buffer);
  await prisma.fileAsset.create({
    data: {
      publicPath,
      storagePath,
      kind: "FEEDBACK_ATTACHMENT",
      mimeType: "image/png",
      size: pngUpload("persistent.png").buffer.length,
      feedbackId,
    },
  });
  try {
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${sequenceName}"`);
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF OLD."publicPath" = '${publicPath}'
           AND nextval('"${sequenceName}"') <= 2 THEN
          RAISE EXCEPTION 'injected persistent upload cleanup failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE DELETE ON "FileAsset"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    await expect(
      cleanupUploadPaths([publicPath], "playwright_persistent_failure"),
    ).resolves.toEqual({ cleaned: 0, scheduled: 1 });
    await expect(
      prisma.fileAsset.findUniqueOrThrow({
        where: { publicPath },
        select: {
          cleanupAttempts: true,
          cleanupRequestedAt: true,
          cleanupNextRunAt: true,
        },
      }),
    ).resolves.toMatchObject({
      cleanupAttempts: 2,
      cleanupRequestedAt: expect.any(Date),
      cleanupNextRunAt: expect.any(Date),
    });

    await dropTriggerAndFunction({
      functionName,
      tableName: "FileAsset",
      triggerName,
    });
    await expect(drainUploadCleanupTasks()).resolves.toEqual({
      cleaned: 1,
      failed: 0,
    });
    await expect(
      prisma.fileAsset.count({ where: { publicPath } }),
    ).resolves.toBe(0);
    await expect(fileAssetExists(publicPath)).resolves.toBe(false);
  } finally {
    await dropTriggerAndFunction({
      functionName,
      tableName: "FileAsset",
      triggerName,
    });
    await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${sequenceName}"`);
    await removeUploadByPublicPath(publicPath);
  }
});

async function createOutboxFailureTrigger({
  functionName,
  marker,
  triggerName,
}: {
  functionName: string;
  marker: string;
  triggerName: string;
}) {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
    BEGIN
      IF NEW."payload" LIKE '%${marker}%' THEN
        RAISE EXCEPTION 'injected notification outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}"
    BEFORE INSERT ON "NotificationOutbox"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);
}

async function createDraftProcessingOrder(openId: string, itemCount: number) {
  let user = await prisma.user.findUnique({ where: { openId } });
  if (!user) {
    await resolveFeishuIdentityForUser({
      openId,
      name: "Playwright 原子性测试用户",
    });
    user = await prisma.user.findUniqueOrThrow({ where: { openId } });
  }
  const suffix = randomUUID();
  const created = await prisma.purchaseOrder.create({
    data: {
      orderNo: `PW-ACTION-${suffix}`,
      initiatorId: user.id,
      initiatorName: user.name,
      team: "英雄",
      techGroup: "电控",
      totalPrice: itemCount * 10,
      status: "DRAFT",
      items: {
        create: Array.from({ length: itemCount }, (_, index) => ({
          name: `PW Action Item ${index + 1} ${suffix}`,
          spec: "原子性测试",
          itemKind: "PROCESSING_FEE",
          processingVendor: "原子性供应商",
          quantity: 1,
          unitPrice: 10,
        })),
      },
    },
    include: { items: { orderBy: { name: "asc" } } },
  });
  for (const [index, item] of created.items.entries()) {
    const publicPath = `/uploads/${created.id}/existing-${index}.png`;
    await prisma.$transaction([
      prisma.fileAsset.create({
        data: {
          publicPath,
          storagePath: `${created.id}/existing-${index}.png`,
          kind: "ORDER_ITEM_IMAGE",
          mimeType: "image/png",
          size: 1,
          orderId: created.id,
        },
      }),
      prisma.purchaseItem.update({
        where: { id: item.id },
        data: { referenceImagePath: publicPath },
      }),
    ]);
  }
  return prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: created.id },
    include: { items: { orderBy: { name: "asc" } } },
  });
}

async function orderItemNames(orderId: string) {
  const items = await prisma.purchaseItem.findMany({
    where: { orderId },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return items.map((item) => item.name);
}

async function dropTriggerAndFunction({
  functionName,
  tableName,
  triggerName,
}: {
  functionName: string;
  tableName: "FileAsset" | "NotificationOutbox" | "PurchaseOrder";
  triggerName: string;
}) {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${triggerName}" ON "${tableName}"`,
  );
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
}

async function fillProcessingFeeApplication(
  page: Page,
  marker: string,
  vendorName: string,
) {
  await page.goto("/procurement/new", { waitUntil: "networkidle" });
  await page.getByLabel("车组").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page.getByLabel("技术组").click();
  await page.getByRole("option", { name: "电控" }).click();
  await page.getByLabel("物品名称").fill(marker);
  await page.getByLabel("规格").fill("PW-ATOMIC-SPEC");
  await page.getByLabel("物品种类").click();
  await page.getByRole("option", { name: "加工费" }).click();
  await page.getByLabel("加工商").click();
  await page.getByRole("option", { name: vendorName }).click();
  await page.getByLabel("参考图片").setInputFiles([
    pngUpload("order-atomicity.png"),
  ]);
  await page.getByLabel("行总价").fill("42");
}

function pngUpload(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  };
}

async function listStoredFiles(
  root = uploadStorageRoot(),
  relativeDirectory = "",
): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listStoredFiles(root, relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
