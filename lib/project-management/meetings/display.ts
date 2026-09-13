import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { projectReadableWhere, taskReadableWhere } from "@/lib/project-management/authorization";
import { ProjectManagementServiceError, queryLimitExceededError } from "@/lib/project-management/application/errors";
import { MAX_TIME_CANVAS_ANCHOR_NODES } from "@/lib/project-management/validations/time-canvas";
import type { MeetingTimelineDisplay } from "./validation";

export async function validateMeetingDisplay(
  tx: Prisma.TransactionClient,
  actor: ProjectManagementActor,
  display: MeetingTimelineDisplay,
  previous: MeetingTimelineDisplay = { projectIds: [], taskIds: [] },
) {
  const projectIds = display.projectIds.filter((id) => !previous.projectIds.includes(id));
  const taskIds = display.taskIds.filter((id) => !previous.taskIds.includes(id));
  const [projectCount, taskCount] = await Promise.all([
    tx.project.count({ where: { AND: [{ id: { in: projectIds } }, projectReadableWhere(actor)] } }),
    tx.task.count({ where: { AND: [{ id: { in: taskIds } }, taskReadableWhere(actor)] } }),
  ]);
  const errors: Record<string, string[]> = {};
  if (projectCount !== projectIds.length) errors["timelineDisplay.projectIds"] = ["所选项目不存在或已不可用，请重新选择"];
  if (taskCount !== taskIds.length) errors["timelineDisplay.taskIds"] = ["所选任务不存在或已不可用，请重新选择"];
  if (Object.keys(errors).length) throw new ProjectManagementServiceError("VALIDATION_ERROR", "时间线展示对象已不可用，请重新选择", errors);
}

export async function resolveMeetingDisplay(actor: ProjectManagementActor, display: MeetingTimelineDisplay) {
  const [projects, directTasks] = await Promise.all([
    prisma.project.findMany({
      where: { AND: [{ id: { in: display.projectIds } }, projectReadableWhere(actor)] },
      select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    prisma.task.findMany({
      where: { AND: [{ id: { in: display.taskIds } }, taskReadableWhere(actor)] },
      select: { id: true, title: true }, orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
  ]);
  const tasks = await prisma.task.findMany({
    where: { AND: [taskReadableWhere(actor), { OR: [
      { id: { in: directTasks.map((task) => task.id) } },
      { projectId: { in: projects.map((project) => project.id) } },
    ] }] },
    select: { id: true, title: true, project: { select: { name: true, deletedAt: true } } },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: MAX_TIME_CANVAS_ANCHOR_NODES + 1,
  });
  if (tasks.length > MAX_TIME_CANVAS_ANCHOR_NODES) {
    throw queryLimitExceededError("展示任务数量超过 5000 个，请由会议管理员减少展示项目或任务后重试；不会省略轨道");
  }
  return {
    tasks,
    summary: {
      projects,
      tasks: directTasks,
      unavailableProjectCount: display.projectIds.length - projects.length,
      unavailableTaskCount: display.taskIds.length - directTasks.length,
    },
  };
}
