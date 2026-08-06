import type { NotificationOutbox } from "@prisma/client";
import { defaultAppOrigin } from "@/lib/app-origin";
import {
  collectTeacherReviewEmailRecipients,
  sendTeacherReviewEmailToOpenId,
} from "@/lib/procurement-teacher-email";
import { teacherReviewEmailOutboxPayloadSchema } from "@/lib/notification-contracts/procurement";
import {
  CanceledNotificationError,
  NonRetryableNotificationError,
  type NotificationChannelAdapter,
} from "@/lib/notification-channels/types";
import { prisma } from "@/lib/prisma";

const obsoleteTeacherReviewReason = "订单已离开老师审核，取消过期邮件通知";

async function isExpectedTeacherReviewRound(
  orderId: string,
  expectedStatusEnteredAt: string,
) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    select: { status: true, statusEnteredAt: true },
  });
  return (
    order?.status === "TEACHER_REVIEW" &&
    order.statusEnteredAt.toISOString() === expectedStatusEnteredAt
  );
}

function parseRow(row: NotificationOutbox) {
  if (row.type !== "teacher_review_email") {
    throw new NonRetryableNotificationError(`未知邮件通知类型: ${row.type}`);
  }
  try {
    return teacherReviewEmailOutboxPayloadSchema.parse(JSON.parse(row.payload));
  } catch (error) {
    throw new NonRetryableNotificationError(
      `邮件通知 payload 无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const emailNotificationChannel: NotificationChannelAdapter = {
  channel: "email",
  async resolveRecipientPlan(row) {
    const data = parseRow(row);
    if (
      !(await isExpectedTeacherReviewRound(
        data.order.id,
        data.expectedStatusEnteredAt,
      ))
    ) {
      return {
        supported: true,
        openIds: [],
        cancelReason: obsoleteTeacherReviewReason,
      };
    }
    const recipients = await collectTeacherReviewEmailRecipients(data.order);
    const openIds = recipients.map((recipient) => recipient.openId);
    return {
      supported: true,
      openIds,
      directOpenIds: openIds,
      requiresDirectRecipient: true,
      emptyRecipientReason: "老师审核邮件没有可投递收件人，请检查老师角色和邮箱配置。",
    };
  },
  async sendToRecipient(row, recipientOpenId) {
    const data = parseRow(row);
    if (
      !(await isExpectedTeacherReviewRound(
        data.order.id,
        data.expectedStatusEnteredAt,
      ))
    ) {
      throw new CanceledNotificationError(obsoleteTeacherReviewReason);
    }
    await sendTeacherReviewEmailToOpenId(data.order, recipientOpenId, {
      appOrigin: data.appOrigin ?? defaultAppOrigin(),
    });
    return null;
  },
  async sendComposite() {
    throw new NonRetryableNotificationError("邮件通知必须按收件人投递");
  },
};
