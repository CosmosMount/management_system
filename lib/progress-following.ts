import type { ProgressFollowPreferenceState } from "@prisma/client";
import { getOpenIdsByRole, getUserRoles } from "@/lib/permissions";
import type { UserRoleRecord } from "@/lib/permissions-client";
import {
  isAnyTechGroupLead,
  isProgressSuperAdmin,
  isProjectManager,
  isTeamLead,
  isTechGroupLead,
} from "@/lib/permissions-progress";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import { prisma } from "@/lib/prisma";

type ProjectOwnerLike = {
  openId: string;
  name: string;
};

type ProjectParticipantLike = {
  openId: string;
  name?: string;
};

type ProjectStageLike = {
  id?: string;
  ownerOpenId: string;
};

type TaskAssigneeLike = {
  openId: string;
  name: string;
};

type TaskTechGroupLike = {
  techGroup: string;
  sortOrder?: number;
};

type FollowPreferenceLike = {
  openId: string;
  state: ProgressFollowPreferenceState;
};

export type ProjectFollowSubject = {
  id?: string;
  team?: string;
  techGroup?: string;
  ownerOpenId: string;
  ownerName: string;
  owners?: ProjectOwnerLike[];
  participants?: ProjectParticipantLike[];
  stages?: ProjectStageLike[];
  tasks?: Array<{
    assigneeOpenId: string;
    assigneeName: string;
    assignees?: TaskAssigneeLike[];
  }>;
  followPreferences?: FollowPreferenceLike[];
};

export type TaskFollowSubject = {
  id?: string;
  projectId?: string;
  team: string;
  techGroup: string;
  assigneeOpenId: string;
  assigneeName: string;
  assignees?: TaskAssigneeLike[];
  techGroups?: TaskTechGroupLike[];
  project: ProjectFollowSubject;
  followPreferences?: FollowPreferenceLike[];
};

export type FollowPolicy = {
  followedByCurrentUser: boolean;
  manualState: ProgressFollowPreferenceState | null;
  forcedFollowedByCurrentUser: boolean;
  canFollow: boolean;
  canUnfollow: boolean;
  forcedFollowReasons: string[];
};

export async function collectProjectNotificationRecipients(
  project: ProjectFollowSubject,
): Promise<string[]> {
  const defaultOpenIds = await collectProjectDefaultFollowerOpenIds(project);
  const preferenceMap = await getProjectPreferenceMap(project);
  for (const [openId, state] of preferenceMap) {
    if (state === "FOLLOWING") add(defaultOpenIds, openId);
  }
  return filterProjectNotificationRecipients(project, [...defaultOpenIds]);
}

export async function collectTaskNotificationRecipients(
  task: TaskFollowSubject,
): Promise<string[]> {
  const defaultOpenIds = await collectTaskDefaultFollowerOpenIds(task);
  const preferenceMap = await getTaskPreferenceMap(task);
  for (const [openId, state] of preferenceMap) {
    if (state === "FOLLOWING") add(defaultOpenIds, openId);
  }
  return filterTaskNotificationRecipients(task, [...defaultOpenIds]);
}

export async function filterProjectNotificationRecipients(
  project: ProjectFollowSubject,
  candidateOpenIds: string[],
  options: { alwaysIncludeOpenIds?: string[] } = {},
): Promise<string[]> {
  const forcedOpenIds = await collectProjectForcedFollowerOpenIds(project);
  const defaultOpenIds = await collectProjectDefaultFollowerOpenIds(project);
  const preferenceMap = await getProjectPreferenceMap(project);
  const alwaysInclude = new Set(options.alwaysIncludeOpenIds?.filter(Boolean) ?? []);
  const result = new Set<string>();

  for (const openId of candidateOpenIds) {
    if (!openId) continue;
    if (alwaysInclude.has(openId) || forcedOpenIds.has(openId)) {
      add(result, openId);
      continue;
    }
    const preference = preferenceMap.get(openId);
    if (preference === "FOLLOWING") {
      add(result, openId);
      continue;
    }
    if (preference === "MUTED") continue;
    if (defaultOpenIds.has(openId)) add(result, openId);
  }

  return [...result];
}

