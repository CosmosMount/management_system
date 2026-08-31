"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  cancelPlannedSegment,
  confirmPlannedSegment,
  partiallyConfirmSegment,
  softDeleteActualSegment,
  updateWorkSegment,
} from "@/app/actions/project-management/segments";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import type {
  TimeCanvasModel,
  TimeCanvasRange,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectManagementActionFailure, ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  fieldErrorsFullyHandled,
  firstFieldErrorMessage,
} from "@/lib/project-management/field-errors";
import {
  taskPriorityLabels,
  workSegmentStatusLabels,
  workSegmentTypeLabels,
} from "@/lib/project-management/labels";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import {
  Field,
  formatPlannerRange,
  parseShanghaiLocalMs,
  selectClass,
  supportedFieldErrors,
  toLocal,
  validateSegmentRangeInputs,
  type SegmentChange,
} from "@/components/project-management/resource-planner-panel-support";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export { QuickCreatePanel } from "@/components/project-management/resource-planner-quick-create-panel";
export {
  explicitRangeForDraft,
  formatPlannerRange,
} from "@/components/project-management/resource-planner-panel-support";
export type {
  CreateDraft,
  SegmentChange,
} from "@/components/project-management/resource-planner-panel-support";

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
    onSuccess?: () => void,
    onFailure?: (error: ProjectManagementActionFailure["error"]) => boolean | void,
  ) => void;
  onRetryDetail: () => void;
  onLoadMoreChanges: () => void;
  onRetryHistory: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onTaskNavigation: () => boolean;
  onRangeChange: (range: { startMs: number; endMs: number }) => void;
}) {
  const [editErrors, setEditErrors] = useState<Record<string, string[]>>({});
  const clearEditError = (key: string) => {
    setEditErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
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
          noValidate
          onChange={() => onDirtyChange(true)}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const submittedRange = validateSegmentRangeInputs(
              String(form.get("startAt") ?? ""),
              String(form.get("endAt") ?? ""),
            );
            if (!submittedRange.ok) {
              setEditErrors((current) => ({
                ...current,
                startAt: [submittedRange.message],
              }));
              requestAnimationFrame(() => document.getElementById("inspect-start")?.focus());
              return;
            }
            const content = String(form.get("content") ?? "");
            if (!content.trim()) {
              const next = { content: ["请输入工作内容"] };
              setEditErrors((current) => ({ ...current, ...next }));
              requestAnimationFrame(() => document.getElementById("inspect-content")?.focus());
              return;
            }
            onRun(
              () => updateWorkSegment({
                segmentId: detail.id,
                expectedUpdatedAt: detail.updatedAt,
                reason: String(form.get("reason") ?? "投入详情更新"),
                startAt: new Date(detailRange.startMs).toISOString(),
                endAt: new Date(detailRange.endMs).toISOString(),
                content,
                priority: String(form.get("priority") ?? detail.priority),
                expectedOutput: String(form.get("expectedOutput") ?? ""),
                actualOutput: String(form.get("actualOutput") ?? ""),
              }),
              "已更新投入详情",
              undefined,
              undefined,
              (error) => {
                const next = supportedFieldErrors(error.fieldErrors, ["startAt", "endAt", "content", "priority", "expectedOutput", "actualOutput", "reason"]);
                if (Object.keys(next).length === 0) return false;
                setEditErrors(next);
                const first = ["startAt", "endAt", "content", "priority", "expectedOutput", "actualOutput", "reason"].find((key) => next[key]);
                const id = first === "startAt" ? "inspect-start" : first === "endAt" ? "inspect-end" : first ? `inspect-${first === "expectedOutput" ? "expected" : first === "actualOutput" ? "actual" : first}` : "inspect-content";
                requestAnimationFrame(() => document.getElementById(id)?.focus());
                return fieldErrorsFullyHandled(error.fieldErrors, [
                  "startAt",
                  "endAt",
                  "content",
                  "priority",
                  "expectedOutput",
                  "actualOutput",
                  "reason",
                ]);
              },
            );
          }}
        >
          <SegmentRangeFields range={detailRange} onRangeChange={onRangeChange} errors={editErrors} onClearError={clearEditError} />
          <Field label="内容" htmlFor="inspect-content" className="md:col-span-2"><Textarea id="inspect-content" name="content" defaultValue={detail.content} maxLength={2_000} required aria-invalid={Boolean(editErrors.content)} aria-describedby={editErrors.content ? "inspect-content-error" : undefined} onChange={() => clearEditError("content")} /><FieldError id="inspect-content-error" messages={editErrors.content} /></Field>
          <Field label="优先级" htmlFor="inspect-priority"><select id="inspect-priority" name="priority" className={selectClass} defaultValue={detail.priority} aria-invalid={Boolean(editErrors.priority)} aria-describedby={editErrors.priority ? "inspect-priority-error" : undefined} onChange={() => clearEditError("priority")}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><FieldError id="inspect-priority-error" messages={editErrors.priority} /></Field>
          <Field label="预期输出" htmlFor="inspect-expected" className="md:col-span-2"><Textarea id="inspect-expected" name="expectedOutput" defaultValue={detail.expectedOutput} maxLength={2_000} aria-invalid={Boolean(editErrors.expectedOutput)} aria-describedby={editErrors.expectedOutput ? "inspect-expected-error" : undefined} onChange={() => clearEditError("expectedOutput")} /><FieldError id="inspect-expected-error" messages={editErrors.expectedOutput} /></Field>
          <Field label="实际输出" htmlFor="inspect-actual" className="md:col-span-2"><Textarea id="inspect-actual" name="actualOutput" defaultValue={detail.actualOutput} maxLength={2_000} aria-invalid={Boolean(editErrors.actualOutput)} aria-describedby={editErrors.actualOutput ? "inspect-actual-error" : undefined} onChange={() => clearEditError("actualOutput")} /><FieldError id="inspect-actual-error" messages={editErrors.actualOutput} /></Field>
          <div className="md:col-span-2"><Input id="inspect-reason" name="reason" aria-label="修改原因" placeholder="修改原因（可选）" aria-invalid={Boolean(editErrors.reason)} aria-describedby={editErrors.reason ? "inspect-reason-error" : undefined} onChange={() => clearEditError("reason")} /><FieldError id="inspect-reason-error" messages={editErrors.reason} className="mt-1.5" /></div>
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
          <PlannedConfirmationForm
            detail={detail}
            disabled={disabled}
            onDirtyChange={onDirtyChange}
            onRun={onRun}
          />
        </div>
      )}

      {plannedEditable && canvasSegment.permissions.canCancel && (
        <ReasonAction label="取消计划" destructive disabled={disabled} onSubmit={(reason, onFailure) => onRun(() => cancelPlannedSegment({ segmentId: detail.id, expectedUpdatedAt: detail.updatedAt, reason }), "已取消计划", undefined, undefined, onFailure)} />
      )}
      {detail.type === "ACTUAL" && canvasSegment.permissions.canSoftDelete && (
        <ReasonAction label="删除 Actual" destructive disabled={disabled} onSubmit={(reason, onFailure) => onRun(() => softDeleteActualSegment({ segmentId: detail.id, expectedUpdatedAt: detail.updatedAt, reason }), "已软删除 Actual", undefined, undefined, onFailure)} />
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

function ReasonAction({ label, destructive, disabled, onSubmit }: { label: string; destructive?: boolean; disabled: boolean; onSubmit: (reason: string, onFailure: (error: ProjectManagementActionFailure["error"]) => boolean) => void }) {
  const [reasonError, setReasonError] = useState("");
  const inputId = label === "取消计划" ? "cancel-segment-reason" : "delete-segment-reason";
  return (
    <form className="grid gap-2 border-t border-border pt-4" noValidate onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const reason = String(form.get("reason") ?? "");
      if (!reason.trim()) {
        setReasonError(label === "取消计划" ? "请输入取消原因" : "请输入删除原因");
        requestAnimationFrame(() => document.getElementById(inputId)?.focus());
        return;
      }
      onSubmit(reason, (error) => {
        const message = firstFieldErrorMessage(error.fieldErrors, "reason");
        if (!message) return false;
        setReasonError(message);
        requestAnimationFrame(() => document.getElementById(inputId)?.focus());
        return fieldErrorsFullyHandled(error.fieldErrors, ["reason"]);
      });
    }}>
      <Input id={inputId} name="reason" aria-label={`${label}原因`} placeholder={`${label}原因`} required aria-invalid={Boolean(reasonError)} aria-describedby={reasonError ? `${inputId}-error` : undefined} onChange={(event) => { if (event.target.value.trim()) setReasonError(""); }} />
      <FieldError id={`${inputId}-error`} messages={reasonError} />
      <Button type="submit" variant={destructive ? "destructive" : "outline"} disabled={disabled}>{label}</Button>
    </form>
  );
}

