import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError, queryLimitExceededError, ProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { fullSegmentSelect } from "@/lib/project-management/queries/time-canvas-records";
import { toFullSegmentDto } from "@/lib/project-management/queries/time-canvas-dto";
import { timeCanvasDataDtoSchema } from "@/lib/project-management/types/time-canvas";
import { getTimeCanvasDataInputSchema, MAX_TIME_CANVAS_VISIBLE_SEGMENTS } from "@/lib/project-management/validations/time-canvas";
import { taskReadableWhere } from "@/lib/project-management/authorization";
import { loadTaskAnchors } from "@/lib/project-management/queries/time-canvas-anchor-loader";
import { listGlobalTimeMarkers } from "@/lib/project-management/global-time-markers";
import { assertCanManageMeetings, getMeeting } from "./service";
import { meetingTimelineSchema } from "./validation";
import { resolveMeetingDisplay } from "./display";

export async function getMeetingTimeline(actor: ProjectManagementActor, input: unknown) {
  const parsed = meetingTimelineSchema.parse(input);
  let personIds: string[];
  let timelineDisplay;
  if (parsed.kind === "SAVED") {
    const meeting = await getMeeting({ meetingId: parsed.meetingId });
    if (parsed.rangeStart < new Date(meeting.rangeStart) || parsed.rangeEnd > new Date(meeting.rangeEnd)) {
      throw new ProjectManagementServiceError("VALIDATION_ERROR", "查看范围必须位于会议的工作时间区间内");
    }
    personIds = meeting.participants.map((person) => person.id);
    timelineDisplay = meeting.timelineDisplay;
  } else {
    assertCanManageMeetings(actor);
    personIds = parsed.personIds;
    timelineDisplay = parsed.timelineDisplay ?? { projectIds: [], taskIds: [] };
  }
  const display = await resolveMeetingDisplay(actor, timelineDisplay);
  const taskIds = display.tasks.map((task) => task.id);
  const segmentWhere: Prisma.WorkSegmentWhereInput = {
    deletedAt: null,
    startAt: { lt: parsed.rangeEnd }, endAt: { gt: parsed.rangeStart },
    AND: [
      { OR: [{ personId: { in: personIds } }, { taskId: { in: taskIds } }] },
      { OR: [{ taskId: null }, { task: { is: taskReadableWhere(actor) } }] },
    ],
  };
  const [people, records, globalMarkers, loadedAnchors] = await Promise.all([
    prisma.person.findMany({
      where: { OR: [{ id: { in: personIds } }, { workSegments: { some: segmentWhere } }] },
      select: { id: true, displayName: true, status: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    }),
    prisma.workSegment.findMany({
      where: segmentWhere,
      select: {
        ...fullSegmentSelect,
        task: { select: { ...fullSegmentSelect.task.select, project: { select: { name: true, deletedAt: true } } } },
      },
      orderBy: [{ startAt: "asc" }, { endAt: "asc" }, { id: "asc" }],
      take: MAX_TIME_CANVAS_VISIBLE_SEGMENTS + 1,
    }),
    listGlobalTimeMarkers(),
    loadTaskAnchors(actor, getTimeCanvasDataInputSchema.parse({
      scope: { kind: "RESOURCE_PLANNER" }, groupBy: "TASK",
      rangeStart: parsed.rangeStart.toISOString(), rangeEnd: parsed.rangeEnd.toISOString(),
    }), null, taskIds, []).catch((error: unknown) => {
      if (error instanceof ProjectManagementServiceError && error.code === "QUERY_LIMIT_EXCEEDED") {
        throw queryLimitExceededError("计划节点超过 5000 个，请由会议管理员减少展示项目或任务后重试；不会省略节点");
      }
      throw error;
    }),
  ]);
  if (personIds.some((id) => !people.some((person) => person.id === id))) throw notFoundError();
  if (records.length > MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
    throw queryLimitExceededError("工作记录超过 5000 条，请由会议管理员减少展示项目、任务或参与人后重试；不会省略记录");
  }
  const segments = records.map((record) => ({
    ...toFullSegmentDto(actor, record),
    taskTitle: record.task ? [record.task.project?.deletedAt === null ? record.task.project.name : null, record.task.title].filter(Boolean).join(" / ") : null,
    permissions: { canViewDetails: true, canEdit: false, canMove: false, canResize: false, canSoftDelete: false },
  }));
  const rows = people.map((person) => ({
    kind: "PERSON" as const, id: person.id,
    label: `${person.displayName}${person.status === "INACTIVE" ? "（已停用）" : ""}`,
    sublabel: null, capabilities: { canCreateSegment: false },
  }));
  const taskTitles = new Map(display.tasks.map((task) => [task.id,
    [task.project?.deletedAt === null ? task.project.name : null, task.title].filter(Boolean).join(" / "),
  ]));
  const anchors = loadedAnchors.map((task) => ({
    ...task,
    title: taskTitles.get(task.id) ?? task.title,
    capabilities: {
      canView: true, canUpdateMetadata: false, canManageMembers: false,
      canActivate: false, canArchive: false, canCreateRevision: false,
    },
    nodes: task.nodes.map((node) => ({ ...node, capabilities: {
      canView: true, canEditDraft: false, canCreateSegment: false,
      canSubmitReview: false, canReview: false, canSubmitTerminationReview: false,
    } })),
  }));
  const data = timeCanvasDataDtoSchema.parse({
    scope: { kind: "RESOURCE_PLANNER" }, timezone: "Asia/Shanghai", groupBy: "PERSON",
    range: { startAt: parsed.rangeStart.toISOString(), endAt: parsed.rangeEnd.toISOString() },
    rowPageKey: createHash("sha256").update(JSON.stringify({ rows, segments, anchors, globalMarkers, display: display.summary })).digest("hex"),
    rows, segments, anchors, globalMarkers, generatedAt: new Date().toISOString(),
  });
  return { ...data, display: display.summary };
}
