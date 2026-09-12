import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { projectReadableWhere, taskReadableWhere } from "@/lib/project-management/authorization";
import { ProjectManagementServiceError, queryLimitExceededError } from "@/lib/project-management/application/errors";
import { MAX_TIME_CANVAS_VISIBLE_SEGMENTS } from "@/lib/project-management/validations/time-canvas";
import { getMeeting } from "./service";
import { resolveMeetingDisplay } from "./display";
import { formatMeetingMinutes } from "./markdown";

export async function exportMeetingMinutes(actor: ProjectManagementActor, input: unknown, appOrigin?: string | null) {
  const account = await prisma.account.findUnique({
    where: { id: actor.accountId },
    select: {
      person: { select: { id: true, status: true } },
      systemRoles: { where: { revokedAt: null }, select: { role: true, team: true, techGroup: true } },
    },
  });
  if (!account?.person || account.person.id !== actor.personId || account.person.status !== "ACTIVE") {
    throw new ProjectManagementServiceError("FORBIDDEN", "人员已停用或身份不可用，无法导出会议纪要");
  }
  const currentActor = { ...actor, isActive: true, systemRoles: account.systemRoles };
  const meeting = await getMeeting(input);
  const display = await resolveMeetingDisplay(currentActor, meeting.timelineDisplay);
  const taskSelect = { id: true, title: true, projectId: true } as const;
  const [tasks, segments] = await Promise.all([
    prisma.task.findMany({
      where: { AND: [taskReadableWhere(currentActor), { id: { in: display.tasks.map((task) => task.id) }, status: "ACTIVE" }] },
      select: taskSelect, orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
    prisma.workSegment.findMany({
      where: {
        deletedAt: null, personId: { in: meeting.participants.map((person) => person.id) },
        startAt: { lt: new Date(meeting.rangeEnd) }, endAt: { gt: new Date(meeting.rangeStart) },
        OR: [{ taskId: null }, { task: { is: taskReadableWhere(currentActor) } }],
      },
      select: { personId: true, content: true, task: { select: taskSelect } },
      orderBy: [{ startAt: "asc" }, { endAt: "asc" }, { id: "asc" }],
      take: MAX_TIME_CANVAS_VISIBLE_SEGMENTS + 1,
    }),
  ]);
  if (segments.length > MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
    throw queryLimitExceededError("工作记录超过 5000 条，请由会议管理员减少工作区间或参与人后重试；不会省略记录");
  }
  const projectIds = [...new Set([...tasks, ...segments.flatMap((segment) => segment.task ? [segment.task] : [])]
    .flatMap((task) => task.projectId ? [task.projectId] : []))];
  const projects = await prisma.project.findMany({
    where: { AND: [projectReadableWhere(currentActor), { id: { in: projectIds } }] },
    select: { id: true, name: true },
  });
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const withProject = (task: typeof tasks[number]) => ({
    id: task.id, title: task.title, project: task.projectId ? projectsById.get(task.projectId) ?? null : null,
  });
  return {
    markdown: formatMeetingMinutes({
      ...meeting,
      tasks: tasks.map(withProject),
      segments: segments.map((segment) => ({ ...segment, task: segment.task ? withProject(segment.task) : null })),
    }, appOrigin),
  };
}
