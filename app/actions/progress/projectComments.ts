"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  progressProjectReadableWhere,
} from "@/lib/permissions-progress";
import { requireSessionUser } from "@/lib/progress-activity";
import { canDeleteProjectComment } from "@/lib/progress-project-comments";
import { prisma } from "@/lib/prisma";
import { revalidateProgress } from "@/lib/revalidate";
import { withActionLogging } from "@/lib/logger";

const PROJECT_COMMENT_MAX_LENGTH = 1000;

const createProjectCommentSchema = z.object({
  projectId: z.string().min(1, "项目不存在"),
  content: z
    .string()
    .trim()
    .min(1, "请输入评论内容")
    .max(PROJECT_COMMENT_MAX_LENGTH, `评论不能超过 ${PROJECT_COMMENT_MAX_LENGTH} 个字符`),
});

const deleteProjectCommentSchema = z.object({
  commentId: z.string().min(1, "评论不存在"),
});

export async function createProjectComment(input: {
  projectId: string;
  content: string;
}) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.project.comment.create",
      module: "progress",
      action: "createProjectComment",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Project",
      entityId: input.projectId,
    },
    async () => createProjectCommentLogged(input, user),
  );
}

async function createProjectCommentLogged(
  input: { projectId: string; content: string },
  user: { openId: string; name: string; avatar?: string | null },
) {
  const parsed = createProjectCommentSchema.parse(input);
  const roles = await getUserRoles(user.openId);
  const project = await prisma.project.findFirst({
    where: {
      id: parsed.projectId,
      AND: progressProjectReadableWhere(roles, user.openId),
    },
    select: { id: true, name: true },
  });
  if (!project) throw new Error("无权限评论该项目");

  const comment = await prisma.$transaction(async (tx) => {
    const saved = await tx.projectComment.create({
      data: {
        projectId: project.id,
        authorOpenId: user.openId,
        authorName: user.name,
        authorAvatar: user.avatar ?? null,
        content: parsed.content,
      },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: project.id,
        action: "project.comment_created",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          commentId: saved.id,
          commentPreview: compactComment(parsed.content),
        }),
      },
    });

    return saved;
  });

  revalidateProgress(project.id);
  return {
    id: comment.id,
    content: comment.content,
    createdAt: comment.createdAt.toISOString(),
  };
}

export async function deleteProjectComment(input: { commentId: string }) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.project.comment.delete",
      module: "progress",
      action: "deleteProjectComment",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "ProjectComment",
      entityId: input.commentId,
    },
    async () => deleteProjectCommentLogged(input, user),
  );
}

async function deleteProjectCommentLogged(
  input: { commentId: string },
  user: { openId: string; name: string },
) {
  const parsed = deleteProjectCommentSchema.parse(input);
  const roles = await getUserRoles(user.openId);
  const comment = await prisma.projectComment.findUnique({
    where: { id: parsed.commentId },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!comment || comment.deletedAt) throw new Error("评论不存在或已删除");

  if (
    !canDeleteProjectComment({
      roles,
      project: comment.project,
      authorOpenId: comment.authorOpenId,
      userOpenId: user.openId,
    })
  ) {
    throw new Error("无权限删除该评论");
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.projectComment.updateMany({
      where: { id: comment.id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedByOpenId: user.openId,
        deletedByName: user.name,
      },
    });
    if (updated.count !== 1) throw new Error("评论已被删除，请刷新后重试");

    await tx.progressActivityLog.create({
      data: {
        projectId: comment.projectId,
        action: "project.comment_deleted",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          commentId: comment.id,
          commentPreview: compactComment(comment.content),
          authorName: comment.authorName,
        }),
      },
    });
  });

  revalidateProgress(comment.projectId);
  return { ok: true };
}

function compactComment(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}
