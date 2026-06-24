"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import type { FeedbackStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  MAX_FEEDBACK_IMAGE_COUNT,
  saveFeedbackImage,
} from "@/lib/file-upload";
import {
  sendFeedbackCreatedNotification,
  sendFeedbackReplyNotification,
  sendFeedbackStatusNotification,
} from "@/lib/feishu-feedback";
import { isSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";

const MAX_FEEDBACK_TEXT_LENGTH = 5000;
const feedbackStatuses: FeedbackStatus[] = ["OPEN", "IN_PROGRESS", "CLOSED"];

type FeedbackActionUser = {
  openId: string;
  name: string;
  avatar: string | null;
};

function parseText(formData: FormData, key = "body"): string {
  return String(formData.get(key) ?? "").trim();
}

function validateText(body: string, required: boolean) {
  if (required && !body) {
    throw new Error("请填写反馈内容");
  }
  if (body.length > MAX_FEEDBACK_TEXT_LENGTH) {
    throw new Error("反馈内容不能超过 5000 字");
  }
}

function parseImages(formData: FormData): File[] {
  const files = formData
    .getAll("images")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length > MAX_FEEDBACK_IMAGE_COUNT) {
    throw new Error(`最多上传 ${MAX_FEEDBACK_IMAGE_COUNT} 张图片`);
  }
  return files;
}

function notificationBody(body: string, imageCount: number): string {
  if (body) return body;
  return imageCount > 0 ? `上传了 ${imageCount} 张图片` : "更新了反馈";
}

async function requireFeedbackUser(): Promise<FeedbackActionUser> {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  return prisma.user.upsert({
    where: { openId: session.user.openId },
    update: {
      name: session.user.name ?? "未知用户",
      avatar: session.user.image ?? null,
    },
    create: {
      openId: session.user.openId,
      name: session.user.name ?? "未知用户",
      avatar: session.user.image ?? null,
    },
    select: { openId: true, name: true, avatar: true },
  });
}

async function saveAttachments(feedbackId: string, files: File[]) {
  const attachments = [];
  for (const [index, file] of files.entries()) {
    const path = await saveFeedbackImage(feedbackId, file, index);
    attachments.push({
      path,
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
      sortOrder: index,
    });
  }
  return attachments;
}

function parseFeedbackStatus(value: FormDataEntryValue | null): FeedbackStatus {
  const status = String(value ?? "");
  if (!feedbackStatuses.includes(status as FeedbackStatus)) {
    throw new Error("反馈状态无效");
  }
  return status as FeedbackStatus;
}

export async function createFeedback(formData: FormData) {
  const user = await requireFeedbackUser();
  const body = parseText(formData);
  validateText(body, true);
  const files = parseImages(formData);
  const feedbackId = randomUUID();
  const now = new Date();
  const attachments = await saveAttachments(feedbackId, files);

  const feedback = await prisma.feedback.create({
    data: {
      id: feedbackId,
      submitterOpenId: user.openId,
      submitterName: user.name,
      status: "OPEN",
      lastMessageAt: now,
      messages: {
        create: {
          authorOpenId: user.openId,
          authorName: user.name,
          body,
          createdAt: now,
          attachments: { create: attachments },
        },
      },
    },
    select: { id: true },
  });

  await sendFeedbackCreatedNotification({
    feedbackId: feedback.id,
    submitterName: user.name,
    body: notificationBody(body, files.length),
  }, await getNotificationContext()).catch((err) => {
    console.error("[feedback] 飞书新反馈通知失败:", err);
  });

  revalidatePath("/feedback");
  return feedback;
}

export async function replyFeedback(formData: FormData) {
  const user = await requireFeedbackUser();
  const feedbackId = String(formData.get("feedbackId") ?? "");
  if (!feedbackId) {
    throw new Error("参数无效");
  }

  const body = parseText(formData);
  validateText(body, false);
  const files = parseImages(formData);
  if (!body && files.length === 0) {
    throw new Error("请填写回复或上传图片");
  }

  const feedback = await prisma.feedback.findUnique({
    where: { id: feedbackId },
    select: {
      id: true,
      status: true,
      submitterOpenId: true,
      submitterName: true,
    },
  });
  if (!feedback) {
    throw new Error("反馈不存在");
  }

  const actorIsAdmin = await isSuperAdmin(user.openId);
  const isSubmitter = feedback.submitterOpenId === user.openId;
  if (!actorIsAdmin && !isSubmitter) {
    throw new Error("无权查看或回复该反馈");
  }
  if (!actorIsAdmin && feedback.status === "CLOSED") {
    throw new Error("该反馈已关闭，无法继续回复");
  }

  const now = new Date();
  const attachments = await saveAttachments(feedbackId, files);
  await prisma.feedback.update({
    where: { id: feedbackId },
    data: {
      lastMessageAt: now,
      messages: {
        create: {
          authorOpenId: user.openId,
          authorName: user.name,
          body,
          createdAt: now,
          attachments: { create: attachments },
        },
      },
    },
  });

  const recipientOpenIds = actorIsAdmin
    ? [feedback.submitterOpenId].filter((openId) => openId !== user.openId)
    : undefined;
  await sendFeedbackReplyNotification({
    feedbackId,
    actorName: user.name,
    actorIsAdmin,
    recipientOpenIds,
    body: notificationBody(body, files.length),
  }, await getNotificationContext()).catch((err) => {
    console.error("[feedback] 飞书反馈回复通知失败:", err);
  });

  revalidatePath("/feedback");
  return { id: feedbackId };
}

export async function updateFeedbackStatus(formData: FormData) {
  const user = await requireFeedbackUser();
  if (!(await isSuperAdmin(user.openId))) {
    throw new Error("无管理权限");
  }

  const feedbackId = String(formData.get("feedbackId") ?? "");
  const status = parseFeedbackStatus(formData.get("status"));
  if (!feedbackId) {
    throw new Error("参数无效");
  }

  const feedback = await prisma.feedback.findUnique({
    where: { id: feedbackId },
    select: { id: true, submitterOpenId: true },
  });
  if (!feedback) {
    throw new Error("反馈不存在");
  }

  const updated = await prisma.feedback.update({
    where: { id: feedbackId },
    data: {
      status,
      closedAt: status === "CLOSED" ? new Date() : null,
    },
    select: { id: true, status: true, submitterOpenId: true },
  });

  await sendFeedbackStatusNotification({
    feedbackId: updated.id,
    actorName: user.name,
    status: updated.status,
    submitterOpenId: updated.submitterOpenId,
  }, await getNotificationContext()).catch((err) => {
    console.error("[feedback] 飞书反馈状态通知失败:", err);
  });

  revalidatePath("/feedback");
  return updated;
}