export async function filterTaskNotificationRecipients(
  task: TaskFollowSubject,
  candidateOpenIds: string[],
  options: { alwaysIncludeOpenIds?: string[] } = {},
): Promise<string[]> {
  const forcedOpenIds = await collectTaskForcedFollowerOpenIds(task);
  const defaultOpenIds = await collectTaskDefaultFollowerOpenIds(task);
  const preferenceMap = await getTaskPreferenceMap(task);
  const alwaysInclude = new Set(options.alwaysIncludeOpenIds?.filter(Boolean) ?? []);
  const result = new Set<string>();

  for (const openId of candidateOpenIds) {
    if (!openId) continue;
    if (alwaysInclude.has(openId) || forcedOpenIds.has(openId)) {
      add(result, openId);
      continue;
    }
    const preference = preferenceMap.get(openId);
    if (preference === "FOLLOWING") {
      add(result, openId);
      continue;
    }
    if (preference === "MUTED") continue;
    if (defaultOpenIds.has(openId)) add(result, openId);
  }

  return [...result];
}

export async function getProjectFollowPolicy({
  project,
  userOpenId,
  roles,
}: {
  project: ProjectFollowSubject;
  userOpenId?: string;
  roles?: UserRoleRecord[];
}): Promise<FollowPolicy> {
  if (!userOpenId) return emptyPolicy();
  const resolvedRoles = roles ?? (await getUserRoles(userOpenId));
  const preference = (await getProjectPreferenceMap(project)).get(userOpenId) ?? null;
  const forcedReasons = getProjectForcedFollowReasons(
    project,
    userOpenId,
    resolvedRoles,
  );
  const forced = forcedReasons.length > 0;
  const defaultFollowed = forced || isProgressSuperAdmin(resolvedRoles);
  const followed =
    forced ||
    preference === "FOLLOWING" ||
    (preference !== "MUTED" && defaultFollowed);

  return {
    followedByCurrentUser: followed,
    manualState: preference,
    forcedFollowedByCurrentUser: forced,
    canFollow: !followed,
    canUnfollow: followed && !forced,
    forcedFollowReasons: forcedReasons,
  };
}

export async function getTaskFollowPolicy({
  task,
  userOpenId,
  roles,
}: {
  task: TaskFollowSubject;
  userOpenId?: string;
  roles?: UserRoleRecord[];
}): Promise<FollowPolicy> {
  if (!userOpenId) return emptyPolicy();
  const resolvedRoles = roles ?? (await getUserRoles(userOpenId));
  const preference = (await getTaskPreferenceMap(task)).get(userOpenId) ?? null;
  const forcedReasons = getTaskForcedFollowReasons(task, userOpenId, resolvedRoles);
  const forced = forcedReasons.length > 0;
  const inheritedProjectPolicy = await getProjectFollowPolicy({
    project: task.project,
    userOpenId,
    roles: resolvedRoles,
  });
  const followed =
    forced ||
    preference === "FOLLOWING" ||
    (preference !== "MUTED" && inheritedProjectPolicy.followedByCurrentUser);

  return {
    followedByCurrentUser: followed,
    manualState: preference,
    forcedFollowedByCurrentUser: forced,
    canFollow: !followed,
    canUnfollow: followed && !forced,
    forcedFollowReasons: forcedReasons,
  };
}

