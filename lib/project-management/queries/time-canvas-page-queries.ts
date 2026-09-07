import { prisma } from "@/lib/prisma";
import {
  DAY_MS,
  floorShanghaiDay,
} from "@/lib/project-management/time-canvas/time-math";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError } from "@/lib/project-management/application/errors";
import {
  getAdaptiveTimeCanvasBlockInputSchema,
  getMyTimelinePageInputSchema,
  getPersonTimelinePageInputSchema,
  getTimeCanvasDataInputSchema,
} from "@/lib/project-management/validations/time-canvas";
import {
  listMyTaskOptions,
  listPersonTaskOptions,
  resolvePeopleOptionsByIds,
} from "@/lib/project-management/queries/option-queries";
import { getProjectDetail } from "@/lib/project-management/queries/project-queries";
import { getResourcePlanSelection } from "@/lib/project-management/queries/resource-plan-queries";
import {
  authorizedSegmentFilterWhere,
  personAvailableInRangeWhere,
  personUniverseWhere,
} from "@/lib/project-management/queries/time-canvas-query-scope";
import { getContentDrivenTimeCanvasData } from "@/lib/project-management/queries/time-canvas-content-query";

export async function getMyTimelinePageData({
  actor,
  input,
  preferredCenterMs,
  load,
}: {
  actor: ProjectManagementActor;
  input: unknown;
  preferredCenterMs?: number;
  load?: Parameters<typeof getContentDrivenTimeCanvasData>[0]["load"];
}) {
  const selector = getMyTimelinePageInputSchema.parse(input);
  const tasks = await listMyTaskOptions({
    actor,
    statuses: selector.showAll ? [] : ["ACTIVE"],
  });
  const canvas = await getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    anchorTaskIds: tasks.map((task) => task.id),
    load,
    input: {
      scope: { kind: "PERSONAL" },
      personIds: [actor.personId],
      taskIds: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      includeBusyBlocks: false,
    },
  });
  return { tasks, ...canvas };
}

export async function getPersonTimelinePageData({
  actor,
  input,
  preferredCenterMs,
  load,
}: {
  actor: ProjectManagementActor;
  input: unknown;
  preferredCenterMs?: number;
  load?: Parameters<typeof getContentDrivenTimeCanvasData>[0]["load"];
}) {
  const selector = getPersonTimelinePageInputSchema.parse(input);
  const [person] = await resolvePeopleOptionsByIds({
    actor,
    input: {
      scope: { purpose: "VISIBLE" },
      ids: [selector.personId],
    },
  });
  if (!person || (person.status !== "ACTIVE" && person.id !== actor.personId)) {
    throw notFoundError();
  }
  const tasks = await listPersonTaskOptions({
    actor,
    personId: person.id,
    statuses: ["ACTIVE"],
  });
  const inactiveSelf = person.id === actor.personId && person.status === "INACTIVE";
  const canvas = await getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    includePreferredCenterInFullRange: true,
    anchorTaskIds: tasks.map((task) => task.id),
    load,
    input: {
      scope: { kind: inactiveSelf ? "PERSONAL" : "RESOURCE_PLANNER" },
      personIds: inactiveSelf ? [] : [person.id],
      taskIds: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      emptyPersonIdsMeansNone: false,
      includeBusyBlocks: false,
    },
  });
  return { person, tasks, ...canvas };
}

export async function getResourcePlanPageData({
  actor,
  input,
  preferredCenterMs,
  load,
}: {
  actor: ProjectManagementActor;
  input: unknown;
  preferredCenterMs?: number;
  load?: Parameters<typeof getContentDrivenTimeCanvasData>[0]["load"];
}) {
  const selection = await getResourcePlanSelection({ actor, input });
  const canvas = await getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    load,
    anchorTaskIds: selection.taskIds,
    input: {
      scope: { kind: "RESOURCE_PLANNER" },
      personIds: selection.personIds,
      taskIds: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      emptyPersonIdsMeansNone: true,
      includeBusyBlocks: false,
    },
  });
  return { selection, ...canvas };
}

