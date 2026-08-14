"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  cancelPlannedSegment,
  confirmPlannedSegment,
  createActualSegment,
  createWorkSegment,
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
import { DAY_MS } from "@/components/project-management/time-canvas/time-math";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import type {
  TimeCanvasModel,
  TimeCanvasRange,
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
  workSegmentStatusLabels,
  workSegmentTypeLabels,
} from "@/lib/project-management/labels";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type TaskOption = TaskOptionPage["items"][number];

export type CreateDraft = {
  rowId: string;
  personId: string;
  startMs: number;
  endMs: number;
};
export type SegmentChange = {
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

export function QuickCreatePanel({
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
        <Input id="quick-content" name="content" defaultValue="" required maxLength={2_000} />
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

export function SegmentInspector({
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
  onTaskNavigation,
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
  onTaskNavigation: () => boolean;
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
        <p className="mt-3 text-sm">{formatPlannerRange(canvasSegment.startMs, canvasSegment.endMs)}</p>
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
        <p className="mt-2 text-sm text-muted-foreground">{detail.personName} · {formatPlannerRange(Date.parse(detail.startAt), Date.parse(detail.endAt))}</p>
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
        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <ReadOnlyValue label="类型" value={workSegmentTypeLabels[detail.type]} />
          <ReadOnlyValue label="状态" value={workSegmentStatusLabels[detail.status]} />
          <ReadOnlyValue label="所属人员" value={detail.personName} />
          <ReadOnlyValue
            label="关联 Task"
            value={detail.task?.deleted ? (
              `${detail.task.title}（已删除）`
            ) : detail.task ? (
              <Link
                href={routes.progress.taskDetail(detail.task.id)}
                className="font-medium text-primary hover:underline"
                onClick={(event) => {
                  if (!onTaskNavigation()) event.preventDefault();
                }}
              >
                {detail.task.title}
              </Link>
            ) : "独立投入"}
          />
        </dl>
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
          关联对象：{detail.task
            ? `${detail.task.title}${detail.task.deleted ? "（已删除）" : ""}`
            : "独立投入"}
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
        if (coveredMinutes >= durationMinutes) {
          onRun(
            () => confirmPlannedSegment({
              segmentId: detail.id,
              expectedUpdatedAt: detail.updatedAt,
              reason: "投入详情完整确认",
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
          <span>{formatPlannerRange(startMs, startMs + 60_000).split(" – ")[0]}</span>
          <span>{formatPlannerRange(startMs, endMs).split(" – ")[1]}</span>
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
  value: React.ReactNode;
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

export function formatPlannerRange(startMs: number, endMs: number) {
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
  return formatPlannerRange(Date.parse(startAt), Date.parse(endAt));
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

export function explicitRangeForDraft(range: TimeCanvasRange, draft: CreateDraft) {
  const startDayMs = Date.parse(`${formatShanghaiDate(draft.startMs)}T00:00:00.000+08:00`);
  const endDayMs = Date.parse(`${formatShanghaiDate(draft.endMs)}T00:00:00.000+08:00`);
  const draftEndExclusive = draft.endMs > endDayMs ? endDayMs + DAY_MS : endDayMs;
  return {
    startMs: Math.min(range.startMs, startDayMs),
    endMs: Math.max(range.endMs, draftEndExclusive),
  };
}

const selectClass = "h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm";
