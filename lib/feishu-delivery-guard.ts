import { prisma } from "@/lib/prisma";

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
    console.warn(
      `[feishu] 私信收件人不在 allowlist，已拦截 openId=${openIdOrUnionId}`,
    );
    return false;
  }

  if (
    allowedOpenIds.has(user.openId) ||
    (user.unionId && allowedUnionIds.has(user.unionId)) ||
    allowedNames.has(user.name)
  ) {
    return true;
  }

  console.warn(
    `[feishu] 私信收件人不在 allowlist，已拦截 openId=${user.openId} name=${user.name}`,
  );
  return false;
}
