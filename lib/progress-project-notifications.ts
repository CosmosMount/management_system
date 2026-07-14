import { getOpenIdsByRole } from "@/lib/permissions";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import {
  collectProjectNotificationRecipients as collectProjectFollowers,
  filterProjectNotificationRecipients,
  type ProjectFollowSubject,
} from "@/lib/progress-following";

export type ProjectNotificationSubject = ProjectFollowSubject;

export async function collectProjectNotificationRecipients(
  project: ProjectNotificationSubject,
): Promise<string[]> {
  return collectProjectFollowers(project);
}

export async function collectProjectStageRiskNotificationRecipients(
  project: Pick<
    ProjectNotificationSubject,
    | "id"
    | "team"
    | "techGroup"
    | "ownerOpenId"
    | "ownerName"
    | "owners"
    | "participants"
    | "followPreferences"
  >,
  stage: {
    ownerOpenId: string;
    ownerName: string;
    owners?: Array<{ openId: string; name: string }>;
  },
): Promise<string[]> {
  return collectProjectFollowers({
    ...project,
    stages: [stage],
  });
}

export async function collectProjectEstablishmentReviewRecipients(scope: {
  team: string;
  techGroup: string;
}): Promise<string[]> {
  return collectProjectRoleReviewCandidateOpenIds(scope);
}

export async function collectProjectBatchDdlReviewRecipients(
  project: ProjectNotificationSubject,
  requesterOpenId: string,
): Promise<string[]> {
  const candidates = await collectProjectRoleReviewCandidateOpenIds({
    team: project.team ?? "",
    techGroup: project.techGroup ?? "",
  });
  return filterProjectNotificationRecipients(
    project,
    candidates.filter((openId) => openId !== requesterOpenId),
  );
}

export async function collectProjectStageDdlReviewRecipients(
  project: ProjectNotificationSubject,
  requesterOpenId: string,
): Promise<string[]> {
  const requesterIsOwner = getProjectOwnerOpenIds(project).includes(requesterOpenId);
  const roleGroups = await Promise.all([
    getOpenIdsByRole("PROJECT_MANAGER", { team: "", techGroup: "" }),
    getOpenIdsByRole("SUPER_ADMIN", { team: "", techGroup: "" }),
  ]);
  const candidates = new Set<string>();
  if (!requesterIsOwner) {
    for (const openId of getProjectOwnerOpenIds(project)) add(candidates, openId);
  }
  for (const group of roleGroups) {
    for (const openId of group) add(candidates, openId);
  }
  return filterProjectNotificationRecipients(
    project,
    [...candidates].filter((openId) => openId !== requesterOpenId),
  );
}

export async function collectStageAcceptanceReviewRecipients(
  project: ProjectNotificationSubject & { allowOwnerSelfApproval?: boolean },
  submitterOpenId: string,
): Promise<string[]> {
  const roleCandidates = await collectProjectRoleReviewCandidateOpenIds({
    team: project.team ?? "",
    techGroup: project.techGroup ?? "",
  });
  const ownerOpenIds = getProjectOwnerOpenIds(project);
  const candidates = new Set([...roleCandidates, ...ownerOpenIds]);
  return filterProjectNotificationRecipients(
    project,
    [...candidates].filter((openId) => {
      if (openId !== submitterOpenId) return true;
      return !!project.allowOwnerSelfApproval && ownerOpenIds.includes(openId);
    }),
  );
}

export { filterProjectNotificationRecipients };

async function collectProjectRoleReviewCandidateOpenIds(scope: {
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
