"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import {
  batchCancelPlannedSegments,
  batchConfirmPlannedSegments,
  cancelPlannedSegment,
  confirmPlannedSegment,
  createActualSegment,
  createWorkSegment,
  getWorkSegment,
  listWorkSegmentChanges,
  mergePlannedSegments,
  movePlannedSegments,
  partiallyConfirmSegment,
  relinkPlannedSegment,
  softDeleteActualSegment,
  splitPlannedSegment,
  updateWorkSegment,
} from "@/app/actions/project-management/segments";
import { searchTaskOptions as searchTaskOptionResults } from "@/app/actions/project-management/options";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import type {
  TimeCanvasBrushRequest,
  TimeCanvasMode,
  TimeCanvasModel,
  TimeCanvasSegmentTransformRequest,
  TimeCanvasSelection,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  workSegmentRoleLabels,
  workSegmentStatusLabels,
  workSegmentTypeLabels,
} from "@/lib/project-management/labels";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import { cn } from "@/lib/utils";

type PersonOption = { id: string; displayName: string };
type TaskOption = {
  id: string;
  title: string;
  activeNodeId: string | null;
};
type Notice = { kind: "success" | "error" | "info"; message: string } | null;
type CreateDraft = { personId: string; startMs: number; endMs: number };
type SegmentChange = {
  id: string;
  action: string;
  reason: string | null;
  createdAt: string;
};

