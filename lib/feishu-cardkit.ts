import { getFeishuTenantAccessTokenByBotKind } from "@/lib/feishu-auth";
import type { FeishuBotKind } from "@/lib/feishu-app-config";

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
    throw new Error(`创建飞书卡片实例失败(${data.code || res.status})`);
  }

  return data.data.card_id;
}

export async function updateCardKitInstance(
  cardId: string,
  card: Record<string, unknown>,
  sequence: number,
  botKind: FeishuBotKind = "notification",
): Promise<void> {
  const token = await getFeishuTenantAccessTokenByBotKind(botKind);
  const res = await fetch(
    `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cardId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        card: {
          type: "card_json",
          data: JSON.stringify(card),
        },
        sequence,
      }),
    },
  );

  const data = (await res.json()) as { code: number; msg?: string };
  if (data.code !== 0) {
    const sequenceSuffix = data.msg?.includes("sequence number compare failed")
      ? ": sequence number compare failed"
      : "";
    throw new Error(
      `更新飞书卡片失败(${data.code || res.status})${sequenceSuffix}`,
    );
  }
}

function isCardKitSequenceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("sequence number compare failed")
  );
}

export async function updateCardKitInstanceResilient(
  cardId: string,
  card: Record<string, unknown>,
  startSequence: number,
  botKind: FeishuBotKind = "notification",
  maxAttempts = 6,
): Promise<number> {
  let sequence = startSequence;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await updateCardKitInstance(cardId, card, sequence, botKind);
      return sequence;
    } catch (error) {
      if (!isCardKitSequenceError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      sequence += 1;
    }
  }
  return sequence;
}
