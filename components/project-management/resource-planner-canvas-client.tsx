"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { getAdaptiveTimeCanvasBlock } from "@/app/actions/project-management/canvas";
import {
  cancelPlannedSegment,
  confirmPlannedSegment,
  createActualSegment,
  createWorkSegment,
  getWorkSegment,
  listWorkSegmentChanges,
  partiallyConfirmSegment,
  softDeleteActualSegment,
  updateWorkSegment,
} from "@/app/actions/project-management/segments";
import { TaskSelect } from "@/components/project-management/task-picker";
import {
  UserSelect,
  type UserPickerScope,
} from "@/components/project-management/user-picker";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { timeCanvasSegmentsToModel } from "@/components/project-management/time-canvas/adapter";
import {
  TIME_CANVAS_CACHE_LEAF_BLOCK_LIMIT,
  TIME_CANVAS_CACHE_OBJECT_LIMIT,
  mergeTimeCanvasVersionedSegments,
  pruneTimeCanvasBlockCache,
  type TimeCanvasCachedBlock,
} from "@/components/project-management/time-canvas/block-cache";
import {
  layoutIntervalLanes,
  rowHeightForLaneCount,
} from "@/components/project-management/time-canvas/lane-layout";
import {
  DAY_MS,
  clampLogicalRangeToThreeYears,
  padShanghaiCalendarRange,
} from "@/components/project-management/time-canvas/time-math";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import type {
  AdaptiveTimeCanvasBlockQuery,
  TimeCanvasBrushRequest,
  TimeCanvasMode,
  TimeCanvasModel,
  TimeCanvasRange,
  TimeCanvasSelection,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { TIME_CANVAS_VIEWPORT_STATE_EVENT } from "@/components/project-management/time-canvas/viewport-state-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import {
  taskPriorityLabels,
  workSegmentStatusLabels,
  workSegmentTypeLabels,
} from "@/lib/project-management/labels";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import { cn } from "@/lib/utils";

type TaskOption = TaskOptionPage["items"][number];
type Notice = { kind: "success" | "error" | "info"; message: string } | null;
type CreateDraft = {
  rowId: string;
  personId: string;
  startMs: number;
  endMs: number;
};
type SegmentChange = {
  key: string;
  action: string;
  actorName: string;
  reason: string;
  createdAt: string;
  differences: Array<{
    label: string;
    before: string;
    after: string;
  }>;
};
type CachedBlock = TimeCanvasCachedBlock<TimeCanvasModel["segments"][number]>;
type FailedBlock = {
  key: string;
  range: { startMs: number; endMs: number };
  requestRange: { startMs: number; endMs: number };
  message: string;
  kind: "LOAD" | "CAPACITY" | "CONFLICT";
};
type PendingPlannedRange = {
  range: TimeCanvasRange;
  previousRowPageKey?: string;
};

