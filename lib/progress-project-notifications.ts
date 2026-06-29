import { getOpenIdsByRole } from "@/lib/permissions";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";

type ProjectOwnerLike = {
  openId: string;
  name: string;
};

type ProjectParticipantLike = {
  openId: string;
};

type ProjectStageLike = {
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

type ProjectTaskLike = {
  team: string;
  techGroup: string;
  assigneeOpenId: string;
  assigneeName: string;
  assignees?: TaskAssigneeLike[];
  techGroups?: TaskTechGroupLike[];
};

export type ProjectNotificationSubject = {
  team: string;
  techGroup: string;
  ownerOpenId: string;
  ownerName: string;
  owners?: ProjectOwnerLike[];
  participants?: ProjectParticipantLike[];
  stages?: ProjectStageLike[];
  tasks?: ProjectTaskLike[];
};

export async function collectProjectNotificationRecipients(
  project: ProjectNotificationSubject,
): Promise<string[]> {
  const openIds = new Set<string>();

  for (const openId of getProjectOwnerOpenIds(project)) add(openIds, openId);
  for (const participant of project.participants ?? []) add(openIds, participant.openId);
  for (const stage of project.stages ?? []) add(openIds, stage.ownerOpenId);
  for (const task of project.tasks ?? []) {
    for (const openId of getTaskAssigneeOpenIds(task)) add(openIds, openId);
  }

  const taskTechGroups = [
    ...new Set((project.tasks ?? []).flatMap((task) => getTaskTechGroups(task))),
  ];
  const roleGroups = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", { team: project.team, techGroup: project.techGroup }),
    getOpenIdsByRole("TECH_GROUP_ADMIN", {
      team: project.team,
      techGroup: project.techGroup,
    }),
    ...taskTechGroups.map((techGroup) =>
      getOpenIdsByRole("TECH_GROUP_ADMIN", { team: "", techGroup }),
    ),
    getOpenIdsByRole("PROJECT_MANAGER", { team: "", techGroup: "" }),
    getOpenIdsByRole("SUPER_ADMIN", { team: "", techGroup: "" }),
  ]);

  for (const group of roleGroups) {
    for (const openId of group) add(openIds, openId);
  }

  return [...openIds];
}

export async function collectProjectEstablishmentReviewRecipients(scope: {
  team: string;
  techGroup: string;
}): Promise<string[]> {
  const openIds = new Set<string>();
  const roleGroups = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", { team: scope.team, techGroup: "" }),
    getOpenIdsByRole("TECH_GROUP_ADMIN", { team: "", techGroup: scope.techGroup }),
    getOpenIdsByRole("PROJECT_MANAGER", { team: "", techGroup: "" }),
    getOpenIdsByRole("SUPER_ADMIN", { team: "", techGroup: "" }),
  ]);

  for (const group of roleGroups) {
    for (const openId of group) add(openIds, openId);
  }

  return [...openIds];
}

function add(openIds: Set<string>, openId?: string | null) {
  if (openId) openIds.add(openId);
}
