"use client";

import {
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
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
import type {
  TimeCanvasBrushRequest,
  TimeCanvasMode,
  TimeCanvasModel,
  TimeCanvasSelection,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
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
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
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
  id: string;
  action: string;
  reason: string | null;
  createdAt: string;
};

export function ResourcePlannerCanvasClient({
  initialModel,
  peopleOptions,
  taskOptions,
  peopleScope = { purpose: "VISIBLE" },
  defaultPersonId,
  initialZoom,
  mode = "RESOURCE_PLANNER",
  defaultTaskId = "",
  allowIndependent = true,
  allowCreate = true,
  readOnly = false,
  initialFocusId = null,
  navigateRangeByDate = false,
}: {
  initialModel: TimeCanvasModel;
  peopleOptions: PersonOptionDto[];
  taskOptions: TaskOption[];
  peopleScope?: UserPickerScope;
  defaultPersonId: string;
  initialZoom: TimeCanvasZoom;
  mode?: TimeCanvasMode;
  defaultTaskId?: string;
  allowIndependent?: boolean;
  allowCreate?: boolean;
  readOnly?: boolean;
  initialFocusId?: string | null;
  navigateRangeByDate?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const model = useMemo(
    () => ({
      ...initialModel,
      rows: readOnly
        ? initialModel.rows.map((row) => ({ ...row, editable: false }))
        : initialModel.rows,
      segments: initialModel.segments
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
    }),
    [initialModel, readOnly],
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
  const [selection, setSelection] = useState<TimeCanvasSelection>(initialSelection);
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(null);
  const [dialogDirty, setDialogDirty] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [detail, setDetail] = useState<WorkSegmentDetail | null>(null);
  const [detailRange, setDetailRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [changes, setChanges] = useState<SegmentChange[]>([]);
  const [detailState, setDetailState] = useState<"IDLE" | "LOADING" | "READY" | "ERROR">("IDLE");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
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
    void Promise.all([
      getWorkSegment({ segmentId: openSegmentId }),
      listWorkSegmentChanges({ segmentId: openSegmentId, limit: 20 }),
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
      setDetailRange({
        startMs: Date.parse(detailResult.data.startAt),
        endMs: Date.parse(detailResult.data.endAt),
      });
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
  }, [openSegmentId, selectedCanvasSegment]);
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
          if (stale) router.refresh();
          return;
        }
        setNotice({ kind: "success", message: successMessage });
        if (openSegmentId) {
          setOpenSegmentId(null);
          setDialogDirty(false);
          setSelection(null);
        }
        onSuccess?.();
        router.refresh();
      });
  };

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
    setNotice({ kind: "info", message: "已选择时间区间，请补全投入内容。" });
  }

  return (
    <div className="space-y-4" data-testid="resource-planner-workbench">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        {canCreateSegment && (
          <Button
            type="button"
            size="sm"
            disabled={isPending || Boolean(createDraft)}
            onClick={() =>
              setCreateDraft({
                rowId: quickCreateRowId,
                personId: quickCreatePersonId,
                startMs: model.range.startMs,
                endMs: Math.min(model.range.endMs, model.range.startMs + 60 * 60 * 1_000),
              })
            }
          >
            新增投入
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          双击投入打开详情；总览不会直接修改既有投入。
        </span>
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

      <div className="min-w-0">
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
          <TimeCanvas
            key={initialFocusId ?? "time-canvas"}
            mode={mode}
            model={model}
            initialZoom={initialZoom}
            initialSelection={initialSelection}
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
              onSegmentOpen: (segmentId) => {
                if (createDraft) {
                  setNotice({ kind: "info", message: "请先完成或取消当前投入创建。" });
                  return;
                }
                const segment = model.segments.find((item) => item.id === segmentId);
                if (!segment || segment.visibility !== "FULL") return;
                setSelection({ kind: "SEGMENT", id: segmentId });
                setOpenSegmentId(segmentId);
                setDialogDirty(false);
                setDetail(null);
                setDetailRange(null);
                setChanges([]);
                setDetailError("");
                setDetailState("LOADING");
              },
              onInvalidDrop: (message) => setNotice({ kind: "error", message }),
            }}
            selection={selection}
            onSelectionChange={setSelection}
            emptyMessage="当前筛选和时间范围内没有可见安排。"
            onRangeChange={navigateRangeByDate ? (range) => {
              const url = new URL(window.location.href);
              url.searchParams.set("date", formatShanghaiDate(range.startMs));
              url.searchParams.delete("focus");
              router.push(`${url.pathname}?${url.searchParams.toString()}`);
            } : undefined}
          />
        </div>
      </div>

      <Dialog
        open={Boolean(openSegmentId)}
        onOpenChange={(open) => {
          if (open || isPending) return;
          if (dialogDirty && !window.confirm("有未保存修改，确认放弃并关闭？")) return;
          setOpenSegmentId(null);
          setDialogDirty(false);
          setSelection(null);
        }}
      >
        <DialogContent className="max-h-[94dvh] max-w-[min(96vw,88rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>投入详情</DialogTitle>
            <DialogDescription>
              仅当前打开的投入可修改；同一行的其他安排仅作为时间参考。
            </DialogDescription>
          </DialogHeader>
          <SegmentInspector
            key={`${selectedCanvasSegment?.id ?? "none"}:${detail?.updatedAt ?? detailState}`}
            canvasSegment={selectedCanvasSegment}
            model={model}
            initialZoom={initialZoom}
            detail={detail}
            detailRange={detailRange}
            detailState={detailState}
            detailError={detailError}
            changes={changes}
            disabled={isPending}
            onRun={runMutation}
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
          key={`${createDraft.rowId}:${createDraft.startMs}:${createDraft.endMs}`}
          draft={createDraft}
          peopleOptions={peopleOptions}
          peopleScope={peopleScope}
          taskOptions={taskOptions}
          defaultTaskId={defaultTaskId}
          lockedTaskId={lockedTaskId}
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
  peopleOptions,
  peopleScope,
  taskOptions,
  defaultTaskId,
  lockedTaskId,
  allowIndependent,
  disabled,
  onCancel,
  onRun,
}: {
  draft: CreateDraft;
  peopleOptions: PersonOptionDto[];
  peopleScope: UserPickerScope;
  taskOptions: TaskOption[];
  defaultTaskId: string;
  lockedTaskId: string | null;
  allowIndependent: boolean;
  disabled: boolean;
  onCancel: () => void;
  onRun: (action: () => Promise<ProjectManagementActionResult<unknown>>) => void;
}) {
  const [personId, setPersonId] = useState<string | null>(draft.personId || null);
  const [taskId, setTaskId] = useState<string | null>(defaultTaskId || null);
  const lockedTask = lockedTaskId
    ? taskOptions.find((option) => option.id === lockedTaskId) ?? null
    : null;
  return (
    <form
      className="grid gap-3 rounded-xl border border-primary/30 bg-card p-4 md:grid-cols-2 xl:grid-cols-4"
      aria-label="投入快速创建"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const submittedTaskId = String(form.get("taskId") ?? "") || null;
        const type = String(form.get("type")) === "ACTUAL" ? "ACTUAL" : "PLANNED";
        const base = {
          personId: String(form.get("personId") ?? draft.personId),
          startAt: shanghaiDateTimeLocalToIso(String(form.get("startAt") ?? "")),
          endAt: shanghaiDateTimeLocalToIso(String(form.get("endAt") ?? "")),
          content: String(form.get("content") ?? ""),
          priority: String(form.get("priority") ?? "MEDIUM"),
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
          value={personId}
          onValueChange={setPersonId}
          initialOptions={peopleOptions}
          required
          clearable={false}
          disabled={disabled}
          placeholder="按姓名或拼音首字母搜索"
        />
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
        {lockedTaskId ? (
          <>
            <Input
              id="quick-task"
              value={lockedTask?.title ?? "当前 Task"}
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
            onValueChange={setTaskId}
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
  detail,
  detailRange,
  detailState,
  detailError,
  changes,
  disabled,
  onRun,
  onDirtyChange,
  onRangeChange,
}: {
  canvasSegment: TimeCanvasModel["segments"][number] | null;
  model: TimeCanvasModel;
  initialZoom: TimeCanvasZoom;
  detail: WorkSegmentDetail | null;
  detailRange: { startMs: number; endMs: number } | null;
  detailState: "IDLE" | "LOADING" | "READY" | "ERROR";
  detailError: string;
  changes: SegmentChange[];
  disabled: boolean;
  onRun: (
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
    rollback?: () => void,
  ) => void;
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
    return <aside className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive" role="alert">投入详情加载失败：{detailError}</aside>;
  }
  if (!detail || !detailRange || detailState === "LOADING") {
    return <aside className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">正在读取投入详情…</aside>;
  }
  const editable = canvasSegment.permissions.canEdit;
  const plannedEditable = detail.type === "PLANNED" && !["CONFIRMED", "CANCELLED"].includes(detail.status);
  const detailModel: TimeCanvasModel = {
    ...model,
    rows: model.rows.filter((row) => row.id === canvasSegment.rowId),
    anchors: model.anchors.filter((anchor) => anchor.rowId === canvasSegment.rowId),
    phaseBands: model.phaseBands?.filter((band) => band.rowId === canvasSegment.rowId),
    segments: model.segments
      .filter((segment) => segment.rowId === canvasSegment.rowId)
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
        <TimeCanvas
          mode="RESOURCE_PLANNER"
          model={detailModel}
          initialZoom={initialZoom}
          selection={{ kind: "SEGMENT", id: detail.id }}
          display={{ showActual: true, showBusy: true, showInspector: false }}
          interaction={editable ? {
            onSegmentTransform: (request) => {
              if (request.segmentId !== detail.id) return;
              onRangeChange({ startMs: request.startMs, endMs: request.endMs });
            },
          } : undefined}
          emptyMessage="当前投入没有可显示的时间上下文。"
        />
      </div>

      {editable && (
        <form
          className="grid gap-3"
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
                completionPercent: detail.type === "ACTUAL" ? numberOrNull(form.get("completionPercent")) : undefined,
              }),
              "已更新投入详情",
            );
          }}
        >
          <Field label="开始" htmlFor="inspect-start"><Input id="inspect-start" name="startAt" type="datetime-local" value={toLocal(detailRange.startMs)} onChange={(event) => onRangeChange({ startMs: Date.parse(shanghaiDateTimeLocalToIso(event.target.value)), endMs: detailRange.endMs })} required /></Field>
          <Field label="结束" htmlFor="inspect-end"><Input id="inspect-end" name="endAt" type="datetime-local" value={toLocal(detailRange.endMs)} onChange={(event) => onRangeChange({ startMs: detailRange.startMs, endMs: Date.parse(shanghaiDateTimeLocalToIso(event.target.value)) })} required /></Field>
          <Field label="内容" htmlFor="inspect-content"><Textarea id="inspect-content" name="content" defaultValue={detail.content} maxLength={2_000} required /></Field>
          <div className="grid gap-2">
            <Field label="完成比例" htmlFor="inspect-completion"><Input id="inspect-completion" name="completionPercent" type="number" min="0" max="100" disabled={detail.type !== "ACTUAL"} defaultValue={detail.completionPercent ?? ""} /></Field>
          </div>
          <Field label="优先级" htmlFor="inspect-priority"><select id="inspect-priority" name="priority" className={selectClass} defaultValue={detail.priority}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="预期输出" htmlFor="inspect-expected"><Textarea id="inspect-expected" name="expectedOutput" defaultValue={detail.expectedOutput} /></Field>
          <Field label="实际输出" htmlFor="inspect-actual"><Textarea id="inspect-actual" name="actualOutput" defaultValue={detail.actualOutput} /></Field>
          <Input name="reason" aria-label="修改原因" placeholder="修改原因（可选）" />
          <Button type="submit" disabled={disabled}>保存</Button>
        </form>
      )}

      {plannedEditable && canvasSegment.permissions.canConfirm && (
        <div className="space-y-3 border-t border-border pt-4">
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
          const nextMs = Date.parse(shanghaiDateTimeLocalToIso(event.target.value));
          const nextMinutes = Math.round((nextMs - startMs) / 60_000);
          setCoveredMinutes(Math.max(1, Math.min(durationMinutes, nextMinutes)));
          onDirtyChange(true);
        }}
        required
      />
      <Input name="reason" aria-label="部分确认原因" defaultValue="投入详情部分确认" required />
      <Button type="submit" variant="outline" disabled={disabled}>
        {coveredMinutes >= durationMinutes ? "完整确认" : "部分确认"}
      </Button>
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
