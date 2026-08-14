import { DAY_MS, HOUR_MS } from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasMode,
  TimeCanvasModel,
  TimeCanvasSegmentPermissions,
} from "@/components/project-management/time-canvas/types";

const RANGE_START = Date.parse("2026-08-01T00:00:00.000+08:00");
const editablePermissions: TimeCanvasSegmentPermissions = {
  canViewDetails: true,
  canEdit: true,
  canMove: true,
  canResize: true,
  canMerge: true,
  canCancel: true,
  canConfirm: true,
  canSoftDelete: false,
};

export function createTimeCanvasFixture(mode: TimeCanvasMode): TimeCanvasModel {
  if (mode === "TASK_COMPOSER") return composerFixture();
  if (mode === "TASK_WORKBENCH") return workbenchFixture();
  if (mode === "PERSONAL_TIMELINE") return personalFixture();
  return resourceFixture();
}

export function createEmptyTimeCanvasFixture(): TimeCanvasModel {
  return {
    timezone: "Asia/Shanghai",
    range: { startMs: RANGE_START, endMs: RANGE_START + 14 * DAY_MS },
    rows: [],
    anchors: [],
    segments: [],
    generatedAt: new Date(RANGE_START).toISOString(),
  };
}

function composerFixture(): TimeCanvasModel {
  const rowId = "plan:fixture-composer";
  const tones = [
    "BLUE",
    "VIOLET",
    "AMBER",
    "EMERALD",
    "ROSE",
    "SLATE",
  ] as const;
  return {
    timezone: "Asia/Shanghai",
    range: { startMs: RANGE_START, endMs: RANGE_START + 30 * DAY_MS },
    rows: [planRow(rowId, "Task Composer · 200 节点压力计划")],
    anchors: Array.from({ length: 200 }, (_, index) => ({
      id: `composer-node-${index}`,
      rowId,
      taskId: "fixture-composer",
      kind: index === 199 ? ("TERMINATION" as const) : ("MILESTONE" as const),
      status: index === 8 ? "ACTIVE" : "PENDING",
      label: `节点 ${index + 1} ${index % 25 === 0 ? "同日密集与超长标题验证".repeat(3) : ""}`,
      atMs: RANGE_START + Math.floor(index / 10) * DAY_MS,
      sequence: index,
      editable: true,
      versionToken: `fixture-${index}`,
    })),
    phaseBands: Array.from({ length: 19 }, (_, index) => ({
      id: `composer-phase-${index}`,
      rowId,
      startMs: RANGE_START + index * DAY_MS,
      endMs: RANGE_START + (index + 1) * DAY_MS,
      label: `阶段 ${index + 1}`,
      tone: tones[index % tones.length] ?? "BLUE",
    })),
    segments: [],
    generatedAt: new Date(RANGE_START).toISOString(),
  };
}

function workbenchFixture(): TimeCanvasModel {
  const planId = "plan:fixture-workbench";
  const personRows = Array.from({ length: 5 }, (_, index) =>
    personRow(index, `工作台成员 ${index + 1}`),
  );
  return {
    timezone: "Asia/Shanghai",
    range: { startMs: RANGE_START, endMs: RANGE_START + 21 * DAY_MS },
    rows: [planRow(planId, "Task 工作台计划"), ...personRows],
    anchors: [0, 7, 14, 20].map((day, index) => ({
      id: `workbench-node-${index}`,
      rowId: planId,
      taskId: "fixture-workbench",
      kind: index === 3 ? ("TERMINATION" as const) : ("MILESTONE" as const),
      status: index === 0 ? "COMPLETED" : index === 1 ? "ACTIVE" : "PENDING",
      label: index === 3 ? "计划结束" : `里程碑 ${index + 1}`,
      atMs: RANGE_START + day * DAY_MS,
      sequence: index,
      editable: false,
      versionToken: `workbench-${index}`,
    })),
    segments: personRows.flatMap((row, rowIndex) =>
      Array.from({ length: rowIndex === 0 ? 10 : 3 }, (_, index) => ({
        id: `workbench-segment-${rowIndex}-${index}`,
        rowId: row.id,
        personId: row.sourceId,
        taskId: "fixture-workbench",
        taskTitle: "Task 工作台计划",
        type: index % 3 === 2 ? ("ACTUAL" as const) : ("PLANNED" as const),
        status: index % 3 === 2 ? "CONFIRMED" : "PLANNED",
        startMs: RANGE_START + (2 + index / 3) * DAY_MS,
        endMs: RANGE_START + (4 + index / 3) * DAY_MS,
        title: `工作台投入 ${index + 1}`,
        priority: "MEDIUM",
        visibility: "FULL" as const,
        permissions: editablePermissions,
        versionToken: `workbench-segment-${index}`,
      })),
    ),
    generatedAt: new Date(RANGE_START).toISOString(),
  };
}

