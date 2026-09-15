"use server";

import { createHash } from "node:crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { OrderStatus, Prisma } from "@prisma/client";
import { mapOrderItems } from "@/lib/procurement-notification-contract";
import {
  enqueueOrderNotificationTx,
  orderNotificationEventKey,
} from "@/lib/notification-producers/procurement";
import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";
import { getNotificationContext } from "@/lib/request-origin";
import {
  MAX_FILE_SIZE,
  MAX_INVOICE_COUNT,
  saveUpload,
  publicPathToStoragePath,
  uploadTypeSets,
} from "@/lib/file-upload";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";
import { MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";
import {
  formatDocDate,
  generateReimbursementListDocx,
  publicPathToAbsolute,
  saveGeneratedListDoc,
  type ReimbursementDocItem,
} from "@/lib/generate-reimbursement-docx";
import { serializeFilePaths, resolveInvoicePaths } from "@/lib/order-attachments";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { clearProcurementRejectionFields } from "@/lib/procurement-rejection";
import { prisma } from "@/lib/prisma";
import { canRemoveApplicantInvoices, canSupplementApplicantDocs, canUploadApplicantDocs } from "@/lib/permissions";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { logger } from "@/lib/logger";
import {
  assertListSignaturesReady,
  resolveReimbursementListSignatures,
} from "@/lib/reimbursement-list-signatures";
import { revalidateProcurement } from "@/lib/revalidate";
import {
  lockActiveProcurementUserTx,
  requireActiveProcurementUser,
} from "@/lib/active-account";

const confirmedItemSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1, "物品名称不能为空"),
  spec: z.string().trim().min(1, "规格不能为空"),
  quantity: z.coerce.number().int().min(1, "数量至少为 1"),
  lineTotal: z.number().min(0),
});

function canEditApplicantDocs(
  status: OrderStatus,
  userOpenId: string | undefined,
  initiatorOpenId: string,
): boolean {
  return (
    canUploadApplicantDocs(status, userOpenId, initiatorOpenId) ||
    canSupplementApplicantDocs(status, userOpenId, initiatorOpenId)
  );
}

