import crypto from "crypto";
import {
  isNotificationDeliveryDisabled,
  logFeishuDeliveryDisabled,
  type FeishuDeliveryBypassOptions,
} from "@/lib/feishu-delivery-guard";

function buildSign(timestamp: string, secret: string): string {
  return crypto
    .createHmac("sha256", "")
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
}

export async function postToFeishuWebhook(
  webhookUrl: string | undefined,
  webhookSecret: string | undefined,
  body: Record<string, unknown>,
  options?: FeishuDeliveryBypassOptions,
): Promise<void> {
  if (!webhookUrl) return;
  if (isNotificationDeliveryDisabled(options)) {
    logFeishuDeliveryDisabled({
      action: "postToFeishuWebhook",
      channel: "webhook",
      target: webhookUrl,
    });
    return;
  }

  const payload: Record<string, unknown> = { ...body };
  if (webhookSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = buildSign(timestamp, webhookSecret);
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`飞书 Webhook 请求失败: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { code?: number; msg?: string };
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`飞书 Webhook 返回错误: ${data.msg ?? "unknown"}`);
  }
}

export function getProcurementWebhookConfig(): {
  url?: string;
  secret?: string;
} {
  const url =
    process.env.FEISHU_PROCUREMENT_WEBHOOK_URL?.trim() ||
    process.env.FEISHU_WEBHOOK_URL?.trim();
  const secret =
    process.env.FEISHU_PROCUREMENT_WEBHOOK_SECRET?.trim() ||
    process.env.FEISHU_WEBHOOK_SECRET?.trim();
  return { url, secret };
}
