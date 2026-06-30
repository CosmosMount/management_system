import { cardToast } from "@/lib/feishu-card-response";
import {
  extractRejectReasonFromForm,
} from "@/lib/feishu-procurement-card";
import { approveProcurementByOpenId } from "@/lib/procurement-approve-by-open-id";
import { rejectProcurementByOpenId } from "@/lib/procurement-reject-by-open-id";

type CardActionPayload = {
  operator?: {
    open_id?: string;
    name?: string;
  };
  action?: {
    value?: unknown;
    tag?: string;
    form_value?: Record<string, string>;
  };
};

type CardActionValue = {
  action?: string;
  orderId?: string;
};

function parseActionValue(raw: unknown): CardActionValue | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as CardActionValue;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    return raw as CardActionValue;
  }
  return null;
}

export async function handleFeishuCardAction(data: CardActionPayload) {
  const openId = data.operator?.open_id;
  if (!openId) {
    return cardToast("error", "无法识别操作人");
  }

  const value = parseActionValue(data.action?.value);
  if (!value?.action || !value.orderId) {
    console.log("[feishu-ws] 未识别的卡片操作", {
      tag: data.action?.tag,
      value: data.action?.value,
      operator: data.operator?.name ?? openId,
    });
    return cardToast("info", "已收到操作，请使用系统页面完成处理");
  }

  const reason = extractRejectReasonFromForm(data.action?.form_value);

  if (value.action === "procurement_approve_management") {
    const result = await approveProcurementByOpenId(openId, value.orderId);
    return cardToast("success", result.message);
  }

  if (value.action === "procurement_approve_teacher") {
    const result = await approveProcurementByOpenId(openId, value.orderId, {
      teacherOnly: true,
    });
    return cardToast("success", result.message);
  }

  if (value.action === "procurement_reject_terminate") {
    const result = await rejectProcurementByOpenId(
      openId,
      value.orderId,
      reason,
      "terminate",
    );
    return cardToast("success", result.message);
  }

  if (value.action === "procurement_reject_resubmit") {
    const result = await rejectProcurementByOpenId(
      openId,
      value.orderId,
      reason,
      "resubmit",
    );
    return cardToast("success", result.message);
  }

  return cardToast("info", "暂不支持该卡片操作");
}
