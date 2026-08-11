export type TimeCanvasMode =
  | "TASK_COMPOSER"
  | "TASK_WORKBENCH"
  | "RESOURCE_PLANNER"
  | "PERSONAL_TIMELINE";

export type TimeCanvasZoom = "WEEK" | "MONTH" | "QUARTER" | "YEAR";

export type TimeCanvasPresentation = "FULL" | "COMPACT";

export type TimeCanvasTone =
  | "BLUE"
  | "VIOLET"
  | "AMBER"
  | "EMERALD"
  | "ROSE"
  | "SLATE";

export type TimeCanvasRange = {
  startMs: number;
  endMs: number;
};

export type TimeCanvasViewportChangeSource = "LAYOUT" | "USER";

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
  completed?: boolean;
  tone?: TimeCanvasTone;
  visualState?: "TEMPORARY" | "INVALID";
};

export type TimeCanvasPhaseBand = {
  id: string;
  rowId: string;
  startMs: number;
  endMs: number;
  label: string;
  tone: TimeCanvasTone;
  visualState?: "TEMPORARY";
};

export type TimeCanvasSegmentPermissions = {
  canViewDetails: boolean;
  canEdit: boolean;
  canMove: boolean;
  canResize: boolean;
  canMerge: boolean;
  canCancel: boolean;
  canConfirm: boolean;
  canSoftDelete: boolean;
};

export type TimeCanvasSegment = {
  id: string;
  rowId: string;
  personId: string;
  taskId: string | null;
  type: "PLANNED" | "ACTUAL" | "BUSY";
  status: string;
  startMs: number;
  endMs: number;
  title: string;
  priority: string | null;
  visibility: "FULL" | "BUSY_ONLY";
  permissions: TimeCanvasSegmentPermissions;
  versionToken: string | null;
};

export type TimeCanvasModel = {
  timezone: string;
  range: TimeCanvasRange;
  fullRange?: TimeCanvasRange;
  rowPageKey?: string;
  contentRange?: TimeCanvasRange | null;
  rangeClipped?: boolean;
  loadedRanges?: TimeCanvasRange[];
  loadedLeafBlockCounts?: number[];
  failedRanges?: Array<TimeCanvasRange & { message: string }>;
  rows: TimeCanvasRow[];
  anchors: TimeCanvasAnchor[];
  phaseBands?: TimeCanvasPhaseBand[];
  segments: TimeCanvasSegment[];
  nextCursor?: string | null;
  generatedAt: string;
};

export type AdaptiveTimeCanvasBlockQuery =
  | {
      kind: "MY_TIMELINE";
      preferredCenterMs: number;
      showAll: boolean;
      taskCursor?: string;
    }
  | {
      kind: "TASK";
      preferredCenterMs: number;
      taskId: string;
    }
  | {
      kind: "PROJECT";
      preferredCenterMs: number;
      projectId: string;
      taskCursor?: string;
    }
  | {
      kind: "RESOURCE_PLAN";
      preferredCenterMs: number;
      all: boolean;
      projectIds: string[];
      taskIds: string[];
      personIds: string[];
      pinnedTaskIds: string[];
      pinnedPersonIds: string[];
      taskCursor?: string;
      personCursor?: string;
    };

export type TimeCanvasSelection =
  | { kind: "ANCHOR" | "SEGMENT"; id: string }
  | null;

export type TimeCanvasDisplayOptions = {
  showActual?: boolean;
  showBusy?: boolean;
  showInspector?: boolean;
};

export type TimeCanvasBrushRequest = {
  rowId: string;
  rowKind: TimeCanvasRow["kind"];
  sourceId: string;
  startMs: number;
  endMs: number;
};

export type TimeCanvasSegmentTransformRequest = {
  segmentId: string;
  kind: "MOVE" | "RESIZE_START" | "RESIZE_END" | "KEYBOARD_MOVE";
  startMs: number;
  endMs: number;
};

export type TimeCanvasCreationRangeTransformRequest = {
  kind: "MOVE" | "RESIZE_START" | "RESIZE_END" | "KEYBOARD_MOVE";
  startMs: number;
  endMs: number;
  targetRowId: string;
  targetSourceId: string;
};

export type TimeCanvasAnchorCreateRequest = {
  rowId: string;
  rowKind: TimeCanvasRow["kind"];
  sourceId: string;
  atMs: number;
  snapMs: number;
};

export type TimeCanvasAnchorMoveRequest = {
  anchorId: string;
  rowId: string;
  kind: "MOVE" | "KEYBOARD_MOVE";
  atMs: number;
  deltaMs: number;
  snapMs: number;
};

export type TimeCanvasAnchorMoveResolution = Pick<
  TimeCanvasAnchorMoveRequest,
  "atMs" | "deltaMs"
> & {
  blockedMessage?: string;
};

export type TimeCanvasInteractionOptions = {
  enableBrushCreate?: boolean;
  enableAnchorCreate?: boolean;
  desktopOnlySegmentTransform?: boolean;
  creationRange?: TimeCanvasBrushRequest | null;
  selectedSegmentIds?: ReadonlySet<string>;
  onBrushCreate?: (request: TimeCanvasBrushRequest) => void;
  onCreationRangeTransform?: (
    request: TimeCanvasCreationRangeTransformRequest,
  ) => void;
  onAnchorCreate?: (request: TimeCanvasAnchorCreateRequest) => void;
  constrainAnchorMove?: (
    request: TimeCanvasAnchorMoveRequest,
  ) => TimeCanvasAnchorMoveResolution;
  onAnchorMove?: (request: TimeCanvasAnchorMoveRequest) => void;
  onAnchorSelectionChange?: (anchorId: string | null) => void;
  onSegmentTransform?: (request: TimeCanvasSegmentTransformRequest) => void;
  onSegmentToggleSelection?: (segmentId: string) => void;
  onSegmentOpen?: (segmentId: string) => void;
  onInvalidDrop?: (message: string) => void;
};

export type TimeCanvasProps = {
  mode: TimeCanvasMode;
  model: TimeCanvasModel;
  presentation?: TimeCanvasPresentation;
  initialZoom?: TimeCanvasZoom;
  initialCenterMs?: number;
  display?: TimeCanvasDisplayOptions;
  interaction?: TimeCanvasInteractionOptions;
  /** Passing `selection` makes selection controlled; omit it for internal state. */
  selection?: TimeCanvasSelection;
  initialSelection?: TimeCanvasSelection;
  emptyMessage?: string;
  onRangeChange?: (range: TimeCanvasRange) => void;
  navigationRange?: TimeCanvasRange;
  onRequestCenter?: (centerMs: number) => void;
  onViewportChange?: (
    range: TimeCanvasRange,
    source: TimeCanvasViewportChangeSource,
  ) => void;
  onZoomChange?: (zoom: TimeCanvasZoom) => void;
  onSelectionChange?: (selection: TimeCanvasSelection) => void;
};