export function getProjectForcedFollowReasons(
  project: ProjectFollowSubject,
  userOpenId: string,
  roles: UserRoleRecord[],
): string[] {
  const reasons: string[] = [];
  if (getProjectOwnerOpenIds(project).includes(userOpenId)) {
    reasons.push("你是项目负责人，必须接收该项目通知");
  }
  if ((project.participants ?? []).some((item) => item.openId === userOpenId)) {
    reasons.push("你是项目参与人，必须接收该项目通知");
  }
  if ((project.stages ?? []).some((stage) => stage.ownerOpenId === userOpenId)) {
    reasons.push("你是阶段负责人，必须接收该项目通知");
  }
  if (
    (project.tasks ?? []).some((task) =>
      getTaskAssigneeOpenIds(task).includes(userOpenId),
    )
  ) {
    reasons.push("你是项目任务负责人，必须接收该项目通知");
  }
  if (isProjectManager(roles)) {
    reasons.push("你是项管，必须接收该项目通知");
  }
  if (isTeamLead(roles, projectTeam(project))) {
    reasons.push("你是该项目车组组长，必须接收该项目通知");
  }
  if (isTechGroupLead(roles, projectTechGroup(project))) {
    reasons.push("你是该项目技术组组长，必须接收该项目通知");
  }
  return [...new Set(reasons)];
}

export function getTaskForcedFollowReasons(
  task: TaskFollowSubject,
  userOpenId: string,
  roles: UserRoleRecord[],
): string[] {
  const reasons: string[] = [];
  if (getTaskAssigneeOpenIds(task).includes(userOpenId)) {
    reasons.push("你是任务负责人，必须接收该任务通知");
  }
  if (getProjectOwnerOpenIds(task.project).includes(userOpenId)) {
    reasons.push("你是项目负责人，必须接收该任务通知");
  }
  if (isProjectManager(roles)) {
    reasons.push("你是项管，必须接收该任务通知");
  }
  if (isTeamLead(roles, task.team)) {
    reasons.push("你是该任务车组组长，必须接收该任务通知");
  }
  if (
    isTechGroupLead(roles, task.techGroup) ||
    isAnyTechGroupLead(roles, getTaskTechGroups(task))
  ) {
    reasons.push("你是该任务技术组组长，必须接收该任务通知");
  }
  return [...new Set(reasons)];
}

async function collectProjectDefaultFollowerOpenIds(
  project: ProjectFollowSubject,
): Promise<Set<string>> {
  const openIds = await collectProjectForcedFollowerOpenIds(project);
  for (const openId of await getOpenIdsByRole("SUPER_ADMIN", {
    team: "",
    techGroup: "",
  })) {
    add(openIds, openId);
  }
  return openIds;
}

async function collectProjectForcedFollowerOpenIds(
  project: ProjectFollowSubject,
): Promise<Set<string>> {
  const openIds = new Set<string>();
  const members = await getProjectFollowMembers(project);
  for (const openId of members.ownerOpenIds) add(openIds, openId);
  for (const participant of members.participants) add(openIds, participant.openId);
  for (const stage of members.stages) add(openIds, stage.ownerOpenId);
  for (const task of members.tasks) {
    for (const openId of getTaskAssigneeOpenIds(task)) add(openIds, openId);
  }

  const roleGroups = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", { team: projectTeam(project), techGroup: "" }),
    getOpenIdsByRole("TECH_GROUP_ADMIN", {
      team: "",
      techGroup: projectTechGroup(project),
    }),
    getOpenIdsByRole("PROJECT_MANAGER", { team: "", techGroup: "" }),
  ]);
  for (const group of roleGroups) {
    for (const openId of group) add(openIds, openId);
  }
  return openIds;
}

