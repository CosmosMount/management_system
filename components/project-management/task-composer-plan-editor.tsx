"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarClock,
  Plus,
  Trash2,
} from "lucide-react";
import {
  TaskPlanNodeNavigator,
  type TaskPlanNavigatorNode,
} from "@/components/project-management/task-plan-node-navigator";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { buildPlanPhaseBands } from "@/components/project-management/time-canvas/plan-phase-bands";
import {
  clampLogicalRangeToThreeYears,
  contentTimeBounds,
  padShanghaiCalendarRange,
} from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasGlobalMarker,
  TimeCanvasAnchorMoveRequest,
  TimeCanvasAnchorMoveResolution,
  TimeCanvasModel,
  TimeCanvasTone,
} from "@/components/project-management/time-canvas/types";
import type { GlobalTimeMarkerDto } from "@/lib/project-management/types/time-canvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isoToShanghaiDateTimeLocal } from "@/lib/project-management/date-time";
import { cn } from "@/lib/utils";
import type {
  TaskComposerInspectorDraft,
  TaskComposerMilestone,
  TaskComposerSeed,
  TaskComposerValidationIssue as ValidationIssue,
} from "@/lib/project-management/composer-contract";
import { TASK_COMPOSER_START_ID } from "@/lib/project-management/composer-contract";
import {
  composerBatchDelayEntityIds,
  isReadOnlyRevisionEntity,
  localMs,
  renderAtMs,
  renderAtLocal,
  sortMilestonesByRenderTime,
  type ComposerPlanTimeMutationResult,
} from "@/components/project-management/task-composer-plan-state";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PLAN_ROW_ID = "task-composer-plan-row";
const phaseTones: TimeCanvasTone[] = [
  "BLUE",
  "VIOLET",
  "AMBER",
  "EMERALD",
  "ROSE",
  "SLATE",
];

