import type { OrderStatus } from "@prisma/client";
import { buildAppUrl } from "@/lib/app-origin";
import type { OrderCardPayload } from "@/lib/feishu";
import {
  buildOrderItemsTableElement,
  formatOrderItemsPlainList,
} from "@/lib/feishu-order-items-md";
import { statusLabels } from "@/lib/permissions-client";
import { routes } from "@/lib/routes";

type CardOptions = {
  headerTitle?: string;
  headerTemplate?: "blue" | "red" | "orange" | "green";
  extraLines?: string[];
  detailFocus?: "approval" | "upload" | "confirm";
  primaryButtonText?: string;
  appOrigin?: string | null;
  readOnly?: boolean;
};

const REJECT_REASON_FIELD = "Input_procurement_reject_reason";

function buildDetailUrl(
  orderId: string,
  focus?: CardOptions["detailFocus"],
  appOrigin?: string | null,
) {
  const base = buildAppUrl(`${routes.procurement.detail(orderId)}`, appOrigin);
  const notify = "from=notify";
  if (focus === "approval") return `${base}?focus=approval&${notify}#approval`;
  if (focus === "upload") return `${base}?focus=upload&${notify}#upload`;
  if (focus === "confirm") return `${base}?focus=confirm&${notify}#confirm`;
  return `${base}?${notify}#approval`;
}

function defaultDetailFocus(
  status: OrderStatus,
): CardOptions["detailFocus"] | undefined {
  if (
    status === "MANAGEMENT_REVIEW" ||
    status === "TEACHER_REVIEW" ||
    status === "PENDING_FINANCE_REVIEW"
  ) {
    return "approval";
  }
  if (status === "PENDING_APPLICANT_DOCS") return "upload";
  if (status === "PENDING_APPLICANT_CONFIRM") return "confirm";
  return undefined;
}

export function supportsProcurementCardApproval(status: OrderStatus): boolean {
  return status === "MANAGEMENT_REVIEW" || status === "TEACHER_REVIEW";
}

function formSubmitButton(
  name: string,
  label: string,
  type: "primary" | "default" | "danger",
  value: Record<string, string>,
) {
  return {
    tag: "button",
    name,
    form_action_type: "submit",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

function buildApprovalActionRow(
  order: OrderCardPayload,
  detailUrl: string,
  detailLabel: string,
) {
  const approveAction =
    order.status === "MANAGEMENT_REVIEW"
      ? "procurement_approve_management"
      : "procurement_approve_teacher";

  return {
    tag: "form",
    name: `procurement_approval_${order.id}`,
    elements: [
      {
        tag: "input",
        name: REJECT_REASON_FIELD,
        required: false,
        max_length: 500,
        input_type: "multiline_text",
        rows: 2,
        placeholder: {
          tag: "plain_text",
          content: "退回修改时请填写原因（通过可留空）",
        },
        label: {
          tag: "plain_text",
          content: "退回原因",
        },
      },
      {
        tag: "column_set",
        flex_mode: "flow",
        horizontal_spacing: "8px",
        columns: [
          {
            tag: "column",
            width: "auto",
            elements: [
              formSubmitButton("approve_btn", "通过", "primary", {
                action: approveAction,
                orderId: order.id,
              }),
            ],
          },
          {
            tag: "column",
            width: "auto",
            elements: [
              formSubmitButton("reject_btn", "退回修改", "danger", {
                action: "procurement_reject",
                orderId: order.id,
              }),
            ],
          },
          {
            tag: "column",
            width: "auto",
            elements: [linkButton(detailLabel, detailUrl, "default")],
          },
        ],
      },
    ],
  };
}

function linkButton(
  label: string,
  url: string,
  type: "primary" | "default" = "default",
) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [
      {
        type: "open_url",
        default_url: url,
        pc_url: url,
        ios_url: url,
        android_url: url,
      },
    ],
  };
}

function legacyLinkButton(
  label: string,
  url: string,
  type: "primary" | "default" = "default",
) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    url,
  };
}

