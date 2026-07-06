"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  progressProjectReadableWhere,
} from "@/lib/permissions-progress";
import { requireSessionUser } from "@/lib/progress-activity";
import { canDeleteProjectComment } from "@/lib/progress-project-comments";
import {
  collectProjectNotificationRecipients,
  getProjectFollowPolicy,
} from "@/lib/progress-following";
import { getProjectOwnerNames } from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
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
  autoFollowProject: z.boolean().optional().default(false),
});

const deleteProjectCommentSchema = z.object({
  commentId: z.string().min(1, "评论不存在"),
});

export async function createProjectComment(input: {
  projectId: string;
  content: string;
  autoFollowProject?: boolean;
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
  input: { projectId: string; content: string; autoFollowProject?: boolean },
  user: { openId: string; name: string; avatar?: string | null },
) {
  const parsed = createProjectCommentSchema.parse(input);
  const roles = await getUserRoles(user.openId);
  const project = await prisma.project.findFirst({
    where: {
      id: parsed.projectId,
      AND: progressProjectReadableWhere(roles, user.openId),
    },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { orderBy: { sortOrder: "asc" } },
      tasks: {
        where: { deletedAt: null },
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      followPreferences: true,
    },
  });
  if (!project) throw new Error("无权限评论该项目");

  const [followPolicy, recipientOpenIds, context] = await Promise.all([
    getProjectFollowPolicy({ project, userOpenId: user.openId, roles }),
    collectProjectNotificationRecipients(project),
    getNotificationContext(),
  ]);
  const notificationRecipientOpenIds = recipientOpenIds.filter(
    (openId) => openId && openId !== user.openId,
  );

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

    if (parsed.autoFollowProject && !followPolicy.followedByCurrentUser) {
      await tx.projectFollowPreference.upsert({
        where: {
          projectId_openId: { projectId: project.id, openId: user.openId },
        },
        update: { state: "FOLLOWING" },
        create: {
          projectId: project.id,
          openId: user.openId,
          state: "FOLLOWING",
        },
      });
    }

    if (notificationRecipientOpenIds.length > 0) {
      await enqueueProgressNotificationTx(
        tx,
        `progress:project_comment_created:${saved.id}`,
        {
          type: "project_comment_created",
          projectId: project.id,
          projectName: project.name,
          authorOpenId: user.openId,
          authorName: user.name,
          content: saved.content,
          createdAt: saved.createdAt.toISOString(),
          team: project.team,
          techGroup: project.techGroup,
          ownerNames: getProjectOwnerNames(project),
          currentStageName: getCurrentProjectStageName(project),
          recipientOpenIds: notificationRecipientOpenIds,
        },
        context,
      );
    }

    return saved;
  });

  if (notificationRecipientOpenIds.length > 0) {
    drainNotificationOutboxSoon();
  }
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

function getCurrentProjectStageName(project: {
  stages: Array<{ name: string; status: string; sortOrder: number }>;
}): string {
  const sortedStages = [...project.stages].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    sortedStages.find((stage) =>
      ["IN_PROGRESS", "PENDING_ACCEPTANCE"].includes(stage.status),
    )?.name ??
    sortedStages.find((stage) => stage.status === "NOT_STARTED")?.name ??
    "无当前阶段"
  );
}
