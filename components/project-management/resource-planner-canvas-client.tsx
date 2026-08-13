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
  getWorkSegment,
  listWorkSegmentChanges,
} from "@/app/actions/project-management/segments";
import type { UserPickerScope } from "@/components/project-management/user-picker";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { timeCanvasSegmentsToModel } from "@/components/project-management/time-canvas/adapter";
import {
  TIME_CANVAS_CACHE_LEAF_BLOCK_LIMIT,
  TIME_CANVAS_CACHE_OBJECT_LIMIT,
  mergeTimeCanvasVersionedSegments,
  pruneTimeCanvasBlockCache,
} from "@/components/project-management/time-canvas/block-cache";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import { cn } from "@/lib/utils";
import {
  blockKey,
  blockRangesForViewport,
  centerFallsWithinRange,
  createInitialBlocks,
  createInitialFailedBlocks,
  failedRangeKey,
  mergeBlockRanges,
  normalizeResourcePlanUrl,
  plannedRangeFromMutation,
  replaceViewportUrl,
  resizeRowsForSegments,
  viewportCenterFromCurrentUrl,
  type CachedBlock,
  type FailedBlock,
} from "@/components/project-management/resource-planner-state";
import {
  explicitRangeForDraft,
  formatPlannerRange,
  QuickCreatePanel,
  SegmentInspector,
  type CreateDraft,
  type SegmentChange,
} from "@/components/project-management/resource-planner-panels";

