import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError, queryLimitExceededError, ProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { fullSegmentSelect } from "@/lib/project-management/queries/time-canvas-records";
import { toFullSegmentDto } from "@/lib/project-management/queries/time-canvas-dto";
import { timeCanvasDataDtoSchema } from "@/lib/project-management/types/time-canvas";
import { MAX_TIME_CANVAS_VISIBLE_SEGMENTS } from "@/lib/project-management/validations/time-canvas";
import { listGlobalTimeMarkers } from "@/lib/project-management/global-time-markers";
import { assertCanManageMeetings, getMeeting } from "./service";
import { meetingTimelineSchema } from "./validation";

export async function getMeetingTimeline(actor: ProjectManagementActor, input: unknown) {
  const parsed = meetingTimelineSchema.parse(input);
  let personIds: string[];
  if (parsed.kind === "SAVED") {
    const meeting = await getMeeting({ meetingId: parsed.meetingId });
    if (parsed.rangeStart < new Date(meeting.rangeStart) || parsed.rangeEnd > new Date(meeting.rangeEnd)) {
      throw new ProjectManagementServiceError("VALIDATION_ERROR", "查看范围必须位于会议的工作时间区间内");
    }
    personIds = meeting.participants.map((person) => person.id);
  } else {
    assertCanManageMeetings(actor);
    personIds = parsed.personIds;
  }
  const [people, records, globalMarkers] = await Promise.all([
    prisma.person.findMany({
      where: { id: { in: personIds } }, select: { id: true, displayName: true, status: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    }),
    prisma.workSegment.findMany({
      where: {
        deletedAt: null, personId: { in: personIds },
        startAt: { lt: parsed.rangeEnd }, endAt: { gt: parsed.rangeStart },
      },
      select: {
        ...fullSegmentSelect,
        task: { select: { ...fullSegmentSelect.task.select, project: { select: { name: true } } } },
      },
      orderBy: [{ startAt: "asc" }, { endAt: "asc" }, { id: "asc" }],
      take: MAX_TIME_CANVAS_VISIBLE_SEGMENTS + 1,
    }),
    listGlobalTimeMarkers(),
  ]);
  if (people.length !== personIds.length) throw notFoundError();
  if (records.length > MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
    throw queryLimitExceededError("该查看区间超过 5000 条工作记录，请缩小查看区间后重试；不会省略记录");
  }
  const segments = records.map((record) => ({
    ...toFullSegmentDto(actor, record),
    taskTitle: record.task ? [record.task.project?.name, record.task.title].filter(Boolean).join(" / ") : null,
    permissions: { canViewDetails: true, canEdit: false, canMove: false, canResize: false, canSoftDelete: false },
  }));
  const rows = people.map((person) => ({
    kind: "PERSON" as const, id: person.id,
    label: `${person.displayName}${person.status === "INACTIVE" ? "（已停用）" : ""}`,
    sublabel: null, capabilities: { canCreateSegment: false },
  }));
  return timeCanvasDataDtoSchema.parse({
    scope: { kind: "RESOURCE_PLANNER" }, timezone: "Asia/Shanghai", groupBy: "PERSON",
    range: { startAt: parsed.rangeStart.toISOString(), endAt: parsed.rangeEnd.toISOString() },
    rowPageKey: createHash("sha256").update(JSON.stringify({ rows, segments, globalMarkers })).digest("hex"),
    rows, segments, anchors: [], globalMarkers, generatedAt: new Date().toISOString(),
  });
}
