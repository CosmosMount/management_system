export type ProjectOwnerLike = {
  openId: string;
  name: string;
};

export type ProjectWithOwners = {
  ownerOpenId: string;
  ownerName: string;
  owners?: ProjectOwnerLike[];
};

export function getProjectOwnerOpenIds(project: ProjectWithOwners): string[] {
  const owners = project.owners ?? [];
  if (owners.length > 0) {
    return owners.map((owner) => owner.openId);
  }
  return project.ownerOpenId ? [project.ownerOpenId] : [];
}

export function getProjectOwnerNames(project: ProjectWithOwners): string {
  const owners = project.owners ?? [];
  if (owners.length > 0) {
    return owners.map((owner) => owner.name).join("、");
  }
  return project.ownerName;
}