export function ResourcePlannerCanvasClient({
  initialModel: incomingModel,
  peopleOptions,
  taskOptions,
  peopleScope = { purpose: "VISIBLE" },
  defaultPersonId,
  initialZoom,
  mode = "RESOURCE_PLANNER",
  defaultTaskId = "",
  defaultTaskTitle = "",
  allowIndependent = true,
  allowCreate = true,
  readOnly = false,
  initialFocusId = null,
  initialCenterMs,
  persistViewportInUrl = false,
  adaptiveBlockQuery,
}: {
  initialModel: TimeCanvasModel;
  peopleOptions: PersonOptionDto[];
  taskOptions: TaskOption[];
  peopleScope?: UserPickerScope;
  defaultPersonId: string;
  initialZoom?: TimeCanvasZoom;
  mode?: TimeCanvasMode;
  defaultTaskId?: string;
  defaultTaskTitle?: string;
  allowIndependent?: boolean;
  allowCreate?: boolean;
  readOnly?: boolean;
  initialFocusId?: string | null;
  initialCenterMs?: number;
  persistViewportInUrl?: boolean;
  adaptiveBlockQuery?: AdaptiveTimeCanvasBlockQuery;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [createDraftDirty, setCreateDraftDirty] = useState(false);
  const [initialModel, setInitialModel] = useState(incomingModel);
  const initialBlocks = useMemo(
    () => createInitialBlocks(initialModel),
    [initialModel],
  );
  const [cachedBlocks, setCachedBlocks] = useState<CachedBlock[]>(initialBlocks);
  const cachedBlocksRef = useRef(initialBlocks);
  const [failedBlocks, setFailedBlocks] = useState<FailedBlock[]>(() =>
    createInitialFailedBlocks(incomingModel),
  );
  const inFlightBlockKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const cachedMerge = useMemo(
    () => mergeTimeCanvasVersionedSegments(cachedBlocks),
    [cachedBlocks],
  );
  const cachedSegments = cachedMerge.segments;
  const model = useMemo(
    () => {
      const draftRange = createDraft &&
          Number.isFinite(createDraft.startMs) &&
          Number.isFinite(createDraft.endMs) &&
          createDraft.endMs > createDraft.startMs
        ? { startMs: createDraft.startMs, endMs: createDraft.endMs }
        : null;
      const displayContentRange = draftRange
        ? {
            startMs: Math.min(
              initialModel.contentRange?.startMs ?? draftRange.startMs,
              draftRange.startMs,
            ),
            endMs: Math.max(
              initialModel.contentRange?.endMs ?? draftRange.endMs,
              draftRange.endMs,
            ),
          }
        : initialModel.contentRange;
      const draftDisplayRange = draftRange && adaptiveBlockQuery
        ? padShanghaiCalendarRange(displayContentRange ?? draftRange, 2)
        : draftRange;
      const displayFullRange = draftDisplayRange
        ? {
            startMs: Math.min(
              initialModel.fullRange?.startMs ?? initialModel.range.startMs,
              draftDisplayRange.startMs,
            ),
            endMs: Math.max(
              initialModel.fullRange?.endMs ?? initialModel.range.endMs,
              draftDisplayRange.endMs,
            ),
          }
        : initialModel.fullRange;
      const draftLogicalRange = draftRange && adaptiveBlockQuery && displayFullRange
        ? clampLogicalRangeToThreeYears(
            displayFullRange,
            (draftRange.startMs + draftRange.endMs) / 2,
          )
        : null;
      const displayRange = draftLogicalRange
        ? draftLogicalRange.range
        : draftDisplayRange
          ? {
              startMs: Math.min(initialModel.range.startMs, draftDisplayRange.startMs),
              endMs: Math.max(initialModel.range.endMs, draftDisplayRange.endMs),
            }
          : initialModel.range;
      return {
      ...initialModel,
      range: displayRange,
      contentRange: displayContentRange,
      fullRange: displayFullRange,
      rangeClipped: draftLogicalRange?.clipped ?? initialModel.rangeClipped,
      loadedRanges: cachedBlocks.map((block) => block.range),
      rows: resizeRowsForSegments(
        readOnly
          ? initialModel.rows.map((row) => ({ ...row, editable: false }))
          : initialModel.rows,
        cachedSegments,
      ),
      segments: cachedSegments
        .filter(
          (segment) =>
            segment.type !== "PLANNED" ||
            (segment.status !== "CONFIRMED" && segment.status !== "CANCELLED"),
        )
        .map((segment) =>
          readOnly
            ? {
                ...segment,
                permissions: {
                  canViewDetails: segment.visibility === "FULL",
                  canEdit: false,
                  canMove: false,
                  canResize: false,
                  canMerge: false,
                  canCancel: false,
                  canConfirm: false,
                  canSoftDelete: false,
                },
              }
            : segment,
        ),
    };
    },
    [adaptiveBlockQuery, cachedBlocks, cachedSegments, createDraft, initialModel, readOnly],
  );
  const initialSelection = useMemo<TimeCanvasSelection>(() => {
    if (!initialFocusId) return null;
    if (initialModel.segments.some((segment) => segment.id === initialFocusId)) {
      return { kind: "SEGMENT", id: initialFocusId };
    }
    if (initialModel.anchors.some((anchor) => anchor.id === initialFocusId)) {
      return { kind: "ANCHOR", id: initialFocusId };
    }
    return null;
  }, [initialFocusId, initialModel]);
  const [dismissedFocusId, setDismissedFocusId] = useState<string | null>(null);
  const effectiveInitialSelection = dismissedFocusId === initialFocusId
    ? null
    : initialSelection;
  const [selection, setSelection] = useState<TimeCanvasSelection>(
    effectiveInitialSelection,
  );
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(() =>
    initialFocusId && initialModel.segments.some(
      (segment) => segment.id === initialFocusId && segment.visibility === "FULL",
    )
      ? initialFocusId
      : null,
  );
  const [viewportRange, setViewportRange] = useState(
    initialModel.loadedRanges?.[0] ?? initialModel.range,
  );
  const [currentZoom, setCurrentZoom] = useState<TimeCanvasZoom>(
    initialZoom ?? "WEEK",
  );
  const externalInitialZoomRef = useRef(initialZoom);
  const [pendingPlannedRange, setPendingPlannedRange] =
    useState<PendingPlannedRange | null>(null);
  const [dialogDirty, setDialogDirty] = useState(false);
  const [detail, setDetail] = useState<WorkSegmentDetail | null>(null);
  const [detailRange, setDetailRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [changes, setChanges] = useState<SegmentChange[]>([]);
  const [changesCursor, setChangesCursor] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<
    "IDLE" | "LOADING" | "READY" | "ERROR"
  >(openSegmentId ? "LOADING" : "IDLE");
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  const [detailRetryToken, setDetailRetryToken] = useState(0);
  const [detailState, setDetailState] = useState<"IDLE" | "LOADING" | "READY" | "ERROR">("IDLE");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const cacheClockRef = useRef(1);
  const rowPageKeyRef = useRef(initialModel.rowPageKey);
  const viewportRangeRef = useRef(viewportRange);
  const selectionRef = useRef(selection);
  const openSegmentIdRef = useRef(openSegmentId);
  const handledConflictRef = useRef("");
  const capacityViewportSignatureRef = useRef("");
  const externalFocusRef = useRef(initialFocusId);
  const blockedExternalFocusRef = useRef<{ focusId: string | null } | null>(null);
  const activeModelRef = useRef(initialModel);
  const incomingModelRef = useRef(incomingModel);
  const dialogDirtyRef = useRef(dialogDirty);
  const adaptiveRefreshStateRef = useRef<"IDLE" | "DEFERRED" | "REFRESHING">("IDLE");
  const previousInitialFocusRef = useRef(initialFocusId);
  const centerNavigationTargetRef = useRef<number | null>(null);
  const viewportUrlTimerRef = useRef<number | null>(null);
  const staleRefreshFocusRef = useRef<string | null>(null);
  const handleViewportChange = useCallback((nextViewport: TimeCanvasRange) => {
    const navigationTarget = centerNavigationTargetRef.current;
    if (
      navigationTarget !== null &&
      nextViewport.startMs <= navigationTarget &&
      navigationTarget < nextViewport.endMs
    ) {
      centerNavigationTargetRef.current = null;
    }
    setViewportRange(nextViewport);
  }, []);
  const selectedCanvasSegment = useMemo(
    () =>
      openSegmentId
        ? model.segments.find((segment) => segment.id === openSegmentId) ?? null
        : null,
    [model.segments, openSegmentId],
  );
  const canCreateSegment = allowCreate && model.rows.some(
    (row) => row.kind !== "PLAN" && row.editable,
  );
  const quickCreatePersonId =
    model.rows.find(
      (row) =>
        row.kind === "PERSON" &&
        row.editable &&
        row.sourceId === defaultPersonId,
    )?.sourceId ??
    model.rows.find((row) => row.kind === "PERSON" && row.editable)?.sourceId ??
    defaultPersonId;
  const quickCreateRowId =
    model.rows.find(
      (row) =>
        row.kind === "PERSON" &&
        row.editable &&
        row.sourceId === quickCreatePersonId,
    )?.id ?? `person:${quickCreatePersonId}`;
  const lockedTaskId = !allowIndependent && defaultTaskId
    ? defaultTaskId
    : null;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (externalInitialZoomRef.current === initialZoom) return;
    externalInitialZoomRef.current = initialZoom;
    const timer = window.setTimeout(() => {
      setCurrentZoom(initialZoom ?? "WEEK");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialZoom]);
  useEffect(() => {
    if (!createDraft) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        isPending ||
        openSegmentId
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "[role='listbox'],[data-radix-popper-content-wrapper],[role='dialog']",
        )
      ) {
        return;
      }
      if (createDraftDirty && !window.confirm("创建内容尚未保存，确认放弃？")) {
        return;
      }
      event.preventDefault();
      setCreateDraft(null);
      setCreateDraftDirty(false);
      setNotice({ kind: "info", message: "已取消待创建投入。" });
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [createDraft, createDraftDirty, isPending, openSegmentId]);
  useEffect(() => {
    if (previousInitialFocusRef.current === initialFocusId) return;
    previousInitialFocusRef.current = initialFocusId;
    setDismissedFocusId(null);
  }, [initialFocusId]);
  useEffect(() => {
    incomingModelRef.current = incomingModel;
    dialogDirtyRef.current = dialogDirty;
    rowPageKeyRef.current = initialModel.rowPageKey;
    viewportRangeRef.current = viewportRange;
    selectionRef.current = selection;
    openSegmentIdRef.current = openSegmentId;
  }, [dialogDirty, incomingModel, initialModel.rowPageKey, openSegmentId, selection, viewportRange]);
  useEffect(() => {
    if (incomingModel === initialModel) return;
    if (dialogDirty) {
      const timer = window.setTimeout(() => {
        setNotice({
          kind: "error",
          message: "当前投入有未保存修改，请保存或关闭后再切换时间窗口。",
        });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setInitialModel(incomingModel), 0);
    return () => window.clearTimeout(timer);
  }, [dialogDirty, incomingModel, initialModel]);
  useEffect(() => {
    if (activeModelRef.current === initialModel) return;
    activeModelRef.current = initialModel;
    if (adaptiveRefreshStateRef.current === "REFRESHING") {
      adaptiveRefreshStateRef.current = "IDLE";
    }
    const nextBlocks = createInitialBlocks(initialModel);
    cachedBlocksRef.current = nextBlocks;
    inFlightBlockKeysRef.current.clear();
    handledConflictRef.current = "";
    capacityViewportSignatureRef.current = "";
    rowPageKeyRef.current = initialModel.rowPageKey;
    setCachedBlocks(nextBlocks);
    setFailedBlocks(createInitialFailedBlocks(initialModel));
    setViewportRange(initialModel.loadedRanges?.[0] ?? initialModel.range);
    const staleFocusedSegment = staleRefreshFocusRef.current
      ? initialModel.segments.find(
          (segment) =>
            segment.id === staleRefreshFocusRef.current &&
            segment.visibility === "FULL",
        ) ?? null
      : null;
    staleRefreshFocusRef.current = null;
    const nextSelection: TimeCanvasSelection = staleFocusedSegment
      ? { kind: "SEGMENT", id: staleFocusedSegment.id }
      : effectiveInitialSelection;
    setSelection(nextSelection);
    const focusedSegment = nextSelection?.kind === "SEGMENT"
      ? initialModel.segments.find(
          (segment) =>
            segment.id === nextSelection.id &&
            segment.visibility === "FULL",
        ) ?? null
      : null;
    setOpenSegmentId(focusedSegment?.id ?? null);
    setDialogDirty(false);
    setDetail(null);
    setDetailRange(null);
    setChanges([]);
    setChangesCursor(null);
    setHistoryState(focusedSegment ? "LOADING" : "IDLE");
    setHistoryLoadingMore(false);
    setHistoryError("");
    setDetailError("");
    setDetailState(focusedSegment ? "LOADING" : "IDLE");
  }, [effectiveInitialSelection, initialModel]);
  useEffect(() => {
    if (
      dialogDirty ||
      incomingModel !== initialModel ||
      adaptiveRefreshStateRef.current !== "DEFERRED"
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      adaptiveRefreshStateRef.current = "REFRESHING";
      router.refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dialogDirty, incomingModel, initialModel, router]);
  useEffect(() => {
    if (externalFocusRef.current === initialFocusId) return;
    if (incomingModel !== initialModel) return;
    if (dialogDirty) {
      if (blockedExternalFocusRef.current?.focusId === initialFocusId) return;
      blockedExternalFocusRef.current = { focusId: initialFocusId };
      const timer = window.setTimeout(() => {
        setNotice({
          kind: "error",
          message: "当前投入有未保存修改，请保存或关闭后再切换聚焦对象。",
        });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    blockedExternalFocusRef.current = null;
    const timer = window.setTimeout(() => {
      externalFocusRef.current = initialFocusId;
      setSelection(effectiveInitialSelection);
      const focusedSegment = effectiveInitialSelection?.kind === "SEGMENT"
        ? initialModel.segments.find(
            (segment) =>
              segment.id === effectiveInitialSelection.id &&
              segment.visibility === "FULL",
          ) ?? null
        : null;
      setOpenSegmentId(focusedSegment?.id ?? null);
      setDialogDirty(false);
      setDetail(null);
      setDetailRange(null);
      setChanges([]);
      setChangesCursor(null);
      setHistoryState(focusedSegment ? "LOADING" : "IDLE");
      setHistoryLoadingMore(false);
      setHistoryError("");
      setDetailError("");
      setDetailState(focusedSegment ? "LOADING" : "IDLE");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dialogDirty, effectiveInitialSelection, incomingModel, initialFocusId, initialModel]);
  useEffect(() => {
    const signature = cachedMerge.conflictBlockKeys.join("|");
    if (!signature) {
      handledConflictRef.current = "";
      return;
    }
    if (handledConflictRef.current === signature) return;
    if (incomingModel !== initialModel) return;
    if (dialogDirty) {
      const timer = window.setTimeout(() => {
        setNotice({
          kind: "error",
          message: "检测到时间对象版本冲突；请先保存或关闭当前未保存修改，再刷新画布。",
        });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    handledConflictRef.current = signature;
    const conflictKeys = new Set(cachedMerge.conflictBlockKeys);
    const conflictBlocks = cachedBlocksRef.current.filter((block) =>
      conflictKeys.has(block.key),
    );
    const remaining = cachedBlocksRef.current.filter((block) =>
      !conflictKeys.has(block.key),
    );
    cachedBlocksRef.current = remaining;
    setCachedBlocks(remaining);
    setFailedBlocks((current) => [
      ...current.filter((block) => !conflictKeys.has(block.key)),
      ...conflictBlocks.map((block) => ({
        key: block.key,
        range: block.range,
        requestRange: block.range,
        message: "时间对象版本内容冲突，已使相关数据块失效，请重试",
        kind: "CONFLICT" as const,
      })),
    ]);
    setNotice({
      kind: "error",
      message: "检测到时间对象版本内容冲突，正在刷新画布结构。",
    });
    router.refresh();
  }, [cachedMerge.conflictBlockKeys, dialogDirty, incomingModel, initialModel, router]);
  useEffect(() => {
    if (!persistViewportInUrl || centerNavigationTargetRef.current !== null) return;
    viewportUrlTimerRef.current = window.setTimeout(() => {
      viewportUrlTimerRef.current = null;
      if (centerNavigationTargetRef.current !== null) return;
      replaceViewportUrl({
        centerMs: (viewportRange.startMs + viewportRange.endMs) / 2,
        zoom: currentZoom,
      });
    }, 300);
    return () => {
      if (viewportUrlTimerRef.current === null) return;
      window.clearTimeout(viewportUrlTimerRef.current);
      viewportUrlTimerRef.current = null;
    };
  }, [currentZoom, persistViewportInUrl, viewportRange]);
  useEffect(() => {
    if (
      !adaptiveBlockQuery ||
      !initialModel.rowPageKey ||
      dialogDirty ||
      incomingModel !== initialModel ||
      adaptiveRefreshStateRef.current !== "IDLE"
    ) {
      return;
    }
    const requestedRowPageKey = initialModel.rowPageKey;
    const desiredRanges = mergeBlockRanges(
      blockRangesForViewport(initialModel.range, viewportRange),
      pendingPlannedRange
        ? blockRangesForViewport(initialModel.range, pendingPlannedRange.range)
        : [],
    );
    const desiredSignature = desiredRanges.map(blockKey).join("|");
    if (capacityViewportSignatureRef.current !== desiredSignature) {
      capacityViewportSignatureRef.current = desiredSignature;
      setFailedBlocks((current) => {
        const next = current.filter((block) => block.kind !== "CAPACITY");
        return next.length === current.length ? current : next;
      });
    }
    const range = desiredRanges.find((candidate) => {
      const key = blockKey(candidate);
      return !cachedBlocks.some((block) => block.key === key) &&
        !failedBlocks.some((block) => block.key === key) &&
        !inFlightBlockKeysRef.current.has(key);
    });
    if (!range) return;
    const key = blockKey(range);
    inFlightBlockKeysRef.current.add(key);
    const { preferredCenterMs, ...semanticInput } = adaptiveBlockQuery;
    void getAdaptiveTimeCanvasBlock({
      ...semanticInput,
      rowPageKey: requestedRowPageKey,
      preferredCenter: new Date(preferredCenterMs).toISOString(),
      blockStart: new Date(range.startMs).toISOString(),
      blockEnd: new Date(range.endMs).toISOString(),
    }).then((result) => {
        inFlightBlockKeysRef.current.delete(key);
        if (!mountedRef.current || rowPageKeyRef.current !== requestedRowPageKey) return;
        if (!result.ok) {
          if (result.error.code === "STATE_CONFLICT") {
            if (
              dialogDirtyRef.current ||
              incomingModelRef.current !== activeModelRef.current
            ) {
              adaptiveRefreshStateRef.current = "DEFERRED";
              setNotice({
                kind: "error",
                message: "时间画布结构已变化；请先保存或关闭当前未保存修改，随后将自动刷新。",
              });
            } else {
              adaptiveRefreshStateRef.current = "REFRESHING";
              router.refresh();
            }
            return;
          }
          setFailedBlocks((current) => [
            ...current.filter((block) => block.key !== key),
            {
              key,
              range,
              requestRange: range,
              message: result.error.message,
              kind: "LOAD",
            },
          ]);
          setNotice({ kind: "error", message: result.error.message });
          return;
        }
        if (result.data.rowPageKey !== requestedRowPageKey) {
          if (
            dialogDirtyRef.current ||
            incomingModelRef.current !== activeModelRef.current
          ) {
            adaptiveRefreshStateRef.current = "DEFERRED";
            setNotice({
              kind: "error",
              message: "时间画布结构已变化；请先保存或关闭当前未保存修改，随后将自动刷新。",
            });
          } else {
            adaptiveRefreshStateRef.current = "REFRESHING";
            router.refresh();
          }
          return;
        }
        const segments = timeCanvasSegmentsToModel(
          result.data.segments,
          result.data.groupBy,
          initialModel.rows,
        );
        const candidate: CachedBlock = {
          key,
          range,
          segments,
          touchedAt: cacheClockRef.current++,
          leafBlockCount: result.data.leafBlockCount,
        };
        const pinnedIds = [
          selectionRef.current?.id,
          openSegmentIdRef.current,
        ].filter((id): id is string => Boolean(id));
        const attemptedBlocks = [
            ...cachedBlocksRef.current.filter((block) => block.key !== key),
            candidate,
          ];
        const cacheResult = pruneTimeCanvasBlockCache({
          blocks: attemptedBlocks,
          viewport: viewportRangeRef.current,
          pinnedIds,
          candidateKey: key,
        });
        cachedBlocksRef.current = cacheResult.blocks;
        setCachedBlocks(cacheResult.blocks);
        const retainedKeys = new Set(cacheResult.blocks.map((block) => block.key));
        const desiredKeys = new Set(
          mergeBlockRanges(
            blockRangesForViewport(initialModel.range, viewportRangeRef.current),
            pendingPlannedRange
              ? blockRangesForViewport(initialModel.range, pendingPlannedRange.range)
              : [],
          ).map(blockKey),
        );
        const rejectedDesiredBlocks = attemptedBlocks.filter((block) =>
          desiredKeys.has(block.key) && !retainedKeys.has(block.key),
        );
        if (rejectedDesiredBlocks.length > 0) {
          const message = `缓存容量已达上限，当前数据块无法纳入 ${TIME_CANVAS_CACHE_OBJECT_LIMIT} 个对象 / ${TIME_CANVAS_CACHE_LEAF_BLOCK_LIMIT} 个叶数据块预算`;
          const rejectedKeys = new Set(
            rejectedDesiredBlocks.map((block) => block.key),
          );
          setFailedBlocks((current) => [
            ...current.filter((block) => !rejectedKeys.has(block.key)),
            ...rejectedDesiredBlocks.map((block) => ({
              key: block.key,
              range: block.range,
              requestRange: block.range,
              message,
              kind: "CAPACITY" as const,
            })),
          ]);
          setNotice({ kind: "error", message });
        } else {
          const failedRanges = result.data.failedRanges.map((failedRange) => ({
            key: failedRangeKey(range, failedRange),
            range: failedRange,
            requestRange: range,
            message: failedRange.message,
            kind: "LOAD" as const,
          }));
          setFailedBlocks((current) => [
            ...current.filter(
              (block) => blockKey(block.requestRange) !== key,
            ),
            ...failedRanges,
          ]);
          if (failedRanges.length > 0) {
            setNotice({
              kind: "error",
              message: "部分日期的数据密度超过上限，其他时间范围仍可浏览。",
            });
          }
        }
    }).catch(() => {
      inFlightBlockKeysRef.current.delete(key);
      if (mountedRef.current && rowPageKeyRef.current === requestedRowPageKey) {
        const message = "时间数据块加载失败，请重试";
        setFailedBlocks((current) => [
          ...current.filter((block) => block.key !== key),
          { key, range, requestRange: range, message, kind: "LOAD" },
        ]);
        setNotice({ kind: "error", message });
      }
    });
  }, [
    adaptiveBlockQuery,
    cachedBlocks,
    dialogDirty,
    failedBlocks,
    incomingModel,
    initialModel,
    initialModel.range,
    initialModel.rowPageKey,
    initialModel.rows,
    openSegmentId,
    pendingPlannedRange,
    router,
    selection,
    viewportRange,
  ]);
  useEffect(() => {
    if (!pendingPlannedRange) return;
    if (initialModel.rowPageKey === pendingPlannedRange.previousRowPageKey) return;
    const targetStart = Math.max(
      initialModel.range.startMs,
      pendingPlannedRange.range.startMs,
    );
    const targetEnd = Math.min(
      initialModel.range.endMs,
      pendingPlannedRange.range.endMs,
    );
    const target = targetEnd > targetStart
      ? { startMs: targetStart, endMs: targetEnd }
      : null;
    const targetLoaded = target
      ? cachedBlocks.some(
        (block) => block.range.startMs < target.endMs && block.range.endMs > target.startMs,
      )
      : true;
    if (!targetLoaded) return;
    const timer = window.setTimeout(() => setPendingPlannedRange(null), 0);
    return () => window.clearTimeout(timer);
  }, [
    cachedBlocks,
    initialModel.range,
    initialModel.rowPageKey,
    pendingPlannedRange,
  ]);
  useEffect(() => {
    let active = true;
    if (
      !openSegmentId ||
      !selectedCanvasSegment ||
      selectedCanvasSegment.visibility !== "FULL"
    ) {
      return () => {
        active = false;
      };
    }
    void getWorkSegment({ segmentId: openSegmentId })
      .then((detailResult) => {
        if (!active) return;
        if (!detailResult.ok) {
          setDetail(null);
          setDetailError(detailResult.error.message);
          setDetailState("ERROR");
          return;
        }
        const detailData = detailResult.data;
        setDetail(detailData);
        setDetailRange({
          startMs: Date.parse(detailData.startAt),
          endMs: Date.parse(detailData.endAt),
        });
        setDetailState("READY");
      })
      .catch(() => {
        if (!active) return;
        setDetail(null);
        setDetailError("网络异常，请稍后重试。");
        setDetailState("ERROR");
      });
    return () => {
      active = false;
    };
  }, [detailRetryToken, openSegmentId, selectedCanvasSegment]);
  useEffect(() => {
    let active = true;
    if (
      !openSegmentId ||
      !selectedCanvasSegment ||
      selectedCanvasSegment.visibility !== "FULL"
    ) {
      return () => {
        active = false;
      };
    }
    void listWorkSegmentChanges({ segmentId: openSegmentId, limit: 20 })
      .then((historyResult) => {
        if (!active) return;
        if (!historyResult.ok) {
          setChanges([]);
          setChangesCursor(null);
          setHistoryState("ERROR");
          setHistoryError(historyResult.error.message);
          return;
        }
        setChanges(historyResult.data.items);
        setChangesCursor(historyResult.data.nextCursor);
        setHistoryState("READY");
        setHistoryError("");
      })
      .catch(() => {
        if (!active) return;
        setChanges([]);
        setChangesCursor(null);
        setHistoryState("ERROR");
        setHistoryError("网络异常，请稍后重试。");
      });
    return () => {
      active = false;
    };
  }, [historyRetryToken, openSegmentId, selectedCanvasSegment]);
  const runMutation = (
      action: () => Promise<ProjectManagementActionResult<unknown>>,
      successMessage: string,
      rollback?: () => void,
      onSuccess?: () => void,
    ) => {
      setNotice({ kind: "info", message: "正在保存…" });
      startTransition(async () => {
        let result: ProjectManagementActionResult<unknown>;
        try {
          result = await action();
        } catch {
          rollback?.();
          setNotice({
            kind: "error",
            message: rollback
              ? "网络异常，未能保存；已恢复原状态。"
              : "网络异常，未能保存；输入仍保留，可直接重试。",
          });
          return;
        }
        if (!result.ok) {
          rollback?.();
          const stale = result.error.code === "STALE_SEGMENT";
          setNotice({
            kind: "error",
            message: stale
              ? `${result.error.message}，正在读取服务器最新版本。`
              : result.error.message,
          });
          if (stale) {
            setDialogDirty(false);
            setDetail(null);
            setDetailRange(null);
            setDetailError("");
            setDetailState("LOADING");
            setChanges([]);
            setChangesCursor(null);
            setHistoryState("LOADING");
            setHistoryLoadingMore(false);
            setHistoryError("");
            setDetailRetryToken((current) => current + 1);
            setHistoryRetryToken((current) => current + 1);
            staleRefreshFocusRef.current = openSegmentId;
            router.refresh();
          }
          return;
        }
        const plannedRange = plannedRangeFromMutation(result.data);
        if (plannedRange) {
          setPendingPlannedRange({
            range: plannedRange,
            previousRowPageKey: initialModel.rowPageKey,
          });
        }
        setNotice({ kind: "success", message: successMessage });
        const completedSegmentId = openSegmentId;
        if (completedSegmentId) {
          setDismissedFocusId(initialFocusId ?? completedSegmentId);
          setOpenSegmentId(null);
          setDialogDirty(false);
          setSelection(null);
        }
        onSuccess?.();
        if (persistViewportInUrl) {
          replaceViewportUrl({
            centerMs:
              (viewportRangeRef.current.startMs + viewportRangeRef.current.endMs) / 2,
            zoom: currentZoom,
          });
        }
        const url = new URL(window.location.href);
        const hadUrlFocus =
          url.searchParams.has("focus") ||
          url.searchParams.has("focusSegmentIds");
        if (completedSegmentId) {
          url.searchParams.delete("focus");
          url.searchParams.delete("focusSegmentIds");
        }
        if (persistViewportInUrl || hadUrlFocus) {
          router.replace(`${url.pathname}?${url.searchParams.toString()}`, {
            scroll: false,
          });
        } else {
          router.refresh();
        }
      });
  };

  function loadMoreChanges() {
    if (!openSegmentId || !changesCursor || isPending || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    setHistoryError("");
    startTransition(async () => {
      try {
        const result = await listWorkSegmentChanges({
          segmentId: openSegmentId,
          cursor: changesCursor,
          limit: 20,
        });
        if (!result.ok) {
          setHistoryState("ERROR");
          setHistoryError(result.error.message);
          return;
        }
        setChanges((current) => {
          const seen = new Set(current.map((change) => change.key));
          return [...current, ...result.data.items.filter((change) => !seen.has(change.key))];
        });
        setChangesCursor(result.data.nextCursor);
        setHistoryState("READY");
      } catch {
        setHistoryState("ERROR");
        setHistoryError("网络异常，请稍后重试。");
      } finally {
        setHistoryLoadingMore(false);
      }
    });
  }

  function handleBrush(request: TimeCanvasBrushRequest) {
    if (isPending) return;
    if (request.rowKind !== "PERSON") {
      setNotice({ kind: "error", message: "按 Task 分组时请使用精确表单选择人员。" });
      return;
    }
    setCreateDraft({
      rowId: request.rowId,
      personId: request.sourceId,
      startMs: request.startMs,
      endMs: request.endMs,
    });
    setCreateDraftDirty(false);
    setNotice({ kind: "info", message: "已选择时间区间，请补全投入内容。" });
  }

  function cancelCreateDraft() {
    if (createDraftDirty && !window.confirm("创建内容尚未保存，确认放弃？")) return;
    setCreateDraft(null);
    setCreateDraftDirty(false);
    setNotice({ kind: "info", message: "已取消待创建投入。" });
  }

  function updateCreateDraft(next: CreateDraft) {
    if (next.endMs <= next.startMs || !Number.isFinite(next.startMs + next.endMs)) {
      setNotice({ kind: "error", message: "结束时间必须晚于开始时间。" });
      return false;
    }
    if (next.endMs - next.startMs > 31 * DAY_MS) {
      setNotice({ kind: "error", message: "单条投入最长 31 天，请缩短待创建区间。" });
      return false;
    }
    if (!adaptiveBlockQuery) {
      const explicitRange = explicitRangeForDraft(initialModel.range, next);
      if (explicitRange.endMs - explicitRange.startMs > 366 * DAY_MS) {
        setNotice({
          kind: "error",
          message: "待创建区间会使人员计划超过 366 天，请先缩小或调整资源时间范围。",
        });
        return false;
      }
      const url = new URL(window.location.href);
      url.searchParams.set("from", formatShanghaiDate(explicitRange.startMs));
      url.searchParams.set("to", formatShanghaiDate(explicitRange.endMs));
      url.searchParams.delete("cursor");
      url.searchParams.delete("focus");
      router.replace(`${url.pathname}?${url.searchParams.toString()}`, {
        scroll: false,
      });
    }
    setCreateDraft(next);
    setCreateDraftDirty(true);
    return true;
  }

  function requestContentCenter(candidateMs: number) {
    if (dialogDirty) {
      setNotice({
        kind: "error",
        message: "当前投入有未保存修改，请保存或关闭后再切换时间窗口。",
      });
      return;
    }
    const fullRange = initialModel.fullRange;
    if (!adaptiveBlockQuery || !fullRange || fullRange.endMs <= fullRange.startMs) return;
    const centerMs = Math.max(
      fullRange.startMs,
      Math.min(candidateMs, fullRange.endMs - 1),
    );
    const url = new URL(window.location.href);
    url.searchParams.set("center", new Date(centerMs).toISOString());
    if (currentZoom) url.searchParams.set("scale", currentZoom.toLowerCase());
    url.searchParams.delete("focus");
    url.searchParams.delete("timelineDate");
    url.searchParams.delete("timelineFocus");
    url.searchParams.delete("date");
    url.searchParams.delete("mode");
    url.searchParams.delete("zoom");
    centerNavigationTargetRef.current = centerMs;
    if (viewportUrlTimerRef.current !== null) {
      window.clearTimeout(viewportUrlTimerRef.current);
      viewportUrlTimerRef.current = null;
    }
    setNotice({ kind: "info", message: "正在定位新的时间窗口…" });
    startTransition(() => {
      router.replace(`${url.pathname}?${url.searchParams.toString()}`, { scroll: false });
    });
  }

  function closeSegmentDialog() {
    const dismissedId = initialFocusId ?? openSegmentId;
    if (dismissedId) setDismissedFocusId(dismissedId);
    setOpenSegmentId(null);
    setDialogDirty(false);
    setSelection(null);

    const url = new URL(window.location.href);
    const hadUrlFocus =
      url.searchParams.has("focus") ||
      url.searchParams.has("focusSegmentIds");
    url.searchParams.delete("focus");
    url.searchParams.delete("focusSegmentIds");
    if (!hadUrlFocus) return;
    startTransition(() => {
      router.replace(`${url.pathname}?${url.searchParams.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="space-y-4" data-testid="resource-planner-workbench">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        {canCreateSegment && (
          <Button
            type="button"
            size="sm"
            disabled={isPending || Boolean(createDraft)}
            onClick={() => {
              setCreateDraftDirty(false);
              setCreateDraft((() => {
                const center = (viewportRange.startMs + viewportRange.endMs) / 2;
                const duration = 60 * 60 * 1_000;
                const snappedCenter = Math.floor(center / (30 * 60 * 1_000)) *
                  30 * 60 * 1_000;
                const startMs = Math.max(
                  model.range.startMs,
                  Math.min(snappedCenter, model.range.endMs - duration),
                );
                return {
                rowId: quickCreateRowId,
                personId: quickCreatePersonId,
                startMs,
                endMs: startMs + duration,
                };
              })());
            }}
          >
            新增投入
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          双击投入打开详情；总览不会直接修改既有投入。
        </span>
      </div>

      {initialModel.rangeClipped && initialModel.fullRange && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <span className="min-w-0 flex-1">
            可导航时间范围超过三个上海日历年，当前显示一个三年窗口。
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => requestContentCenter(
              initialModel.contentRange?.startMs ?? initialModel.fullRange!.startMs,
            )}
          >
            最早内容
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => requestContentCenter(
              (initialModel.contentRange?.endMs ?? initialModel.fullRange!.endMs) - 1,
            )}
          >
            最新内容
          </Button>
        </div>
      )}

      {failedBlocks.map((block) => (
        <div
          key={block.key}
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">
            {formatRange(block.range.startMs, block.range.endMs)}：{block.message}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const requestKey = blockKey(block.requestRange);
              const remaining = cachedBlocksRef.current.filter(
                (item) => item.key !== requestKey,
              );
              cachedBlocksRef.current = remaining;
              setCachedBlocks(remaining);
              setFailedBlocks((current) => current.filter(
                (item) => blockKey(item.requestRange) !== requestKey,
              ));
              setNotice({ kind: "info", message: "正在重试时间数据块…" });
            }}
          >
            <RefreshCw aria-hidden="true" />
            重试
          </Button>
        </div>
      ))}

      {notice && (
        <p
          className={cn(
            "break-words rounded-lg px-3 py-2 text-sm",
            notice.kind === "error" && "bg-destructive/10 text-destructive",
            notice.kind === "success" && "bg-emerald-50 text-emerald-800",
            notice.kind === "info" && "bg-muted text-muted-foreground",
          )}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}

      <div className="min-w-0">
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
          <TimeCanvas
            mode={mode}
            model={model}
            initialZoom={currentZoom}
            initialCenterMs={initialCenterMs}
            initialSelection={effectiveInitialSelection}
            display={{ showActual: true, showBusy: true, showInspector: false }}
            interaction={{
              enableBrushCreate: !isPending && !createDraft && canCreateSegment,
              creationRange: createDraft
                ? {
                    rowId: createDraft.rowId,
                    rowKind: "PERSON",
                    sourceId: createDraft.personId,
                    startMs: createDraft.startMs,
                    endMs: createDraft.endMs,
                  }
                : null,
              onBrushCreate: handleBrush,
              onCreationRangeTransform: (request) => {
                const targetRow = model.rows.find(
                  (row) =>
                    row.id === request.targetRowId &&
                    row.kind === "PERSON" &&
                    row.editable,
                );
                if (!createDraft || !targetRow) {
                  setNotice({
                    kind: "error",
                    message: "待创建投入只能移动到当前已加载且可编辑的人员行。",
                  });
                  return;
                }
                updateCreateDraft({
                  rowId: targetRow.id,
                  personId: targetRow.sourceId,
                  startMs: request.startMs,
                  endMs: request.endMs,
                });
              },
              onSegmentOpen: (segmentId) => {
                if (createDraft) {
                  setNotice({ kind: "info", message: "请先完成或取消当前投入创建。" });
                  return;
                }
                const segment = model.segments.find((item) => item.id === segmentId);
                if (!segment || segment.visibility !== "FULL") return;
                setDismissedFocusId(null);
                setSelection({ kind: "SEGMENT", id: segmentId });
                setOpenSegmentId(segmentId);
                setDialogDirty(false);
                setDetail(null);
                setDetailRange(null);
                setChanges([]);
                setChangesCursor(null);
                setHistoryState("LOADING");
                setHistoryLoadingMore(false);
                setHistoryError("");
                setDetailError("");
                setDetailState("LOADING");
              },
              onInvalidDrop: (message) => setNotice({ kind: "error", message }),
            }}
            selection={selection}
            onSelectionChange={setSelection}
            onViewportChange={handleViewportChange}
            onZoomChange={(nextZoom) => {
              setCurrentZoom(nextZoom);
              if (!persistViewportInUrl) return;
              const pendingCenter = centerNavigationTargetRef.current;
              replaceViewportUrl({
                centerMs: pendingCenter ??
                  (viewportRangeRef.current.startMs + viewportRangeRef.current.endMs) / 2,
                zoom: nextZoom,
              });
              if (pendingCenter !== null) {
                const url = new URL(window.location.href);
                startTransition(() => {
                  router.replace(`${url.pathname}?${url.searchParams.toString()}`, {
                    scroll: false,
                  });
                });
              }
            }}
            navigationRange={model.fullRange}
            onRequestCenter={adaptiveBlockQuery ? requestContentCenter : undefined}
            emptyMessage="当前筛选和时间范围内没有可见安排。"
          />
        </div>
      </div>

      <Dialog
        open={Boolean(openSegmentId)}
        onOpenChange={(open) => {
          if (open || isPending) return;
          if (dialogDirty && !window.confirm("有未保存修改，确认放弃并关闭？")) return;
          closeSegmentDialog();
        }}
      >
        <DialogContent className="max-h-[94dvh] overflow-y-auto sm:max-w-[min(96vw,88rem)]">
          <DialogHeader>
            <DialogTitle>投入详情</DialogTitle>
            <DialogDescription>
              复用打开前的完整时间线上下文；仅当前打开的投入可修改，其他对象只读。
            </DialogDescription>
          </DialogHeader>
          <SegmentInspector
            key={`${selectedCanvasSegment?.id ?? "none"}:${detail?.updatedAt ?? detailState}`}
            canvasSegment={selectedCanvasSegment}
            model={model}
            initialZoom={currentZoom}
            initialCenterMs={(viewportRange.startMs + viewportRange.endMs) / 2}
            detail={detail}
            detailRange={detailRange}
            detailState={detailState}
            detailError={detailError}
            changes={changes}
            historyState={historyState}
            historyLoadingMore={historyLoadingMore}
            historyError={historyError}
            hasMoreChanges={Boolean(changesCursor)}
            disabled={isPending}
            onRun={runMutation}
            onRetryDetail={() => {
              setDetailError("");
              setDetailState("LOADING");
              setDetailRetryToken((current) => current + 1);
            }}
            onLoadMoreChanges={loadMoreChanges}
            onRetryHistory={() => {
              if (changes.length > 0 && changesCursor) {
                loadMoreChanges();
                return;
              }
              setHistoryState("LOADING");
              setHistoryError("");
              setHistoryRetryToken((current) => current + 1);
            }}
            onDirtyChange={setDialogDirty}
            onRangeChange={(range) => {
              setDetailRange(range);
              setDialogDirty(true);
            }}
          />
        </DialogContent>
      </Dialog>

      {createDraft && (
        <QuickCreatePanel
          draft={createDraft}
          peopleOptions={peopleOptions}
          peopleScope={peopleScope}
          taskOptions={taskOptions}
          defaultTaskId={defaultTaskId}
          defaultTaskTitle={defaultTaskTitle}
          lockedTaskId={lockedTaskId}
          allowIndependent={allowIndependent}
          disabled={isPending}
          onCancel={cancelCreateDraft}
          onDirtyChange={() => setCreateDraftDirty(true)}
          onPersonChange={(personId) => {
            const targetRow = model.rows.find(
              (row) =>
                row.kind === "PERSON" &&
                row.editable &&
                row.sourceId === personId,
            );
            if (!targetRow) {
              setNotice({
                kind: "error",
                message: "该人员不在当前已加载的可编辑行中，请先调整筛选或分页。",
              });
              return;
            }
            updateCreateDraft({
              ...createDraft,
              rowId: targetRow.id,
              personId: targetRow.sourceId,
            });
          }}
          onRangeChange={(startMs, endMs) =>
            updateCreateDraft({ ...createDraft, startMs, endMs })
          }
          onRun={(action) => {
            runMutation(action, "已创建投入记录", undefined, () => {
              setCreateDraft(null);
              setCreateDraftDirty(false);
            });
          }}
        />
      )}
    </div>
  );
}

function createInitialBlocks(model: TimeCanvasModel): CachedBlock[] {
  const ranges = model.loadedRanges?.length
    ? model.loadedRanges
    : [model.range];
  return ranges.map((range, index) => ({
    key: blockKey(range),
    range,
    segments: model.segments.filter(
      (segment) => segment.startMs < range.endMs && segment.endMs > range.startMs,
    ),
    touchedAt: index,
    leafBlockCount: model.loadedLeafBlockCounts?.[index] ?? 1,
  }));
}

function createInitialFailedBlocks(model: TimeCanvasModel): FailedBlock[] {
  return (model.failedRanges ?? []).map((failedRange) => {
    const requestRange = model.loadedRanges?.find(
      (range) =>
        failedRange.startMs >= range.startMs && failedRange.endMs <= range.endMs,
    ) ?? failedRange;
    return {
      key: failedRangeKey(requestRange, failedRange),
      range: failedRange,
      requestRange,
      message: failedRange.message,
      kind: "LOAD",
    };
  });
}

function failedRangeKey(
  requestRange: { startMs: number; endMs: number },
  failedRange: { startMs: number; endMs: number },
) {
  return `${blockKey(requestRange)}:failed:${blockKey(failedRange)}`;
}

function blockRangesForViewport(
  logicalRange: { startMs: number; endMs: number },
  viewport: { startMs: number; endMs: number },
) {
  const blockMs = 180 * DAY_MS;
  const firstVisibleIndex = Math.max(
    0,
    Math.floor((Math.max(logicalRange.startMs, viewport.startMs) - logicalRange.startMs) / blockMs),
  );
  const lastVisibleIndex = Math.max(
    firstVisibleIndex,
    Math.floor(
      (Math.min(logicalRange.endMs, viewport.endMs) - 1 - logicalRange.startMs) /
        blockMs,
    ),
  );
  const maximumIndex = Math.max(
    0,
    Math.ceil((logicalRange.endMs - logicalRange.startMs) / blockMs) - 1,
  );
  const ranges = [];
  for (
    let index = Math.max(0, firstVisibleIndex - 1);
    index <= Math.min(maximumIndex, lastVisibleIndex + 1);
    index += 1
  ) {
    const startMs = logicalRange.startMs + index * blockMs;
    ranges.push({
      startMs,
      endMs: Math.min(logicalRange.endMs, startMs + blockMs),
    });
  }
  const viewportCenter = (viewport.startMs + viewport.endMs) / 2;
  return ranges.sort((left, right) => {
    const leftVisible = left.startMs < viewport.endMs && left.endMs > viewport.startMs;
    const rightVisible = right.startMs < viewport.endMs && right.endMs > viewport.startMs;
    if (leftVisible !== rightVisible) return leftVisible ? -1 : 1;
    const leftCenter = (left.startMs + left.endMs) / 2;
    const rightCenter = (right.startMs + right.endMs) / 2;
    return Math.abs(leftCenter - viewportCenter) - Math.abs(rightCenter - viewportCenter) ||
      left.startMs - right.startMs;
  });
}

function blockKey(range: { startMs: number; endMs: number }) {
  return `${range.startMs}:${range.endMs}`;
}

function mergeBlockRanges(
  primary: TimeCanvasRange[],
  additional: TimeCanvasRange[],
) {
  const ranges = new Map<string, TimeCanvasRange>();
  for (const range of [...primary, ...additional]) {
    ranges.set(blockKey(range), range);
  }
  return [...ranges.values()];
}

function plannedRangeFromMutation(data: unknown): TimeCanvasRange | null {
  if (!data || typeof data !== "object" || !("segment" in data)) return null;
  const segment = data.segment;
  if (!segment || typeof segment !== "object") return null;
  const record = segment as Record<string, unknown>;
  if (
    record.type !== "PLANNED" ||
    record.status === "CONFIRMED" ||
    record.status === "CANCELLED" ||
    typeof record.startAt !== "string" ||
    typeof record.endAt !== "string"
  ) {
    return null;
  }
  const startMs = Date.parse(record.startAt);
  const endMs = Date.parse(record.endAt);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? { startMs, endMs }
    : null;
}

function replaceViewportUrl({
  centerMs,
  zoom,
}: {
  centerMs?: number;
  zoom: TimeCanvasZoom;
}) {
  const url = new URL(window.location.href);
  if (typeof centerMs === "number" && Number.isFinite(centerMs)) {
    url.searchParams.set("center", new Date(centerMs).toISOString());
  }
  url.searchParams.set("scale", zoom.toLowerCase());
  url.searchParams.delete("date");
  url.searchParams.delete("mode");
  url.searchParams.delete("zoom");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}?${url.searchParams.toString()}`,
  );
  window.dispatchEvent(new Event(TIME_CANVAS_VIEWPORT_STATE_EVENT));
}

function resizeRowsForSegments(
  rows: TimeCanvasModel["rows"],
  segments: TimeCanvasModel["segments"],
) {
  return rows.map((row) => {
    if (row.kind === "PLAN") return row;
    const layout = layoutIntervalLanes(
      segments
        .filter((segment) => segment.rowId === row.id)
        .map((segment) => ({
          id: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
        })),
    );
    return { ...row, height: rowHeightForLaneCount(layout.laneCount) };
  });
}

function QuickCreatePanel({
  draft,
  peopleOptions,
  peopleScope,
  taskOptions,
  defaultTaskId,
  defaultTaskTitle,
  lockedTaskId,
  allowIndependent,
  disabled,
  onCancel,
  onDirtyChange,
  onPersonChange,
  onRangeChange,
  onRun,
}: {
  draft: CreateDraft;
  peopleOptions: PersonOptionDto[];
  peopleScope: UserPickerScope;
  taskOptions: TaskOption[];
  defaultTaskId: string;
  defaultTaskTitle: string;
  lockedTaskId: string | null;
  allowIndependent: boolean;
  disabled: boolean;
  onCancel: () => void;
  onDirtyChange: () => void;
  onPersonChange: (personId: string) => void;
  onRangeChange: (startMs: number, endMs: number) => boolean;
  onRun: (action: () => Promise<ProjectManagementActionResult<unknown>>) => void;
}) {
  const [taskId, setTaskId] = useState<string | null>(defaultTaskId || null);
  const [rangeInputs, setRangeInputs] = useState<{
    baseStartMs: number;
    baseEndMs: number;
    startValue: string;
    endValue: string;
  } | null>(null);
  const lockedTask = lockedTaskId
    ? taskOptions.find((option) => option.id === lockedTaskId) ?? null
    : null;
  const activeRangeInputs = rangeInputs?.baseStartMs === draft.startMs &&
      rangeInputs.baseEndMs === draft.endMs
    ? rangeInputs
    : null;
  const startValue = activeRangeInputs?.startValue ?? toLocal(draft.startMs);
  const endValue = activeRangeInputs?.endValue ?? toLocal(draft.endMs);
  const pendingRange = validateSegmentRangeInputs(startValue, endValue);
  const rangeError = activeRangeInputs && !pendingRange.ok
    ? pendingRange.message
    : "";

  function updateRangeInputs(nextStartValue: string, nextEndValue: string) {
    const range = validateSegmentRangeInputs(nextStartValue, nextEndValue);
    if (!range.ok) {
      setRangeInputs({
        baseStartMs: draft.startMs,
        baseEndMs: draft.endMs,
        startValue: nextStartValue,
        endValue: nextEndValue,
      });
      return;
    }
    if (!onRangeChange(range.startMs, range.endMs)) {
      setRangeInputs(null);
      return;
    }
    setRangeInputs(null);
  }

  return (
    <form
      className="grid gap-3 rounded-xl border border-primary/30 bg-card p-4 md:grid-cols-2 xl:grid-cols-4"
      aria-label="投入快速创建"
      onChange={onDirtyChange}
      onSubmit={(event) => {
        event.preventDefault();
        const range = validateSegmentRangeInputs(startValue, endValue);
        if (!range.ok) {
          setRangeInputs({
            baseStartMs: draft.startMs,
            baseEndMs: draft.endMs,
            startValue,
            endValue,
          });
          return;
        }
        const form = new FormData(event.currentTarget);
        const submittedTaskId = String(form.get("taskId") ?? "") || null;
        const type = String(form.get("type")) === "ACTUAL" ? "ACTUAL" : "PLANNED";
        const base = {
          personId: String(form.get("personId") ?? draft.personId),
          startAt: new Date(range.startMs).toISOString(),
          endAt: new Date(range.endMs).toISOString(),
          content: String(form.get("content") ?? ""),
          priority: String(form.get("priority") ?? "MEDIUM"),
          expectedOutput: String(form.get("expectedOutput") ?? ""),
          taskId: submittedTaskId,
          tagIds: [],
        };
        onRun(() =>
          type === "ACTUAL"
            ? createActualSegment({ ...base, sources: [] })
            : createWorkSegment({ ...base, type: "PLANNED" }),
        );
      }}
    >
      <div className="md:col-span-2 xl:col-span-4">
        <h2 className="font-semibold">投入快速创建</h2>
        <p className="text-sm text-muted-foreground">拖选或精确填写时间；最终规则由服务端校验。</p>
      </div>
      <Field label="类型" htmlFor="quick-type">
        <select id="quick-type" name="type" className={selectClass} defaultValue="PLANNED">
          <option value="PLANNED">Planned</option>
          <option value="ACTUAL">Actual</option>
        </select>
      </Field>
      <Field label="人员" htmlFor="quick-person">
        <UserSelect
          inputId="quick-person"
          ariaLabel="人员"
          scope={peopleScope}
          name="personId"
          value={draft.personId}
          onValueChange={(value) => {
            if (!value) return;
            onDirtyChange();
            onPersonChange(value);
          }}
          initialOptions={peopleOptions}
          required
          clearable={false}
          disabled={disabled}
          placeholder="按姓名或拼音首字母搜索"
        />
      </Field>
      <Field label="开始" htmlFor="quick-start">
        <Input
          id="quick-start"
          name="startAt"
          type="datetime-local"
          value={startValue}
          aria-invalid={Boolean(rangeError)}
          aria-describedby={rangeError ? "quick-range-error" : undefined}
          onChange={(event) => {
            updateRangeInputs(event.target.value, endValue);
          }}
          required
        />
      </Field>
      <Field label="结束" htmlFor="quick-end">
        <Input
          id="quick-end"
          name="endAt"
          type="datetime-local"
          value={endValue}
          aria-invalid={Boolean(rangeError)}
          aria-describedby={rangeError ? "quick-range-error" : undefined}
          onChange={(event) => {
            updateRangeInputs(startValue, event.target.value);
          }}
          required
        />
      </Field>
      {rangeError && (
        <p id="quick-range-error" className="text-sm text-destructive md:col-span-2 xl:col-span-4" role="alert">
          {rangeError}
        </p>
      )}
      <Field label="内容" htmlFor="quick-content" className="md:col-span-2">
        <Input id="quick-content" name="content" defaultValue="计划投入" required maxLength={2_000} />
      </Field>
      <Field label="Task" htmlFor="quick-task">
        {lockedTaskId ? (
          <>
            <Input
              id="quick-task"
              value={(lockedTask?.title ?? defaultTaskTitle) || "当前 Task"}
              readOnly
              aria-readonly="true"
            />
            <input type="hidden" name="taskId" value={lockedTaskId} />
          </>
        ) : (
          <TaskSelect
            inputId="quick-task"
            ariaLabel="Task"
            name="taskId"
            value={taskId}
            onValueChange={(value) => {
              setTaskId(value);
              onDirtyChange();
            }}
            initialOptions={taskOptions}
            statuses={["ACTIVE"]}
            allowIndependent={allowIndependent}
            required={!allowIndependent}
            clearable={allowIndependent}
            disabled={disabled}
            placeholder="按标题、描述或拼音首字母搜索"
          />
        )}
      </Field>
      <Field label="优先级" htmlFor="quick-priority">
        <select id="quick-priority" name="priority" className={selectClass} defaultValue="MEDIUM">
          {Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <Field label="预期输出" htmlFor="quick-expected" className="md:col-span-2 xl:col-span-4">
        <Textarea
          id="quick-expected"
          name="expectedOutput"
          maxLength={2_000}
          placeholder="填写本次投入预期形成的结果"
        />
      </Field>
      <div className="flex gap-2 md:col-span-2 xl:col-span-4">
        <Button type="submit" disabled={disabled}>创建</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>取消</Button>
      </div>
    </form>
  );
}

function SegmentInspector({
  canvasSegment,
  model,
  initialZoom,
  initialCenterMs,
  detail,
  detailRange,
  detailState,
  detailError,
  changes,
  historyState,
  historyLoadingMore,
  historyError,
  hasMoreChanges,
  disabled,
  onRun,
  onRetryDetail,
  onLoadMoreChanges,
  onRetryHistory,
  onDirtyChange,
  onRangeChange,
}: {
  canvasSegment: TimeCanvasModel["segments"][number] | null;
  model: TimeCanvasModel;
  initialZoom?: TimeCanvasZoom;
  initialCenterMs: number;
  detail: WorkSegmentDetail | null;
  detailRange: { startMs: number; endMs: number } | null;
  detailState: "IDLE" | "LOADING" | "READY" | "ERROR";
  detailError: string;
  changes: SegmentChange[];
  historyState: "IDLE" | "LOADING" | "READY" | "ERROR";
  historyLoadingMore: boolean;
  historyError: string;
  hasMoreChanges: boolean;
  disabled: boolean;
  onRun: (
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
    rollback?: () => void,
  ) => void;
  onRetryDetail: () => void;
  onLoadMoreChanges: () => void;
  onRetryHistory: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onRangeChange: (range: { startMs: number; endMs: number }) => void;
}) {
  if (!canvasSegment) {
    return <aside className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">选择画布中的投入查看 Inspector。</aside>;
  }
  if (canvasSegment.type === "BUSY") {
    return (
      <aside className="rounded-xl border border-border bg-card p-5" data-testid="segment-inspector">
        <h2 className="font-semibold">其他占用</h2>
        <p className="mt-2 text-sm text-muted-foreground">详情受限，仅显示占用时间。</p>
        <p className="mt-3 text-sm">{formatRange(canvasSegment.startMs, canvasSegment.endMs)}</p>
      </aside>
    );
  }
  if (detailState === "ERROR") {
    return (
      <aside className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive" role="alert">
        <p>投入详情加载失败：{detailError}</p>
        <Button className="mt-3" type="button" size="sm" variant="outline" disabled={disabled} onClick={onRetryDetail}>
          重试详情
        </Button>
      </aside>
    );
  }
  if (!detail || !detailRange || detailState === "LOADING") {
    return <aside className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">正在读取投入详情…</aside>;
  }
  const editable = canvasSegment.permissions.canEdit;
  const plannedEditable = detail.type === "PLANNED" && !["CONFIRMED", "CANCELLED"].includes(detail.status);
  const detailModel: TimeCanvasModel = {
    ...model,
    segments: model.segments
      .map((segment) => ({
        ...segment,
        ...(segment.id === canvasSegment.id
          ? { startMs: detailRange.startMs, endMs: detailRange.endMs }
          : {}),
        permissions:
          segment.id === canvasSegment.id
            ? segment.permissions
            : {
                canViewDetails: false,
                canEdit: false,
                canMove: false,
                canResize: false,
                canMerge: false,
                canCancel: false,
                canConfirm: false,
                canSoftDelete: false,
              },
      })),
  };
  return (
    <aside className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4" data-testid="segment-inspector">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-words font-semibold">{detail.content}</h2>
          <Badge variant={detail.type === "ACTUAL" ? "default" : "outline"}>{workSegmentTypeLabels[detail.type]}</Badge>
          <Badge variant="secondary">{workSegmentStatusLabels[detail.status]}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{detail.personName} · {formatRange(Date.parse(detail.startAt), Date.parse(detail.endAt))}</p>
        <p className="mt-1 text-sm text-muted-foreground">{detail.task?.title ?? "独立投入"}</p>
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-border">
        <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">当前时间线上下文</h3>
        <TimeCanvas
          mode="RESOURCE_PLANNER"
          model={detailModel}
          presentation="COMPACT"
          initialZoom={initialZoom}
          initialCenterMs={initialCenterMs}
          selection={{ kind: "SEGMENT", id: detail.id }}
          display={{ showActual: true, showBusy: true, showInspector: false }}
          interaction={editable ? {
            desktopOnlySegmentTransform: true,
            onSegmentTransform: (request) => {
              if (request.segmentId !== detail.id) return;
              onRangeChange({ startMs: request.startMs, endMs: request.endMs });
            },
          } : undefined}
          emptyMessage="当前投入没有可显示的时间上下文。"
        />
      </div>

      <section className="space-y-3 border-t border-border pt-4" aria-labelledby="segment-basic-heading">
        <h3 id="segment-basic-heading" className="text-sm font-semibold">基本信息</h3>
      {editable ? (
        <form
          className="grid gap-3 md:grid-cols-2"
          aria-label="编辑投入详情"
          onChange={() => onDirtyChange(true)}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            onRun(
              () => updateWorkSegment({
                segmentId: detail.id,
                expectedUpdatedAt: detail.updatedAt,
                reason: String(form.get("reason") ?? "投入详情更新"),
                startAt: new Date(detailRange.startMs).toISOString(),
                endAt: new Date(detailRange.endMs).toISOString(),
                content: String(form.get("content") ?? ""),
                priority: String(form.get("priority") ?? detail.priority),
                expectedOutput: String(form.get("expectedOutput") ?? ""),
                actualOutput: String(form.get("actualOutput") ?? ""),
              }),
              "已更新投入详情",
            );
          }}
        >
          <SegmentRangeFields range={detailRange} onRangeChange={onRangeChange} />
          <Field label="内容" htmlFor="inspect-content" className="md:col-span-2"><Textarea id="inspect-content" name="content" defaultValue={detail.content} maxLength={2_000} required /></Field>
          <Field label="优先级" htmlFor="inspect-priority"><select id="inspect-priority" name="priority" className={selectClass} defaultValue={detail.priority}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="预期输出" htmlFor="inspect-expected" className="md:col-span-2"><Textarea id="inspect-expected" name="expectedOutput" defaultValue={detail.expectedOutput} maxLength={2_000} /></Field>
          <Field label="实际输出" htmlFor="inspect-actual" className="md:col-span-2"><Textarea id="inspect-actual" name="actualOutput" defaultValue={detail.actualOutput} maxLength={2_000} /></Field>
          <Input className="md:col-span-2" name="reason" aria-label="修改原因" placeholder="修改原因（可选）" />
          <Button className="md:col-span-2 md:w-fit" type="submit" disabled={disabled}>保存基本信息</Button>
        </form>
      ) : (
        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <ReadOnlyValue label="开始" value={formatIsoDateTime(detail.startAt)} />
          <ReadOnlyValue label="结束" value={formatIsoDateTime(detail.endAt)} />
          <ReadOnlyValue label="内容" value={detail.content} wide />
          <ReadOnlyValue label="优先级" value={taskPriorityLabels[detail.priority]} />
          <ReadOnlyValue label="预期输出" value={detail.expectedOutput || "未填写"} wide />
          <ReadOnlyValue label="实际输出" value={detail.actualOutput || "未填写"} wide />
        </dl>
      )}
      </section>

      {plannedEditable && canvasSegment.permissions.canConfirm && (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">确认、取消与删除</h3>
          <Button type="button" className="w-full" disabled={disabled} onClick={() => onRun(() => confirmPlannedSegment({ segmentId: detail.id, expectedUpdatedAt: detail.updatedAt, reason: "投入详情完整确认" }), "已完整确认并生成 Actual")}>完整确认</Button>
          <PartialConfirmForm
            detail={detail}
            disabled={disabled}
            onDirtyChange={onDirtyChange}
            onRun={onRun}
          />
        </div>
      )}

      {plannedEditable && canvasSegment.permissions.canCancel && (
        <ReasonAction label="取消计划" destructive disabled={disabled} onSubmit={(reason) => onRun(() => cancelPlannedSegment({ segmentId: detail.id, expectedUpdatedAt: detail.updatedAt, reason }), "已取消计划")} />
      )}
      {detail.type === "ACTUAL" && canvasSegment.permissions.canSoftDelete && (
        <ReasonAction label="删除 Actual" destructive disabled={disabled} onSubmit={(reason) => onRun(() => softDeleteActualSegment({ segmentId: detail.id, expectedUpdatedAt: detail.updatedAt, reason }), "已软删除 Actual")} />
      )}

      <section className="border-t border-border pt-4" aria-label="来源与历史">
        <h3 className="text-sm font-semibold">来源与变更历史</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          关联对象：{detail.task?.title ?? "独立投入"}
        </p>
        {historyState === "LOADING" && (
          <p className="mt-2 text-sm text-muted-foreground" role="status">
            正在加载变更历史…
          </p>
        )}
        {historyError && (
          <div className="mt-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            <p>变更历史加载失败：{historyError}</p>
            <Button className="mt-2" type="button" size="sm" variant="outline" disabled={disabled} onClick={onRetryHistory}>重试历史</Button>
          </div>
        )}
        {detail.plannedSources.length > 0 && (
          <div className="mt-2 text-xs">
            <p className="font-medium">由本 Planned 生成的 Actual</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {detail.plannedSources.map((source) => (
                <li key={source.id} className="break-words">
                  覆盖 {formatIsoRange(source.coveredStartAt, source.coveredEndAt)} · Actual {formatIsoRange(source.actualSegment.startAt, source.actualSegment.endAt)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {detail.actualSources.length > 0 && (
          <div className="mt-2 text-xs">
            <p className="font-medium">本 Actual 的 Planned 来源</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {detail.actualSources.map((source) => (
                <li key={source.id} className="break-words">
                  覆盖 {formatIsoRange(source.coveredStartAt, source.coveredEndAt)} · Planned {formatIsoRange(source.plannedSegment.startAt, source.plannedSegment.endAt)}（{workSegmentStatusLabels[source.plannedSegment.status]}）
                </li>
              ))}
            </ul>
          </div>
        )}
        {changes.length === 0 ? (historyState === "READY" && <p className="mt-2 text-sm text-muted-foreground">暂无可见变更。</p>) : (
          <ol className="mt-2 space-y-2 text-xs">
            {changes.map((change) => (
              <li key={change.key} className="rounded border border-border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{change.action}</span>
                  <time className="text-muted-foreground" dateTime={change.createdAt}>
                    {formatIsoDateTime(change.createdAt)}
                  </time>
                </div>
                <p className="mt-1 text-muted-foreground">操作者：{change.actorName}</p>
                <p className="mt-1 break-words">原因：{change.reason}</p>
                {change.differences.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-border pt-2">
                    {change.differences.map((difference, index) => (
                      <li key={`${difference.label}:${index}`} className="break-words">
                        {difference.label}：{difference.before} → {difference.after}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
        {hasMoreChanges && (
          <Button
            className="mt-3"
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || historyLoadingMore}
            onClick={onLoadMoreChanges}
          >
            {historyLoadingMore ? "正在加载更多变更…" : "加载更多变更"}
          </Button>
        )}
        {historyState === "READY" && changes.length > 0 && !hasMoreChanges && (
          <p className="mt-3 text-xs text-muted-foreground" role="status">
            已加载全部变更。
          </p>
        )}
      </section>
    </aside>
  );
}

function ReasonAction({ label, destructive, disabled, onSubmit }: { label: string; destructive?: boolean; disabled: boolean; onSubmit: (reason: string) => void }) {
  return (
    <form className="grid gap-2 border-t border-border pt-4" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      onSubmit(String(form.get("reason") ?? ""));
    }}>
      <Input name="reason" aria-label={`${label}原因`} placeholder={`${label}原因`} required />
      <Button type="submit" variant={destructive ? "destructive" : "outline"} disabled={disabled}>{label}</Button>
    </form>
  );
}

function SegmentRangeFields({
  range,
  onRangeChange,
}: {
  range: TimeCanvasRange;
  onRangeChange: (range: TimeCanvasRange) => void;
}) {
  const [rangeInputs, setRangeInputs] = useState<{
    baseStartMs: number;
    baseEndMs: number;
    startValue: string;
    endValue: string;
  } | null>(null);
  const startInputRef = useRef<HTMLInputElement>(null);
  const endInputRef = useRef<HTMLInputElement>(null);
  const activeRangeInputs = rangeInputs?.baseStartMs === range.startMs &&
      rangeInputs.baseEndMs === range.endMs
    ? rangeInputs
    : null;
  const startValue = activeRangeInputs?.startValue ?? toLocal(range.startMs);
  const endValue = activeRangeInputs?.endValue ?? toLocal(range.endMs);
  const pendingRange = validateSegmentRangeInputs(startValue, endValue);
  const rangeError = activeRangeInputs && !pendingRange.ok
    ? pendingRange.message
    : "";

  useEffect(() => {
    startInputRef.current?.setCustomValidity(rangeError);
    endInputRef.current?.setCustomValidity(rangeError);
  }, [rangeError]);

  function updateRangeInputs(nextStartValue: string, nextEndValue: string) {
    const nextRange = validateSegmentRangeInputs(nextStartValue, nextEndValue);
    if (!nextRange.ok) {
      setRangeInputs({
        baseStartMs: range.startMs,
        baseEndMs: range.endMs,
        startValue: nextStartValue,
        endValue: nextEndValue,
      });
      return;
    }
    setRangeInputs(null);
    onRangeChange({ startMs: nextRange.startMs, endMs: nextRange.endMs });
  }

  return (
    <>
      <Field label="开始" htmlFor="inspect-start">
        <Input
          ref={startInputRef}
          id="inspect-start"
          name="startAt"
          type="datetime-local"
          value={startValue}
          aria-invalid={Boolean(rangeError)}
          aria-describedby={rangeError ? "inspect-range-error" : undefined}
          onChange={(event) => updateRangeInputs(event.target.value, endValue)}
          required
        />
      </Field>
      <Field label="结束" htmlFor="inspect-end">
        <Input
          ref={endInputRef}
          id="inspect-end"
          name="endAt"
          type="datetime-local"
          value={endValue}
          aria-invalid={Boolean(rangeError)}
          aria-describedby={rangeError ? "inspect-range-error" : undefined}
          onChange={(event) => updateRangeInputs(startValue, event.target.value)}
          required
        />
      </Field>
      {rangeError && (
        <p id="inspect-range-error" className="text-sm text-destructive md:col-span-2" role="alert">
          {rangeError}
        </p>
      )}
    </>
  );
}

function PartialConfirmForm({
  detail,
  disabled,
  onDirtyChange,
  onRun,
}: {
  detail: WorkSegmentDetail;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onRun: (
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
  ) => void;
}) {
  const startMs = Date.parse(detail.startAt);
  const endMs = Date.parse(detail.endAt);
  const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60_000));
  const [coveredMinutes, setCoveredMinutes] = useState(() =>
    Math.min(durationMinutes, Math.max(1, Math.round(durationMinutes / 2))),
  );
  const coveredEndAt = new Date(startMs + coveredMinutes * 60_000).toISOString();

  return (
    <form
      className="grid gap-2"
      aria-label="部分确认"
      onChange={() => onDirtyChange(true)}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const reason = String(form.get("reason") ?? "投入详情部分确认");
        if (coveredMinutes >= durationMinutes) {
          onRun(
            () => confirmPlannedSegment({
              segmentId: detail.id,
              expectedUpdatedAt: detail.updatedAt,
              reason,
            }),
            "已完整确认并生成 Actual",
          );
          return;
        }
        onRun(
          () => partiallyConfirmSegment({
            segmentId: detail.id,
            expectedUpdatedAt: detail.updatedAt,
            coveredStartAt: detail.startAt,
            coveredEndAt,
            reason,
            actual: {
              content: String(form.get("content") ?? ""),
              expectedOutput: String(form.get("expectedOutput") ?? ""),
              actualOutput: String(form.get("actualOutput") ?? ""),
            },
          }),
          "已确认计划前段并保留剩余计划",
        );
      }}
    >
      <p className="text-sm font-medium">确认计划前段</p>
      <p className="text-xs text-muted-foreground">
        开始固定为当前计划开头；拖动时间线选择确认结束点，也可直接填写结束时间。
      </p>
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <input
          className="w-full accent-primary"
          type="range"
          aria-label="在时间线上选择确认结束"
          min={1}
          max={durationMinutes}
          value={coveredMinutes}
          onChange={(event) => {
            setCoveredMinutes(Number(event.target.value));
            onDirtyChange(true);
          }}
        />
        <div className="mt-1 flex justify-between gap-3 text-xs text-muted-foreground">
          <span>{formatRange(startMs, startMs + 60_000).split(" – ")[0]}</span>
          <span>{formatRange(startMs, endMs).split(" – ")[1]}</span>
        </div>
      </div>
      <Input aria-label="确认开始" type="datetime-local" value={toLocal(startMs)} readOnly />
      <Input
        aria-label="确认结束"
        type="datetime-local"
        value={toLocal(Date.parse(coveredEndAt))}
        onChange={(event) => {
          const nextMs = parseShanghaiLocalMs(event.target.value);
          if (nextMs === null) return;
          const nextMinutes = Math.round((nextMs - startMs) / 60_000);
          setCoveredMinutes(Math.max(1, Math.min(durationMinutes, nextMinutes)));
          onDirtyChange(true);
        }}
        required
      />
      <Input name="reason" aria-label="部分确认原因" defaultValue="投入详情部分确认" required />
      <Field label="实际投入内容" htmlFor={`partial-content-${detail.id}`}>
        <Textarea
          id={`partial-content-${detail.id}`}
          name="content"
          defaultValue={detail.content}
          maxLength={2_000}
          required={coveredMinutes < durationMinutes}
        />
      </Field>
      <Field label="预期输出" htmlFor={`partial-expected-${detail.id}`}>
        <Textarea
          id={`partial-expected-${detail.id}`}
          name="expectedOutput"
          defaultValue={detail.expectedOutput}
          maxLength={2_000}
          required={coveredMinutes < durationMinutes}
        />
      </Field>
      <Field label="实际输出" htmlFor={`partial-actual-${detail.id}`}>
        <Textarea
          id={`partial-actual-${detail.id}`}
          name="actualOutput"
          maxLength={2_000}
          required={coveredMinutes < durationMinutes}
        />
      </Field>
      <Button type="submit" variant="outline" disabled={disabled}>
        {coveredMinutes >= durationMinutes ? "完整确认" : "部分确认"}
      </Button>
    </form>
  );
}

function Field({ label, htmlFor, className, children }: { label: string; htmlFor: string; className?: string; children: React.ReactNode }) {
  return <div className={cn("grid gap-1.5", className)}><Label htmlFor={htmlFor}>{label}</Label>{children}</div>;
}

function ReadOnlyValue({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={cn("min-w-0", wide && "md:col-span-2")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words">{value}</dd>
    </div>
  );
}

function toLocal(timeMs: number) {
  return isoToShanghaiDateTimeLocal(new Date(timeMs).toISOString());
}

function parseShanghaiLocalMs(value: string) {
  const parsed = Date.parse(shanghaiDateTimeLocalToIso(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function validateSegmentRangeInputs(startValue: string, endValue: string):
  | { ok: true; startMs: number; endMs: number }
  | { ok: false; message: string } {
  const startMs = parseShanghaiLocalMs(startValue);
  const endMs = parseShanghaiLocalMs(endValue);
  if (startMs === null || endMs === null) {
    return { ok: false, message: "请填写有效的开始和结束时间。" };
  }
  if (endMs <= startMs) {
    return { ok: false, message: "结束时间必须晚于开始时间。" };
  }
  if (endMs - startMs > 31 * DAY_MS) {
    return { ok: false, message: "单条投入最长 31 天，请缩短待创建区间。" };
  }
  return { ok: true, startMs, endMs };
}

function formatRange(startMs: number, endMs: number) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${formatter.format(new Date(startMs))} – ${formatter.format(new Date(endMs))}`;
}

function formatIsoRange(startAt: string, endAt: string) {
  return formatRange(Date.parse(startAt), Date.parse(endAt));
}

function formatIsoDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function explicitRangeForDraft(range: TimeCanvasRange, draft: CreateDraft) {
  const startDayMs = Date.parse(`${formatShanghaiDate(draft.startMs)}T00:00:00.000+08:00`);
  const endDayMs = Date.parse(`${formatShanghaiDate(draft.endMs)}T00:00:00.000+08:00`);
  const draftEndExclusive = draft.endMs > endDayMs ? endDayMs + DAY_MS : endDayMs;
  return {
    startMs: Math.min(range.startMs, startDayMs),
    endMs: Math.max(range.endMs, draftEndExclusive),
  };
}

const selectClass = "h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm";
