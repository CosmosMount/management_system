export type ProjectStageOwnerLike = {
  openId: string;
  name: string;
};

export type ProjectStageWithOwners = {
  ownerOpenId: string;
  ownerName: string;
  owners?: ProjectStageOwnerLike[];
};

export function getProjectStageOwnerOpenIds(
  stage: ProjectStageWithOwners,
): string[] {
  const owners = stage.owners ?? [];
  if (owners.length > 0) {
    return owners.map((owner) => owner.openId);
  }
  return stage.ownerOpenId ? [stage.ownerOpenId] : [];
}

export function getProjectStageOwnerNames(
  stage: ProjectStageWithOwners,
): string {
  const owners = stage.owners ?? [];
  if (owners.length > 0) {
    return owners.map((owner) => owner.name).join("、");
  }
  return stage.ownerName;
}