export function ResourcePlannerCanvasClient({
  initialModel,
  people,
  tasks,
  defaultPersonId,
  initialZoom,
  mode = "RESOURCE_PLANNER",
  defaultTaskId = "",
  allowIndependent = true,
  initialFocusId = null,
}: {
  initialModel: TimeCanvasModel;
  people: PersonOption[];
  tasks: TaskOption[];
  defaultPersonId: string;
  initialZoom: TimeCanvasZoom;
  mode?: TimeCanvasMode;
  defaultTaskId?: string;
  allowIndependent?: boolean;
  initialFocusId?: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimisticModel, setOptimisticModel] = useState<{
    baseGeneratedAt: string;
    value: TimeCanvasModel;
  } | null>(null);
  const model = optimisticModel?.baseGeneratedAt === initialModel.generatedAt
    ? optimisticModel.value
    : initialModel;
  const setModel = useCallback((update: SetStateAction<TimeCanvasModel>) => {
    setOptimisticModel((current) => {
      const base = current?.baseGeneratedAt === initialModel.generatedAt
        ? current.value
        : initialModel;
      return {
        baseGeneratedAt: initialModel.generatedAt,
        value: typeof update === "function" ? update(base) : update,
      };
    });
  }, [initialModel]);
  const initialSelection = useMemo<TimeCanvasSelection>(() => {
    if (!initialFocusId) return null;
    if (initialModel.segments.some((segment) => segment.id === initialFocusId)) {
      return { kind: "SEGMENT", id: initialFocusId };
    }
    if (initialModel.conflicts.some((conflict) => conflict.id === initialFocusId)) {
      return { kind: "CONFLICT", id: initialFocusId };
    }
    if (initialModel.anchors.some((anchor) => anchor.id === initialFocusId)) {
      return { kind: "ANCHOR", id: initialFocusId };
    }
    return null;
  }, [initialFocusId, initialModel]);
  const [selection, setSelection] = useState<TimeCanvasSelection>(initialSelection);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [detail, setDetail] = useState<WorkSegmentDetail | null>(null);
  const [changes, setChanges] = useState<SegmentChange[]>([]);
  const [detailState, setDetailState] = useState<"IDLE" | "LOADING" | "READY" | "ERROR">("IDLE");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [searchedTasks, setSearchedTasks] = useState<TaskOption[]>([]);
  const availableTasks = useMemo(
    () => mergeTaskOptions(tasks, searchedTasks),
    [searchedTasks, tasks],
  );

  const searchAvailableTasks = useCallback(async (query: string) => {
    try {
      const result = await searchTaskOptionResults({
        query: query.trim() || undefined,
        statuses: ["ACTIVE"],
        limit: 50,
      });
      if (!result.ok) {
        return { ok: false as const, message: result.error.message };
      }
      const incoming = result.data.items.map((task) => ({
        id: task.id,
        title: task.title,
        activeNodeId: task.activeMilestone?.nodeId ?? null,
      }));
      setSearchedTasks((current) => mergeTaskOptions(current, incoming));
      return {
        ok: true as const,
        message:
          incoming.length > 0
            ? `已找到 ${incoming.length} 个 Task`
            : "没有找到可关联的 Active Task",
      };
    } catch {
      return { ok: false as const, message: "Task 搜索失败，请重试。" };
    }
  }, []);

  const selectedCanvasSegment = useMemo(
    () =>
      selection?.kind === "SEGMENT"
        ? model.segments.find((segment) => segment.id === selection.id) ?? null
        : null,
    [model.segments, selection],
  );
  const effectivePeople = useMemo(() => {
    const byId = new Map(people.map((person) => [person.id, person]));
    for (const row of model.rows) {
      if (row.kind === "PERSON" && !byId.has(row.sourceId)) {
        byId.set(row.sourceId, { id: row.sourceId, displayName: row.label });
      }
    }
    return [...byId.values()];
  }, [model.rows, people]);

  useEffect(() => {
    let active = true;
    if (
      selection?.kind !== "SEGMENT" ||
      !selectedCanvasSegment ||
      selectedCanvasSegment.visibility !== "FULL"
    ) {
      return () => {
        active = false;
      };
    }
    void Promise.all([
      getWorkSegment({ segmentId: selection.id }),
      listWorkSegmentChanges({ segmentId: selection.id, limit: 20 }),
    ]).then(([detailResult, historyResult]) => {
      if (!active) return;
      if (!detailResult.ok) {
        setDetail(null);
        setDetailError(detailResult.error.message);
        setDetailState("ERROR");
        return;
      }
      if (!historyResult.ok) {
        setDetail(null);
        setDetailError(`变更历史加载失败：${historyResult.error.message}`);
        setDetailState("ERROR");
        return;
      }
      setDetail(detailResult.data);
      setChanges(historyResult.data.items);
      setDetailState("READY");
    }).catch(() => {
      if (!active) return;
      setDetail(null);
      setChanges([]);
      setDetailError("网络异常，请稍后重试。");
      setDetailState("ERROR");
    });
    return () => {
      active = false;
    };
  }, [selectedCanvasSegment, selection]);

  const runMutation = useCallback(
    (
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
          if (stale) router.refresh();
          return;
        }
        setNotice({ kind: "success", message: successMessage });
        setSelectedIds(new Set());
        onSuccess?.();
        router.refresh();
      });
    },
    [router],
  );

  function handleBrush(request: TimeCanvasBrushRequest) {
    if (isPending) return;
    if (request.rowKind !== "PERSON") {
      setNotice({ kind: "error", message: "按 Task 分组时请使用精确表单选择人员。" });
      return;
    }
    setCreateDraft({
      personId: request.sourceId,
      startMs: request.startMs,
      endMs: request.endMs,
    });
    setNotice({ kind: "info", message: "已选择时间区间，请补全投入内容。" });
  }

  function handleTransform(request: TimeCanvasSegmentTransformRequest) {
    if (isPending) return;
    const current = model.segments.find((segment) => segment.id === request.segmentId);
    if (!current || current.type !== "PLANNED" || !current.versionToken) return;
    const previous = model;
    if (selection?.kind === "SEGMENT" && selection.id === request.segmentId) {
      setDetail(null);
      setChanges([]);
      setDetailError("");
      setDetailState("LOADING");
    }
    setModel((value) => ({
      ...value,
      segments: value.segments.map((segment) =>
        segment.id === request.segmentId
          ? { ...segment, startMs: request.startMs, endMs: request.endMs }
          : segment,
      ),
    }));
    runMutation(
      () =>
        movePlannedSegments({
          moves: [
            {
              segmentId: request.segmentId,
              expectedUpdatedAt: current.versionToken,
              startAt: new Date(request.startMs).toISOString(),
              endAt: new Date(request.endMs).toISOString(),
            },
          ],
          reason: request.kind === "MOVE" || request.kind === "KEYBOARD_MOVE"
            ? "时间画布移动"
            : "时间画布调整区间",
        }),
      request.kind === "MOVE" || request.kind === "KEYBOARD_MOVE"
        ? "已移动计划投入"
        : "已调整计划投入区间",
      () => setModel(previous),
    );
  }

  const selectedPlanned = model.segments.filter(
    (segment) =>
      selectedIds.has(segment.id) &&
      segment.type === "PLANNED" &&
      segment.versionToken,
  );
  const movableSelected = selectedPlanned.filter(
    (segment) => segment.permissions.canMove,
  );
  const cancelableSelected = selectedPlanned.filter(
    (segment) => segment.permissions.canCancel,
  );
  const confirmableSelected = selectedPlanned.filter(
    (segment) => segment.permissions.canConfirm,
  );
  const mergeableSelected = selectedPlanned.filter(
    (segment) => segment.permissions.canMerge,
  );

  const toggleSegmentSelection = useCallback((segmentId: string) => {
    const segment = model.segments.find((item) => item.id === segmentId);
    if (!segment || segment.type !== "PLANNED" || !segment.versionToken) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(segmentId)) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });
  }, [model.segments]);

  return (
    <div className="space-y-4" data-testid="resource-planner-workbench">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <Button
          type="button"
          size="sm"
          onClick={() =>
            setCreateDraft({
              personId: defaultPersonId,
              startMs: model.range.startMs,
              endMs: Math.min(model.range.endMs, model.range.startMs + 60 * 60 * 1_000),
            })
          }
        >
          新增投入
        </Button>
        <span className="text-sm text-muted-foreground">
          Shift+点击可多选；Shift+方向键移动，Alt+方向键调整结束时间。
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-sm">已选 {selectedIds.size} 条</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending || movableSelected.length !== selectedPlanned.length || movableSelected.length === 0}
            onClick={() => {
              const previous = model;
              const delta = 60 * 60 * 1_000;
              setModel((value) => ({
                ...value,
                segments: value.segments.map((segment) =>
                  selectedIds.has(segment.id)
                    ? { ...segment, startMs: segment.startMs + delta, endMs: segment.endMs + delta }
                    : segment,
                ),
              }));
              runMutation(
                () =>
                  movePlannedSegments({
                    moves: movableSelected.map((segment) => ({
                      segmentId: segment.id,
                      expectedUpdatedAt: segment.versionToken,
                      startAt: new Date(segment.startMs + delta).toISOString(),
                      endAt: new Date(segment.endMs + delta).toISOString(),
                    })),
                    reason: "时间画布批量平移 1 小时",
                  }),
                "已原子平移所选计划",
                () => setModel(previous),
              );
            }}
          >
            批量顺延 1 小时
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending || mergeableSelected.length !== selectedPlanned.length || mergeableSelected.length < 2}
            onClick={() =>
              runMutation(
                () =>
                  mergePlannedSegments({
                    segments: mergeableSelected.map((segment) => ({
                      segmentId: segment.id,
                      expectedUpdatedAt: segment.versionToken,
                    })),
                    reason: "时间画布批量合并",
                  }),
                "已合并所选计划",
              )
            }
          >
            合并所选
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending || confirmableSelected.length !== selectedPlanned.length || confirmableSelected.length === 0}
            onClick={() => {
              if (!window.confirm(`确认完整确认所选 ${confirmableSelected.length} 条计划并生成 Actual？`)) return;
              runMutation(
                () => batchConfirmPlannedSegments({
                  segments: confirmableSelected.map((segment) => ({
                    segmentId: segment.id,
                    expectedUpdatedAt: segment.versionToken,
                  })),
                  reason: "时间画布批量完整确认",
                }),
                "已原子确认所选计划并生成 Actual",
              );
            }}
          >
            批量完整确认
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={isPending || cancelableSelected.length !== selectedPlanned.length || cancelableSelected.length === 0}
            onClick={() => {
              if (!window.confirm(`确认取消所选 ${cancelableSelected.length} 条计划？该操作会保留完整历史。`)) return;
              runMutation(
                () => batchCancelPlannedSegments({
                  segments: cancelableSelected.map((segment) => ({
                    segmentId: segment.id,
                    expectedUpdatedAt: segment.versionToken,
                  })),
                  reason: "时间画布批量取消",
                }),
                "已原子取消所选计划",
              );
            }}
          >
            批量取消
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            清除选择
          </Button>
        </div>
      </div>

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

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
          <TimeCanvas
            key={initialFocusId ?? "time-canvas"}
            mode={mode}
            model={model}
            initialZoom={initialZoom}
            initialSelection={initialSelection}
            display={{ showActual: true, showBusy: true, showConflicts: true, showInspector: false }}
            interaction={{
              enableBrushCreate: !isPending,
              selectedSegmentIds: selectedIds,
              onBrushCreate: handleBrush,
              onSegmentTransform: isPending ? undefined : handleTransform,
              onSegmentToggleSelection: toggleSegmentSelection,
              onInvalidDrop: (message) => setNotice({ kind: "error", message }),
            }}
            onSelectionChange={(next) => {
              setSelection(next);
              setDetail(null);
              setChanges([]);
              const selected = next?.kind === "SEGMENT"
                ? model.segments.find((segment) => segment.id === next.id)
                : null;
              setDetailState(selected?.visibility === "FULL" ? "LOADING" : "IDLE");
              setDetailError("");
            }}
            emptyMessage="当前筛选和时间范围内没有可见安排。"
          />
        </div>
        <SegmentInspector
          key={`${selectedCanvasSegment?.id ?? "none"}:${detail?.updatedAt ?? detailState}`}
          canvasSegment={selectedCanvasSegment}
          detail={detail}
          detailState={detailState}
          detailError={detailError}
          changes={changes}
          tasks={availableTasks}
          onSearchTasks={searchAvailableTasks}
          disabled={isPending}
          onRun={runMutation}
          onToggleSelected={toggleSegmentSelection}
          selected={Boolean(selectedCanvasSegment && selectedIds.has(selectedCanvasSegment.id))}
        />
      </div>

      {createDraft && (
        <QuickCreatePanel
          draft={createDraft}
          people={effectivePeople}
          tasks={availableTasks}
          onSearchTasks={searchAvailableTasks}
          defaultTaskId={defaultTaskId}
          allowIndependent={allowIndependent}
          disabled={isPending}
          onCancel={() => setCreateDraft(null)}
          onRun={(action) => {
            runMutation(action, "已创建投入记录", undefined, () => setCreateDraft(null));
          }}
        />
      )}
    </div>
  );
}

