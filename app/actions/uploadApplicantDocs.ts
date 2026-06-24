"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { OrderStatus, UserRoleType } from "@prisma/client";
import { sendOrderNotification, mapOrderItems } from "@/lib/feishu";
import { getNotificationContext } from "@/lib/request-origin";
import {
  MAX_FILE_SIZE,
  MAX_INVOICE_COUNT,
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
import { prisma } from "@/lib/prisma";
import { canUploadApplicantDocs } from "@/lib/permissions";
import { routes } from "@/lib/routes";

const confirmedItemSchema = z.object({
  id: z.string(),
  lineTotal: z.number().min(0),
});

type ListSignatureContext = {
  acceptor1Path: string | null;
  acceptor2Path: string | null;
  receiverPath: string | null;
  acceptor1Label: string;
  acceptor2Label: string;
  receiverLabel: string;
};

async function resolveListSignatures(
  team: string,
  techGroup: string,
  initiator: { name: string; signaturePath: string | null },
): Promise<ListSignatureContext> {
  const roles = await prisma.userRole.findMany({
    where: {
      OR: [
        { role: UserRoleType.TEAM_ADMIN, team },
        { role: UserRoleType.TECH_GROUP_ADMIN, techGroup },
      ],
    },
  });

  const openIds = roles.map((r) => r.openId);
  const users =
    openIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { openId: { in: openIds } },
          select: { openId: true, name: true, signaturePath: true },
        });
  const userByOpenId = new Map(users.map((u) => [u.openId, u]));

  const teamAdmin = roles.find((r) => r.role === UserRoleType.TEAM_ADMIN);
  const techAdmin = roles.find((r) => r.role === UserRoleType.TECH_GROUP_ADMIN);
  const teamUser = teamAdmin ? userByOpenId.get(teamAdmin.openId) : undefined;
  const techUser = techAdmin ? userByOpenId.get(techAdmin.openId) : undefined;

  return {
    acceptor1Path: teamUser?.signaturePath
      ? publicPathToAbsolute(teamUser.signaturePath)
      : null,
    acceptor2Path: techUser?.signaturePath
      ? publicPathToAbsolute(techUser.signaturePath)
      : null,
    receiverPath: initiator.signaturePath
      ? publicPathToAbsolute(initiator.signaturePath)
      : null,
    acceptor1Label: teamUser?.name ?? "车组组长",
    acceptor2Label: techUser?.name ?? "技术组组长",
    receiverLabel: initiator.name,
  };
}

function assertListSignaturesReady(
  signatures: ListSignatureContext,
  requireAll: boolean,
): void {
  if (!requireAll) return;

  const missing: string[] = [];
  if (!signatures.acceptor1Path) {
    missing.push(`验收人 1（${signatures.acceptor1Label}）`);
  }
  if (!signatures.acceptor2Path) {
    missing.push(`验收人 2（${signatures.acceptor2Label}）`);
  }
  if (!signatures.receiverPath) {
    missing.push(`领用人（${signatures.receiverLabel}）`);
  }
  if (missing.length > 0) {
    throw new Error(
      `以下人员尚未上传电子签名，请先在「个人中心」上传：${missing.join("、")}`,
    );
  }
}

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

  const signatures = await resolveListSignatures(
    order.team,
    order.techGroup,
    order.initiator,
  );
  assertListSignaturesReady(signatures, true);
  const docDate = formatDocDate();
  const listBuffer = generateReimbursementListDocx(docItems, {
    acceptor1Path: signatures.acceptor1Path,
    acceptor2Path: signatures.acceptor2Path,
    receiverPath: signatures.receiverPath,
    acceptDate: docDate,
    receiveDate: docDate,
  });
  const listDocPath = await saveGeneratedListDoc(orderId, listBuffer);

  const totalPrice = confirmedItems.reduce((sum, c) => sum + c.lineTotal, 0);

  const updated = await prisma.$transaction(async (tx) => {
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

    return tx.purchaseOrder.update({
      where: { id: orderId },
      data: {
        totalPrice,
        invoicePaths: serializeFilePaths(invoicePaths),
        invoicePath: invoicePaths[0] ?? null,
        listDocPath,
        status: OrderStatus.PENDING_FINANCE_REVIEW,
        rejectionReason: null,
        rejectedAt: null,
        rejectedByName: null,
        ...stepTimerResetFields(),
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
    items: mapOrderItems(docItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    }))),
  }, await getNotificationContext()).catch((err) => {
    console.error("[uploadApplicantDocs] 飞书通知失败:", err);
  });

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  revalidatePath(routes.procurement.dashboard);
  return updated;
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

  const signatures = await resolveListSignatures(
    order.team,
    order.techGroup,
    order.initiator,
  );
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
