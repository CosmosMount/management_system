"use server";

import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { getUserRoles } from "@/lib/permissions";
import {
  drainNotificationOutboxSoon,
  enqueueProgressNotificationTx,
} from "@/lib/notification-outbox";
import {
  getProjectFollowPolicy,
  getTaskFollowPolicy,
  type ProjectFollowSubject,
  type TaskFollowSubject,
} from "@/lib/progress-following";
import { requireSessionUser } from "@/lib/progress-activity";
import {
  getProjectOwnerNames,
} from "@/lib/progress-project-owners";
import { getProjectParticipantNames } from "@/lib/progress-project-participants";
import {
  getTaskAssigneeNames,
} from "@/lib/progress-assignees";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProgress } from "@/lib/revalidate";
import { withActionLogging } from "@/lib/logger";

export async function followProject(projectId: string) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.project.follow",
      module: "progress",
      action: "followProject",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Project",
      entityId: projectId,
    },
    async () => setProjectFollowState(projectId, user, "FOLLOWING"),
  );
}

export async function unfollowProject(projectId: string) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.project.unfollow",
      module: "progress",
      action: "unfollowProject",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Project",
      entityId: projectId,
    },
    async () => setProjectFollowState(projectId, user, "MUTED"),
  );
}

export async function followTask(taskId: string) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.task.follow",
      module: "progress",
      action: "followTask",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Task",
      entityId: taskId,
    },
    async () => setTaskFollowState(taskId, user, "FOLLOWING"),
  );
}

export async function unfollowTask(taskId: string) {
  const session = await auth();
  const user = await requireSessionUser(session?.user?.openId);
  return withActionLogging(
    {
      event: "progress.task.unfollow",
      module: "progress",
      action: "unfollowTask",
      actorOpenId: user.openId,
      actorName: user.name,
      entityType: "Task",
      entityId: taskId,
    },
    async () => setTaskFollowState(taskId, user, "MUTED"),
  );
}

