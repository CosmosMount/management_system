"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Plus,
  Trash2,
} from "lucide-react";
import {
  TaskPlanNodeNavigator,
  type TaskPlanNavigatorNode,
} from "@/components/project-management/task-plan-node-navigator";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { buildPlanPhaseBands } from "@/components/project-management/time-canvas/plan-phase-bands";
import type {
  TimeCanvasAnchorMoveRequest,
  TimeCanvasAnchorMoveResolution,
  TimeCanvasModel,
  TimeCanvasTone,
} from "@/components/project-management/time-canvas/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isoToShanghaiDateTimeLocal } from "@/lib/project-management/date-time";
import { cn } from "@/lib/utils";
import type {
  TaskComposerInspectorDraft,
  TaskComposerMilestone,
  TaskComposerSeed,
  ValidationIssue,
} from "@/components/project-management/task-composer-client";

const DAY_MS = 24 * 60 * 60 * 1_000;
const TASK_COMPOSER_START_ID = "task-composer-start";
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
  onUpdateInspector,
  onDeleteMilestones,
  onSubmit,
}: {
  state: TaskComposerSeed;
  issues: ValidationIssue[];
  inspectorDraft: TaskComposerInspectorDraft | null;
  inspectorIssues: ValidationIssue[];
  notice: { message: string; error: boolean } | null;
  optionLoading: boolean;
  submitting: boolean;
  submitDisabled?: boolean;
  submitLabel: string;
  submittingLabel: string;
  onSelect: (entityId: string) => void;
  onBeginMilestone: (at: string, source?: TaskComposerMilestone) => void;
  onConstrainAnchorMove: (
    request: TimeCanvasAnchorMoveRequest,
  ) => TimeCanvasAnchorMoveResolution;
  onMoveAnchor: (request: TimeCanvasAnchorMoveRequest) => void;
  onMoveTerminal: (at: string) => void;
  onUpdateInspector: (draft: TaskComposerInspectorDraft) => void;
  onDeleteMilestones: (ids: string[]) => void;
  onSubmit: () => void;
}) {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [quickAt, setQuickAt] = useState<{ atMs: number; snapMs: number } | null>(null);
  const canvasModel = useMemo(() => buildComposerCanvasModel(state, issues), [issues, state]);
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

  useEffect(() => {
    if (!quickAt) return;
    const closeQuickMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuickAt(null);
    };
    window.addEventListener("keydown", closeQuickMenu);
    return () => window.removeEventListener("keydown", closeQuickMenu);
  }, [quickAt]);

  const selectNavigatorNode = (nodeId: string) => {
    onSelect(nodeId);
    const anchor = canvasModel.anchors.find((item) => item.id === nodeId);
    const scroller = canvasContainerRef.current?.querySelector<HTMLElement>(
      "[data-testid='time-canvas-scroll']",
    );
    if (!anchor || !scroller) return;
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
            ref={canvasContainerRef}
            className="mt-4 hidden min-w-0 overflow-hidden rounded-lg border border-border lg:block"
          >
            <TimeCanvas
              mode="TASK_COMPOSER"
              model={canvasModel}
              initialZoom="DAY"
              display={{ showActual: false, showBusy: false, showInspector: false }}
              selection={
                state.selectedEntityId
                  ? { kind: "ANCHOR", id: state.selectedEntityId }
                  : null
              }
              emptyMessage="点击时间轴或添加按钮创建 Milestone"
              interaction={{
                enableAnchorCreate: true,
                onAnchorCreate: ({ atMs, snapMs }) => setQuickAt({ atMs, snapMs }),
                constrainAnchorMove: onConstrainAnchorMove,
                onAnchorMove: onMoveAnchor,
                onAnchorSelectionChange: (anchorId) => {
                  if (anchorId) onSelect(anchorId);
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
            onChange={onUpdateInspector}
            onDelete={(milestone) => onDeleteMilestones([milestone.id])}
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
    </>
  );
}

function buildComposerCanvasModel(
  state: TaskComposerSeed,
  issues: ValidationIssue[],
): TimeCanvasModel {
  const sortedMilestones = sortMilestonesForDisplay(state);
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
      editable: !isReadOnlyEntity(state, milestone.id),
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
  const validTimes = anchors.map((anchor) => anchor.atMs).filter(Number.isFinite);
  const start = Math.min(...validTimes);
  const end = Math.max(...validTimes);
  const duration = Math.max(DAY_MS, end - start);
  const padding = Math.max(DAY_MS, duration * 0.08);
  const phaseBands = buildPlanPhaseBands(anchors, PLAN_ROW_ID).map((band) => ({
    ...band,
    id: `composer-phase-${band.id}`,
  }));
  return {
    timezone: "Asia/Shanghai",
    range: { startMs: start - padding, endMs: end + padding + 1 },
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
  const milestoneNodes: TaskPlanNavigatorNode[] = sortMilestonesForDisplay(state).map(
    (milestone) => ({
      id: milestone.id,
      kind: "MILESTONE",
      label: milestone.goal || "临时 Milestone",
      at: milestone.expectedCompletedAt,
      status: isTemporary(state, milestone.id)
        ? "临时节点"
        : isReadOnlyEntity(state, milestone.id)
          ? "只读承接"
          : "计划中",
      completed: isReadOnlyEntity(state, milestone.id),
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
  onChange,
  onDelete,
}: {
  state: TaskComposerSeed;
  draft: TaskComposerInspectorDraft | null;
  issues: ValidationIssue[];
  onChange: (draft: TaskComposerInspectorDraft) => void;
  onDelete: (milestone: TaskComposerMilestone) => void;
}) {
  if (!draft) {
    return <p className="text-sm text-muted-foreground">从画布或节点列表选择一个节点进行编辑。</p>;
  }
  const readOnly = isReadOnlyEntity(state, draft.entityId);
  const fieldError = (key: string) => issues.some((issue) => issue.key === key);
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

      {draft.kind === "START" && (
        <PlanField label="计划开始时间" required htmlFor="plannedStartAt">
          <Input
            id="plannedStartAt"
            type="datetime-local"
            value={draft.plannedStartAt}
            readOnly={readOnly}
            aria-invalid={fieldError("plannedStartAt")}
            onChange={(event) => onChange({ ...draft, plannedStartAt: event.target.value })}
          />
        </PlanField>
      )}

      {draft.kind === "REVISION" && (
        <>
          <PlanField label="Revision 时间" required htmlFor="revisionAt">
            <Input
              id="revisionAt"
              type="datetime-local"
              value={draft.revision.revisionAt}
              readOnly={readOnly}
              aria-invalid={fieldError("revisionAt")}
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
          <PlanField label="Revision 名称" required htmlFor="revision-reason">
            <Input
              id="revision-reason"
              value={draft.revision.reason}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError("revision-reason")}
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
          >
            <Textarea
              id="revision-description"
              value={draft.revision.description}
              readOnly={readOnly}
              rows={7}
              maxLength={2_000}
              aria-invalid={fieldError("revision-description")}
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
          <PlanField label="目标" required htmlFor={`goal-${draft.entityId}`}>
            <Input
              id={`goal-${draft.entityId}`}
              value={draft.milestone.goal}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError(`goal-${draft.entityId}`)}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, goal: event.target.value } })}
            />
          </PlanField>
          <PlanField label="预期完成时间" required htmlFor={`expected-${draft.entityId}`}>
            <Input
              id={`expected-${draft.entityId}`}
              type="datetime-local"
              value={draft.milestone.expectedCompletedAt}
              readOnly={readOnly}
              aria-invalid={fieldError(`expected-${draft.entityId}`)}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, expectedCompletedAt: event.target.value } })}
            />
          </PlanField>
          <PlanField label="完成条件" required htmlFor={`criteria-${draft.entityId}`}>
            <Textarea
              id={`criteria-${draft.entityId}`}
              value={draft.milestone.completionCriteria}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError(`criteria-${draft.entityId}`)}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, completionCriteria: event.target.value } })}
            />
          </PlanField>
          <PlanField label="验收要求" required htmlFor={`review-${draft.entityId}`}>
            <Textarea
              id={`review-${draft.entityId}`}
              value={draft.milestone.reviewRequirements}
              readOnly={readOnly}
              maxLength={2_000}
              aria-invalid={fieldError(`review-${draft.entityId}`)}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, reviewRequirements: event.target.value } })}
            />
          </PlanField>
          <PlanField label="业务说明" htmlFor={`business-${draft.entityId}`}>
            <Textarea
              id={`business-${draft.entityId}`}
              value={draft.milestone.businessDescription}
              readOnly={readOnly}
              maxLength={2_000}
              onChange={(event) => onChange({ ...draft, milestone: { ...draft.milestone, businessDescription: event.target.value } })}
            />
          </PlanField>
        </>
      )}

      {draft.kind === "TERMINATION" && (
        <>
          <PlanField label="Terminal 名称" required htmlFor="termination-name">
            <Input
              id="termination-name"
              value={draft.termination.name}
              maxLength={200}
              aria-invalid={fieldError("termination-name")}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, name: event.target.value } })}
            />
          </PlanField>
          <PlanField label="计划结束时间" required htmlFor="termination-plannedAt">
            <Input
              id="termination-plannedAt"
              type="datetime-local"
              value={draft.termination.plannedAt}
              aria-invalid={fieldError("termination-plannedAt")}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, plannedAt: event.target.value } })}
            />
          </PlanField>
          <PlanField label="结束条件" required htmlFor="termination-outcome">
            <Textarea
              id="termination-outcome"
              value={draft.termination.plannedOutcomeCriteria}
              maxLength={2_000}
              aria-invalid={fieldError("termination-outcome")}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, plannedOutcomeCriteria: event.target.value } })}
            />
          </PlanField>
          <PlanField label="业务说明" htmlFor="termination-business">
            <Textarea
              id="termination-business"
              value={draft.termination.businessDescription}
              maxLength={2_000}
              onChange={(event) => onChange({ ...draft, termination: { ...draft.termination, businessDescription: event.target.value } })}
            />
          </PlanField>
        </>
      )}

      {issues.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {issues.map((issue) => <li key={`${issue.key}:${issue.message}`}>{issue.message}</li>)}
        </ul>
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

function PlanField({ label, required = false, htmlFor, children }: { label: string; required?: boolean; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
        {label}{required && <span className="ml-1 text-destructive">*</span>}
      </label>
      {children}
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

function sortMilestonesForDisplay(state: TaskComposerSeed) {
  return [...state.milestones].sort(
    (left, right) =>
      renderAtMs(state, left.id) - renderAtMs(state, right.id) ||
      left.id.localeCompare(right.id),
  );
}

function isTemporary(state: TaskComposerSeed, entityId: string) {
  return state.nodeMeta?.[entityId]?.lifecycle === "TEMPORARY";
}

function renderAtMs(state: TaskComposerSeed, entityId: string) {
  const stored = state.nodeMeta?.[entityId]?.lastValidAt;
  if (stored) return localMs(stored);
  if (state.revision?.markerId === entityId) {
    return localMs(state.revision.revisionAt);
  }
  const carriedRevision = state.revision?.carriedAnchors.find(
    (anchor) => anchor.id === entityId,
  );
  if (carriedRevision) return localMs(carriedRevision.revisionAt);
  if (entityId === TASK_COMPOSER_START_ID) return localMs(state.plannedStartAt);
  if (entityId === state.termination.id) return localMs(state.termination.plannedAt);
  return localMs(
    state.milestones.find((milestone) => milestone.id === entityId)
      ?.expectedCompletedAt ?? "",
  );
}

function isReadOnlyEntity(state: TaskComposerSeed, entityId: string) {
  if (!state.revision) return false;
  return (
    entityId === TASK_COMPOSER_START_ID ||
    state.revision.lockedMilestoneIds.includes(entityId) ||
    state.revision.carriedAnchors.some((anchor) => anchor.id === entityId)
  );
}

function localMs(value: string) {
  const parsed = new Date(`${value}:00+08:00`).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLocalDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? value.replace("T", " ")
    : "未设置";
}
