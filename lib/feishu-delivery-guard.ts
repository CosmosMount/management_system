import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export type FeishuDeliveryBypassOptions = {
  ignoreDeliveryDisabled?: boolean;
};

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSet(value: string | undefined): Set<string> {
  return new Set(splitList(value));
}

export function hasFeishuDirectMessageAllowlist(): boolean {
  return (
    splitList(process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS).length > 0 ||
    splitList(process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS).length > 0 ||
    splitList(process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES).length > 0
  );
}

export function isNotificationDeliveryDisabled(
  options?: FeishuDeliveryBypassOptions,
): boolean {
  if (process.env.NOTIFICATION_DELIVERY_DISABLED !== "true") return false;
  if (!options?.ignoreDeliveryDisabled) return true;
  if (canBypassNotificationDeliveryDisabled()) return false;

  logger.warn("feishu.delivery.bypass_denied", {
    module: "feishu",
    action: "isNotificationDeliveryDisabled",
    reason: "NOTIFICATION_DELIVERY_DISABLED",
    result: "skipped",
  });
  return true;
}

function canBypassNotificationDeliveryDisabled(): boolean {
  if (process.env.CONFIRM_SEND_FEISHU === "true") return true;
  const playwrightDatabase = process.env.PLAYWRIGHT_DATABASE_URL?.trim();
  if (!playwrightDatabase) return false;
  try {
    return new URL(playwrightDatabase).pathname.endsWith("_test");
  } catch {
    return false;
  }
}

export function logFeishuDeliveryDisabled(fields: {
  action: string;
  channel?: string;
  botKind?: string;
  target?: string;
}) {
  logger.info("feishu.delivery.disabled", {
    module: "feishu",
    result: "skipped",
    reason: "NOTIFICATION_DELIVERY_DISABLED",
    ...fields,
  });
}

export async function isFeishuDirectMessageAllowed(
  openIdOrUnionId: string,
): Promise<boolean> {
  if (!hasFeishuDirectMessageAllowlist()) return true;

  const allowedOpenIds = buildSet(process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_OPEN_IDS);
  const allowedUnionIds = buildSet(process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_UNION_IDS);
  const allowedNames = buildSet(process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES);

  if (allowedOpenIds.has(openIdOrUnionId) || allowedUnionIds.has(openIdOrUnionId)) {
    return true;
  }

  const user = openIdOrUnionId.startsWith("on_")
    ? await prisma.user.findUnique({
        where: { unionId: openIdOrUnionId },
        select: { name: true, openId: true, unionId: true },
      })
    : await prisma.user.findUnique({
        where: { openId: openIdOrUnionId },
        select: { name: true, openId: true, unionId: true },
      });

  if (!user) {
    logger.warn("feishu.delivery.allowlist.blocked", {
      module: "feishu",
      action: "isFeishuDirectMessageAllowed",
      recipientOpenId: openIdOrUnionId.startsWith("on_") ? undefined : openIdOrUnionId,
      recipientUnionId: openIdOrUnionId.startsWith("on_") ? openIdOrUnionId : undefined,
      reason: "user_not_found",
      result: "skipped",
    });
    return false;
  }

  if (
    allowedOpenIds.has(user.openId) ||
    (user.unionId && allowedUnionIds.has(user.unionId)) ||
    allowedNames.has(user.name)
  ) {
    return true;
  }

  logger.warn("feishu.delivery.allowlist.blocked", {
    module: "feishu",
    action: "isFeishuDirectMessageAllowed",
    recipientOpenId: user.openId,
    recipientUnionId: user.unionId,
    recipientName: user.name,
    reason: "not_in_allowlist",
    result: "skipped",
  });
  return false;
}
