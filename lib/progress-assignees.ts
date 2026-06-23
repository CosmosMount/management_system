export type TaskAssigneeLike = {
  openId: string;
  name: string;
};

export type TaskWithAssignees = {
  assigneeOpenId: string;
  assigneeName: string;
  assignees?: TaskAssigneeLike[];
};

export function getTaskAssigneeOpenIds(task: TaskWithAssignees): string[] {
  const assignees = task.assignees ?? [];
  if (assignees.length > 0) {
    return assignees.map((assignee) => assignee.openId);
  }
  return task.assigneeOpenId ? [task.assigneeOpenId] : [];
}

export function getTaskAssigneeNames(task: TaskWithAssignees): string {
  const assignees = task.assignees ?? [];
  if (assignees.length > 0) {
    return assignees.map((assignee) => assignee.name).join("、");
  }
  return task.assigneeName;
}