export async function uploadApplicantDocs(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  await requireActiveProcurementUser(session.user.openId);

  const orderId = String(formData.get("orderId") ?? "");
  const confirmedRaw = String(formData.get("confirmedItems") ?? "[]");
  let removedInvoicePaths: string[];
  try {
    removedInvoicePaths = [...new Set(z.array(z.string().min(1).max(1024))
      .max(MAX_INVOICE_COUNT)
      .parse(JSON.parse(String(formData.get("removedInvoicePaths") ?? "[]"))))];
  } catch {
    throw new Error("待删除发票参数无效");
  }

  if (!orderId) {
    throw new Error("参数无效");
  }

  let confirmedItems: z.infer<typeof confirmedItemSchema>[];
  try {
    const parsed = z.array(confirmedItemSchema).parse(JSON.parse(confirmedRaw));
    if (parsed.length === 0) {
      throw new Error("请确认采购明细");
    }
    confirmedItems = parsed;
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(err.issues[0]?.message ?? "采购明细数据无效");
    }
    throw new Error("采购明细数据无效");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      initiator: { select: { openId: true, name: true, signaturePath: true } },
      items: true,
    },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  if (
    !canEditApplicantDocs(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    throw new Error("无上传权限");
  }

  const isInitialSubmit = order.status === OrderStatus.PENDING_APPLICANT_DOCS;
  if (removedInvoicePaths.length > 0 && !canRemoveApplicantInvoices(
    order.status, session.user.openId, order.initiator.openId,
  )) {
    throw new Error("当前状态不允许删除发票");
  }

  if (confirmedItems.length > MAX_REIMBURSEMENT_LIST_ROWS) {
    throw new Error(
      `当前明细 ${confirmedItems.length} 行，验收清单最多支持 ${MAX_REIMBURSEMENT_LIST_ROWS} 行`,
    );
  }
  if (confirmedItems.length === 0) {
    throw new Error("请至少保留一行采购明细");
  }

  const orderItemIds = new Set(order.items.map((item) => item.id));
  const confirmedIds = new Set(confirmedItems.map((item) => item.id));
  for (const item of confirmedItems) {
    const isNew = item.id.startsWith("new_");
    if (!isNew && !orderItemIds.has(item.id)) {
      throw new Error("采购明细与订单不匹配");
    }
  }

  const invoices = formData
    .getAll("invoices")
    .filter((f): f is File => f instanceof File && f.size > 0);
  const existingInvoices = resolveInvoicePaths(
    order.invoicePaths,
    order.invoicePath,
  );
  for (const filePath of removedInvoicePaths) {
    const storagePath = publicPathToStoragePath(filePath);
    if (!existingInvoices.includes(filePath) || !storagePath ||
      !storagePath.startsWith(`${orderId}/`) || storagePath.includes("\\") || storagePath.includes("\0") ||
      filePath === order.listDocPath || filePath === order.screenshotPath ||
      order.items.some((item) => item.photoPath === filePath || item.referenceImagePath === filePath)) {
      throw new Error("待删除发票不属于当前订单的有效发票，请刷新后重试");
    }
  }
  const retainedInvoices = existingInvoices.filter((filePath) => !removedInvoicePaths.includes(filePath));
  if (invoices.length === 0 && retainedInvoices.length === 0) {
    throw new Error("请至少上传一张发票");
  }
  if (retainedInvoices.length + invoices.length > MAX_INVOICE_COUNT) {
    throw new Error(`发票最多上传 ${MAX_INVOICE_COUNT} 张`);
  }

  const itemMap = new Map(order.items.map((item) => [item.id, item]));
  const deletedItems = order.items.filter((item) => !confirmedIds.has(item.id));
  /** client line id -> saved photo public path */
  const photoByClientId = new Map<string, string>();
  const invoicePaths: string[] = [];
  const newlyUploadedPaths: string[] = [];
  const replacedPhotoPaths: string[] = [
    ...deletedItems
      .map((item) => item.photoPath)
      .filter((path): path is string => !!path),
  ];
  const previousListDocPath = order.listDocPath;
  let listDocPath = "";
  try {
    for (const confirmed of confirmedItems) {
      const dbItem = itemMap.get(confirmed.id);
      const isNew = confirmed.id.startsWith("new_");
      const photo = formData.get(`photo-${confirmed.id}`);
      if (photo instanceof File && photo.size > 0) {
        if (photo.size > MAX_FILE_SIZE) {
          throw new Error("单张照片不能超过 20MB");
        }
        const saved = await saveUpload(
          orderId,
          photo,
          `item-photo-${confirmed.id.slice(0, 12)}`,
          uploadTypeSets.itemPhoto,
        );
        photoByClientId.set(confirmed.id, saved);
        newlyUploadedPaths.push(saved);
        if (dbItem?.photoPath) {
          replacedPhotoPaths.push(dbItem.photoPath);
        }
      } else if (dbItem?.photoPath) {
        photoByClientId.set(confirmed.id, dbItem.photoPath);
      } else {
        throw new Error(`请为「${confirmed.name}」上传一张实物照片`);
      }
      if (isNew && !photoByClientId.has(confirmed.id)) {
        throw new Error(`请为「${confirmed.name}」上传一张实物照片`);
      }
    }

    for (let i = 0; i < invoices.length; i++) {
      const saved = await saveUpload(
        orderId,
        invoices[i],
        `invoice-${existingInvoices.length + i + 1}`,
        uploadTypeSets.invoice,
      );
      invoicePaths.push(saved);
      newlyUploadedPaths.push(saved);
    }
    const finalInvoicePaths = [...retainedInvoices, ...invoicePaths];

    const docItems: ReimbursementDocItem[] = confirmedItems.map((confirmed) => {
      const unitPrice =
        confirmed.quantity > 0 ? confirmed.lineTotal / confirmed.quantity : 0;
      const photoPath = photoByClientId.get(confirmed.id);
      return {
        name: confirmed.name,
        spec: confirmed.spec,
        quantity: confirmed.quantity,
        unitPrice,
        lineTotal: confirmed.lineTotal,
        photoAbsolutePath: photoPath
          ? publicPathToAbsolute(photoPath)
          : null,
      };
    });

    const signatures = await resolveReimbursementListSignatures({
      team: order.team,
      techGroup: order.techGroup,
      teamApproverAccountId: order.teamApproverAccountId,
      teamApproverOpenId: order.teamApproverOpenId,
      techGroupApproverAccountId: order.techGroupApproverAccountId,
      techGroupApproverOpenId: order.techGroupApproverOpenId,
      initiator: order.initiator,
    });
    assertListSignaturesReady(signatures, true);
    const docDate = formatDocDate();
    const listBuffer = generateReimbursementListDocx(docItems, {
      acceptor1Path: signatures.acceptor1Path,
      acceptor2Path: signatures.acceptor2Path,
      receiverPath: signatures.receiverPath,
      acceptDate: docDate,
      receiveDate: docDate,
    });
    listDocPath = await saveGeneratedListDoc(orderId, listBuffer);
    newlyUploadedPaths.push(listDocPath);

    const totalPrice = confirmedItems.reduce((sum, c) => sum + c.lineTotal, 0);
    const context = isInitialSubmit ? await getNotificationContext() : null;

    await prisma.$transaction(async (tx) => {
      await lockActiveProcurementUserTx(tx, session.user.openId);
      // 先锁定订单版本，再写明细，避免并发保存把已经删除的发票写回。
      const locked = await tx.purchaseOrder.updateMany({
        where: { id: orderId, status: order.status, updatedAt: order.updatedAt, initiatorId: order.initiatorId },
        data: {
          totalPrice,
          invoicePaths: serializeFilePaths(finalInvoicePaths),
          invoicePath: finalInvoicePaths[0] ?? null,
          listDocPath,
          ...(isInitialSubmit
            ? {
                status: OrderStatus.PENDING_FINANCE_REVIEW,
                ...clearProcurementRejectionFields(),
                ...stepTimerResetFields(),
              }
            : {}),
        },
      });
      if (locked.count !== 1) {
        throw new Error("凭证或订单状态已更新，请刷新后重试");
      }

      if (removedInvoicePaths.length > 0) {
        const cleanupAt = new Date();
        for (const publicPath of removedInvoicePaths) {
          const storagePath = publicPathToStoragePath(publicPath)!;
          const asset = await tx.fileAsset.findUnique({ where: { publicPath } });
          if (asset && (asset.kind !== "ORDER_ATTACHMENT" || asset.orderId !== orderId ||
            asset.storagePath !== storagePath || asset.cleanupRequestedAt)) {
            throw new Error("待删除发票资产无效，请刷新后重试");
          }
          // 历史单字段发票可能没有资产记录；先登记清理任务，保证提交后可重试。
          await tx.fileAsset.upsert({
            where: { publicPath },
            create: {
              publicPath, storagePath, kind: "ORDER_ATTACHMENT", orderId,
              mimeType: "application/octet-stream", size: 0,
              cleanupRequestedAt: cleanupAt, cleanupNextRunAt: cleanupAt,
            },
            update: { cleanupRequestedAt: cleanupAt, cleanupNextRunAt: cleanupAt },
          });
        }
        const actor = await tx.accountIdentity.findFirstOrThrow({
          where: { provider: "FEISHU", tenantId: "default", openId: session.user.openId },
          select: { accountId: true, account: { select: { person: { select: { id: true } } } } },
        });
        // 保留稳定的发票引用供审计比对，不将下载路径写入审计载荷。
        const references = (paths: string[]) => paths.map((value) => createHash("sha256").update(value).digest("hex"));
        await createDomainAuditEventTx(tx, {
          actorAccountId: actor.accountId,
          actorPersonId: actor.account.person?.id,
          action: "procurement.invoices.remove",
          entityType: "PurchaseOrder", entityId: orderId,
          before: { status: order.status, invoiceReferences: references(existingInvoices) },
          after: {
            status: isInitialSubmit ? OrderStatus.PENDING_FINANCE_REVIEW : order.status,
            invoiceReferences: references(finalInvoicePaths),
            removedInvoiceReferences: references(removedInvoicePaths),
          },
        });
      }
      if (deletedItems.length > 0) {
        await tx.purchaseItem.deleteMany({
          where: {
            orderId,
            id: { in: deletedItems.map((item) => item.id) },
          },
        });
      }

      for (const confirmed of confirmedItems) {
        const unitPrice =
          confirmed.quantity > 0
            ? confirmed.lineTotal / confirmed.quantity
            : 0;
        const photoPath = photoByClientId.get(confirmed.id) ?? null;
        const isNew = confirmed.id.startsWith("new_");

        if (isNew) {
          await tx.purchaseItem.create({
            data: {
              orderId,
              name: confirmed.name,
              spec: confirmed.spec,
              quantity: confirmed.quantity,
              unitPrice,
              photoPath,
            },
          });
          continue;
        }

        await tx.purchaseItem.update({
          where: { id: confirmed.id },
          data: {
            name: confirmed.name,
            spec: confirmed.spec,
            quantity: confirmed.quantity,
            unitPrice,
            photoPath,
          },
        });
      }

      if (!isInitialSubmit || !context) {
        return;
      }

      const record = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: orderId },
      });

      await enqueueOrderNotificationTx(
        tx,
        orderNotificationEventKey(record),
        {
          id: record.id,
          orderNo: record.orderNo,
          initiatorName: record.initiatorName,
          totalPrice: record.totalPrice,
          status: record.status,
          team: record.team,
          techGroup: record.techGroup,
          items: mapOrderItems(
            docItems.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          ),
        },
        context,
      );
    });
  } catch (err) {
    await cleanupUploadPaths(
      newlyUploadedPaths,
      "applicant_documents_transaction_compensation",
    );
    logger.error("procurement.applicant_documents.save_failed", {
      module: "procurement", action: "uploadApplicantDocs",
      actorOpenId: session.user.openId, entityType: "PurchaseOrder", entityId: orderId, error: err,
    });
    if (err instanceof Prisma.PrismaClientKnownRequestError ||
      err instanceof Prisma.PrismaClientUnknownRequestError ||
      (err instanceof Error && ("code" in err || "clientVersion" in err))) {
      throw new Error("凭证保存失败，请稍后重试");
    }
    throw err;
  }
  // 提交后清理失败不能补偿删除本次已成功保存的文件。
  await cleanupUploadPaths(
    [
      ...removedInvoicePaths,
      ...replacedPhotoPaths,
      ...(previousListDocPath && previousListDocPath !== listDocPath ? [previousListDocPath] : []),
    ],
    "applicant_documents_replaced",
  );
  if (isInitialSubmit) {
    drainNotificationOutboxSoon();
  }

  revalidateProcurement(orderId);
  return { id: orderId, supplemented: !isInitialSubmit };
}