export async function resolveProjectTimelinePersonIds({
  actor,
  personIds,
}: {
  actor: ProjectManagementActor;
  personIds: string[];
}) {
  const uniquePersonIds = [...new Set(personIds)];
  if (uniquePersonIds.length === 0) return [];
  const seedStart = floorShanghaiDay(Date.now());
  const input = getTimeCanvasDataInputSchema.parse({
    scope: { kind: "RESOURCE_PLANNER" },
    personIds: uniquePersonIds,
    taskIds: [],
    groupBy: "PERSON",
    includeTaskAnchors: true,
    includeBusyBlocks: false,
    rangeStart: new Date(seedStart).toISOString(),
    rangeEnd: new Date(seedStart + DAY_MS).toISOString(),
  });
  const authorizedAllTimeFilter = authorizedSegmentFilterWhere(actor, input, false);
  const people = await prisma.person.findMany({
    where: {
      AND: [
        { id: { in: uniquePersonIds } },
        personUniverseWhere(actor, input, null),
        personAvailableInRangeWhere(authorizedAllTimeFilter),
      ],
    },
    select: { id: true },
  });
  const availableIds = new Set(people.map((person) => person.id));
  return uniquePersonIds.filter((personId) => availableIds.has(personId));
}

export async function getAdaptiveTimeCanvasBlock({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = getAdaptiveTimeCanvasBlockInputSchema.parse(input);
  const preferredCenterMs = parsed.preferredCenter.getTime();
  const load = {
    mode: "BLOCK" as const,
    range: {
      startMs: parsed.blockStart.getTime(),
      endMs: parsed.blockEnd.getTime(),
    },
    expectedRowPageKey: parsed.rowPageKey,
  };
  const result = parsed.kind === "MY_TIMELINE"
    ? await getMyTimelinePageData({
        actor,
        input: { showAll: parsed.showAll },
        preferredCenterMs,
        load,
      })
    : parsed.kind === "PERSON_TIMELINE"
      ? await getPersonTimelinePageData({
          actor,
          input: { personId: parsed.personId },
          preferredCenterMs,
          load,
        })
    : parsed.kind === "TASK"
      ? await getContentDrivenTimeCanvasData({
          actor,
          preferredCenterMs,
          load,
          input: {
            scope: { kind: "TASK_SCOPED", taskId: parsed.taskId },
            personIds: [],
            taskIds: [],
            groupBy: "PERSON",
            includeTaskAnchors: true,
            includeBusyBlocks: false,
          },
        })
      : parsed.kind === "PROJECT"
        ? await loadProjectTimeCanvasBlock(actor, parsed, preferredCenterMs, load)
        : await getResourcePlanPageData({
            actor,
            input: {
              all: parsed.all,
              taskStatuses: parsed.taskStatuses,
              projectIds: parsed.projectIds,
              taskIds: parsed.taskIds,
              personIds: parsed.personIds,
              pinnedTaskIds: parsed.pinnedTaskIds,
              pinnedPersonIds: parsed.pinnedPersonIds,
            },
            preferredCenterMs,
            load,
          });
  return {
    rowPageKey: result.data.rowPageKey,
    logicalRange: result.data.range,
    loadedRange: result.loadedRange,
    groupBy: result.data.groupBy,
    segments: result.data.segments,
    generatedAt: result.data.generatedAt,
    leafBlockCount: result.leafBlockCount,
    failedRanges: result.failedRanges,
  };
}

async function loadProjectTimeCanvasBlock(
  actor: ProjectManagementActor,
  input: Extract<
    ReturnType<typeof getAdaptiveTimeCanvasBlockInputSchema.parse>,
    { kind: "PROJECT" }
  >,
  preferredCenterMs: number,
  load: Extract<
    NonNullable<Parameters<typeof getContentDrivenTimeCanvasData>[0]["load"]>,
    { mode: "BLOCK" }
  >,
) {
  const project = await getProjectDetail({
    actor,
    projectId: input.projectId,
  });
  const personIds = await resolveProjectTimelinePersonIds({
    actor,
    personIds: [
      ...project.members.map((member) => member.personId),
      ...project.tasks.flatMap((task) => task.members.map((member) => member.personId)),
    ],
  });
  return getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    load,
    anchorTaskIds: project.tasks.map((task) => task.id),
    input: {
      scope: { kind: "RESOURCE_PLANNER" },
      personIds,
      taskIds: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      includeBusyBlocks: false,
    },
  });
}
