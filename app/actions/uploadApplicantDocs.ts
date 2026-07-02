"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotificationTx,
  orderNotificationEventKey,
} from "@/lib/notification-outbox";
import { getNotificationContext } from "@/lib/request-origin";
import {
  MAX_FILE_SIZE,
  MAX_INVOICE_COUNT,
  removeUploadByPublicPath,
  saveUpload,
  uploadTypeSets,
} from "@/lib/file-upload";
import { MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";
import {
  formatDocDate,
  generateReimbursementListDocx,
  publicPathToAbsolute,
  saveGeneratedListDoc,
  type ReimbursementDocItem,
} from "@/lib/generate-reimbursement-docx";
import { serializeFilePaths } from "@/lib/order-attachments";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { clearProcurementRejectionFields } from "@/lib/procurement-rejection";
import { prisma } from "@/lib/prisma";
import { canUploadApplicantDocs } from "@/lib/permissions";
import {
  assertListSignaturesReady,
  resolveReimbursementListSignatures,
} from "@/lib/reimbursement-list-signatures";
import { revalidateProcurement } from "@/lib/revalidate";

const confirmedItemSchema = z.object({
  id: z.string(),
  lineTotal: z.number().min(0),
});

export async function uploadApplicantDocs(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const orderId = String(formData.get("orderId") ?? "");
  const confirmedRaw = String(formData.get("confirmedItems") ?? "[]");

  if (!orderId) {
    throw new Error("参数无效");
  }

  let confirmedItems: z.infer<typeof confirmedItemSchema>[];
  try {
    const parsed = z.array(confirmedItemSchema).parse(JSON.parse(confirmedRaw));
    if (parsed.length === 0) {
      throw new Error("请确认采购明细价格");
    }
    confirmedItems = parsed;
  } catch {
    throw new Error("采购明细价格数据无效");
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
    !canUploadApplicantDocs(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    throw new Error("无上传权限");
  }

  if (order.items.length > MAX_REIMBURSEMENT_LIST_ROWS) {
    throw new Error(
      `当前明细 ${order.items.length} 行，验收清单最多支持 ${MAX_REIMBURSEMENT_LIST_ROWS} 行`,
    );
  }

  const orderItemIds = new Set(order.items.map((item) => item.id));
  for (const item of confirmedItems) {
    if (!orderItemIds.has(item.id)) {
      throw new Error("采购明细与订单不匹配");
    }
  }

  const invoices = formData
    .getAll("invoices")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (invoices.length === 0) {
    throw new Error("请至少上传一张发票");
  }
  if (invoices.length > MAX_INVOICE_COUNT) {
    throw new Error(`发票最多上传 ${MAX_INVOICE_COUNT} 张`);
  }

  const itemMap = new Map(order.items.map((item) => [item.id, item]));
  const photoPaths = new Map<string, string>();
  const invoicePaths: string[] = [];
  let listDocPath = "";
  try {
    for (const confirmed of confirmedItems) {
      const photo = formData.get(`photo-${confirmed.id}`);
      if (!(photo instanceof File) || photo.size === 0) {
        const dbItem = itemMap.get(confirmed.id);
        throw new Error(`请为「${dbItem?.name ?? "明细"}」上传实物照片`);
      }
      if (photo.size > MAX_FILE_SIZE) {
        throw new Error("单张照片不能超过 20MB");
      }
      const saved = await saveUpload(
        orderId,
        photo,
        `item-photo-${confirmed.id.slice(0, 8)}`,
        uploadTypeSets.itemPhoto,
      );
      photoPaths.set(confirmed.id, saved);
    }

    for (let i = 0; i < invoices.length; i++) {
      const saved = await saveUpload(
        orderId,
        invoices[i],
        `invoice-${i + 1}`,
        uploadTypeSets.invoice,
      );
      invoicePaths.push(saved);
    }

    const docItems: ReimbursementDocItem[] = confirmedItems.map((confirmed) => {
      const dbItem = itemMap.get(confirmed.id)!;
      const unitPrice =
        dbItem.quantity > 0 ? confirmed.lineTotal / dbItem.quantity : 0;
      const photoPath = photoPaths.get(confirmed.id);
      return {
        name: dbItem.name,
        spec: dbItem.spec,
        quantity: dbItem.quantity,
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
      teamApproverOpenId: order.teamApproverOpenId,
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

    const totalPrice = confirmedItems.reduce((sum, c) => sum + c.lineTotal, 0);
    const context = await getNotificationContext();

    await prisma.$transaction(async (tx) => {
      for (const confirmed of confirmedItems) {
        const dbItem = itemMap.get(confirmed.id);
        if (!dbItem || dbItem.quantity <= 0) continue;
        await tx.purchaseItem.update({
          where: { id: confirmed.id },
          data: {
            unitPrice: confirmed.lineTotal / dbItem.quantity,
            photoPath: photoPaths.get(confirmed.id) ?? null,
          },
        });
      }

      const locked = await tx.purchaseOrder.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          totalPrice,
          invoicePaths: serializeFilePaths(invoicePaths),
          invoicePath: invoicePaths[0] ?? null,
          listDocPath,
          status: OrderStatus.PENDING_FINANCE_REVIEW,
          ...clearProcurementRejectionFields(),
          ...stepTimerResetFields(),
        },
      });
      if (locked.count !== 1) {
        throw new Error("订单状态已更新，请刷新后重试");
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
    await Promise.allSettled(
      [...photoPaths.values(), ...invoicePaths, listDocPath].map((publicPath) =>
        removeUploadByPublicPath(publicPath),
      ),
    );
    throw err;
  }
  try {
    drainNotificationOutboxSoon();
  } catch (err) {
    console.error("[procurement] drain notification outbox failed:", err);
  }

  revalidateProcurement(orderId);
  return { id: orderId };
}

/** 提交前预览生成的验收清单（不落库） */
export async function previewReimbursementListDoc(input: {
  orderId: string;
  confirmedItems: { id: string; lineTotal: number }[];
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
    !canUploadApplicantDocs(
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
      if (!dbItem) throw new Error("采购明细与订单不匹配");
      return {
        name: dbItem.name,
        spec: dbItem.spec,
        quantity: dbItem.quantity,
        unitPrice:
          dbItem.quantity > 0 ? confirmed.lineTotal / dbItem.quantity : 0,
        lineTotal: confirmed.lineTotal,
      };
    },
  );

  const signatures = await resolveReimbursementListSignatures({
    team: order.team,
    techGroup: order.techGroup,
    teamApproverOpenId: order.teamApproverOpenId,
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
