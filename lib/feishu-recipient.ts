import {
  getFeishuTenantAccessTokenByBotKind,
} from "@/lib/feishu-auth";
import {
  usesSeparateApprovalBot,
  type FeishuBotKind,
} from "@/lib/feishu-app-config";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export type FeishuReceiveIdType = "open_id" | "union_id";

export type FeishuDirectMessageTarget = {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  botKind: FeishuBotKind;
};

const BOT_UNAVAILABLE_PATTERNS = [
  "Bot has NO availability to this user",
  "bot has no availability to this user",
];

const unionIdCache = new Map<string, Promise<string | null>>();

function shouldUseUnionId(botKind: FeishuBotKind): boolean {
  return botKind === "approval" && usesSeparateApprovalBot();
}

export function shouldFallbackApprovalBotUnavailable(
  botKind: FeishuBotKind,
  error: unknown,
): boolean {
  if (botKind !== "approval" || !usesSeparateApprovalBot()) return false;
  const message = error instanceof Error ? error.message : String(error);
  return BOT_UNAVAILABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

async function fetchUnionIdByOpenId(
  openId: string,
  lookupBotKind: FeishuBotKind,
): Promise<string | null> {
  const token = await getFeishuTenantAccessTokenByBotKind(lookupBotKind);
  const url = new URL(
    `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(
      openId,
    )}`,
  );
  url.searchParams.set("user_id_type", "open_id");
  url.searchParams.set("department_id_type", "open_department_id");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: {
      user?: {
        union_id?: string;
      };
      union_id?: string;
    };
  };

  if (body.code !== 0) {
    logger.warn("feishu.recipient.union_id_lookup.failed", {
      module: "feishu",
      action: "fetchUnionIdByOpenId",
      recipientOpenId: openId,
      lookupBotKind,
      feishuCode: body.code,
      feishuMessage: body.msg ?? String(res.status),
      result: "failure",
    });
    return null;
  }

  const unionId = body.data?.user?.union_id ?? body.data?.union_id ?? null;
  if (!unionId) {
    logger.warn("feishu.recipient.union_id_missing", {
      module: "feishu",
      action: "fetchUnionIdByOpenId",
      recipientOpenId: openId,
      lookupBotKind,
      result: "failure",
    });
    return null;
  }

  if (lookupBotKind === "notification") {
    await prisma.user
      .update({
        where: { openId },
        data: { unionId },
      })
      .catch(() => undefined);
  }
  return unionId;
}

async function resolveUnionIdForOpenId(openId: string): Promise<string | null> {
  if (openId.startsWith("on_")) return openId;

  const user = await prisma.user.findUnique({
    where: { openId },
    select: { unionId: true },
  });
  if (user?.unionId) return user.unionId;

  let pending = unionIdCache.get(openId);
  if (!pending) {
    pending = fetchUnionIdByOpenId(openId, "notification").catch((error) => {
      logger.error("feishu.recipient.union_id_lookup.error", {
        module: "feishu",
        action: "resolveUnionIdForOpenId",
        recipientOpenId: openId,
        error,
      });
      return null;
    });
    unionIdCache.set(openId, pending);
  }
  return pending;
}

async function fetchSystemOpenIdByUnionId(
  unionId: string,
): Promise<string | null> {
  const token = await getFeishuTenantAccessTokenByBotKind("notification");
  const url = new URL(
    `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(
      unionId,
    )}`,
  );
  url.searchParams.set("user_id_type", "union_id");
  url.searchParams.set("department_id_type", "open_department_id");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: {
      user?: {
        open_id?: string;
      };
      open_id?: string;
    };
  };

  if (body.code !== 0) {
    logger.warn("feishu.recipient.open_id_lookup.failed", {
      module: "feishu",
      action: "fetchSystemOpenIdByUnionId",
      recipientUnionId: unionId,
      feishuCode: body.code,
      feishuMessage: body.msg ?? String(res.status),
      result: "failure",
    });
    return null;
  }

  const openId = body.data?.user?.open_id ?? body.data?.open_id ?? null;
  if (!openId) return null;

  await prisma.user
    .update({
      where: { openId },
      data: { unionId },
    })
    .catch(() => undefined);
  return openId;
}

export async function resolveDirectMessageTarget(
  openId: string,
  botKind: FeishuBotKind,
): Promise<FeishuDirectMessageTarget> {
  if (openId.startsWith("on_")) {
    return { receiveId: openId, receiveIdType: "union_id", botKind };
  }
  if (!shouldUseUnionId(botKind)) {
    return { receiveId: openId, receiveIdType: "open_id", botKind };
  }

  const unionId = await resolveUnionIdForOpenId(openId);
  if (unionId) {
    return { receiveId: unionId, receiveIdType: "union_id", botKind };
  }

  logger.warn("feishu.recipient.approval_union_id_unresolved", {
    module: "feishu",
    action: "resolveDirectMessageTarget",
    recipientOpenId: openId,
    botKind,
    result: "failure",
  });
  throw new Error(
    "独立审批机器人无法解析收件人 union_id，请先让该用户登录系统或执行飞书通讯录同步",
  );
}

export async function resolveSystemOpenIdFromFeishuOperator({
  openId,
  unionId,
  botKind,
}: {
  openId: string;
  unionId?: string | null;
  botKind?: FeishuBotKind;
}): Promise<string> {
  if (unionId) {
    const user = await prisma.user.findUnique({
      where: { unionId },
      select: { openId: true },
    });
    if (user?.openId) return user.openId;

    const fetchedOpenId = await fetchSystemOpenIdByUnionId(unionId);
    if (fetchedOpenId) return fetchedOpenId;
  }

  if (botKind === "approval" && shouldUseUnionId("approval")) {
    const resolvedUnionId = await fetchUnionIdByOpenId(openId, "approval");
    if (resolvedUnionId) {
      const user = await prisma.user.findUnique({
        where: { unionId: resolvedUnionId },
        select: { openId: true },
      });
      if (user?.openId) return user.openId;

      const fetchedOpenId = await fetchSystemOpenIdByUnionId(resolvedUnionId);
      if (fetchedOpenId) return fetchedOpenId;
    }
  }

  return openId;
}
