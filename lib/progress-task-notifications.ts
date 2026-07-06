import {
  collectTaskNotificationRecipients as collectTaskFollowers,
  filterTaskNotificationRecipients,
  type TaskFollowSubject,
} from "@/lib/progress-following";
import { getOpenIdsByRole } from "@/lib/permissions";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";

export type TaskNotificationSubject = TaskFollowSubject;

export async function collectTaskNotificationRecipients(
  task: TaskNotificationSubject,
): Promise<string[]> {
  return collectTaskFollowers(task);
}

export async function collectTaskManagementReviewRecipients(
  task: TaskNotificationSubject,
): Promise<string[]> {
  const candidates = new Set<string>(getProjectOwnerOpenIds(task.project));
  for (const openId of await collectTaskRoleReviewCandidateOpenIds(task)) {
    add(candidates, openId);
  }
  return filterTaskNotificationRecipients(task, [...candidates]);
}

export async function collectTaskDdlReviewRecipients(
  task: TaskNotificationSubject,
): Promise<string[]> {
  const candidates = new Set<string>(getProjectOwnerOpenIds(task.project));
  for (const openId of await collectTaskRoleReviewCandidateOpenIds(task)) {
    add(candidates, openId);
  }
  for (const techGroup of getTaskTechGroups(task)) {
    const group = await getOpenIdsByRole("TECH_GROUP_ADMIN", {
      team: "",
      techGroup,
    });
    for (const openId of group) add(candidates, openId);
  }
  return filterTaskNotificationRecipients(task, [...candidates]);
}

export async function collectTaskAcceptanceReviewRecipients(
  task: TaskNotificationSubject,
): Promise<string[]> {
  return filterTaskNotificationRecipients(
    task,
    await collectTaskRoleReviewCandidateOpenIds(task),
  );
}

export { filterTaskNotificationRecipients };

async function collectTaskRoleReviewCandidateOpenIds(
  task: TaskNotificationSubject,
): Promise<string[]> {
  const openIds = new Set<string>();
  const roleGroups = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", { team: task.team, techGroup: "" }),
    getOpenIdsByRole("TECH_GROUP_ADMIN", { team: "", techGroup: task.techGroup }),
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
