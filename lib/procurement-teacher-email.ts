import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { sendEmail } from "@/lib/email";
import type { OrderCardPayload } from "@/lib/feishu";
import { getOpenIdsByRole } from "@/lib/permissions";
import { statusLabels } from "@/lib/permissions-client";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { logger } from "@/lib/logger";

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
      <p>${teacherName} 老师，您好：</p>
      <p>采购单 <strong>${order.orderNo}</strong> 已进入「<strong>${statusLabel}</strong>」环节，请登录系统完成审批。</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">申请人</td><td>${order.initiatorName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">车组 / 技术组</td><td>${order.team} / ${order.techGroup}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">总金额</td><td>¥${order.totalPrice.toFixed(2)}</td></tr>
      </table>
      <p>
        <a href="${detailUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;">
          前往系统审批
        </a>
      </p>
      <p style="color:#6b7280;font-size:12px;">如按钮无法打开，请复制链接到浏览器：${detailUrl}</p>
    </div>
  `.trim();

  return { subject, text, html };
}

export async function sendTeacherReviewEmails(
  order: OrderCardPayload,
  context?: NotificationContext,
): Promise<{ sent: number; skipped: number }> {
  const recipients = await collectTeacherReviewEmailRecipients(order);
  if (recipients.length === 0) {
    logger.warn("email.teacher_review.recipient.empty", {
      module: "email",
      action: "sendTeacherReviewEmails",
      entityType: "PurchaseOrder",
      entityId: order.id,
      status: order.status,
      team: order.team,
      techGroup: order.techGroup,
    });
    return { sent: 0, skipped: 0 };
  }

  const detailUrl = buildAppUrl(
    `${routes.procurement.detail(order.id)}?focus=approval&from=email#approval`,
    context?.appOrigin,
  );

  let sent = 0;
  let skipped = 0;

  const results = await Promise.allSettled(
    recipients.map(async (recipient) => {
      const content = buildTeacherReviewEmailContent(
        order,
        recipient.name,
        detailUrl,
      );
      const result = await sendEmail({
        to: recipient.email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      if (result.skipped) {
        skipped += 1;
        return;
      }
      sent += 1;
      logger.info("email.teacher_review.sent", {
        module: "email",
        action: "sendTeacherReviewEmails",
        entityType: "PurchaseOrder",
        entityId: order.id,
        orderNo: order.orderNo,
        recipientOpenId: recipient.openId,
      });
    }),
  );

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    const message =
      failures[0]?.reason instanceof Error
        ? failures[0].reason.message
        : String(failures[0]?.reason);
    throw new Error(
      `老师审核邮件发送失败：${failures.length}/${recipients.length} 封失败；${message}`,
    );
  }

  return { sent, skipped };
}

/** 同一订单进入老师审核时只发一次邮件（outbox 按收件人发送时补发） */
export async function sendTeacherReviewEmailsOnce(
  order: OrderCardPayload,
  context: NotificationContext | undefined,
  dedupeEventKey: string,
): Promise<void> {
  if (order.status !== "TEACHER_REVIEW") return;

  const emailEventKey = `${dedupeEventKey}:teacher_email`;
  const reserved = await prisma.notificationOutbox.createMany({
    data: [
      {
        eventKey: emailEventKey,
        channel: "procurement",
        type: "teacher_email_sent",
        botKind: "notification",
        payload: JSON.stringify({ orderId: order.id }),
        status: "SENT",
        sentAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  if (reserved.count === 0) return;

  await sendTeacherReviewEmails(order, context).catch((error) => {
    logger.error("email.teacher_review.failed", {
      module: "email",
      action: "sendTeacherReviewEmailsOnce",
      entityType: "PurchaseOrder",
      entityId: order.id,
      eventKey: emailEventKey,
      error,
    });
  });
}
