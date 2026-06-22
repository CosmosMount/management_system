"use server";

import { revalidatePath } from "next/cache";
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

export async function uploadApplicantDocs(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const orderId = String(formData.get("orderId") ?? "");
  const totalPrice = Number(formData.get("totalPrice"));

  if (!orderId || Number.isNaN(totalPrice)) {
    throw new Error("参数无效");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { initiator: { select: { openId: true } } },
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

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: {
      totalPrice,
      invoicePaths: serializeFilePaths(invoicePaths),
      invoicePath: invoicePaths[0] ?? null,
      listDocPath,
      status: OrderStatus.PENDING_FINANCE_REVIEW,
    },
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
  return updated;
}
