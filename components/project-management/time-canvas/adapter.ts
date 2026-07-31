import { layoutIntervalLanes, rowHeightForLaneCount } from "@/components/project-management/time-canvas/lane-layout";
import type {
  TimeCanvasAnchor,
  TimeCanvasConflict,
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
  canSplit: false,
  canMerge: false,
  canCancel: false,
  canConfirm: false,
  canRelink: false,
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

  const conflicts: TimeCanvasConflict[] = data.conflicts.map((conflict, index) => {
    if (conflict.visibility === "HIDDEN") {
      return {
        id: `hidden-conflict:${index}`,
        rowId: null,
        visibility: "HIDDEN",
        severity: conflict.severity,
        status: null,
        reason: null,
        startMs: null,
        endMs: null,
        hiddenSegmentCount: conflict.hiddenSegmentCount,
      };
    }
    return {
      id: conflict.id,
      rowId:
        data.groupBy === "PERSON"
          ? rowIdBySource.get(`PERSON:${conflict.personId}`) ?? null
          : null,
      visibility: "VISIBLE",
      severity: conflict.severity,
      status: conflict.status,
      reason: conflict.conflictKind,
      startMs: parseMs(conflict.startAt),
      endMs: parseMs(conflict.endAt),
      hiddenSegmentCount: conflict.hiddenSegmentCount,
    };
  });

  return {
    timezone: data.timezone,
    range: {
      startMs: parseMs(data.range.startAt),
      endMs: parseMs(data.range.endAt),
    },
    rows: [...planRows, ...regularRows],
    anchors,
    segments,
    conflicts,
    generatedAt: data.generatedAt,
  };
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
      nodeId: null,
      type: "BUSY",
      status: "BUSY",
      startMs: parseMs(segment.startAt),
      endMs: parseMs(segment.endAt),
      title: "其他占用",
      allocation: segment.allocation,
      priority: null,
      associationNeedsReview: false,
      conflictIds: [],
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
    nodeId: segment.nodeId,
    type: segment.type,
    status: segment.status,
    startMs: parseMs(segment.startAt),
    endMs: parseMs(segment.endAt),
    title: segment.content || "未命名投入",
    allocation: segment.allocation,
    priority: segment.priority,
    associationNeedsReview: segment.associationNeedsReview,
    conflictIds: segment.conflictIds,
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
  if (task.plannedStartAt) {
    anchors.push({
      id: `plan-start:${task.id}`,
      rowId,
      taskId: task.id,
      kind: "PLAN_START",
      status: task.status,
      label: "计划开始",
      atMs: parseMs(task.plannedStartAt),
      sequence: -1,
      editable: canEditDraftPlan,
      versionToken: task.versionToken,
    });
  }
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
