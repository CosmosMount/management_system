"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  softDeleteWorkSegment,
  updateWorkSegment,
} from "@/app/actions/project-management/segments";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { TaskSelect } from "@/components/project-management/task-picker";
import type {
  TimeCanvasModel,
  TimeCanvasRange,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectManagementActionFailure, ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  fieldErrorsFullyHandled,
} from "@/lib/project-management/field-errors";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import {
  Field,
  formatPlannerRange,
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
  const editable = canvasSegment.permissions.canEdit && detail.permissions.canEdit;
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
                canSoftDelete: false,
              },
      })),
  };
  return (
    <aside className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4" data-testid="segment-inspector">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 max-w-full break-words font-semibold [overflow-wrap:anywhere]">{detail.content}</h2>
        </div>
        <p className="mt-2 break-words text-sm text-muted-foreground">{detail.personName} · {formatPlannerRange(Date.parse(detail.startAt), Date.parse(detail.endAt))}</p>
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
          display={{ showBusy: true, showInspector: false }}
          interaction={editable && !disabled ? {
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
          <ReadOnlyValue label="所属人员" value={detail.personName} />
          <ReadOnlyValue
            label="关联任务"
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
            const taskId = String(form.get("taskId") ?? "") || null;
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
                startAt: new Date(submittedRange.startMs).toISOString(),
                endAt: new Date(submittedRange.endMs).toISOString(),
                content,
                ...(taskId !== detail.taskId ? { taskId } : {}),
              }),
              "已更新投入详情",
              undefined,
              undefined,
              (error) => {
                const next = supportedFieldErrors(error.fieldErrors, ["startAt", "endAt", "content", "taskId"]);
                if (Object.keys(next).length === 0) return false;
                setEditErrors(next);
                const first = ["startAt", "endAt", "content", "taskId"].find((key) => next[key]);
                const id = first === "startAt" ? "inspect-start" : first === "endAt" ? "inspect-end" : first === "taskId" ? "inspect-task" : "inspect-content";
                requestAnimationFrame(() => document.getElementById(id)?.focus());
                return fieldErrorsFullyHandled(error.fieldErrors, [
                  "startAt",
                  "endAt",
                  "content",
                  "taskId",
                ]);
              },
            );
          }}
        >
          <SegmentRangeFields range={detailRange} disabled={disabled} onRangeChange={onRangeChange} errors={editErrors} onClearError={clearEditError} />
          <SegmentTaskField
            taskId={detail.taskId}
            disabled={disabled}
            errors={editErrors.taskId}
            onChange={() => {
              clearEditError("taskId");
              onDirtyChange(true);
            }}
          />
          <Field label="内容" htmlFor="inspect-content" className="md:col-span-2"><Textarea id="inspect-content" name="content" defaultValue={detail.content} maxLength={2_000} required disabled={disabled} aria-invalid={Boolean(editErrors.content)} aria-describedby={editErrors.content ? "inspect-content-error" : undefined} onChange={() => clearEditError("content")} /><FieldError id="inspect-content-error" messages={editErrors.content} /></Field>
          <Button className="md:col-span-2 md:w-fit" type="submit" disabled={disabled}>保存基本信息</Button>
        </form>
      ) : (
        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <ReadOnlyValue label="开始" value={formatIsoDateTime(detail.startAt)} />
          <ReadOnlyValue label="结束" value={formatIsoDateTime(detail.endAt)} />
          <ReadOnlyValue label="内容" value={detail.content} wide />
        </dl>
      )}
      </section>

      {canvasSegment.permissions.canSoftDelete && detail.permissions.canSoftDelete && (
        <Button
          type="button"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            if (!window.confirm("确认删除这条投入记录？")) return;
            onRun(
              () => softDeleteWorkSegment({ segmentId: detail.id, expectedUpdatedAt: detail.updatedAt }),
              "已删除投入记录",
            );
          }}
        >
          删除投入
        </Button>
      )}

      <section className="border-t border-border pt-4" aria-label="变更历史">
        <h3 className="text-sm font-semibold">变更历史</h3>
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

function SegmentTaskField({
  taskId: initialTaskId,
  disabled,
  errors,
  onChange,
}: {
  taskId: string | null;
  disabled: boolean;
  errors: string[] | undefined;
  onChange: () => void;
}) {
  const [taskId, setTaskId] = useState(initialTaskId);
  return (
    <Field label="关联任务" htmlFor="inspect-task" className="md:col-span-2">
      <TaskSelect
        inputId="inspect-task"
        ariaLabel="关联任务"
        name="taskId"
        value={taskId}
        onValueChange={(value) => {
          setTaskId(value);
          onChange();
        }}
        statuses={["ACTIVE"]}
        allowIndependent
        disabled={disabled}
        invalid={Boolean(errors)}
        ariaDescribedBy={errors ? "inspect-task-error" : undefined}
      />
      <FieldError id="inspect-task-error" messages={errors} />
    </Field>
  );
}

function SegmentRangeFields({
  range,
  disabled,
  onRangeChange,
  errors,
  onClearError,
}: {
  range: TimeCanvasRange;
  disabled: boolean;
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
    onClearError("startAt");
    onClearError("endAt");
    onRangeChange({ startMs: nextRange.startMs, endMs: nextRange.endMs });
  }

  return (
    <>
      <Field label="开始" htmlFor="inspect-start">
        <Input
          ref={startInputRef}
          id="inspect-start"
          disabled={disabled}
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
          disabled={disabled}
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
