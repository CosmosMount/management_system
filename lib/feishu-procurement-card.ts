import type { OrderStatus } from "@prisma/client";
import { buildAppUrl } from "@/lib/app-origin";
import type { OrderCardPayload } from "@/lib/feishu";
import { formatOrderItemsMarkdownTable } from "@/lib/feishu-order-items-md";
import { statusLabels } from "@/lib/permissions-client";
import { routes } from "@/lib/routes";

type CardOptions = {
  headerTitle?: string;
  headerTemplate?: "blue" | "red" | "orange" | "green";
  extraLines?: string[];
  detailFocus?: "approval" | "upload" | "confirm";
  primaryButtonText?: string;
  appOrigin?: string | null;
  /** 催办等场景：仅展示信息，不带审批按钮 */
  readOnly?: boolean;
};

const REJECT_REASON_FIELD = "reject_reason";

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

function callbackButton(
  label: string,
  type: "primary" | "default" | "danger",
  value: Record<string, string>,
) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [
      {
        type: "callback",
        value,
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

function buildApprovalActions(order: OrderCardPayload) {
  const approveAction =
    order.status === "MANAGEMENT_REVIEW"
      ? "procurement_approve_management"
      : "procurement_approve_teacher";

  return [
    callbackButton("通过", "primary", {
      action: approveAction,
      orderId: order.id,
    }),
    callbackButton("驳回终止", "danger", {
      action: "procurement_reject_terminate",
      orderId: order.id,
    }),
    callbackButton("退回修改", "default", {
      action: "procurement_reject_resubmit",
      orderId: order.id,
    }),
  ];
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
            ? "\n**操作提示**：可在下方直接审批；驳回或退回时请填写原因"
            : "";

  return [
    `**当前状态**：${statusLabel}`,
    `**申请人**：${order.initiatorName}`,
    `**车组 / 技术组**：${order.team} / ${order.techGroup}`,
    `**单号**：${order.orderNo}`,
    `**总金额**：¥${order.totalPrice.toFixed(2)}`,
    formatOrderItemsMarkdownTable(order.items),
    attachmentHint,
    ...(options.extraLines ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildProcurementNotificationCard(
  order: OrderCardPayload,
  options: CardOptions = {},
) {
  const focus = options.detailFocus ?? defaultDetailFocus(order.status);
  const detailUrl = buildDetailUrl(order.id, focus, options.appOrigin);
  const summary = buildSummaryMarkdown(order, options);
  const useApprovalForm =
    !options.readOnly && supportsProcurementCardApproval(order.status);

  const bodyElements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: summary,
    },
  ];

  if (useApprovalForm) {
    bodyElements.push({
      tag: "form",
      name: `procurement_approval_${order.id}`,
      elements: [
        {
          tag: "input",
          name: REJECT_REASON_FIELD,
          required: false,
          max_length: 500,
          placeholder: {
            tag: "plain_text",
            content: "驳回或退回时请填写原因（通过可留空）",
          },
          label: {
            tag: "plain_text",
            content: "审批说明",
          },
        },
        {
          tag: "action",
          actions: buildApprovalActions(order),
        },
      ],
    });
  }

  bodyElements.push({
    tag: "action",
    actions: [
      linkButton(
        options.primaryButtonText ?? "查看详情",
        detailUrl,
        useApprovalForm ? "default" : "primary",
      ),
      linkButton(
        "订单列表",
        buildAppUrl(routes.procurement.list, options.appOrigin),
        "default",
      ),
    ],
  });

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

export function extractRejectReasonFromForm(
  formValue?: Record<string, string>,
): string {
  return formValue?.[REJECT_REASON_FIELD]?.trim() ?? "";
}

export { REJECT_REASON_FIELD };
