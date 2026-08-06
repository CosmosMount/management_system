import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { normalizeEmailAddress, sendEmail } from "../lib/email";
import {
  drainNotificationOutbox,
  enqueueNotification,
} from "../lib/notification-outbox";
import { buildTeacherReviewEmailContent } from "../lib/procurement-teacher-email";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import { parseJsonFormField } from "../lib/validations/form-data-json";

test("邮箱格式校验", () => {
  expect(normalizeEmailAddress(" Teacher@Example.COM ")).toBe(
    "teacher@example.com",
  );
  expect(normalizeEmailAddress("")).toBe("");
  expect(() => normalizeEmailAddress("invalid-email")).toThrow("邮箱格式不正确");
});

test("老师审核邮件包含审批链接", () => {
  const content = buildTeacherReviewEmailContent(
    {
      id: "order-1",
      orderNo: "PO-20260702-0001",
      initiatorName: "张宇山",
      totalPrice: 128.5,
      status: "TEACHER_REVIEW",
      team: "步兵",
      techGroup: "电控",
    },
    "李老师",
    "https://example.com/procurement/order-1?focus=approval#approval",
  );

  expect(content.subject).toContain("待老师审核");
  expect(content.text).toContain("PO-20260702-0001");
  expect(content.html).toContain("前往系统审批");
  expect(content.html).toContain("https://example.com/procurement/order-1");
});

test("老师邮件 HTML 会转义身份文本和链接属性", () => {
  const content = buildTeacherReviewEmailContent(
    {
      id: "order-escape",
      orderNo: "PO-<script>",
      initiatorName: "<img src=x>",
      totalPrice: 1,
      status: "TEACHER_REVIEW",
      team: "A&B",
      techGroup: "\"电控\"",
    },
    "<老师>",
    "https://example.com/?q=\"x\"&a=1",
  );
  expect(content.html).not.toContain("<script>");
  expect(content.html).not.toContain("<img src=x>");
  expect(content.html).toContain("&lt;老师&gt;");
  expect(content.html).toContain("&quot;x&quot;&amp;a=1");
});

test("通知总禁发闸在 SMTP 配置解析和网络发送前阻断邮件", async () => {
  const original = process.env.NOTIFICATION_DELIVERY_DISABLED;
  const originalHost = process.env.SMTP_HOST;
  const originalUser = process.env.SMTP_USER;
  const originalPassword = process.env.SMTP_PASSWORD;
  try {
    process.env.NOTIFICATION_DELIVERY_DISABLED = "true";
    process.env.SMTP_HOST = "should-never-connect.invalid";
    process.env.SMTP_USER = "sender@example.com";
    process.env.SMTP_PASSWORD = "test-only";
    await expect(
      sendEmail({
        to: "teacher@example.com",
        subject: "测试",
        html: "<p>测试</p>",
      }),
    ).resolves.toEqual({
      sent: false,
      skipped: true,
      reason: "delivery_disabled",
    });
  } finally {
    restoreEnv("NOTIFICATION_DELIVERY_DISABLED", original);
    restoreEnv("SMTP_HOST", originalHost);
    restoreEnv("SMTP_USER", originalUser);
    restoreEnv("SMTP_PASSWORD", originalPassword);
  }
});

test("FormData JSON 边界将损坏输入映射为稳定中文错误", () => {
  const formData = new FormData();
  formData.set("payload", "{invalid");
  expect(() => parseJsonFormField(formData)).toThrow(
    "提交数据格式不正确，请刷新页面后重试",
  );
});

test("订单重新进入老师审核后会取消上一轮积压邮件", async () => {
  const suffix = randomUUID();
  const eventKey = `test:obsolete-teacher-email:${suffix}`;
  const openId = `ou_obsolete_email_${suffix}`;
  const identity = await resolveFeishuIdentityForUser({
    openId,
    name: "测试申请人",
  });
  const user = await prisma.user.upsert({
    where: { openId },
    update: { accountId: identity.account.id, name: "测试申请人" },
    create: {
      accountId: identity.account.id,
      openId,
      name: "测试申请人",
    },
  });
  const order = await prisma.purchaseOrder.create({
    data: {
      orderNo: `PW-OBSOLETE-${suffix}`,
      initiatorId: user.id,
      initiatorName: "测试申请人",
      team: "英雄",
      techGroup: "机械",
      status: "TEACHER_REVIEW",
      statusEnteredAt: new Date("2026-08-06T10:00:00.000Z"),
    },
  });
  try {
    await enqueueNotification({
      eventKey,
      channel: "email",
      type: "teacher_review_email",
      payload: {
        kind: "teacher_review_email",
        order: {
          id: order.id,
          orderNo: order.orderNo,
          initiatorName: order.initiatorName,
          totalPrice: order.totalPrice,
          status: "TEACHER_REVIEW",
          team: order.team,
          techGroup: order.techGroup,
        },
        expectedStatusEnteredAt: "2026-08-06T09:00:00.000Z",
        appOrigin: "http://127.0.0.1:3002",
      },
    });

    await expect(
      drainNotificationOutbox(1, { ignoreDeliveryDisabled: true }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey },
        select: { status: true, lastError: true },
      }),
    ).resolves.toEqual({
      status: "CANCELED",
      lastError: "订单已离开老师审核，取消过期邮件通知",
    });
  } finally {
    await prisma.purchaseOrder.delete({ where: { id: order.id } });
    await prisma.notificationOutbox.deleteMany({ where: { eventKey } });
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