function QuickCreatePanel({
  draft,
  people,
  tasks,
  onSearchTasks,
  defaultTaskId,
  allowIndependent,
  disabled,
  onCancel,
  onRun,
}: {
  draft: CreateDraft;
  people: PersonOption[];
  tasks: TaskOption[];
  onSearchTasks: TaskSearchHandler;
  defaultTaskId: string;
  allowIndependent: boolean;
  disabled: boolean;
  onCancel: () => void;
  onRun: (action: () => Promise<ProjectManagementActionResult<unknown>>) => void;
}) {
  return (
    <form
      className="grid gap-3 rounded-xl border border-primary/30 bg-card p-4 md:grid-cols-2 xl:grid-cols-4"
      aria-label="投入快速创建"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const taskId = String(form.get("taskId") ?? defaultTaskId);
        const task = tasks.find((item) => item.id === taskId);
        const type = String(form.get("type")) === "ACTUAL" ? "ACTUAL" : "PLANNED";
        const base = {
          personId: String(form.get("personId") ?? draft.personId),
          startAt: shanghaiDateTimeLocalToIso(String(form.get("startAt") ?? "")),
          endAt: shanghaiDateTimeLocalToIso(String(form.get("endAt") ?? "")),
          content: String(form.get("content") ?? ""),
          allocation: numberOrNull(form.get("allocation")),
          role: String(form.get("role") ?? "DEVELOPER"),
          customRole: String(form.get("customRole") ?? ""),
          priority: String(form.get("priority") ?? "MEDIUM"),
          taskId: taskId || null,
          nodeId: task?.activeNodeId ?? null,
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
        <select id="quick-person" name="personId" className={selectClass} defaultValue={draft.personId}>
          {people.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
        </select>
      </Field>
      <Field label="开始" htmlFor="quick-start">
        <Input id="quick-start" name="startAt" type="datetime-local" defaultValue={toLocal(draft.startMs)} required />
      </Field>
      <Field label="结束" htmlFor="quick-end">
        <Input id="quick-end" name="endAt" type="datetime-local" defaultValue={toLocal(draft.endMs)} required />
      </Field>
      <Field label="内容" htmlFor="quick-content" className="md:col-span-2">
        <Input id="quick-content" name="content" defaultValue="计划投入" required maxLength={2_000} />
      </Field>
      <Field label="Task" htmlFor="quick-task">
        <TaskSearchControl
          idPrefix="quick"
          disabled={disabled}
          onSearch={onSearchTasks}
        />
        <select
          id="quick-task"
          name="taskId"
          className={selectClass}
          defaultValue={defaultTaskId}
          required={!allowIndependent}
        >
          {allowIndependent && <option value="">独立投入</option>}
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </Field>
      <Field label="投入比例" htmlFor="quick-allocation">
        <Input id="quick-allocation" name="allocation" type="number" min="1" max="100" step="0.01" defaultValue="50" />
      </Field>
      <Field label="职责" htmlFor="quick-role">
        <select id="quick-role" name="role" className={selectClass} defaultValue="DEVELOPER">
          {Object.entries(workSegmentRoleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <Field label="自定义职责" htmlFor="quick-custom-role">
        <Input id="quick-custom-role" name="customRole" maxLength={100} placeholder="选择“自定义”时必填" />
      </Field>
      <Field label="优先级" htmlFor="quick-priority">
        <select id="quick-priority" name="priority" className={selectClass} defaultValue="MEDIUM">
          {Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
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
  detail,
  detailState,
  detailError,
  changes,
  tasks,
  onSearchTasks,
  disabled,
  onRun,
  onToggleSelected,
  selected,
}: {
  canvasSegment: TimeCanvasModel["segments"][number] | null;
  detail: WorkSegmentDetail | null;
  detailState: "IDLE" | "LOADING" | "READY" | "ERROR";
  detailError: string;
  changes: SegmentChange[];
  tasks: TaskOption[];
  onSearchTasks: TaskSearchHandler;
  disabled: boolean;
  onRun: (
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
    rollback?: () => void,
  ) => void;
  onToggleSelected: (segmentId: string) => void;
  selected: boolean;
}) {
  if (!canvasSegment) {
    return <aside className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">选择画布中的投入查看 Inspector。</aside>;
  }
  if (canvasSegment.type === "BUSY") {
    return (
      <aside className="rounded-xl border border-border bg-card p-5" data-testid="segment-inspector">
        <h2 className="font-semibold">其他占用</h2>
        <p className="mt-2 text-sm text-muted-foreground">详情受限，仅显示时间与安全投入摘要。</p>
        <p className="mt-3 text-sm">{formatRange(canvasSegment.startMs, canvasSegment.endMs)}</p>
        <p className="mt-1 text-sm">投入：{canvasSegment.allocation == null ? "未提供" : `${canvasSegment.allocation}%`}</p>
      </aside>
    );
  }
  if (detailState === "ERROR") {
    return <aside className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive" role="alert">投入详情加载失败：{detailError}</aside>;
  }
  if (!detail || detailState === "LOADING") {
    return <aside className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">正在读取投入详情…</aside>;
  }
  const editable = canvasSegment.permissions.canEdit;
  const plannedEditable = detail.type === "PLANNED" && !["CONFIRMED", "CANCELLED"].includes(detail.status);
  return (
    <aside className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4" data-testid="segment-inspector">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-words font-semibold">{detail.content}</h2>
          <Badge variant={detail.type === "ACTUAL" ? "default" : "outline"}>{workSegmentTypeLabels[detail.type]}</Badge>
          <Badge variant="secondary">{workSegmentStatusLabels[detail.status]}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{detail.personName} · {formatRange(Date.parse(detail.startAt), Date.parse(detail.endAt))}</p>
        <p className="mt-1 text-sm text-muted-foreground">{detail.task?.title ?? "独立投入"}{detail.associationNeedsReview ? " · 关联需复核" : ""}</p>
        {plannedEditable && (
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => onToggleSelected(detail.id)}>
            {selected ? "移出多选" : "加入多选"}
          </Button>
        )}
      </div>

      {editable && (
        <form
          className="grid gap-3"
          aria-label="编辑投入详情"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            onRun(
              () => updateWorkSegment({
                segmentId: detail.id,
                expectedUpdatedAt: detail.updatedAt,
                reason: String(form.get("reason") ?? "Inspector 精确更新"),
                startAt: shanghaiDateTimeLocalToIso(String(form.get("startAt") ?? "")),
                endAt: shanghaiDateTimeLocalToIso(String(form.get("endAt") ?? "")),
                content: String(form.get("content") ?? ""),
                allocation: numberOrNull(form.get("allocation")),
                role: String(form.get("role") ?? detail.role),
                customRole: String(form.get("customRole") ?? ""),
                priority: String(form.get("priority") ?? detail.priority),
                expectedOutput: String(form.get("expectedOutput") ?? ""),
                actualOutput: String(form.get("actualOutput") ?? ""),
                completionPercent: detail.type === "ACTUAL" ? numberOrNull(form.get("completionPercent")) : undefined,
              }),
              "已更新投入详情",
            );
          }}
        >
          <Field label="开始" htmlFor="inspect-start"><Input id="inspect-start" name="startAt" type="datetime-local" defaultValue={toLocal(Date.parse(detail.startAt))} required /></Field>
          <Field label="结束" htmlFor="inspect-end"><Input id="inspect-end" name="endAt" type="datetime-local" defaultValue={toLocal(Date.parse(detail.endAt))} required /></Field>
          <Field label="内容" htmlFor="inspect-content"><Textarea id="inspect-content" name="content" defaultValue={detail.content} maxLength={2_000} required /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="投入比例" htmlFor="inspect-allocation"><Input id="inspect-allocation" name="allocation" type="number" min="1" max="100" step="0.01" defaultValue={detail.allocation ?? ""} /></Field>
            <Field label="完成比例" htmlFor="inspect-completion"><Input id="inspect-completion" name="completionPercent" type="number" min="0" max="100" disabled={detail.type !== "ACTUAL"} defaultValue={detail.completionPercent ?? ""} /></Field>
          </div>
          <Field label="职责" htmlFor="inspect-role"><select id="inspect-role" name="role" className={selectClass} defaultValue={detail.role}>{Object.entries(workSegmentRoleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="自定义职责" htmlFor="inspect-custom-role"><Input id="inspect-custom-role" name="customRole" defaultValue={detail.customRole} maxLength={100} placeholder="选择“自定义”时必填" /></Field>
          <Field label="优先级" htmlFor="inspect-priority"><select id="inspect-priority" name="priority" className={selectClass} defaultValue={detail.priority}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="预期输出" htmlFor="inspect-expected"><Textarea id="inspect-expected" name="expectedOutput" defaultValue={detail.expectedOutput} /></Field>
          <Field label="实际输出" htmlFor="inspect-actual"><Textarea id="inspect-actual" name="actualOutput" defaultValue={detail.actualOutput} /></Field>
          <Input name="reason" aria-label="修改原因" placeholder="修改原因（可选）" />
          <Button type="submit" disabled={disabled}>保存精确修改</Button>
        </form>
      )}

      {plannedEditable && canvasSegment.permissions.canConfirm && (
        <div className="space-y-3 border-t border-border pt-4">
          <Button type="button" className="w-full" disabled={disabled} onClick={() => onRun(() => confirmPlannedSegment({ segmentId: detail.id, expectedUpdatedAt: detail.updatedAt, reason: "Inspector 完整确认" }), "已完整确认并生成 Actual")}>完整确认</Button>
          <form className="grid gap-2" aria-label="部分确认" onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            onRun(() => partiallyConfirmSegment({
              segmentId: detail.id,
              expectedUpdatedAt: detail.updatedAt,
              coveredStartAt: shanghaiDateTimeLocalToIso(String(form.get("coveredStartAt") ?? "")),
              coveredEndAt: shanghaiDateTimeLocalToIso(String(form.get("coveredEndAt") ?? "")),
              reason: String(form.get("reason") ?? "Inspector 部分确认"),
            }), "已按所选区间部分确认");
          }}>
            <p className="text-sm font-medium">部分确认（必须明确选择区间）</p>
            <Input name="coveredStartAt" aria-label="确认开始" type="datetime-local" defaultValue={toLocal(Date.parse(detail.startAt))} required />
            <Input name="coveredEndAt" aria-label="确认结束" type="datetime-local" required />
            <Input name="reason" aria-label="部分确认原因" defaultValue="Inspector 部分确认" required />
            <Button type="submit" variant="outline" disabled={disabled}>部分确认</Button>
          </form>
        </div>
      )}

      {plannedEditable && canvasSegment.permissions.canSplit && (
        <form className="grid gap-2 border-t border-border pt-4" aria-label="拆分计划" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const splitAt = shanghaiDateTimeLocalToIso(String(form.get("splitAt") ?? ""));
          onRun(() => splitPlannedSegment({
            segmentId: detail.id,
            expectedUpdatedAt: detail.updatedAt,
            reason: String(form.get("reason") ?? ""),
            parts: [
              { startAt: detail.startAt, endAt: splitAt },
              { startAt: splitAt, endAt: detail.endAt },
            ],
          }), "已按指定切分点拆分计划");
        }}>
          <p className="text-sm font-medium">拆分（必须明确选择切分点）</p>
          <Input name="splitAt" aria-label="切分时间" type="datetime-local" required />
          <Input name="reason" aria-label="拆分原因" defaultValue="Inspector 拆分计划" required />
          <Button type="submit" variant="outline" disabled={disabled}>拆分</Button>
        </form>
      )}

      {detail.associationNeedsReview && canvasSegment.permissions.canRelink && (
        <form className="grid gap-2 border-t border-border pt-4" aria-label="重新关联" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const taskId = String(form.get("taskId") ?? "");
          const task = tasks.find((item) => item.id === taskId);
          onRun(() => relinkPlannedSegment({
            segmentId: detail.id,
            expectedUpdatedAt: detail.updatedAt,
            taskId: taskId || null,
            nodeId: task?.activeNodeId ?? null,
            reason: String(form.get("reason") ?? ""),
          }), "已重新确认关联");
        }}>
          <p className="text-sm font-medium">重新关联</p>
          <TaskSearchControl
            idPrefix="relink"
            disabled={disabled}
            onSearch={onSearchTasks}
          />
          <select name="taskId" aria-label="新的 Task" className={selectClass} defaultValue={detail.taskId ?? ""}>
            <option value="">独立投入</option>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
          <Input name="reason" aria-label="重关联原因" defaultValue="Inspector 重新关联" required />
          <Button type="submit" variant="outline" disabled={disabled}>确认关联</Button>
        </form>
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
          {detail.node ? ` · ${detail.node.type} / ${detail.node.status}` : " · 未关联计划节点"}
          {` · 冲突 ${canvasSegment.conflictIds.length} 个`}
        </p>
        {detail.plannedSources.length > 0 && (
          <div className="mt-2 text-xs">
            <p className="font-medium">由本 Planned 生成的 Actual</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {detail.plannedSources.map((source) => (
                <li key={source.id} className="break-words">
                  覆盖 {formatIsoRange(source.coveredStartAt, source.coveredEndAt)} · Actual {formatIsoRange(source.actualSegment.startAt, source.actualSegment.endAt)}{source.actualSegment.deletedAt ? "（已删除）" : ""}
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
        {changes.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">暂无可见变更。</p> : (
          <ol className="mt-2 space-y-2 text-xs">
            {changes.map((change) => <li key={change.id} className="rounded border border-border p-2"><span className="font-medium">{change.action}</span> · {new Date(change.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}<br />{change.reason || "未填写原因"}</li>)}
          </ol>
        )}
      </section>
    </aside>
  );
}

type TaskSearchHandler = (
  query: string,
) => Promise<{ ok: true; message: string } | { ok: false; message: string }>;

function TaskSearchControl({
  idPrefix,
  disabled,
  onSearch,
}: {
  idPrefix: string;
  disabled: boolean;
  onSearch: TaskSearchHandler;
}) {
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [isSearching, startSearch] = useTransition();
  const inputId = `${idPrefix}-task-search`;
  return (
    <div className="grid gap-1">
      <Label htmlFor={inputId}>Task 搜索关键词</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入 Task 名称"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || isSearching}
          onClick={() => {
            startSearch(async () => {
              const result = await onSearch(query);
              setMessage(result.message);
            });
          }}
        >
          搜索可关联 Task
        </Button>
      </div>
      {message && (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function mergeTaskOptions(current: TaskOption[], incoming: TaskOption[]) {
  const merged = new Map(current.map((task) => [task.id, task]));
  incoming.forEach((task) => merged.set(task.id, task));
  return [...merged.values()];
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

function Field({ label, htmlFor, className, children }: { label: string; htmlFor: string; className?: string; children: React.ReactNode }) {
  return <div className={cn("grid gap-1.5", className)}><Label htmlFor={htmlFor}>{label}</Label>{children}</div>;
}

function numberOrNull(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text ? Number(text) : null;
}

function toLocal(timeMs: number) {
  return isoToShanghaiDateTimeLocal(new Date(timeMs).toISOString());
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

const selectClass = "h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm";
