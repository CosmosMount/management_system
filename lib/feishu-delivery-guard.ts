import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

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
