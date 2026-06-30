import { cardToast } from "@/lib/feishu-card-response";
import { extractRejectReasonFromForm } from "@/lib/feishu-procurement-card";
import { prisma } from "@/lib/prisma";
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
    name?: string;
    form_value?: Record<string, unknown>;
    input_value?: string;
  };
};

type CardActionValue = {
  action?: string;
  orderId?: string;
};

type ResolvedCardAction = {
  action: string;
  orderId: string;
  reason: string;
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

function readFormString(
  formValue: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = formValue?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFormValue(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function resolveProcurementCardAction(
  data: CardActionPayload,
): ResolvedCardAction | null {
  const action = data.action;
  if (!action) return null;

  const formValue = normalizeFormValue(action.form_value);
  const reason =
    extractRejectReasonFromForm(formValue) ||
    (typeof action.input_value === "string" ? action.input_value.trim() : "");

  const parsed = parseActionValue(action.value);
  if (parsed?.action && parsed.orderId) {
    return {
      action: parsed.action,
      orderId: parsed.orderId,
      reason,
    };
  }

  const orderId = readFormString(formValue, "order_id");
  const buttonName = action.name;

  if (buttonName === "approve_btn" && orderId) {
    return {
      action:
        readFormString(formValue, "approval_action") ||
        "procurement_approve_management",
      orderId,
      reason,
    };
  }

  if (buttonName === "reject_btn" && orderId) {
    return {
      action: "procurement_reject",
      orderId,
      reason,
    };
  }

  return null;
}

export async function handleFeishuCardAction(data: CardActionPayload) {
  const openId = data.operator?.open_id;
  if (!openId) {
    return cardToast("error", "无法识别操作人");
  }

  const resolved = resolveProcurementCardAction(data);
  if (!resolved) {
    const isLinkOnlyButton =
      data.action?.tag === "button" &&
      !data.action?.name &&
      !data.action?.form_value &&
      !parseActionValue(data.action?.value)?.action;

    if (isLinkOnlyButton) {
      return {};
    }

    console.log("[feishu-ws] 未识别的卡片操作", {
      tag: data.action?.tag,
      name: data.action?.name,
      value: data.action?.value,
      formValue: data.action?.form_value,
      operator: data.operator?.name ?? openId,
    });
    return cardToast("info", "已收到操作，请使用系统页面完成处理");
  }

  const { action, orderId, reason } = resolved;

  if (action === "procurement_approve_management") {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) {
      return cardToast("error", "订单不存在");
    }
    if (order.status !== "MANAGEMENT_REVIEW") {
      return cardToast("info", "该管理审核卡片已失效，请打开系统查看最新状态");
    }
    const result = await approveProcurementByOpenId(openId, orderId);
    return cardToast("success", result.message);
  }

  if (action === "procurement_approve_teacher") {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) {
      return cardToast("error", "订单不存在");
    }
    if (order.status !== "TEACHER_REVIEW") {
      return cardToast("info", "该老师审核卡片已失效，请打开系统查看最新状态");
    }
    const result = await approveProcurementByOpenId(openId, orderId, {
      teacherOnly: true,
    });
    return cardToast("success", result.message);
  }

  if (
    action === "procurement_reject" ||
    action === "procurement_reject_resubmit" ||
    action === "procurement_reject_terminate"
  ) {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) {
      return cardToast("error", "订单不存在");
    }
    if (
      order.status !== "MANAGEMENT_REVIEW" &&
      order.status !== "TEACHER_REVIEW"
    ) {
      return cardToast("info", "该审批卡片已失效，请打开系统查看最新状态");
    }
    if (!reason) {
      console.log("[feishu-ws] 驳回缺少原因", {
        formValue: data.action?.form_value,
        buttonName: data.action?.name,
      });
      return cardToast("error", "请填写退回原因");
    }
    const result = await rejectProcurementByOpenId(
      openId,
      orderId,
      reason,
      action === "procurement_reject_terminate" ? "terminate" : "resubmit",
    );
    return cardToast("success", result.message);
  }

  return cardToast("info", "暂不支持该卡片操作");
}
