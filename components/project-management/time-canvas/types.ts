export type TimeCanvasMode =
  | "TASK_COMPOSER"
  | "TASK_WORKBENCH"
  | "RESOURCE_PLANNER"
  | "PERSONAL_TIMELINE";

export type TimeCanvasZoom = "HOUR" | "DAY" | "WEEK" | "MONTH";

export type TimeCanvasRange = {
  startMs: number;
  endMs: number;
};

export type TimeCanvasRow = {
  id: string;
  sourceId: string;
  kind: "PLAN" | "PERSON" | "TASK";
  label: string;
  sublabel: string | null;
  editable: boolean;
  height: number;
  capacity: number | null;
};

export type TimeCanvasAnchor = {
  id: string;
  rowId: string;
  taskId: string;
  kind: "PLAN_START" | "MILESTONE" | "REVISION" | "TERMINATION";
  status: string;
  label: string;
  atMs: number;
  sequence: number;
  editable: boolean;
  versionToken: string;
};

export type TimeCanvasSegmentPermissions = {
  canViewDetails: boolean;
  canEdit: boolean;
  canMove: boolean;
  canResize: boolean;
  canSplit: boolean;
  canMerge: boolean;
  canCancel: boolean;
  canConfirm: boolean;
  canRelink: boolean;
  canSoftDelete: boolean;
};

export type TimeCanvasSegment = {
  id: string;
  rowId: string;
  personId: string;
  taskId: string | null;
  nodeId: string | null;
  type: "PLANNED" | "ACTUAL" | "BUSY";
  status: string;
  startMs: number;
  endMs: number;
  title: string;
  allocation: number | null;
  priority: string | null;
  associationNeedsReview: boolean;
  conflictIds: string[];
  visibility: "FULL" | "BUSY_ONLY";
  permissions: TimeCanvasSegmentPermissions;
  versionToken: string | null;
};

export type TimeCanvasConflict = {
  id: string;
  rowId: string | null;
  visibility: "VISIBLE" | "HIDDEN";
  severity: string;
  status: string | null;
  reason: string | null;
  startMs: number | null;
  endMs: number | null;
  hiddenSegmentCount: number;
};

export type TimeCanvasModel = {
  timezone: string;
  range: TimeCanvasRange;
  rows: TimeCanvasRow[];
  anchors: TimeCanvasAnchor[];
  segments: TimeCanvasSegment[];
  conflicts: TimeCanvasConflict[];
  generatedAt: string;
};

export type TimeCanvasSelection =
  | { kind: "ANCHOR" | "SEGMENT" | "CONFLICT"; id: string }
  | null;

export type TimeCanvasDisplayOptions = {
  showActual?: boolean;
  showBusy?: boolean;
  showConflicts?: boolean;
  showInspector?: boolean;
};

export type TimeCanvasProps = {
  mode: TimeCanvasMode;
  model: TimeCanvasModel;
  initialZoom?: TimeCanvasZoom;
  display?: TimeCanvasDisplayOptions;
  emptyMessage?: string;
  onRangeChange?: (range: TimeCanvasRange) => void;
  onSelectionChange?: (selection: TimeCanvasSelection) => void;
};