function resourceFixture(): TimeCanvasModel {
  const rows = Array.from({ length: 50 }, (_, index) =>
    personRow(index, index === 0 ? "超长人员名称".repeat(12) : `资源成员 ${index + 1}`),
  );
  const segments = rows.flatMap((row, rowIndex) =>
    Array.from({ length: rowIndex === 0 ? 10 : 4 }, (_, index) => ({
      id: `resource-segment-${rowIndex}-${index}`,
      rowId: row.id,
      personId: row.sourceId,
      taskId: `fixture-task-${index % 5}`,
      taskTitle: index === 3 ? null : `资源 Task ${index % 5 + 1}`,
      type: index === 3 ? ("BUSY" as const) : index % 2 === 0 ? ("PLANNED" as const) : ("ACTUAL" as const),
      status: index === 3 ? "BUSY" : index % 2 === 0 ? "PENDING_CONFIRMATION" : "CONFIRMED",
      startMs: RANGE_START + (rowIndex % 10) * DAY_MS + index * 2 * HOUR_MS,
      endMs: RANGE_START + (rowIndex % 10) * DAY_MS + index * 2 * HOUR_MS + 8 * HOUR_MS,
      title: index === 3 ? "其他占用" : `资源安排 ${rowIndex + 1}-${index + 1}`,
      priority: index === 3 ? null : "MEDIUM",
      visibility: index === 3 ? ("BUSY_ONLY" as const) : ("FULL" as const),
      permissions: index === 3 ? readOnlyPermissions() : editablePermissions,
      versionToken: index === 3 ? null : `resource-${rowIndex}-${index}`,
    })),
  );
  return {
    timezone: "Asia/Shanghai",
    range: { startMs: RANGE_START, endMs: RANGE_START + 30 * DAY_MS },
    rows,
    anchors: [],
    segments,
    generatedAt: new Date(RANGE_START).toISOString(),
  };
}

function personalFixture(): TimeCanvasModel {
  const row = personRow(0, "我的时间线");
  return {
    timezone: "Asia/Shanghai",
    range: { startMs: RANGE_START, endMs: RANGE_START + 7 * DAY_MS },
    rows: [row],
    anchors: [],
    segments: Array.from({ length: 8 }, (_, index) => ({
      id: `personal-segment-${index}`,
      rowId: row.id,
      personId: row.sourceId,
      taskId: `personal-task-${index % 2}`,
      taskTitle: `个人 Task ${index % 2 + 1}`,
      type: index % 2 === 0 ? ("PLANNED" as const) : ("ACTUAL" as const),
      status: index % 2 === 0 ? "PENDING_CONFIRMATION" : "CONFIRMED",
      startMs: RANGE_START + index * 8 * HOUR_MS,
      endMs: RANGE_START + index * 8 * HOUR_MS + 4 * HOUR_MS,
      title: `个人安排 ${index + 1}`,
      priority: "MEDIUM",
      visibility: "FULL" as const,
      permissions: editablePermissions,
      versionToken: `personal-${index}`,
    })),
    generatedAt: new Date(RANGE_START).toISOString(),
  };
}

function planRow(id: string, label: string) {
  return {
    id,
    sourceId: id.replace("plan:", ""),
    kind: "PLAN" as const,
    label,
    sublabel: "计划轨道",
    editable: true,
    height: 112,
    capacity: null,
  };
}

function personRow(index: number, label: string) {
  return {
    id: `person:fixture-person-${index}`,
    sourceId: `fixture-person-${index}`,
    kind: "PERSON" as const,
    label,
    sublabel: index % 2 === 0 ? "前端 / Owner" : "机械 / Member",
    editable: true,
    height: index === 0 ? 120 : 72,
    capacity: 100,
  };
}

function readOnlyPermissions(): TimeCanvasSegmentPermissions {
  return {
    canViewDetails: false,
    canEdit: false,
    canMove: false,
    canResize: false,
    canMerge: false,
    canCancel: false,
    canConfirm: false,
    canSoftDelete: false,
  };
}