export function TaskComposerPlanEditor({
  state,
  globalMarkers,
  issues,
  inspectorDraft,
  inspectorIssues,
  notice,
  optionLoading,
  submitting,
  submitDisabled,
  submitLabel,
  submittingLabel,
  onSelect,
  onBeginMilestone,
  onConstrainAnchorMove,
  onMoveAnchor,
  onMoveTerminal,
  onBatchDelay,
  onUpdateInspector,
  onDeleteMilestones,
  onSubmit,
}: {
  state: TaskComposerSeed;
  globalMarkers: GlobalTimeMarkerDto[];
  issues: ValidationIssue[];
  inspectorDraft: TaskComposerInspectorDraft | null;
  inspectorIssues: ValidationIssue[];
  notice: { message: string; error: boolean } | null;
  optionLoading: boolean;
  submitting: boolean;
  submitDisabled?: boolean;
  submitLabel: string;
  submittingLabel: string;
  onSelect: (entityId: string | null) => void;
  onBeginMilestone: (at: string, source?: TaskComposerMilestone) => void;
  onConstrainAnchorMove: (
    request: TimeCanvasAnchorMoveRequest,
    selectedEntityIds: readonly string[],
  ) => TimeCanvasAnchorMoveResolution;
  onMoveAnchor: (
    request: TimeCanvasAnchorMoveRequest,
    selectedEntityIds: readonly string[],
  ) => void;
  onMoveTerminal: (at: string) => void;
  onBatchDelay: (
    entityId: string,
    targetAt: string,
  ) => ComposerPlanTimeMutationResult;
  onUpdateInspector: (draft: TaskComposerInspectorDraft) => void;
  onDeleteMilestones: (ids: string[]) => void;
  onSubmit: () => void;
}) {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [quickAt, setQuickAt] = useState<{ atMs: number; snapMs: number } | null>(null);
  const [selectedAnchorIds, setSelectedAnchorIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchDelay, setBatchDelay] = useState<{
    entityId: string;
    targetAt: string;
    error: string;
  } | null>(null);
  const [requestedCanvasCenter, setRequestedCanvasCenter] = useState<{
    atMs: number;
    revision: number;
  } | null>(null);
  const planCenterMs = useMemo(() => {
    const times = [
      renderAtMs(state, TASK_COMPOSER_START_ID),
      ...state.milestones.map((milestone) => renderAtMs(state, milestone.id)),
      ...(state.revision
        ? [
            localMs(state.revision.revisionAt),
            ...state.revision.carriedAnchors.map((anchor) =>
              localMs(anchor.revisionAt),
            ),
          ]
        : []),
      renderAtMs(state, state.termination.id),
    ];
    return (Math.min(...times) + Math.max(...times)) / 2;
  }, [state]);
  const canvasModel = useMemo(
    () =>
      buildComposerCanvasModel(
        state,
        issues,
        globalMarkers,
        requestedCanvasCenter?.atMs ?? planCenterMs,
      ),
    [globalMarkers, issues, planCenterMs, requestedCanvasCenter?.atMs, state],
  );
  const navigatorNodes = useMemo(
    () => buildComposerNavigatorNodes(state, issues),
    [issues, state],
  );
  const temporaryCount = state.milestones.filter((milestone) => isTemporary(state, milestone.id)).length;
  const quickAtLocal = quickAt
    ? isoToShanghaiDateTimeLocal(new Date(quickAt.atMs))
    : null;
  const canAddAt = quickAt
    ? isStrictlyInsidePlan(state, quickAt.atMs) &&
      !state.milestones.some(
        (milestone) => renderAtMs(state, milestone.id) === quickAt.atMs,
      )
    : false;
  const lastPlanNodeAt = Math.max(
    renderAtMs(state, TASK_COMPOSER_START_ID),
    ...state.milestones.map((milestone) => renderAtMs(state, milestone.id)),
    ...(state.revision
      ? [
          localMs(state.revision.revisionAt),
          ...state.revision.carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
        ]
      : []),
  );
  const canMoveTerminalAt = Boolean(quickAt && quickAt.atMs > lastPlanNodeAt);
  const editableAnchorIds = useMemo(
    () =>
      new Set(
        canvasModel.anchors
          .filter((anchor) => anchor.editable)
          .map((anchor) => anchor.id),
      ),
    [canvasModel.anchors],
  );

  const activeSelectedAnchorIds = useMemo(() => {
    const filtered = new Set(
      [...selectedAnchorIds].filter((anchorId) => editableAnchorIds.has(anchorId)),
    );
    const selectedId = state.selectedEntityId;
    return selectedId && editableAnchorIds.has(selectedId) && !filtered.has(selectedId)
      ? new Set([selectedId])
      : filtered;
  }, [editableAnchorIds, selectedAnchorIds, state.selectedEntityId]);

  useEffect(() => {
    if (!quickAt) return;
    const closeQuickMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuickAt(null);
    };
    window.addEventListener("keydown", closeQuickMenu);
    return () => window.removeEventListener("keydown", closeQuickMenu);
  }, [quickAt]);

  const selectOnly = (nodeId: string | null) => {
    setSelectedAnchorIds(
      nodeId && editableAnchorIds.has(nodeId)
        ? new Set([nodeId])
        : new Set(),
    );
    onSelect(nodeId);
  };

  const selectCanvasAnchor = (nodeId: string, toggle: boolean) => {
    if (!editableAnchorIds.has(nodeId) || !toggle) {
      selectOnly(nodeId);
      return;
    }
    const next = new Set(activeSelectedAnchorIds);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    setSelectedAnchorIds(next);
    if (next.has(nodeId)) {
      onSelect(nodeId);
    } else if (state.selectedEntityId === nodeId) {
      onSelect(next.values().next().value ?? null);
    }
  };

  const selectCanvasMarquee = (anchorIds: string[], additive: boolean) => {
    const next = additive ? new Set(activeSelectedAnchorIds) : new Set<string>();
    for (const anchorId of anchorIds) {
      if (editableAnchorIds.has(anchorId)) next.add(anchorId);
    }
    setSelectedAnchorIds(next);
    const primaryId = anchorIds.findLast((anchorId) => next.has(anchorId));
    if (primaryId) onSelect(primaryId);
    else if (!additive || next.size === 0) onSelect(next.values().next().value ?? null);
  };

  const selectNavigatorNode = (nodeId: string) => {
    selectOnly(nodeId);
    const anchor = canvasModel.anchors.find((item) => item.id === nodeId);
    const scroller = canvasContainerRef.current?.querySelector<HTMLElement>(
      "[data-testid='time-canvas-scroll']",
    );
    if (!anchor || !scroller) return;
    if (
      anchor.atMs < canvasModel.range.startMs ||
      anchor.atMs >= canvasModel.range.endMs
    ) {
      setRequestedCanvasCenter((current) => ({
        atMs: anchor.atMs,
        revision: (current?.revision ?? 0) + 1,
      }));
      return;
    }
    const timelineRow = scroller.querySelector<HTMLElement>(
      "[data-testid^='timeline-row-']",
    );
    const rowHeaderWidth =
      timelineRow?.firstElementChild instanceof HTMLElement
        ? timelineRow.firstElementChild.offsetWidth
        : 0;
    const rangeDuration = canvasModel.range.endMs - canvasModel.range.startMs;
    if (rangeDuration <= 0) return;
    const ratio = Math.max(
      0,
      Math.min(1, (anchor.atMs - canvasModel.range.startMs) / rangeDuration),
    );
    const timelineWidth = Math.max(0, scroller.scrollWidth - rowHeaderWidth);
    const targetX = rowHeaderWidth + ratio * timelineWidth;
    const maximumLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    scroller.scrollTo({
      left: Math.max(0, Math.min(maximumLeft, targetX - scroller.clientWidth / 2)),
      behavior: "smooth",
    });
  };

  const submitBatchDelay = () => {
    if (!batchDelay) return;
    const result = onBatchDelay(batchDelay.entityId, batchDelay.targetAt);
    if (!result.ok) {
      setBatchDelay({ ...batchDelay, error: result.message });
      return;
    }
    setBatchDelay(null);
  };
  const batchDelayAffectedCount = batchDelay
    ? composerBatchDelayEntityIds(state, batchDelay.entityId).length
    : 0;

  return (
    <>
      <main className="min-w-0 space-y-4">
        <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">计划时间画布</h2>
                <Badge variant="secondary" data-testid="task-composer-milestone-count">
                  {state.milestones.length}/200
                </Badge>
                {temporaryCount > 0 && (
                  <Badge variant="outline" className="border-amber-500 text-amber-700" data-testid="task-composer-temporary-count">
                    {temporaryCount} 个临时
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {state.revision
                  ? "固定 Asia/Shanghai；承接节点只读，Revision 标记不形成计划阶段。"
                  : "固定 Asia/Shanghai；Composer 只编排节点，不加载成员投入数据。"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={state.milestones.length >= 200}
              onClick={() => onBeginMilestone(suggestMilestoneAt(state))}
            >
              <Plus aria-hidden="true" />
              添加 Milestone
            </Button>
          </div>

          <div
            className="mt-3 hidden flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground lg:flex"
            data-testid="task-composer-anchor-multi-selection"
          >
            <Badge variant="outline">已选 {activeSelectedAnchorIds.size} 个可编辑节点</Badge>
            <span>Shift 点击可增减选择；在画布空白处拖动可框选；拖动任一已选节点会整体移动。</span>
          </div>

          <div
            ref={canvasContainerRef}
            className="mt-4 hidden min-w-0 overflow-hidden rounded-lg border border-border lg:block"
          >
            <TimeCanvas
              mode="TASK_COMPOSER"
              model={canvasModel}
              initialCenterMs={requestedCanvasCenter?.atMs ?? planCenterMs}
              initialCenterRevision={requestedCanvasCenter?.revision ?? 0}
              navigationRange={canvasModel.fullRange}
              onRequestCenter={(atMs) =>
                setRequestedCanvasCenter((current) => ({
                  atMs,
                  revision: (current?.revision ?? 0) + 1,
                }))
              }
              display={{ showActual: false, showBusy: false, showInspector: false }}
              selection={
                state.selectedEntityId
                  ? { kind: "ANCHOR", id: state.selectedEntityId }
                  : null
              }
              emptyMessage="点击时间轴或添加按钮创建 Milestone"
              interaction={{
                enableAnchorCreate: true,
                enableAnchorMarqueeSelection: true,
                selectedAnchorIds: activeSelectedAnchorIds,
                onAnchorCreate: ({ atMs, snapMs }) => setQuickAt({ atMs, snapMs }),
                constrainAnchorMove: (request) =>
                  onConstrainAnchorMove(request, [...activeSelectedAnchorIds]),
                onAnchorMove: (request) =>
                  onMoveAnchor(request, [...activeSelectedAnchorIds]),
                onAnchorSelect: (anchorId, options) =>
                  selectCanvasAnchor(anchorId, options.toggle),
                onAnchorMarqueeSelection: ({ anchorIds, additive }) =>
                  selectCanvasMarquee(anchorIds, additive),
                onAnchorSelectionChange: (anchorId) => {
                  if (anchorId) selectOnly(anchorId);
                },
                onInvalidDrop: (message) => window.alert(message),
              }}
            />
          </div>

          {quickAt && quickAtLocal && (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
              role="dialog"
              aria-label="时间画布快捷操作"
              data-testid="task-composer-canvas-quick-menu"
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuickAt(null);
              }}
            >
              <span className="mr-auto font-medium">{formatLocalDateTime(quickAtLocal)}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canAddAt || state.milestones.length >= 200}
                title={canAddAt ? undefined : "Milestone 必须严格位于 Start 与 Terminal 之间且不能同刻"}
                onClick={() => {
                  onBeginMilestone(quickAtLocal);
                  setQuickAt(null);
                }}
              >
                在此添加 Milestone
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canMoveTerminalAt}
                title={canMoveTerminalAt ? undefined : "Terminal 必须严格晚于所有其他节点"}
                onClick={() => {
                  onMoveTerminal(quickAtLocal);
                  setQuickAt(null);
                }}
              >
                移动 Terminal 到此处
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setQuickAt(null)}>
                取消
              </Button>
              {!canAddAt && (
                <span className="w-full text-xs text-muted-foreground">
                  此处不能添加 Milestone：节点必须严格位于 Start 与 Terminal 之间，且不能与其他节点同刻。
                </span>
              )}
              {!canMoveTerminalAt && (
                <span className="w-full text-xs text-muted-foreground">
                  此处不能移动 Terminal：Terminal 必须严格晚于 Start 和全部 Milestone。
                </span>
              )}
            </div>
          )}

          <div className="mt-4">
            <TaskPlanNodeNavigator
              nodes={navigatorNodes}
              selectedId={state.selectedEntityId}
              onSelect={selectNavigatorNode}
              label="Task 阶段"
            />
          </div>
        </section>

        {notice && (
          <div
            className={cn(
              "rounded-lg border p-3 text-sm leading-6",
              notice.error
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : "border-border bg-muted/40",
            )}
            role={notice.error ? "alert" : "status"}
            aria-live="polite"
          >
            {notice.message}
            {optionLoading && " 正在加载…"}
          </div>
        )}
      </main>

      <aside className="min-w-0" aria-label="计划节点检查器">
        <div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
          <Inspector
            state={state}
            draft={inspectorDraft}
            issues={inspectorIssues}
            submitting={submitting}
            onChange={onUpdateInspector}
            onDelete={(milestone) => onDeleteMilestones([milestone.id])}
            onOpenBatchDelay={(entityId) =>
              setBatchDelay({
                entityId,
                targetAt: renderAtLocal(state, entityId),
                error: "",
              })
            }
          />
        </div>
      </aside>

      <div className="sticky bottom-0 z-20 col-span-full flex gap-2 border-t border-border bg-background/95 p-3 backdrop-blur lg:hidden">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={state.milestones.length >= 200}
          onClick={() => onBeginMilestone(suggestMilestoneAt(state))}
        >
          <Plus aria-hidden="true" />
          Milestone
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={submitting || submitDisabled}
          onClick={onSubmit}
        >
          {submitting ? submittingLabel : submitLabel}
        </Button>
      </div>

      <Dialog
        open={Boolean(batchDelay)}
        onOpenChange={(open) => {
          if (!open) setBatchDelay(null);
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="task-composer-batch-delay-dialog">
          <DialogHeader>
            <DialogTitle>批量推迟当前及后续节点</DialogTitle>
            <DialogDescription>
              指定当前节点的新时间；系统会把当前及时间线上之后共
              {batchDelayAffectedCount} 个可编辑节点整体推迟相同时间，较早节点和只读承接节点保持不变。
            </DialogDescription>
          </DialogHeader>
          <div>
            <label htmlFor="task-composer-batch-delay-at" className="mb-1.5 block text-sm font-medium">
              新的节点时间<span className="ml-1 text-destructive">*</span>
            </label>
            <Input
              id="task-composer-batch-delay-at"
              type="datetime-local"
              value={batchDelay?.targetAt ?? ""}
              aria-invalid={Boolean(batchDelay?.error)}
              aria-describedby={batchDelay?.error ? "task-composer-batch-delay-at-error" : undefined}
              onChange={(event) =>
                setBatchDelay((current) =>
                  current
                    ? { ...current, targetAt: event.target.value, error: "" }
                    : current,
                )
              }
            />
            <FieldError
              id="task-composer-batch-delay-at-error"
              messages={batchDelay?.error ?? ""}
              className="mt-1.5"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBatchDelay(null)}>
              取消
            </Button>
            <Button type="button" disabled={submitting} onClick={submitBatchDelay}>
              确认批量推迟
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function buildComposerCanvasModel(
  state: TaskComposerSeed,
  issues: ValidationIssue[],
  globalMarkerDtos: GlobalTimeMarkerDto[],
  preferredCenterMs: number,
): TimeCanvasModel {
  const sortedMilestones = sortMilestonesByRenderTime(state);
  const hasIssue = (entityId: string) => issues.some((issue) => issue.entityId === entityId);
  const anchors = [
    {
      id: TASK_COMPOSER_START_ID,
      rowId: PLAN_ROW_ID,
      taskId: state.draftId,
      kind: "PLAN_START" as const,
      status: "草稿",
      label: "Start",
      atMs: renderAtMs(state, TASK_COMPOSER_START_ID),
      sequence: 0,
      editable: !state.revision,
      versionToken: state.plannedStartAt,
      tone: "BLUE" as const,
      visualState: hasIssue(TASK_COMPOSER_START_ID) ? ("INVALID" as const) : undefined,
    },
    ...sortedMilestones.map((milestone, index) => ({
      id: milestone.id,
      rowId: PLAN_ROW_ID,
      taskId: state.draftId,
      kind: "MILESTONE" as const,
      status: isTemporary(state, milestone.id) ? "临时" : "草稿",
      label: milestone.goal || "临时 Milestone",
      atMs: renderAtMs(state, milestone.id),
      sequence: index + 1,
      editable: !isReadOnlyRevisionEntity(state, milestone.id),
      versionToken: milestone.expectedCompletedAt,
      tone: phaseTones[index % phaseTones.length],
      visualState: isTemporary(state, milestone.id)
        ? ("TEMPORARY" as const)
        : hasIssue(milestone.id)
          ? ("INVALID" as const)
          : undefined,
    })),
    ...(state.revision
      ? [
          ...state.revision.carriedAnchors.map((anchor, index) => ({
            id: anchor.id,
            rowId: PLAN_ROW_ID,
            taskId: state.draftId,
            kind: "REVISION" as const,
            status: anchor.status,
            label: anchor.reason || "Revision",
            atMs: localMs(anchor.revisionAt),
            sequence: sortedMilestones.length + index + 1,
            editable: false,
            versionToken: anchor.revisionAt,
            tone: "SLATE" as const,
          })),
          {
            id: state.revision.markerId,
            rowId: PLAN_ROW_ID,
            taskId: state.draftId,
            kind: "REVISION" as const,
            status: "当前候选",
            label: state.revision.reason || "当前 Revision",
            atMs: localMs(state.revision.revisionAt),
            sequence:
              sortedMilestones.length + state.revision.carriedAnchors.length + 1,
            editable: true,
            versionToken: state.revision.revisionAt,
            tone: "ROSE" as const,
            visualState: hasIssue(state.revision.markerId)
              ? ("INVALID" as const)
              : undefined,
          },
        ]
      : []),
    {
      id: state.termination.id,
      rowId: PLAN_ROW_ID,
      taskId: state.draftId,
      kind: "TERMINATION" as const,
      status: "草稿",
      label: state.termination.name || "Terminal",
      atMs: renderAtMs(state, state.termination.id),
      sequence:
        sortedMilestones.length +
        (state.revision?.carriedAnchors.length ?? 0) +
        (state.revision ? 2 : 1),
      editable: true,
      versionToken: state.termination.plannedAt,
      tone: "VIOLET" as const,
      visualState: hasIssue(state.termination.id) ? ("INVALID" as const) : undefined,
    },
  ];
  const globalMarkers: TimeCanvasGlobalMarker[] = globalMarkerDtos.map((marker) => ({
    id: marker.id,
    label: marker.name,
    atMs: Date.parse(marker.markedAt),
    editable: false,
    versionToken: marker.versionToken,
  }));
  const anchorTimes = anchors.map((anchor) => anchor.atMs).filter(Number.isFinite);
  const start = Math.min(...anchorTimes);
  const end = Math.max(...anchorTimes);
  const duration = Math.max(DAY_MS, end - start);
  const padding = Math.max(DAY_MS, duration * 0.08);
  const planRange = { startMs: start - padding, endMs: end + padding + 1 };
  const markerBounds = contentTimeBounds(
    globalMarkers.map((marker) => marker.atMs),
  );
  const markerRange = markerBounds
    ? padShanghaiCalendarRange(markerBounds, 2, preferredCenterMs)
    : planRange;
  const fullRange = {
    startMs: Math.min(planRange.startMs, markerRange.startMs),
    endMs: Math.max(planRange.endMs, markerRange.endMs),
  };
  const logical = clampLogicalRangeToThreeYears(fullRange, preferredCenterMs);
  const phaseBands = buildPlanPhaseBands(anchors, PLAN_ROW_ID).map((band) => ({
    ...band,
    id: `composer-phase-${band.id}`,
  }));
  return {
    timezone: "Asia/Shanghai",
    range: logical.range,
    fullRange,
    contentRange: contentTimeBounds([
      ...anchorTimes,
      ...globalMarkers.map((marker) => marker.atMs),
    ]),
    rangeClipped: logical.clipped,
    rows: [{
      id: PLAN_ROW_ID,
      sourceId: state.draftId,
      kind: "PLAN",
      label: state.title || "新建 Task",
      sublabel: `${state.milestones.length} 个 Milestone${state.milestones.some((milestone) => isTemporary(state, milestone.id)) ? " · 含临时节点" : ""}`,
      editable: true,
      height: 132,
      capacity: null,
    }],
    anchors,
    globalMarkers,
    phaseBands,
    segments: [],
    // Composer seeds are server-rendered. A stable value avoids a hydration
    // mismatch while the editable plan itself remains the only time source.
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function buildComposerNavigatorNodes(
  state: TaskComposerSeed,
  issues: ValidationIssue[],
): TaskPlanNavigatorNode[] {
  const hasIssue = (entityId: string) =>
    issues.some((issue) => issue.entityId === entityId);
  const milestoneNodes: TaskPlanNavigatorNode[] = sortMilestonesByRenderTime(state).map(
    (milestone) => ({
      id: milestone.id,
      kind: "MILESTONE",
      label: milestone.goal || "临时 Milestone",
      at: milestone.expectedCompletedAt,
      status: isTemporary(state, milestone.id)
        ? "临时节点"
        : isReadOnlyRevisionEntity(state, milestone.id)
          ? "只读承接"
          : "计划中",
      completed: isReadOnlyRevisionEntity(state, milestone.id),
      invalid: hasIssue(milestone.id),
    }),
  );
  const revisionNodes: TaskPlanNavigatorNode[] = state.revision
    ? [
        ...state.revision.carriedAnchors.map((anchor) => ({
          id: anchor.id,
          kind: "REVISION" as const,
          label: anchor.reason || "Revision",
          at: anchor.revisionAt,
          status: "已生效",
          completed: true,
        })),
        {
          id: state.revision.markerId,
          kind: "REVISION" as const,
          label: state.revision.reason || "当前 Revision",
          at: state.revision.revisionAt,
          status: "当前候选",
          invalid: hasIssue(state.revision.markerId),
        },
      ]
    : [];
  return [
    {
      id: TASK_COMPOSER_START_ID,
      kind: "START",
      label: "Start",
      at: state.plannedStartAt,
      status: state.revision ? "只读承接" : "计划开始",
      completed: Boolean(state.revision),
      invalid: hasIssue(TASK_COMPOSER_START_ID),
    },
    ...[...milestoneNodes, ...revisionNodes].sort(
      (left, right) =>
        localMs(left.at) - localMs(right.at) || left.id.localeCompare(right.id),
    ),
    {
      id: state.termination.id,
      kind: "TERMINAL",
      label: state.termination.name || "Terminal",
      at: state.termination.plannedAt,
      status: "计划结束",
      invalid: hasIssue(state.termination.id),
    },
  ];
}

function Inspector({
  state,
  draft,
  issues,
  submitting,
  onChange,
  onDelete,
  onOpenBatchDelay,
}: {
  state: TaskComposerSeed;
  draft: TaskComposerInspectorDraft | null;
  issues: ValidationIssue[];
  submitting: boolean;
  onChange: (draft: TaskComposerInspectorDraft) => void;
  onDelete: (milestone: TaskComposerMilestone) => void;
  onOpenBatchDelay: (entityId: string) => void;
}) {
  if (!draft) {
    return <p className="text-sm text-muted-foreground">从画布或节点列表选择一个节点进行编辑。</p>;
  }
  const readOnly = isReadOnlyRevisionEntity(state, draft.entityId);
  const fieldError = (key: string) => issues.some((issue) => issue.key === key);
  const fieldMessages = (key: string) =>
    issues.filter((issue) => issue.key === key).map((issue) => issue.message);
  return (
    <div className="space-y-3" data-testid="task-composer-inspector">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">
            {draft.kind === "MILESTONE" && draft.isNew
              ? "待新增节点"
              : readOnly
                ? "只读承接节点"
                : "节点 Inspector"}
          </p>
          <h2 className="font-semibold">
            {draft.kind === "START"
              ? "Start"
              : draft.kind === "REVISION"
                ? draft.revision.reason || "Revision"
              : draft.kind === "TERMINATION"
                ? draft.termination.name || "Terminal"
                : draft.milestone.goal || "未命名 Milestone"}
          </h2>
        </div>
        {draft.kind === "MILESTONE" && draft.isNew && (
          <Badge variant="outline" className="border-amber-500 text-amber-700">临时</Badge>
        )}
        {draft.kind === "MILESTONE" && !draft.isNew && issues.length > 0 && (
          <Badge variant="destructive">需修正</Badge>
        )}
        {draft.kind === "REVISION" && draft.isCurrent && !readOnly && (
          <Badge variant="outline">不可删除</Badge>
        )}
        {readOnly && <Badge variant="outline">只读</Badge>}
      </div>

      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start"
          disabled={submitting}
          onClick={() => onOpenBatchDelay(draft.entityId)}
        >
          <CalendarClock aria-hidden="true" />
          批量推迟当前及后续节点
        </Button>
      )}

      {draft.kind === "START" && (
        <PlanField label="计划开始时间" required htmlFor="plannedStartAt" error={fieldMessages("plannedStartAt")}>
          <Input
            id="plannedStartAt"
            type="datetime-local"
            value={draft.plannedStartAt}
            readOnly={readOnly}
            aria-invalid={fieldError("plannedStartAt")}
            aria-describedby={fieldError("plannedStartAt") ? "plannedStartAt-error" : undefined}
            onChange={(event) => onChange({ ...draft, plannedStartAt: event.target.value })}
          />
        </PlanField>
      )}

      {draft.kind === "REVISION" && (
        <>
          <PlanField label="Revision 时间" required htmlFor="revisionAt" error={fieldMessages("revisionAt")}>
            <Input
              id="revisionAt"
              type="datetime-local"
              value={draft.revision.revisionAt}
              readOnly={readOnly}
              aria-invalid={fieldError("revisionAt")}
              aria-describedby={fieldError("revisionAt") ? "revisionAt-error" : undefined}
              onChange={(event) =>
                onChange({
                  ...draft,
                  revision: {
                    ...draft.revision,
                    revisionAt: event.target.value,
                  },
                })
              }
            />
          </PlanField>
          <PlanField label="Revision 名称" required htmlFor="revision-reason" error={fieldMessages("revision-reason")}>
            <Input
              id="revision-reason"
              value={draft.revision.reason}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError("revision-reason")}
              aria-describedby={fieldError("revision-reason") ? "revision-reason-error" : undefined}
              onChange={(event) =>
                onChange({
                  ...draft,
                  revision: {
                    ...draft.revision,
                    reason: event.target.value,
                  },
                })
              }
            />
          </PlanField>
          <PlanField
            label="Revision 详细内容"
            required
            htmlFor="revision-description"
            error={fieldMessages("revision-description")}
          >
            <Textarea
              id="revision-description"
              value={draft.revision.description}
              readOnly={readOnly}
              rows={7}
              maxLength={2_000}
              aria-invalid={fieldError("revision-description")}
              aria-describedby={fieldError("revision-description") ? "revision-description-error" : undefined}
              onChange={(event) =>
                onChange({
                  ...draft,
                  revision: {
                    ...draft.revision,
                    description: event.target.value,
                  },
                })
              }
            />
          </PlanField>
          <p className="text-xs leading-5 text-muted-foreground">
            Revision 是时间标记，不形成阶段，也不能关联人员投入。
          </p>
        </>
      )}

      {draft.kind === "MILESTONE" && (
        <>
          <PlanField label="目标" required htmlFor={`goal-${draft.entityId}`} error={fieldMessages(`goal-${draft.entityId}`)}>
            <Input
              id={`goal-${draft.entityId}`}
              value={draft.milestone.goal}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError(`goal-${draft.entityId}`)}
              aria-describedby={fieldError(`goal-${draft.entityId}`) ? `goal-${draft.entityId}-error` : undefined}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, goal: event.target.value } })}
            />
          </PlanField>
          <PlanField label="预期完成时间" required htmlFor={`expected-${draft.entityId}`} error={fieldMessages(`expected-${draft.entityId}`)}>
            <Input
              id={`expected-${draft.entityId}`}
              type="datetime-local"
              value={draft.milestone.expectedCompletedAt}
              readOnly={readOnly}
              aria-invalid={fieldError(`expected-${draft.entityId}`)}
              aria-describedby={fieldError(`expected-${draft.entityId}`) ? `expected-${draft.entityId}-error` : undefined}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, expectedCompletedAt: event.target.value } })}
            />
          </PlanField>
          <PlanField label="完成条件" required htmlFor={`criteria-${draft.entityId}`} error={fieldMessages(`criteria-${draft.entityId}`)}>
            <Textarea
              id={`criteria-${draft.entityId}`}
              value={draft.milestone.completionCriteria}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError(`criteria-${draft.entityId}`)}
              aria-describedby={fieldError(`criteria-${draft.entityId}`) ? `criteria-${draft.entityId}-error` : undefined}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, completionCriteria: event.target.value } })}
            />
          </PlanField>
          <PlanField label="验收要求" required htmlFor={`review-${draft.entityId}`} error={fieldMessages(`review-${draft.entityId}`)}>
            <Textarea
              id={`review-${draft.entityId}`}
              value={draft.milestone.reviewRequirements}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError(`review-${draft.entityId}`)}
              aria-describedby={fieldError(`review-${draft.entityId}`) ? `review-${draft.entityId}-error` : undefined}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, reviewRequirements: event.target.value } })}
            />
          </PlanField>
          <PlanField label="业务说明" htmlFor={`business-${draft.entityId}`} error={fieldMessages(`business-${draft.entityId}`)}>
            <Textarea
              id={`business-${draft.entityId}`}
              value={draft.milestone.businessDescription}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError(`business-${draft.entityId}`)}
              aria-describedby={fieldError(`business-${draft.entityId}`) ? `business-${draft.entityId}-error` : undefined}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, businessDescription: event.target.value } })}
            />
          </PlanField>
        </>
      )}

      {draft.kind === "TERMINATION" && (
        <>
          <PlanField label="Terminal 名称" required htmlFor="termination-name" error={fieldMessages("termination-name")}>
            <Input
              id="termination-name"
              value={draft.termination.name}
              maxLength={200}
              aria-invalid={fieldError("termination-name")}
              aria-describedby={fieldError("termination-name") ? "termination-name-error" : undefined}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, name: event.target.value } })}
            />
          </PlanField>
          <PlanField label="计划结束时间" required htmlFor="termination-plannedAt" error={fieldMessages("termination-plannedAt")}>
            <Input
              id="termination-plannedAt"
              type="datetime-local"
              value={draft.termination.plannedAt}
              aria-invalid={fieldError("termination-plannedAt")}
              aria-describedby={fieldError("termination-plannedAt") ? "termination-plannedAt-error" : undefined}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, plannedAt: event.target.value } })}
            />
          </PlanField>
          <PlanField label="结束条件" required htmlFor="termination-outcome" error={fieldMessages("termination-outcome")}>
            <Textarea
              id="termination-outcome"
              value={draft.termination.plannedOutcomeCriteria}
              maxLength={2_000}
              aria-invalid={fieldError("termination-outcome")}
              aria-describedby={fieldError("termination-outcome") ? "termination-outcome-error" : undefined}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, plannedOutcomeCriteria: event.target.value } })}
            />
          </PlanField>
          <PlanField label="业务说明" htmlFor="termination-business" error={fieldMessages("termination-business")}>
            <Textarea
              id="termination-business"
              value={draft.termination.businessDescription}
              maxLength={2_000}
              aria-invalid={fieldError("termination-business")}
              aria-describedby={fieldError("termination-business") ? "termination-business-error" : undefined}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, businessDescription: event.target.value } })}
            />
          </PlanField>
        </>
      )}

      {draft.kind === "MILESTONE" && !readOnly && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button type="button" size="sm" variant="destructive" onClick={() => onDelete(draft.milestone)}>
            <Trash2 aria-hidden="true" />
            {draft.isNew ? "删除临时节点" : "删除节点"}
          </Button>
        </div>
      )}
    </div>
  );
}