function SegmentRangeFields({
  range,
  onRangeChange,
  errors,
  onClearError,
}: {
  range: TimeCanvasRange;
  onRangeChange: (range: TimeCanvasRange) => void;
  errors: Record<string, string[]>;
  onClearError: (key: string) => void;
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
          aria-invalid={Boolean(rangeError || errors.startAt)}
          aria-describedby={rangeError || errors.startAt ? "inspect-range-error" : undefined}
          onChange={(event) => { onClearError("startAt"); updateRangeInputs(event.target.value, endValue); }}
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
          aria-invalid={Boolean(rangeError || errors.endAt)}
          aria-describedby={rangeError || errors.endAt ? "inspect-range-error" : undefined}
          onChange={(event) => { onClearError("endAt"); updateRangeInputs(startValue, event.target.value); }}
          required
        />
      </Field>
      <FieldError
        id="inspect-range-error"
        messages={rangeError || [...(errors.startAt ?? []), ...(errors.endAt ?? [])]}
        className="md:col-span-2"
      />
    </>
  );
}

function PlannedConfirmationForm({
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
    rollback?: () => void,
    onSuccess?: () => void,
    onFailure?: (error: ProjectManagementActionFailure["error"]) => boolean | void,
  ) => void;
}) {
  const startMs = Date.parse(detail.startAt);
  const endMs = Date.parse(detail.endAt);
  const durationMs = endMs - startMs;
  const canPartiallyConfirm = durationMs > 60_000;
  const maxPartialMinutes = Math.max(1, Math.ceil(durationMs / 60_000) - 1);
  const [coveredMinutes, setCoveredMinutes] = useState(() =>
    Math.min(
      maxPartialMinutes,
      Math.max(1, Math.round(durationMs / 2 / 60_000)),
    ),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const coveredEndAt = new Date(startMs + coveredMinutes * 60_000).toISOString();
  const clearError = (key: string) => {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const handleFailure = (
    error: ProjectManagementActionFailure["error"],
    includeRange: boolean,
  ) => {
    const supportedPaths = [
      "actual.content",
      "actual.actualOutput",
      ...(includeRange ? ["coveredStartAt", "coveredEndAt"] : []),
    ];
    const raw = supportedFieldErrors(error.fieldErrors, supportedPaths);
    const next: Record<string, string[]> = {
      ...(raw["actual.content"] ? { content: raw["actual.content"] } : {}),
      ...(raw["actual.actualOutput"]
        ? { actualOutput: raw["actual.actualOutput"] }
        : {}),
      ...(raw.coveredStartAt ? { coveredStartAt: raw.coveredStartAt } : {}),
      ...(raw.coveredEndAt ? { coveredEndAt: raw.coveredEndAt } : {}),
    };
    if (Object.keys(next).length === 0) return false;
    setFieldErrors(next);
    const first = next.coveredStartAt || next.coveredEndAt
      ? `confirm-end-${detail.id}`
      : next.content
        ? `confirm-content-${detail.id}`
        : `confirm-actual-${detail.id}`;
    requestAnimationFrame(() => document.getElementById(first)?.focus());
    return fieldErrorsFullyHandled(error.fieldErrors, supportedPaths);
  };

  return (
    <form
      className="grid gap-2"
      aria-label="确认计划"
      noValidate
      onChange={() => onDirtyChange(true)}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const fullConfirmation =
          submitter instanceof HTMLButtonElement && submitter.value === "FULL";
        const content = String(form.get("content") ?? "");
        const actualOutput = String(form.get("actualOutput") ?? "");
        const nextErrors: Record<string, string[]> = {};
        if (!fullConfirmation && !content.trim()) {
          nextErrors.content = ["请输入实际投入内容"];
        }
        if (!actualOutput.trim()) {
          nextErrors.actualOutput = ["请输入实际输出"];
        }
        setFieldErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) {
          const first = nextErrors.content
            ? `confirm-content-${detail.id}`
            : `confirm-actual-${detail.id}`;
          requestAnimationFrame(() => document.getElementById(first)?.focus());
          return;
        }
        if (fullConfirmation) {
          onRun(
            () => confirmPlannedSegment({
              segmentId: detail.id,
              expectedUpdatedAt: detail.updatedAt,
              reason: "投入详情完整确认",
              actual: {
                actualOutput,
                ...(content.trim() ? { content } : {}),
              },
            }),
            "已完整确认并生成 Actual",
            undefined,
            undefined,
            (error) => handleFailure(error, false),
          );
          return;
        }
        const actual = {
          content,
          actualOutput,
        };
        onRun(
          () => partiallyConfirmSegment({
            segmentId: detail.id,
            expectedUpdatedAt: detail.updatedAt,
            coveredStartAt: detail.startAt,
            coveredEndAt,
            actual,
          }),
          "已确认计划前段并保留剩余计划",
          undefined,
          undefined,
          (error) => handleFailure(error, true),
        );
      }}
    >
      <p className="text-sm font-medium">生成 Actual</p>
      <p className="text-xs text-muted-foreground">
        完整确认沿用计划时间；部分确认从当前计划开头起算，并保留未确认的尾段。
      </p>
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
        <p className="text-xs text-muted-foreground">预期输出沿用计划</p>
        <p className="mt-1 break-words">{detail.expectedOutput || "未填写"}</p>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <input
          className="w-full accent-primary"
          type="range"
          aria-label="在时间线上选择确认结束"
          min={1}
          max={maxPartialMinutes}
          value={coveredMinutes}
          disabled={!canPartiallyConfirm || disabled}
          onChange={(event) => {
            setCoveredMinutes(Number(event.target.value));
            clearError("coveredStartAt");
            clearError("coveredEndAt");
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
        id={`confirm-end-${detail.id}`}
        aria-label="确认结束"
        type="datetime-local"
        value={toLocal(Date.parse(coveredEndAt))}
        onChange={(event) => {
          const nextMs = parseShanghaiLocalMs(event.target.value);
          if (nextMs === null) return;
          const nextMinutes = Math.round((nextMs - startMs) / 60_000);
          setCoveredMinutes(Math.max(1, Math.min(maxPartialMinutes, nextMinutes)));
          clearError("coveredStartAt");
          clearError("coveredEndAt");
          onDirtyChange(true);
        }}
        disabled={!canPartiallyConfirm || disabled}
        aria-invalid={Boolean(fieldErrors.coveredStartAt || fieldErrors.coveredEndAt)}
        aria-describedby={fieldErrors.coveredStartAt || fieldErrors.coveredEndAt ? `confirm-range-${detail.id}-error` : undefined}
      />
      <FieldError
        id={`confirm-range-${detail.id}-error`}
        messages={[...(fieldErrors.coveredStartAt ?? []), ...(fieldErrors.coveredEndAt ?? [])]}
      />
      <Field label="实际投入内容" htmlFor={`confirm-content-${detail.id}`}>
        <Textarea
          id={`confirm-content-${detail.id}`}
          name="content"
          defaultValue={detail.content}
          maxLength={2_000}
          aria-invalid={Boolean(fieldErrors.content)}
          aria-describedby={fieldErrors.content ? `confirm-content-${detail.id}-error` : undefined}
          onChange={() => clearError("content")}
        />
        <p className="text-xs text-muted-foreground">
          部分确认必填；完整确认留空时沿用计划内容。
        </p>
        <FieldError id={`confirm-content-${detail.id}-error`} messages={fieldErrors.content} />
      </Field>
      <Field label="实际输出" htmlFor={`confirm-actual-${detail.id}`}>
        <Textarea
          id={`confirm-actual-${detail.id}`}
          name="actualOutput"
          maxLength={2_000}
          required
          aria-invalid={Boolean(fieldErrors.actualOutput)}
          aria-describedby={fieldErrors.actualOutput ? `confirm-actual-${detail.id}-error` : undefined}
          onChange={() => clearError("actualOutput")}
        />
        <FieldError id={`confirm-actual-${detail.id}-error`} messages={fieldErrors.actualOutput} />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" name="confirmationMode" value="FULL" disabled={disabled}>
          完整确认
        </Button>
        <Button
          type="submit"
          name="confirmationMode"
          value="PARTIAL"
          variant="outline"
          disabled={disabled || !canPartiallyConfirm}
        >
          部分确认
        </Button>
      </div>
    </form>
  );
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
