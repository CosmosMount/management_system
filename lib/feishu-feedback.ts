import type { FeedbackStatus } from "@prisma/client";
import { feedbackStatusLabels, feedbackStatusTone } from "@/lib/feedback-labels";
import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { prisma } from "@/lib/prisma";

type FeedbackCard = ReturnType<typeof buildFeedbackCard>;

function truncate(value: string, maxLength = 260): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function feedbackUrl(feedbackId: string, appOrigin?: string | null): string {
  return buildAppUrl(
    `/feedback?selected=${feedbackId}&from=notify`,
    appOrigin,
  );
}

function buildFeedbackCard({
  title,
  content,
  feedbackId,
  template = "blue",
  appOrigin,
}: {
  title: string;
  content: string;
  feedbackId: string;
  template?: "blue" | "red" | "orange" | "green";
  appOrigin?: string | null;
}) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template,
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "打开反馈" },
            url: feedbackUrl(feedbackId, appOrigin),
            type: "primary",
          },
        ],
      },
    ],
  };
}

async function sendDirectCard(openId: string, card: FeedbackCard) {
  const token = await getFeishuTenantAccessToken();
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
  url.searchParams.set("receive_id_type", "open_id");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });

  const data = (await res.json()) as { code: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(`反馈飞书私信失败(${openId}): ${data.msg ?? res.status}`);
  }
}

async function getSuperAdminOpenIds(): Promise<string[]> {
  const records = await prisma.userRole.findMany({
    where: { role: "SUPER_ADMIN" },
    select: { openId: true },
  });
  const openIds = [...new Set(records.map((record) => record.openId))];
  if (openIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { openId: { in: openIds } },
    select: { openId: true },
  });
  return users.map((user) => user.openId);
}

async function notifyOpenIds(openIds: string[], card: FeedbackCard) {
  const uniqueOpenIds = [...new Set(openIds.filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueOpenIds.map((openId) => sendDirectCard(openId, card)),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    const reason = failures[0]?.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `反馈飞书通知失败：${failures.length}/${results.length} 个收件人失败；${message}`,
    );
  }
}

export async function sendFeedbackCreatedNotification({
  feedbackId,
  submitterName,
  body,
}: {
  feedbackId: string;
  submitterName: string;
  body: string;
}, context?: NotificationContext) {
  const card = buildFeedbackCard({
    title: "收到新的系统反馈",
    feedbackId,
    template: "orange",
    appOrigin: context?.appOrigin,
    content: `**提交人**：${submitterName}\n**内容**：${truncate(body)}`,
  });
  await notifyOpenIds(await getSuperAdminOpenIds(), card);
}

export async function sendFeedbackReplyNotification({
  feedbackId,
  actorName,
  body,
  recipientOpenIds,
  actorIsAdmin,
}: {
  feedbackId: string;
  actorName: string;
  body: string;
  recipientOpenIds?: string[];
  actorIsAdmin: boolean;
}, context?: NotificationContext) {
  const card = buildFeedbackCard({
    title: actorIsAdmin ? "你的反馈有新的回复" : "反馈收到新的补充",
    feedbackId,
    template: actorIsAdmin ? "blue" : "orange",
    appOrigin: context?.appOrigin,
    content: `**回复人**：${actorName}\n**内容**：${truncate(body)}`,
  });
  const recipients = actorIsAdmin
    ? (recipientOpenIds ?? [])
    : await getSuperAdminOpenIds();
  await notifyOpenIds(recipients, card);
}

export async function sendFeedbackStatusNotification({
  feedbackId,
  actorName,
  status,
  submitterOpenId,
}: {
  feedbackId: string;
  actorName: string;
  status: FeedbackStatus;
  submitterOpenId: string;
}, context?: NotificationContext) {
  const card = buildFeedbackCard({
    title: "反馈状态已更新",
    feedbackId,
    template: feedbackStatusTone[status],
    appOrigin: context?.appOrigin,
    content: `**处理人**：${actorName}\n**当前状态**：${feedbackStatusLabels[status]}`,
  });
  await notifyOpenIds([submitterOpenId], card);
}