type TaskOption = TaskOptionPage["items"][number];
type Notice = { kind: "success" | "error" | "info"; message: string } | null;
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
  const externalInitialCenterRef = useRef(initialCenterMs);
  const initialViewportUrlCenterRef = useRef(initialCenterMs);
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
  const updateDialogDirty = useCallback((dirty: boolean) => {
    dialogDirtyRef.current = dirty;
    setDialogDirty(dirty);
  }, []);
  const adaptiveRefreshStateRef = useRef<"IDLE" | "DEFERRED" | "REFRESHING">("IDLE");
  const previousInitialFocusRef = useRef(initialFocusId);
  const centerNavigationTargetRef = useRef<number | null>(null);
  const draftViewportCenterRef = useRef<number | null>(null);
  const plannedMutationViewportCenterRef = useRef<number | null>(null);
  const viewportUrlTimerRef = useRef<number | null>(null);
  const staleRefreshFocusRef = useRef<string | null>(null);
  const handleViewportChange = useCallback((
    nextViewport: TimeCanvasRange,
    source: "LAYOUT" | "USER",
  ) => {
    viewportRangeRef.current = nextViewport;
    const navigationTarget = centerNavigationTargetRef.current;
    if (
      navigationTarget !== null &&
      nextViewport.startMs <= navigationTarget &&
      navigationTarget < nextViewport.endMs
    ) {
      centerNavigationTargetRef.current = null;
    }
    if (source === "USER") {
      const nextCenter = (nextViewport.startMs + nextViewport.endMs) / 2;
      if (draftViewportCenterRef.current !== null) {
        draftViewportCenterRef.current = nextCenter;
      }
      if (plannedMutationViewportCenterRef.current !== null) {
        plannedMutationViewportCenterRef.current = nextCenter;
      }
      initialViewportUrlCenterRef.current = undefined;
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
    if (Object.is(externalInitialCenterRef.current, initialCenterMs)) return;
    externalInitialCenterRef.current = initialCenterMs;
    const urlCenter = viewportCenterFromCurrentUrl();
    initialViewportUrlCenterRef.current = centerFallsWithinRange(
      urlCenter,
      incomingModel.fullRange ?? incomingModel.range,
    )
      ? urlCenter
      : initialCenterMs;
  }, [incomingModel, initialCenterMs]);
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
      draftViewportCenterRef.current = null;
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
    if (dialogDirtyRef.current) {
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
    if (persistViewportInUrl) {
      const urlCenter = viewportCenterFromCurrentUrl();
      initialViewportUrlCenterRef.current = centerFallsWithinRange(
        urlCenter,
        initialModel.fullRange ?? initialModel.range,
      )
        ? urlCenter
        : initialCenterMs;
    }
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
    updateDialogDirty(false);
    setDetail(null);
    setDetailRange(null);
    setChanges([]);
    setChangesCursor(null);
    setHistoryState(focusedSegment ? "LOADING" : "IDLE");
    setHistoryLoadingMore(false);
    setHistoryError("");
    setDetailError("");
    setDetailState(focusedSegment ? "LOADING" : "IDLE");
  }, [effectiveInitialSelection, initialCenterMs, initialModel, persistViewportInUrl, updateDialogDirty]);
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
      updateDialogDirty(false);
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
  }, [dialogDirty, effectiveInitialSelection, incomingModel, initialFocusId, initialModel, updateDialogDirty]);
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
    const preservedCenter = createDraft
      ? draftViewportCenterRef.current ?? viewportCenterFromCurrentUrl()
      : pendingPlannedRange
        ? plannedMutationViewportCenterRef.current ?? viewportCenterFromCurrentUrl()
        : undefined;
    viewportUrlTimerRef.current = window.setTimeout(() => {
      viewportUrlTimerRef.current = null;
      if (centerNavigationTargetRef.current !== null) return;
      const initialUrlCenter = initialViewportUrlCenterRef.current;
      initialViewportUrlCenterRef.current = undefined;
      replaceViewportUrl({
        centerMs: initialUrlCenter ?? preservedCenter ??
          (viewportRange.startMs + viewportRange.endMs) / 2,
        zoom: currentZoom,
      });
    }, 300);
    return () => {
      if (viewportUrlTimerRef.current === null) return;
      window.clearTimeout(viewportUrlTimerRef.current);
      viewportUrlTimerRef.current = null;
    };
  }, [createDraft, currentZoom, pendingPlannedRange, persistViewportInUrl, viewportRange]);
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
    if (pendingPlannedRange) return;
    plannedMutationViewportCenterRef.current = null;
  }, [pendingPlannedRange]);
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
      const preservedViewportCenterMs = persistViewportInUrl
        ? createDraft
          ? draftViewportCenterRef.current ?? viewportCenterFromCurrentUrl()
          : viewportCenterFromCurrentUrl()
        : undefined;
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
            updateDialogDirty(false);
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
          plannedMutationViewportCenterRef.current =
            preservedViewportCenterMs ?? viewportCenterFromCurrentUrl() ?? null;
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
          updateDialogDirty(false);
          setSelection(null);
        }
        onSuccess?.();
        if (persistViewportInUrl) {
          replaceViewportUrl({
            centerMs:
              preservedViewportCenterMs ??
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
        normalizeResourcePlanUrl(url);
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
    draftViewportCenterRef.current = currentViewportCenter();
    setCreateDraft({
      rowId: request.rowId,
      personId: request.sourceId,
      startMs: request.startMs,
      endMs: request.endMs,
    });
    setCreateDraftDirty(false);
    setNotice({ kind: "info", message: "已选择时间区间，请补全投入内容。" });
  }

  function currentViewportCenter() {
    const current = viewportRangeRef.current;
    const center = (current.startMs + current.endMs) / 2;
    return Number.isFinite(center)
      ? center
      : viewportCenterFromCurrentUrl() ?? model.range.startMs;
  }

  function cancelCreateDraft() {
    if (createDraftDirty && !window.confirm("创建内容尚未保存，确认放弃？")) return;
    setCreateDraft(null);
    draftViewportCenterRef.current = null;
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
          message: "待创建区间会使资源计划超过 366 天，请先缩小或调整资源时间范围。",
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
    normalizeResourcePlanUrl(url);
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
    updateDialogDirty(false);
    setSelection(null);

    const url = new URL(window.location.href);
    const hadUrlFocus =
      url.searchParams.has("focus") ||
      url.searchParams.has("focusSegmentIds");
    url.searchParams.delete("focus");
    url.searchParams.delete("focusSegmentIds");
    normalizeResourcePlanUrl(url);
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
              draftViewportCenterRef.current = currentViewportCenter();
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
            {formatPlannerRange(block.range.startMs, block.range.endMs)}：{block.message}
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
                updateDialogDirty(false);
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
            onDirtyChange={updateDialogDirty}
            onTaskNavigation={() =>
              !dialogDirty || window.confirm("当前投入有未保存修改，确认放弃并离开？")
            }
            onRangeChange={(range) => {
              setDetailRange(range);
              updateDialogDirty(true);
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
              draftViewportCenterRef.current = null;
              setCreateDraftDirty(false);
            });
          }}
        />
      )}
    </div>
  );
}
