import type { OrderStatus } from "@prisma/client";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { resolveProcurementBotKind } from "@/lib/feishu-bot-routing";
import type { OrderCardPayload } from "@/lib/feishu";
import { mapOrderItems } from "@/lib/feishu";
import { enrichOrderCardPayloadFromDb } from "@/lib/feishu-order-card-payload";
import {
  resolveProcurementCardScreenshotOptions,
  resolveProcurementFinanceReviewAttachmentOptions,
} from "@/lib/feishu-procurement-card-assets";
import {
  buildClosedProcurementCardKitCard,
  buildProcurementCardKitCard,
  defaultDetailFocus,
  supportsProcurementCardApproval,
  supportsProcurementCardConfirm,
} from "@/lib/feishu-procurement-card";
import { updateCardKitInstanceResilient } from "@/lib/feishu-cardkit";
import { statusLabels } from "@/lib/permissions-client";
import { prisma } from "@/lib/prisma";
import { getDefaultNotificationContext } from "@/lib/request-origin";

function isActionableProcurementStatus(status: OrderStatus): boolean {
  return (
    supportsProcurementCardApproval(status) ||
    supportsProcurementCardConfirm(status)
  );
}

function stageStillActionable(
  cardStage: OrderStatus,
  currentStatus: OrderStatus,
): boolean {
  return cardStage === currentStatus && isActionableProcurementStatus(currentStatus);
}

function defaultClosedNotice(
  cardStage: OrderStatus,
  currentStatus: OrderStatus,
): string {
  if (cardStage !== currentStatus) {
    return `该卡片对应环节已结束（当前状态：${statusLabels[currentStatus]}）`;
  }
  return `当前状态：${statusLabels[currentStatus]}，请打开系统查看最新进度`;
}

async function loadEnrichedOrderCard(orderId: string): Promise<{
  order: OrderCardPayload;
  botKind: FeishuBotKind;
  attachmentOptions: Record<string, unknown>;
  focus: ReturnType<typeof defaultDetailFocus>;
} | null> {
  const record = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      initiator: { select: { name: true } },
    },
  });
  if (!record) return null;

  const order: OrderCardPayload = {
    id: record.id,
    orderNo: record.orderNo,
    initiatorName: record.initiator.name,
    totalPrice: record.totalPrice,
    status: record.status,
    team: record.team,
    techGroup: record.techGroup,
    screenshotPath: record.screenshotPath,
    invoicePaths: record.invoicePaths,
    invoicePath: record.invoicePath,
    listDocPath: record.listDocPath,
    items: mapOrderItems(record.items),
  };

  const enrichedOrder = await enrichOrderCardPayloadFromDb(order);
  const appOrigin = getDefaultNotificationContext().appOrigin;
  const botKind = resolveProcurementBotKind(enrichedOrder.status);

  let attachmentOptions: Record<string, unknown> = {};
  if (enrichedOrder.status === "PENDING_APPLICANT_CONFIRM") {
    attachmentOptions = await resolveProcurementCardScreenshotOptions(
      enrichedOrder,
      botKind,
      appOrigin,
    );
  } else if (enrichedOrder.status === "PENDING_FINANCE_REVIEW") {
    attachmentOptions = await resolveProcurementFinanceReviewAttachmentOptions(
      enrichedOrder,
      botKind,
      appOrigin,
    );
  }

  return {
    order: enrichedOrder,
    botKind,
    attachmentOptions,
    focus: defaultDetailFocus(enrichedOrder.status),
  };
}

async function buildCardForSnapshot(
  orderId: string,
  cardStage: OrderStatus,
  options?: {
    notice?: string;
    headerTemplate?: "blue" | "red" | "orange" | "green";
  },
): Promise<Record<string, unknown> | undefined> {
  const loaded = await loadEnrichedOrderCard(orderId);
  if (!loaded) return undefined;

  const { order, attachmentOptions, focus } = loaded;
  const appOrigin = getDefaultNotificationContext().appOrigin;

  if (!cardStage) {
    const notice =
      options?.notice ??
      `当前状态：${statusLabels[order.status]}，请打开系统查看最新进度`;
    return buildClosedProcurementCardKitCard(order, notice, {
      appOrigin,
      detailFocus: focus,
      headerTemplate: options?.headerTemplate ?? "green",
      ...attachmentOptions,
    });
  }

  const stage = cardStage;

  if (stageStillActionable(stage, order.status)) {
    return buildProcurementCardKitCard(
      { ...order, status: stage },
      {
        appOrigin,
        detailFocus: defaultDetailFocus(stage),
        headerTemplate: options?.headerTemplate,
        ...attachmentOptions,
      },
    );
  }

  const notice =
    options?.notice ?? defaultClosedNotice(stage, order.status);

  return buildClosedProcurementCardKitCard(order, notice, {
    appOrigin,
    detailFocus: focus,
    headerTemplate: options?.headerTemplate ?? "green",
    ...attachmentOptions,
  });
}

