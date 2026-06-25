export type ProjectParticipantLike = {
  openId: string;
  name: string;
};

export type ProjectWithParticipants = {
  participants?: ProjectParticipantLike[];
};

export function getProjectParticipantOpenIds(
  project: ProjectWithParticipants,
): string[] {
  return (project.participants ?? []).map((participant) => participant.openId);
}

export function getProjectParticipantNames(
  project: ProjectWithParticipants,
): string {
  return (project.participants ?? [])
    .map((participant) => participant.name)
    .join("、");
}
