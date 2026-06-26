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

type TaskAssigneeLike = {
  openId: string;
  name: string;
};

type TaskTechGroupLike = {
  techGroup: string;
  sortOrder?: number;
};

export type TaskNotificationSubject = {
  team: string;
  techGroup: string;
  assigneeOpenId: string;
  assigneeName: string;
  assignees?: TaskAssigneeLike[];
  techGroups?: TaskTechGroupLike[];
  project: {
    ownerOpenId: string;
    ownerName: string;
    owners?: ProjectOwnerLike[];
    participants?: ProjectParticipantLike[];
  };
};

export async function collectTaskNotificationRecipients(
  task: TaskNotificationSubject,
): Promise<string[]> {
  const openIds = new Set<string>();

  for (const openId of getTaskAssigneeOpenIds(task)) {
    add(openIds, openId);
  }
  for (const openId of getProjectOwnerOpenIds(task.project)) {
    add(openIds, openId);
  }
  for (const participant of task.project.participants ?? []) {
    add(openIds, participant.openId);
  }

  const roleGroups = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", { team: task.team, techGroup: task.techGroup }),
    getOpenIdsByRole("TECH_GROUP_ADMIN", {
      team: task.team,
      techGroup: task.techGroup,
    }),
    ...getTaskTechGroups(task).map((techGroup) =>
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

function add(openIds: Set<string>, openId?: string | null) {
  if (openId) openIds.add(openId);
}
