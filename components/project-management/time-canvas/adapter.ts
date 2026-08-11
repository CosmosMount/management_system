import { layoutIntervalLanes, rowHeightForLaneCount } from "@/components/project-management/time-canvas/lane-layout";
import type {
  TimeCanvasAnchor,
  TimeCanvasMode,
  TimeCanvasModel,
  TimeCanvasRow,
  TimeCanvasSegment,
  TimeCanvasSegmentPermissions,
} from "@/components/project-management/time-canvas/types";
import type {
  BusyBlockDto,
  TimeCanvasDataDto,
  TimeSegmentDto,
} from "@/lib/project-management/types/time-canvas";

const readOnlyPermissions: TimeCanvasSegmentPermissions = {
  canViewDetails: false,
  canEdit: false,
  canMove: false,
  canResize: false,
  canMerge: false,
  canCancel: false,
  canConfirm: false,
  canSoftDelete: false,
};

export function timeCanvasDataToModel(
  data: TimeCanvasDataDto,
  mode: TimeCanvasMode,
): TimeCanvasModel {
  const regularRows: TimeCanvasRow[] = data.rows.map((row) => ({
    id: `${row.kind.toLowerCase()}:${row.id}`,
    sourceId: row.id,
    kind: row.kind,
    label: row.label,
    sublabel: row.sublabel,
    editable: row.capabilities.canCreateSegment,
    height: 48,
    capacity: null,
  }));
  const rowIdBySource = new Map(
    regularRows.map((row) => [`${row.kind}:${row.sourceId}`, row.id]),
  );
  const segments = data.segments.map((segment, index) =>
    adaptSegment(segment, index, data.groupBy, rowIdBySource),
  );

  for (const row of regularRows) {
    const layout = layoutIntervalLanes(
      segments
        .filter((segment) => segment.rowId === row.id)
        .map((segment) => ({
          id: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
        })),
    );
    row.height = rowHeightForLaneCount(layout.laneCount);
  }

  const showPlanRows = mode === "TASK_COMPOSER" || mode === "TASK_WORKBENCH";
  const planRows: TimeCanvasRow[] = showPlanRows
    ? data.anchors.map((task) => {
        const canEditDraftPlan =
          task.status === "DRAFT" && task.capabilities.canUpdateMetadata;
        return {
          id: `plan:${task.id}`,
          sourceId: task.id,
          kind: "PLAN",
          label: task.title,
          sublabel: `计划轨道 · ${task.status}`,
          editable: canEditDraftPlan,
          height: 112,
          capacity: null,
        };
      })
    : [];
  const planRowIds = new Map(planRows.map((row) => [row.sourceId, row.id]));
  const anchors = showPlanRows
    ? data.anchors.flatMap((task) => adaptTaskAnchors(task, planRowIds.get(task.id)))
    : [];

  return {
    timezone: data.timezone,
    range: {
      startMs: parseMs(data.range.startAt),
      endMs: parseMs(data.range.endAt),
    },
    rowPageKey: data.rowPageKey,
    rows: [...planRows, ...regularRows],
    anchors,
    segments,
    nextCursor: data.nextCursor,
    generatedAt: data.generatedAt,
  };
}

export function timeCanvasSegmentsToModel(
  segments: TimeCanvasDataDto["segments"],
  groupBy: TimeCanvasDataDto["groupBy"],
  rows: TimeCanvasRow[],
) {
  const rowIdBySource = new Map(
    rows
      .filter((row) => row.kind !== "PLAN")
      .map((row) => [`${row.kind}:${row.sourceId}`, row.id]),
  );
  return segments.map((segment, index) =>
    adaptSegment(segment, index, groupBy, rowIdBySource),
  );
}

function adaptSegment(
  segment: TimeSegmentDto | BusyBlockDto,
  index: number,
  groupBy: "PERSON" | "TASK",
  rowIdBySource: Map<string, string>,
): TimeCanvasSegment {
  if (segment.kind === "BUSY") {
    return {
      id: `busy:${segment.personId}:${segment.startAt}:${segment.endAt}:${index}`,
      rowId: rowIdBySource.get(`PERSON:${segment.personId}`) ?? `person:${segment.personId}`,
      personId: segment.personId,
      taskId: null,
      type: "BUSY",
      status: "BUSY",
      startMs: parseMs(segment.startAt),
      endMs: parseMs(segment.endAt),
      title: "其他占用",
      priority: null,
      visibility: "BUSY_ONLY",
      permissions: readOnlyPermissions,
      versionToken: null,
    };
  }
  const sourceRowId = groupBy === "PERSON" ? segment.personId : segment.taskId;
  if (!sourceRowId) throw new Error("按 Task 分组的 Segment 缺少 taskId");
  return {
    id: segment.id,
    rowId:
      rowIdBySource.get(`${groupBy}:${sourceRowId}`) ??
      `${groupBy.toLowerCase()}:${sourceRowId}`,
    personId: segment.personId,
    taskId: segment.taskId,
    type: segment.type,
    status: segment.status,
    startMs: parseMs(segment.startAt),
    endMs: parseMs(segment.endAt),
    title: segment.content || "未命名投入",
    priority: segment.priority,
    visibility: segment.visibility,
    permissions: segment.permissions,
    versionToken: segment.versionToken,
  };
}

function adaptTaskAnchors(
  task: TimeCanvasDataDto["anchors"][number],
  rowId: string | undefined,
): TimeCanvasAnchor[] {
  if (!rowId) return [];
  const anchors: TimeCanvasAnchor[] = [];
  const canEditDraftPlan =
    task.status === "DRAFT" && task.capabilities.canUpdateMetadata;
  anchors.push({
    id: `plan-start:${task.id}`,
    rowId,
    taskId: task.id,
    kind: "PLAN_START",
    status: task.status,
    label: "Start",
    atMs: parseMs(task.plannedStartAt ?? task.createdAt),
    sequence: -1,
    editable: canEditDraftPlan && task.plannedStartAt !== null,
    versionToken: task.versionToken,
  });
  for (const node of task.nodes) {
    if (!node.plannedAt) continue;
    anchors.push({
      id: node.id,
      rowId,
      taskId: task.id,
      kind: node.type,
      status: node.status,
      label: node.label,
      atMs: parseMs(node.plannedAt),
      sequence: node.sequence,
      editable: node.capabilities.canEditDraft,
      versionToken: node.versionToken,
    });
  }
  return anchors;
}

function parseMs(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("TimeCanvas DTO 包含无效时间");
  return parsed;
}
