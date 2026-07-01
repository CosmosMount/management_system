import type { OrderStatus } from "@prisma/client";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { buildAppUrl } from "@/lib/app-origin";
import { uploadFeishuMessageImage } from "@/lib/feishu-im-upload";
import { isImagePath } from "@/lib/image-path";
import { resolveInvoicePaths } from "@/lib/order-attachments";

export type ApplicantAttachmentCardItem = {
  label: string;
  imgKey?: string;
  viewUrl?: string;
};

type ApplicantAttachmentSource = {
  label: string;
  path: string;
};

export function collectApplicantAttachments(order: {
  invoicePaths?: string | null;
  invoicePath?: string | null;
  listDocPath?: string | null;
}): ApplicantAttachmentSource[] {
  const invoices = resolveInvoicePaths(
    order.invoicePaths ?? "[]",
    order.invoicePath,
  );
  const items: ApplicantAttachmentSource[] = invoices.map((path, index) => ({
    label: invoices.length > 1 ? `发票 ${index + 1}` : "发票",
    path,
  }));
  if (order.listDocPath) {
    items.push({ label: "采购清单", path: order.listDocPath });
  }
  return items;
}

export async function resolveApplicantAttachmentCardItems(
  attachments: ApplicantAttachmentSource[],
  botKind: FeishuBotKind,
  appOrigin?: string | null,
): Promise<ApplicantAttachmentCardItem[]> {
  const items: ApplicantAttachmentCardItem[] = [];

  for (const { label, path } of attachments) {
    if (isImagePath(path)) {
      const imgKey = await uploadFeishuMessageImage(path, botKind);
      if (imgKey) {
        items.push({ label, imgKey });
        continue;
      }
      console.warn(
        `[feishu] 卡片嵌入${label}失败，将改为系统链接 path=${path}`,
      );
      items.push({ label, viewUrl: buildAppUrl(path, appOrigin) });
      continue;
    }

    items.push({ label, viewUrl: buildAppUrl(path, appOrigin) });
  }

  return items;
}

export async function resolveProcurementFinanceReviewAttachmentOptions(
  order: {
    status: OrderStatus;
    invoicePaths?: string | null;
    invoicePath?: string | null;
    listDocPath?: string | null;
  },
  botKind: FeishuBotKind,
  appOrigin?: string | null,
): Promise<{ applicantAttachments?: ApplicantAttachmentCardItem[] }> {
  if (order.status !== "PENDING_FINANCE_REVIEW") {
    return {};
  }

  const attachments = collectApplicantAttachments(order);
  if (attachments.length === 0) {
    return {};
  }

  return {
    applicantAttachments: await resolveApplicantAttachmentCardItems(
      attachments,
      botKind,
      appOrigin,
    ),
  };
}

export async function resolveProcurementCardScreenshotOptions(
  order: {
    status: OrderStatus;
    screenshotPath?: string | null;
  },
  botKind: FeishuBotKind,
  appOrigin?: string | null,
): Promise<{
  screenshotImgKey?: string;
  screenshotIsPdf?: boolean;
  screenshotPath?: string;
  screenshotViewUrl?: string;
}> {
  if (order.status !== "PENDING_APPLICANT_CONFIRM" || !order.screenshotPath) {
    return {};
  }

  if (isImagePath(order.screenshotPath)) {
    const screenshotImgKey = await uploadFeishuMessageImage(
      order.screenshotPath,
      botKind,
    );
    if (screenshotImgKey) {
      return { screenshotImgKey };
    }
    console.warn(
      `[feishu] 卡片嵌入报销截图失败，将改为系统链接 path=${order.screenshotPath}`,
    );
    return {
      screenshotPath: order.screenshotPath,
      screenshotViewUrl: buildScreenshotViewUrl(order.screenshotPath, appOrigin),
    };
  }

  return {
    screenshotIsPdf: true,
    screenshotPath: order.screenshotPath,
    screenshotViewUrl: buildScreenshotViewUrl(order.screenshotPath, appOrigin),
  };
}

function buildScreenshotViewUrl(
  screenshotPath: string,
  appOrigin?: string | null,
): string {
  return buildAppUrl(screenshotPath, appOrigin);
}
