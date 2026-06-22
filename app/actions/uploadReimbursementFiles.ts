"use server";

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canUploadReimbursement, getUserRole } from "@/lib/permissions";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

async function saveUpload(
  orderId: string,
  file: File,
  prefix: string,
): Promise<string> {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error(`不支持的文件类型: ${file.type}`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("文件大小不能超过 10MB");
  }

  const ext = path.extname(file.name) || ".bin";
  const filename = `${prefix}-${Date.now()}${ext}`;
  const dir = path.join(process.cwd(), "public", "uploads", orderId);
  await mkdir(dir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, filename), buffer);
  return `/uploads/${orderId}/${filename}`;
}

export async function uploadReimbursementFiles(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const role = await getUserRole(session.user.openId);
  const orderId = String(formData.get("orderId") ?? "");
  const totalPrice = Number(formData.get("totalPrice"));
  const complete = formData.get("complete") === "true";

  if (!orderId || Number.isNaN(totalPrice)) {
    throw new Error("参数无效");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  if (!canUploadReimbursement(order.status, role)) {
    throw new Error("无报销操作权限");
  }

  const invoice = formData.get("invoice");
  const screenshot = formData.get("screenshot");

  const updateData: {
    totalPrice: number;
    invoicePath?: string;
    screenshotPath?: string;
    status?: OrderStatus;
  } = { totalPrice };

  if (invoice instanceof File && invoice.size > 0) {
    updateData.invoicePath = await saveUpload(orderId, invoice, "invoice");
  }
  if (screenshot instanceof File && screenshot.size > 0) {
    updateData.screenshotPath = await saveUpload(
      orderId,
      screenshot,
      "screenshot",
    );
  }

  if (complete) {
    const invoicePath = updateData.invoicePath ?? order.invoicePath;
    const screenshotPath = updateData.screenshotPath ?? order.screenshotPath;
    if (!invoicePath || !screenshotPath) {
      throw new Error("完成报销需同时上传发票和系统截图");
    }
    updateData.status = OrderStatus.COMPLETED;
  } else if (order.status === OrderStatus.PENDING_REIMBURSE) {
    updateData.status = OrderStatus.REIMBURSING;
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: updateData,
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return updated;
}
