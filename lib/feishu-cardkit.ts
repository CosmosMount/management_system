import { getFeishuTenantAccessTokenByBotKind } from "@/lib/feishu-auth";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { isFeishuDirectMessageAllowed } from "@/lib/feishu-delivery-guard";
import {
  resolveDirectMessageTarget,
  type FeishuDirectMessageTarget,
} from "@/lib/feishu-recipient";

export class FeishuCardKitPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuCardKitPermissionError";
  }
}

export async function createCardKitInstance(
  card: Record<string, unknown>,
  botKind: FeishuBotKind = "notification",
): Promise<string> {
  const token = await getFeishuTenantAccessTokenByBotKind(botKind);
  const res = await fetch("https://open.feishu.cn/open-apis/cardkit/v1/cards", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      type: "card_json",
      data: JSON.stringify(card),
    }),
  });

  const data = (await res.json()) as {
    code: number;
    msg?: string;
    data?: { card_id?: string };
  };

  if (data.code === 99991672 || data.msg?.includes("cardkit:card:write")) {
    throw new FeishuCardKitPermissionError(
      "飞书应用未开通 cardkit:card:write 权限，无法发送带审批按钮的卡片。请在开放平台权限管理中添加「卡片」写权限后重试。",
    );
  }

  if (data.code !== 0 || !data.data?.card_id) {
    throw new Error(`创建飞书卡片实例失败: ${data.msg ?? res.status}`);
  }

  return data.data.card_id;
}

export async function sendCardKitMessage(
  openId: string,
  cardId: string,
  botKind: FeishuBotKind = "notification",
): Promise<void> {
  if (!(await isFeishuDirectMessageAllowed(openId))) return;

  const target = await resolveDirectMessageTarget(openId, botKind);
  await sendCardKitMessageToTarget(target, cardId);
}

async function sendCardKitMessageToTarget(
  target: FeishuDirectMessageTarget,
  cardId: string,
): Promise<void> {
  const token = await getFeishuTenantAccessTokenByBotKind(target.botKind);
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
  url.searchParams.set("receive_id_type", target.receiveIdType);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: target.receiveId,
      msg_type: "interactive",
      content: JSON.stringify({
        type: "card",
        data: { card_id: cardId },
      }),
    }),
  });

  const data = (await res.json()) as { code: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(
      `发送飞书卡片消息失败(${target.receiveIdType}:${target.receiveId}): ${
        data.msg ?? res.status
      }`,
    );
  }
}

export async function sendInteractiveCardKitDm(
  openId: string,
  card: Record<string, unknown>,
  botKind: FeishuBotKind = "notification",
): Promise<void> {
  if (!(await isFeishuDirectMessageAllowed(openId))) return;

  const target = await resolveDirectMessageTarget(openId, botKind);
  const cardId = await createCardKitInstance(card, target.botKind);
  await sendCardKitMessageToTarget(target, cardId);
}