/** 提交前预览生成的验收清单（不落库） */
export async function previewReimbursementListDoc(input: {
  orderId: string;
  confirmedItems: {
    id: string;
    name: string;
    spec: string;
    quantity: number;
    lineTotal: number;
  }[];
}): Promise<{ fileName: string; base64: string }> {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: input.orderId },
    include: {
      initiator: { select: { openId: true, name: true, signaturePath: true } },
      items: true,
    },
  });
  if (!order) throw new Error("订单不存在");

  if (
    !canEditApplicantDocs(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    throw new Error("无权限");
  }

  const itemMap = new Map(order.items.map((item) => [item.id, item]));
  const docItems: ReimbursementDocItem[] = input.confirmedItems.map(
    (confirmed) => {
      const dbItem = itemMap.get(confirmed.id);
      const quantity =
        confirmed.quantity > 0
          ? confirmed.quantity
          : (dbItem?.quantity ?? 1);
      return {
        name: confirmed.name || dbItem?.name || "未命名物品",
        spec: confirmed.spec || dbItem?.spec || "",
        quantity,
        unitPrice: quantity > 0 ? confirmed.lineTotal / quantity : 0,
        lineTotal: confirmed.lineTotal,
        photoAbsolutePath: dbItem?.photoPath
          ? publicPathToAbsolute(dbItem.photoPath)
          : null,
      };
    },
  );

  const signatures = await resolveReimbursementListSignatures({
    team: order.team,
    techGroup: order.techGroup,
    teamApproverAccountId: order.teamApproverAccountId,
    teamApproverOpenId: order.teamApproverOpenId,
    techGroupApproverAccountId: order.techGroupApproverAccountId,
    techGroupApproverOpenId: order.techGroupApproverOpenId,
    initiator: order.initiator,
  });
  const docDate = formatDocDate();
  const buffer = generateReimbursementListDocx(docItems, {
    acceptor1Path: signatures.acceptor1Path,
    acceptor2Path: signatures.acceptor2Path,
    receiverPath: signatures.receiverPath,
    acceptDate: docDate,
    receiveDate: docDate,
  });
  return {
    fileName: `物品验收及领用清单-${order.orderNo}.docx`,
    base64: buffer.toString("base64"),
  };
}