/** 按订单当前阶段构建卡片：可审批阶段显示按钮，否则只读 */
export async function buildStageAwareProcurementCard(
  orderId: string,
  options?: {
    appOrigin?: string | null;
    botKind?: FeishuBotKind;
    headerTemplate?: "blue" | "red" | "orange" | "green";
    notice?: string;
    cardStage?: OrderStatus;
  },
): Promise<Record<string, unknown> | undefined> {
  const loaded = await loadEnrichedOrderCard(orderId);
  if (!loaded) return undefined;

  const stage = options?.cardStage ?? loaded.order.status;
  return buildCardForSnapshot(orderId, stage, {
    notice: options?.notice,
    headerTemplate: options?.headerTemplate,
  });
}

/** @deprecated 使用 buildStageAwareProcurementCard */
export async function buildProcessedProcurementCard(
  orderId: string,
  resultMessage: string,
  options?: {
    appOrigin?: string | null;
    botKind?: FeishuBotKind;
    headerTemplate?: "blue" | "red" | "orange" | "green";
    cardStage?: OrderStatus;
  },
): Promise<Record<string, unknown> | undefined> {
  return buildStageAwareProcurementCard(orderId, {
    ...options,
    notice: resultMessage,
    headerTemplate: options?.headerTemplate ?? "green",
  });
}

export async function recordProcurementFeishuCard(input: {
  orderId: string;
  openId: string;
  cardId: string;
  botKind: FeishuBotKind;
  cardStage: OrderStatus;
}) {
  await prisma.procurementFeishuCard.upsert({
    where: {
      orderId_openId: {
        orderId: input.orderId,
        openId: input.openId,
      },
    },
    update: {
      cardId: input.cardId,
      botKind: input.botKind,
      cardStage: input.cardStage,
      sequence: 1,
    },
    create: {
      orderId: input.orderId,
      openId: input.openId,
      cardId: input.cardId,
      botKind: input.botKind,
      cardStage: input.cardStage,
      sequence: 1,
    },
  });
}

export async function refreshProcurementFeishuCards(
  orderId: string,
  notice?: string,
): Promise<void> {
  const snapshots = await prisma.procurementFeishuCard.findMany({
    where: { orderId },
  });
  if (snapshots.length === 0) {
    console.warn(`[feishu] 无可刷新的采购卡片记录 order=${orderId}`);
    return;
  }

  for (const snapshot of snapshots) {
    const cardStage = (snapshot.cardStage || "") as OrderStatus;
    const card = await buildCardForSnapshot(orderId, cardStage, { notice });
    if (!card) continue;

    const startSequence = snapshot.sequence + 1;
    const botKind = snapshot.botKind as FeishuBotKind;
    try {
      const sequence = await updateCardKitInstanceResilient(
        snapshot.cardId,
        card,
        startSequence,
        botKind,
      );
      await prisma.procurementFeishuCard.update({
        where: { id: snapshot.id },
        data: { sequence },
      });
      console.log(
        `[feishu] 已按当前阶段刷新采购卡片 order=${orderId} stage=${cardStage} openId=${snapshot.openId}`,
      );
    } catch (error) {
      console.error(
        `[feishu] 刷新采购卡片失败 order=${orderId} card=${snapshot.cardId}:`,
        error,
      );
    }
  }
}

export async function sendTrackedProcurementCardKitDm(
  openId: string,
  card: Record<string, unknown>,
  botKind: FeishuBotKind,
  orderId?: string,
  cardStage?: OrderStatus,
): Promise<boolean> {
  const { sendInteractiveCardKitDm } = await import("@/lib/feishu-cardkit");
  const cardId = await sendInteractiveCardKitDm(openId, card, botKind);
  if (!cardId || !orderId || !cardStage) return Boolean(cardId);

  await recordProcurementFeishuCard({
    orderId,
    openId,
    cardId,
    botKind,
    cardStage,
  });
  return true;
}
