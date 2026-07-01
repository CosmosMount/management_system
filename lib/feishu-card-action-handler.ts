import { cardToast } from "@/lib/feishu-card-response";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { extractRejectReasonFromForm } from "@/lib/feishu-procurement-card";
import { resolveSystemOpenIdFromFeishuOperator } from "@/lib/feishu-recipient";
import { prisma } from "@/lib/prisma";
import { approveProcurementByOpenId } from "@/lib/procurement-approve-by-open-id";
import { confirmProcurementByOpenId } from "@/lib/procurement-confirm-by-open-id";
import { rejectProcurementByOpenId } from "@/lib/procurement-reject-by-open-id";

type CardActionPayload = {
  operator?: {
    open_id?: string;
    union_id?: string;
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
  order_id?: string;
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

function readOrderIdFromAction(
  parsed: CardActionValue | null,
  formValue: Record<string, unknown> | undefined,
): string {
  const fromParsed = parsed?.orderId ?? parsed?.order_id;
  if (typeof fromParsed === "string" && fromParsed.trim()) {
    return fromParsed.trim();
  }
  return (
    readFormString(formValue, "order_id") ||
    readFormString(formValue, "orderId")
  );
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
  const orderId = readOrderIdFromAction(parsed, formValue);
  const actionName =
    typeof parsed?.action === "string" ? parsed.action.trim() : "";

  if (actionName && orderId) {
    return {
      action: actionName,
      orderId,
      reason,
    };
  }

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

  if (buttonName === "confirm_btn" && orderId) {
    return {
      action: actionName || "procurement_confirm_reimbursement",
      orderId,
      reason: "",
    };
  }

  return null;
}

export async function handleFeishuCardAction(
  data: CardActionPayload,
  options?: { botKind?: FeishuBotKind },
) {
  const operatorOpenId = data.operator?.open_id;
  if (!operatorOpenId) {
    return cardToast("error", "无法识别操作人");
  }
  const openId = await resolveSystemOpenIdFromFeishuOperator({
    openId: operatorOpenId,
    unionId: data.operator?.union_id,
    botKind: options?.botKind,
  });

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
      operator: data.operator?.name ?? operatorOpenId,
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

  if (action === "procurement_confirm_reimbursement") {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) {
      return cardToast("error", "订单不存在");
    }
    if (order.status !== "PENDING_APPLICANT_CONFIRM") {
      return cardToast("info", "该确认卡片已失效，请打开系统查看最新状态");
    }
    const result = await confirmProcurementByOpenId(openId, orderId);
    return cardToast("success", result.message);
  }

  return cardToast("info", "暂不支持该卡片操作");
}
