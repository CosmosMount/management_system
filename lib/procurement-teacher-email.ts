import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { sendEmail } from "@/lib/email";
import type { OrderCardPayload } from "@/lib/procurement-notification-contract";
import { getOpenIdsByRole } from "@/lib/permissions";
import { statusLabels } from "@/lib/permissions-client";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import type { TeacherReviewEmailOutboxPayload } from "@/lib/notification-contracts/procurement";

export type TeacherEmailRecipient = {
  openId: string;
  name: string;
  email: string;
};

export async function collectTeacherReviewEmailRecipients(
  order: OrderCardPayload,
): Promise<TeacherEmailRecipient[]> {
  const openIds = await getOpenIdsByRole("TEACHER", {
    team: order.team,
    techGroup: order.techGroup,
  });
  if (openIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { openId: { in: openIds } },
    select: { openId: true, name: true, email: true },
  });

  return users
    .map((user) => ({
      openId: user.openId,
      name: user.name,
      email: user.email?.trim() ?? "",
    }))
    .filter((user) => user.email.length > 0);
}

export function buildTeacherReviewEmailContent(
  order: OrderCardPayload,
  teacherName: string,
  detailUrl: string,
) {
  const safeTeacherName = escapeHtmlText(teacherName);
  const safeOrderNo = escapeHtmlText(order.orderNo);
  const safeStatusLabel = escapeHtmlText(statusLabels[order.status]);
  const safeInitiatorName = escapeHtmlText(order.initiatorName);
  const safeTeam = escapeHtmlText(order.team);
  const safeTechGroup = escapeHtmlText(order.techGroup);
  const safeDetailUrl = escapeHtmlAttribute(detailUrl);
  const statusLabel = statusLabels[order.status];
  const subject = `【采购审批】${order.orderNo} 待老师审核`;
  const text = [
    `${teacherName} 老师，您好：`,
    "",
    `采购单 ${order.orderNo} 已进入「${statusLabel}」环节，请登录系统完成审批。`,
    "",
    `申请人：${order.initiatorName}`,
    `车组 / 技术组：${order.team} / ${order.techGroup}`,
    `总金额：¥${order.totalPrice.toFixed(2)}`,
    "",
    `前往审批：${detailUrl}`,
  ].join("\n");

  const html = `
    <div style="font-family:Segoe UI,Microsoft YaHei,sans-serif;line-height:1.6;color:#111827;">
      <p>${safeTeacherName} 老师，您好：</p>
      <p>采购单 <strong>${safeOrderNo}</strong> 已进入「<strong>${safeStatusLabel}</strong>」环节，请登录系统完成审批。</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">申请人</td><td>${safeInitiatorName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">车组 / 技术组</td><td>${safeTeam} / ${safeTechGroup}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">总金额</td><td>¥${order.totalPrice.toFixed(2)}</td></tr>
      </table>
      <p>
        <a href="${safeDetailUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;">
          前往系统审批
        </a>
      </p>
      <p style="color:#6b7280;font-size:12px;">如按钮无法打开，请复制链接到浏览器：${escapeHtmlText(detailUrl)}</p>
    </div>
  `.trim();

  return { subject, text, html };
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value);
}

export async function sendTeacherReviewEmailToOpenId(
  order: OrderCardPayload,
  recipientOpenId: string,
  context?: NotificationContext,
): Promise<void> {
  const recipients = await collectTeacherReviewEmailRecipients(order);
  const recipient = recipients.find((item) => item.openId === recipientOpenId);
  if (!recipient) throw new Error("老师邮箱不存在或收件人已不具备当前审批资格");

  const detailUrl = buildAppUrl(
    `${routes.procurement.detail(order.id)}?focus=approval&from=email#approval`,
    context?.appOrigin,
  );

  const content = buildTeacherReviewEmailContent(order, recipient.name, detailUrl);
  const result = await sendEmail({
    to: recipient.email,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
  if (result.skipped) throw new Error(`EMAIL_DELIVERY_SKIPPED: ${result.reason}`);
}

/** Legacy entry point retained for reminders; it now only enqueues durable work. */
export async function sendTeacherReviewEmailsOnce(
  order: OrderCardPayload,
  expectedStatusEnteredAt: Date,
  context: NotificationContext | undefined,
  dedupeEventKey: string,
): Promise<void> {
  if (order.status !== "TEACHER_REVIEW") return;

  const emailEventKey = `${dedupeEventKey}:teacher_email`;
  await prisma.notificationOutbox.createMany({
    data: [
      {
        eventKey: emailEventKey,
        channel: "email",
        type: "teacher_review_email",
        botKind: "notification",
        payload: JSON.stringify({
          kind: "teacher_review_email",
          order: { ...order, status: "TEACHER_REVIEW" },
          expectedStatusEnteredAt: expectedStatusEnteredAt.toISOString(),
          appOrigin: context?.appOrigin ?? null,
        } satisfies TeacherReviewEmailOutboxPayload),
        status: "PENDING",
        nextRunAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
}