function PlanField({ label, required = false, htmlFor, error, children }: { label: string; required?: boolean; htmlFor: string; error?: readonly string[]; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
        {label}{required && <span className="ml-1 text-destructive">*</span>}
      </label>
      {children}
      <FieldError id={`${htmlFor}-error`} messages={error} className="mt-1.5" />
    </div>
  );
}

function suggestMilestoneAt(state: TaskComposerSeed) {
  const startMs = renderAtMs(state, TASK_COMPOSER_START_ID);
  const terminalMs = renderAtMs(state, state.termination.id);
  const lastMs = state.milestones.length > 0
    ? Math.max(...state.milestones.map((milestone) => renderAtMs(state, milestone.id)))
    : startMs;
  const preferred = lastMs + 7 * DAY_MS;
  const fallback = lastMs + Math.max(60_000, Math.floor((terminalMs - lastMs) / 2));
  return isoToShanghaiDateTimeLocal(new Date(preferred < terminalMs ? preferred : fallback));
}

function isStrictlyInsidePlan(state: TaskComposerSeed, atMs: number) {
  return (
    atMs > renderAtMs(state, TASK_COMPOSER_START_ID) &&
    atMs < renderAtMs(state, state.termination.id)
  );
}

function isTemporary(state: TaskComposerSeed, entityId: string) {
  return state.nodeMeta?.[entityId]?.lifecycle === "TEMPORARY";
}

function formatLocalDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? value.replace("T", " ")
    : "未设置";
}