async function getProjectFollowMembers(project: ProjectFollowSubject): Promise<{
  ownerOpenIds: string[];
  participants: ProjectParticipantLike[];
  stages: ProjectStageLike[];
  tasks: NonNullable<ProjectFollowSubject["tasks"]>;
}> {
  if (!project.id) {
    return {
      ownerOpenIds: getProjectOwnerOpenIds(project),
      participants: project.participants ?? [],
      stages: project.stages ?? [],
      tasks: project.tasks ?? [],
    };
  }

  const [owners, participants, stages, tasks] = await Promise.all([
    project.owners === undefined
      ? prisma.projectOwner.findMany({
          where: { projectId: project.id },
          select: { openId: true, name: true },
        })
      : Promise.resolve(project.owners),
    project.participants === undefined
      ? prisma.projectParticipant.findMany({
          where: { projectId: project.id },
          select: { openId: true, name: true },
        })
      : Promise.resolve(project.participants),
    project.stages === undefined
      ? prisma.projectStage.findMany({
          where: { projectId: project.id },
          select: { id: true, ownerOpenId: true },
        })
      : Promise.resolve(project.stages),
    project.tasks === undefined
      ? prisma.task.findMany({
          where: { projectId: project.id, deletedAt: null },
          select: {
            assigneeOpenId: true,
            assigneeName: true,
            assignees: { select: { openId: true, name: true } },
          },
        })
      : Promise.resolve(project.tasks),
  ]);

  const ownerOpenIds =
    owners.length > 0
      ? owners.map((owner) => owner.openId)
      : getProjectOwnerOpenIds(project);

  return { ownerOpenIds, participants, stages, tasks };
}

async function collectTaskDefaultFollowerOpenIds(
  task: TaskFollowSubject,
): Promise<Set<string>> {
  const openIds = await collectTaskForcedFollowerOpenIds(task);
  for (const openId of await collectProjectNotificationRecipients(task.project)) {
    add(openIds, openId);
  }
  return openIds;
}

async function collectTaskForcedFollowerOpenIds(
  task: TaskFollowSubject,
): Promise<Set<string>> {
  const openIds = new Set<string>();
  for (const openId of getTaskAssigneeOpenIds(task)) add(openIds, openId);
  for (const openId of getProjectOwnerOpenIds(task.project)) add(openIds, openId);

  const taskTechGroups = getTaskTechGroups(task);
  const roleGroups = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", { team: task.team, techGroup: "" }),
    getOpenIdsByRole("TECH_GROUP_ADMIN", { team: "", techGroup: task.techGroup }),
    ...taskTechGroups.map((techGroup) =>
      getOpenIdsByRole("TECH_GROUP_ADMIN", { team: "", techGroup }),
    ),
    getOpenIdsByRole("PROJECT_MANAGER", { team: "", techGroup: "" }),
  ]);
  for (const group of roleGroups) {
    for (const openId of group) add(openIds, openId);
  }
  return openIds;
}

async function getProjectPreferenceMap(
  project: ProjectFollowSubject,
): Promise<Map<string, ProgressFollowPreferenceState>> {
  const preferences =
    project.followPreferences ??
    (project.id
      ? await prisma.projectFollowPreference.findMany({
          where: { projectId: project.id },
          select: { openId: true, state: true },
        })
      : []);
  return new Map(preferences.map((item) => [item.openId, item.state]));
}

async function getTaskPreferenceMap(
  task: TaskFollowSubject,
): Promise<Map<string, ProgressFollowPreferenceState>> {
  const preferences =
    task.followPreferences ??
    (task.id
      ? await prisma.taskFollowPreference.findMany({
          where: { taskId: task.id },
          select: { openId: true, state: true },
        })
      : []);
  return new Map(preferences.map((item) => [item.openId, item.state]));
}

function emptyPolicy(): FollowPolicy {
  return {
    followedByCurrentUser: false,
    manualState: null,
    forcedFollowedByCurrentUser: false,
    canFollow: false,
    canUnfollow: false,
    forcedFollowReasons: [],
  };
}

function projectTeam(project: ProjectFollowSubject): string {
  return project.team ?? "";
}

function projectTechGroup(project: ProjectFollowSubject): string {
  return project.techGroup ?? "";
}

function add(openIds: Set<string>, openId?: string | null) {
  if (openId) openIds.add(openId);
}
