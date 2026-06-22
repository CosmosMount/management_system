"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendOrderNotification } from "@/lib/feishu";
import {
  MAX_INVOICE_COUNT,
  saveUpload,
  uploadTypeSets,
} from "@/lib/file-upload";
import { serializeFilePaths } from "@/lib/order-attachments";
import { prisma } from "@/lib/prisma";
import { canUploadApplicantDocs } from "@/lib/permissions";

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
      initiator: { select: { openId: true } },
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

  const orderItemIds = new Set(order.items.map((item) => item.id));
  for (const item of confirmedItems) {
    if (!orderItemIds.has(item.id)) {
      throw new Error("采购明细与订单不匹配");
    }
  }

  const invoices = formData
    .getAll("invoices")
    .filter((f): f is File => f instanceof File && f.size > 0);
  const listDoc = formData.get("listDoc");

  if (invoices.length === 0) {
    throw new Error("请至少上传一张发票");
  }
  if (invoices.length > MAX_INVOICE_COUNT) {
    throw new Error(`发票最多上传 ${MAX_INVOICE_COUNT} 张`);
  }
  if (!(listDoc instanceof File) || listDoc.size === 0) {
    throw new Error("请上传 Word 清单");
  }

  const invoicePaths: string[] = [];
  for (let i = 0; i < invoices.length; i++) {
    const saved = await saveUpload(
      orderId,
      invoices[i],
      `invoice-${i + 1}`,
      uploadTypeSets.invoice,
    );
    invoicePaths.push(saved);
  }

  const listDocPath = await saveUpload(
    orderId,
    listDoc,
    "list",
    uploadTypeSets.listDoc,
  );

  const itemMap = new Map(order.items.map((item) => [item.id, item]));
  const totalPrice = confirmedItems.reduce((sum, c) => sum + c.lineTotal, 0);

  const updated = await prisma.$transaction(async (tx) => {
    for (const confirmed of confirmedItems) {
      const dbItem = itemMap.get(confirmed.id);
      if (!dbItem || dbItem.quantity <= 0) continue;
      await tx.purchaseItem.update({
        where: { id: confirmed.id },
        data: { unitPrice: confirmed.lineTotal / dbItem.quantity },
      });
    }

    return tx.purchaseOrder.update({
      where: { id: orderId },
      data: {
        totalPrice,
        invoicePaths: serializeFilePaths(invoicePaths),
        invoicePath: invoicePaths[0] ?? null,
        listDocPath,
        status: OrderStatus.PENDING_FINANCE_REVIEW,
      },
    });
  });

  await sendOrderNotification({
    id: updated.id,
    orderNo: updated.orderNo,
    initiatorName: updated.initiatorName,
    totalPrice: updated.totalPrice,
    status: updated.status,
    team: updated.team,
    techGroup: updated.techGroup,
  }).catch((err) => {
    console.error("[uploadApplicantDocs] 飞书通知失败:", err);
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/dashboard");
  return updated;
}