async function setProjectFollowState(
  projectId: string,
  user: { openId: string; name: string },
  state: "FOLLOWING" | "MUTED",
) {
  const roles = await getUserRoles(user.openId);
  const project = await getProjectForFollow(projectId);
  if (!project) throw new Error("项目不存在");

  const policy = await getProjectFollowPolicy({
    project,
    userOpenId: user.openId,
    roles,
  });
  if (state === "FOLLOWING" && policy.followedByCurrentUser) {
    return policy;
  }
  if (state === "MUTED") {
    if (policy.forcedFollowedByCurrentUser) {
      throw new Error(policy.forcedFollowReasons[0] ?? "当前身份必须关注该项目");
    }
    if (!policy.followedByCurrentUser) {
      return policy;
    }
  }

  const context = await getNotificationContext();
  const result = await prisma.$transaction(async (tx) => {
    await lockFollowPreferenceTx(tx, `project:${projectId}:${user.openId}`);
    const existing = await tx.projectFollowPreference.findUnique({
      where: { projectId_openId: { projectId, openId: user.openId } },
    });
    if (existing?.state === state) {
      return { preference: existing, changed: false };
    }

    const saved = await tx.projectFollowPreference.upsert({
      where: { projectId_openId: { projectId, openId: user.openId } },
      update: { state },
      create: { projectId, openId: user.openId, state },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId,
        action: state === "FOLLOWING" ? "project.followed" : "project.unfollowed",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          state,
          projectName: project.name,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:project_${state === "FOLLOWING" ? "followed" : "unfollowed"}:${projectId}:${user.openId}:${saved.updatedAt.toISOString()}`,
      {
        type: state === "FOLLOWING" ? "project_followed" : "project_unfollowed",
        projectId,
        projectName: project.name,
        actorName: user.name,
        team: project.team,
        techGroup: project.techGroup,
        ownerNames: getProjectOwnerNames(project),
        participantNames: getProjectParticipantNames(project),
        stageCount: project.stages.length,
        projectStatus: project.status,
        currentStageName: getCurrentProjectStageName(project),
        projectDueAt: getProjectDueAtIso(project),
        currentStateLabel:
          state === "FOLLOWING" ? "已关注项目通知" : "已取消关注项目通知",
        recipientOpenIds: [user.openId],
      },
      context,
    );

    return { preference: saved, changed: true };
  });

  if (result.changed) {
    drainNotificationOutboxSoon();
    revalidateProgress(projectId);
  }
  return getProjectFollowPolicy({
    project: {
      ...project,
      followPreferences: [{ openId: user.openId, state: result.preference.state }],
    },
    userOpenId: user.openId,
    roles,
  });
}

async function setTaskFollowState(
  taskId: string,
  user: { openId: string; name: string },
  state: "FOLLOWING" | "MUTED",
) {
  const roles = await getUserRoles(user.openId);
  const task = await getTaskForFollow(taskId);
  if (!task || task.deletedAt) throw new Error("任务不存在");

  const policy = await getTaskFollowPolicy({
    task,
    userOpenId: user.openId,
    roles,
  });
  if (state === "FOLLOWING" && policy.followedByCurrentUser) {
    return policy;
  }
  if (state === "MUTED") {
    if (policy.forcedFollowedByCurrentUser) {
      throw new Error(policy.forcedFollowReasons[0] ?? "当前身份必须关注该任务");
    }
    if (!policy.followedByCurrentUser) {
      return policy;
    }
  }

  const context = await getNotificationContext();
  const result = await prisma.$transaction(async (tx) => {
    await lockFollowPreferenceTx(tx, `task:${taskId}:${user.openId}`);
    const existing = await tx.taskFollowPreference.findUnique({
      where: { taskId_openId: { taskId, openId: user.openId } },
    });
    if (existing?.state === state) {
      return { preference: existing, changed: false };
    }

    const saved = await tx.taskFollowPreference.upsert({
      where: { taskId_openId: { taskId, openId: user.openId } },
      update: { state },
      create: { taskId, openId: user.openId, state },
    });

    await tx.progressActivityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        action: state === "FOLLOWING" ? "task.followed" : "task.unfollowed",
        actorOpenId: user.openId,
        actorName: user.name,
        payload: JSON.stringify({
          state,
          taskTitle: task.title,
          projectName: task.project.name,
        }),
      },
    });

    await enqueueProgressNotificationTx(
      tx,
      `progress:task_${state === "FOLLOWING" ? "followed" : "unfollowed"}:${taskId}:${user.openId}:${saved.updatedAt.toISOString()}`,
      {
        type: state === "FOLLOWING" ? "task_followed" : "task_unfollowed",
        taskId,
        taskTitle: task.title,
        projectId: task.projectId,
        projectName: task.project.name,
        actorName: user.name,
        stageName: task.stage?.name ?? "无阶段",
        assigneeNames: getTaskAssigneeNames(task),
        taskTechGroups: getTaskTechGroups(task),
        team: task.team,
        techGroup: task.techGroup,
        projectOwnerNames: getProjectOwnerNames(task.project),
        taskStatus: task.status,
        dueAt: task.dueAt.toISOString(),
        currentStateLabel:
          state === "FOLLOWING" ? "已关注任务通知" : "已取消关注任务通知",
        recipientOpenIds: [user.openId],
      },
      context,
    );

    return { preference: saved, changed: true };
  });

  if (result.changed) {
    drainNotificationOutboxSoon();
    revalidateProgress(task.projectId, taskId);
  }
  return getTaskFollowPolicy({
    task: {
      ...task,
      followPreferences: [{ openId: user.openId, state: result.preference.state }],
    },
    userOpenId: user.openId,
    roles,
  });
}

async function getProjectForFollow(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: {
        orderBy: { sortOrder: "asc" },
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      tasks: {
        where: { deletedAt: null },
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      followPreferences: true,
    },
  }) satisfies Promise<ProjectFollowSubject | null>;
}

async function getTaskForFollow(taskId: string) {
  return prisma.task.findUnique({
    where: { id: taskId },
    include: {
      stage: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      followPreferences: true,
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
          stages: {
            orderBy: { sortOrder: "asc" },
            include: {
              owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
            },
          },
          tasks: {
            where: { deletedAt: null },
            include: {
              assignees: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
          followPreferences: true,
        },
      },
    },
  }) satisfies Promise<(TaskFollowSubject & { deletedAt: Date | null }) | null>;
}

async function lockFollowPreferenceTx(
  tx: Prisma.TransactionClient,
  key: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
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

function getProjectDueAtIso(project: {
  stages: Array<{ dueAt: Date | null; sortOrder: number }>;
}): string | null {
  const sortedStages = [...project.stages].sort((a, b) => a.sortOrder - b.sortOrder);
  return [...sortedStages].reverse().find((stage) => stage.dueAt)?.dueAt?.toISOString() ?? null;
}
