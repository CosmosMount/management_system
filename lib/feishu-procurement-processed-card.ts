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
  defaultDetailFocus,
} from "@/lib/feishu-procurement-card";
import { prisma } from "@/lib/prisma";
import { getDefaultNotificationContext } from "@/lib/request-origin";

export async function buildProcessedProcurementCard(
  orderId: string,
  resultMessage: string,
  options?: {
    appOrigin?: string | null;
    botKind?: FeishuBotKind;
    headerTemplate?: "blue" | "red" | "orange" | "green";
  },
): Promise<Record<string, unknown> | undefined> {
  const record = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      initiator: { select: { name: true } },
    },
  });
  if (!record) return undefined;

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
  const appOrigin =
    options?.appOrigin ?? getDefaultNotificationContext().appOrigin;
  const botKind =
    options?.botKind ?? resolveProcurementBotKind(enrichedOrder.status);

  let attachmentOptions = {};
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

  const focus = defaultDetailFocus(enrichedOrder.status);

  return buildClosedProcurementCardKitCard(enrichedOrder, resultMessage, {
    appOrigin,
    detailFocus: focus,
    headerTemplate: options?.headerTemplate ?? "green",
    ...attachmentOptions,
  });
}