function buildSummaryMarkdown(
  order: OrderCardPayload,
  options: CardOptions,
): string {
  const statusLabel = statusLabels[order.status];
  const attachmentHint =
    order.status === "PENDING_FINANCE_REVIEW"
      ? "\n**操作提示**：请打开详情页查看发票与清单"
      : order.status === "PENDING_APPLICANT_CONFIRM"
        ? "\n**操作提示**：请核对发票、清单与报销截图后确认"
        : order.status === "PENDING_APPLICANT_DOCS"
          ? "\n**操作提示**：请重新上传发票、实物照片"
          : supportsProcurementCardApproval(order.status)
            ? "\n**操作提示**：可在下方填写原因，通过或退回修改"
            : "";

  return [
    `**当前状态**：${statusLabel}`,
    `**申请人**：${order.initiatorName}`,
    `**车组 / 技术组**：${order.team} / ${order.techGroup}`,
    `**单号**：${order.orderNo}`,
    `**总金额**：¥${order.totalPrice.toFixed(2)}`,
    attachmentHint,
    ...(options.extraLines ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildWebhookSummaryMarkdown(
  order: OrderCardPayload,
  options: CardOptions,
): string {
  const summary = buildSummaryMarkdown(order, options);
  const itemsList = formatOrderItemsPlainList(order.items);
  return [summary, itemsList].filter(Boolean).join("\n");
}

function appendOrderItemsToCardKitBody(
  bodyElements: Record<string, unknown>[],
  items?: OrderCardPayload["items"],
) {
  const table = buildOrderItemsTableElement(items);
  if (!table) return;
  bodyElements.push({
    tag: "markdown",
    content: "**采购明细**",
  });
  bodyElements.push(table);
}

/** CardKit + JSON 2.0，用于应用机器人私信（支持回调按钮） */
export function buildProcurementCardKitCard(
  order: OrderCardPayload,
  options: CardOptions = {},
) {
  const focus = options.detailFocus ?? defaultDetailFocus(order.status);
  const detailUrl = buildDetailUrl(order.id, focus, options.appOrigin);
  const summary = buildSummaryMarkdown(order, options);
  const useApprovalActions =
    !options.readOnly && supportsProcurementCardApproval(order.status);

  const bodyElements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: summary,
    },
  ];

  appendOrderItemsToCardKitBody(bodyElements, order.items);

  if (useApprovalActions) {
    bodyElements.push(
      buildApprovalActionRow(
        order,
        detailUrl,
        options.primaryButtonText ?? "查看详情",
      ),
    );
  } else {
    bodyElements.push(
      linkButton(
        options.primaryButtonText ?? "查看详情",
        detailUrl,
        "primary",
      ),
    );
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: options.headerTitle ?? "采购报销审批提醒",
      },
      template: options.headerTemplate ?? "blue",
    },
    body: {
      elements: bodyElements,
    },
  };
}

/** 群 Webhook 用旧版只读卡片（仅 URL 按钮） */
export function buildProcurementWebhookCard(
  order: OrderCardPayload,
  options: CardOptions = {},
) {
  const focus = options.detailFocus ?? defaultDetailFocus(order.status);
  const detailUrl = buildDetailUrl(order.id, focus, options.appOrigin);
  const summary = buildWebhookSummaryMarkdown(order, options);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: options.headerTitle ?? "采购报销审批提醒",
      },
      template: options.headerTemplate ?? "blue",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: summary },
      },
      {
        tag: "action",
        actions: [
          legacyLinkButton(
            options.primaryButtonText ?? "查看详情",
            detailUrl,
            "primary",
          ),
          legacyLinkButton(
            "订单列表",
            buildAppUrl(routes.procurement.list, options.appOrigin),
            "default",
          ),
        ],
      },
    ],
  };
}

/** @deprecated 使用 buildProcurementCardKitCard 或 buildProcurementWebhookCard */
export function buildProcurementNotificationCard(
  order: OrderCardPayload,
  options: CardOptions = {},
) {
  const readOnly =
    options.readOnly || !supportsProcurementCardApproval(order.status);
  if (readOnly) {
    return buildProcurementWebhookCard(order, options);
  }
  return buildProcurementCardKitCard(order, options);
}

export function extractRejectReasonFromForm(
  formValue?: Record<string, unknown>,
): string {
  if (!formValue) return "";

  const direct = formValue[REJECT_REASON_FIELD];
  if (typeof direct === "string") {
    return direct.trim();
  }

  for (const [key, value] of Object.entries(formValue)) {
    if (key === "order_id" || key === "approval_action") continue;
    if (key.includes("reject_reason") && typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const nestedReason = nested[REJECT_REASON_FIELD];
      if (typeof nestedReason === "string" && nestedReason.trim()) {
        return nestedReason.trim();
      }
      for (const nestedValue of Object.values(nested)) {
        if (typeof nestedValue === "string" && nestedValue.trim()) {
          return nestedValue.trim();
        }
      }
    }
  }

  return "";
}

export { REJECT_REASON_FIELD };
