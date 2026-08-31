"use client";

import { useState } from "react";
import {
  createActualSegment,
  createWorkSegment,
} from "@/app/actions/project-management/segments";
import { TaskSelect } from "@/components/project-management/task-picker";
import {
  UserSelect,
  type UserPickerScope,
} from "@/components/project-management/user-picker";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ProjectManagementActionFailure,
  ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  fieldErrorsFullyHandled,
} from "@/lib/project-management/field-errors";
import {
  taskPriorityLabels,
} from "@/lib/project-management/labels";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import {
  Field,
  selectClass,
  supportedFieldErrors,
  toLocal,
  validateSegmentRangeInputs,
  type CreateDraft,
} from "@/components/project-management/resource-planner-panel-support";

type TaskOption = TaskOptionPage["items"][number];

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
  onRun: (
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    onFailure?: (error: ProjectManagementActionFailure["error"]) => boolean | void,
  ) => void;
}) {
  const [taskId, setTaskId] = useState<string | null>(defaultTaskId || null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
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
  const clearFieldError = (key: string) => {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

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
      noValidate
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
          requestAnimationFrame(() => document.getElementById("quick-start")?.focus());
          return;
        }
        const form = new FormData(event.currentTarget);
        const submittedTaskId = String(form.get("taskId") ?? "") || null;
        const nextErrors: Record<string, string[]> = {};
        const personId = String(form.get("personId") ?? draft.personId);
        const content = String(form.get("content") ?? "");
        if (!personId) nextErrors.personId = ["请选择人员"];
        if (!content.trim()) nextErrors.content = ["请输入工作内容"];
        if (!allowIndependent && !submittedTaskId) nextErrors.taskId = ["请选择 Task"];
        if (Object.keys(nextErrors).length > 0) {
          setFieldErrors((current) => ({ ...current, ...nextErrors }));
          const first = nextErrors.personId ? "quick-person" : nextErrors.content ? "quick-content" : "quick-task";
          requestAnimationFrame(() => document.getElementById(first)?.focus());
          return;
        }
        const type = String(form.get("type")) === "ACTUAL" ? "ACTUAL" : "PLANNED";
        const base = {
          personId,
          startAt: new Date(range.startMs).toISOString(),
          endAt: new Date(range.endMs).toISOString(),
          content,
          priority: String(form.get("priority") ?? "MEDIUM"),
          expectedOutput: String(form.get("expectedOutput") ?? ""),
          taskId: submittedTaskId,
        };
        onRun(
          () =>
            type === "ACTUAL"
              ? createActualSegment({ ...base, sources: [] })
              : createWorkSegment({ ...base, type: "PLANNED" }),
          (error) => {
            const next = supportedFieldErrors(error.fieldErrors, ["personId", "startAt", "endAt", "content", "priority", "expectedOutput", "taskId"]);
            if (Object.keys(next).length === 0) return false;
            setFieldErrors(next);
            const firstKey = ["personId", "startAt", "endAt", "content", "taskId", "priority", "expectedOutput"].find((key) => next[key]);
            const id = firstKey === "personId" ? "quick-person" : firstKey === "taskId" ? "quick-task" : firstKey ? `quick-${firstKey === "expectedOutput" ? "expected" : firstKey.replace("At", "")}` : "quick-content";
            requestAnimationFrame(() => document.getElementById(id)?.focus());
            return fieldErrorsFullyHandled(error.fieldErrors, [
              "personId",
              "startAt",
              "endAt",
              "content",
              "priority",
              "expectedOutput",
              "taskId",
            ]);
          },
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
            clearFieldError("personId");
            onDirtyChange();
            onPersonChange(value);
          }}
          initialOptions={peopleOptions}
          required
          clearable={false}
          disabled={disabled}
          placeholder="按姓名或拼音首字母搜索"
          invalid={Boolean(fieldErrors.personId)}
          ariaDescribedBy={fieldErrors.personId ? "quick-person-error" : undefined}
        />
        <FieldError id="quick-person-error" messages={fieldErrors.personId} />
      </Field>
      <Field label="开始" htmlFor="quick-start">
        <Input
          id="quick-start"
          name="startAt"
          type="datetime-local"
          value={startValue}
          aria-invalid={Boolean(rangeError || fieldErrors.startAt)}
          aria-describedby={rangeError || fieldErrors.startAt ? "quick-range-error" : undefined}
          onChange={(event) => {
            clearFieldError("startAt");
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
          aria-invalid={Boolean(rangeError || fieldErrors.endAt)}
          aria-describedby={rangeError || fieldErrors.endAt ? "quick-range-error" : undefined}
          onChange={(event) => {
            clearFieldError("endAt");
            updateRangeInputs(startValue, event.target.value);
          }}
          required
        />
      </Field>
      <FieldError
        id="quick-range-error"
        messages={rangeError || [...(fieldErrors.startAt ?? []), ...(fieldErrors.endAt ?? [])]}
        className="md:col-span-2 xl:col-span-4"
      />
      <Field label="内容" htmlFor="quick-content" className="md:col-span-2">
        <Input id="quick-content" name="content" defaultValue="" required maxLength={2_000} aria-invalid={Boolean(fieldErrors.content)} aria-describedby={fieldErrors.content ? "quick-content-error" : undefined} onChange={() => clearFieldError("content")} />
        <FieldError id="quick-content-error" messages={fieldErrors.content} />
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
              clearFieldError("taskId");
              onDirtyChange();
            }}
            initialOptions={taskOptions}
            statuses={["ACTIVE"]}
            allowIndependent={allowIndependent}
            required={!allowIndependent}
            clearable={allowIndependent}
            disabled={disabled}
            placeholder="按标题、描述或拼音首字母搜索"
            invalid={Boolean(fieldErrors.taskId)}
            ariaDescribedBy={fieldErrors.taskId ? "quick-task-error" : undefined}
          />
        )}
        <FieldError id="quick-task-error" messages={fieldErrors.taskId} />
      </Field>
      <Field label="优先级" htmlFor="quick-priority">
        <select
          id="quick-priority"
          name="priority"
          className={selectClass}
          defaultValue="MEDIUM"
          aria-invalid={Boolean(fieldErrors.priority)}
          aria-describedby={fieldErrors.priority ? "quick-priority-error" : undefined}
          onChange={() => clearFieldError("priority")}
        >
          {Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <FieldError id="quick-priority-error" messages={fieldErrors.priority} />
      </Field>
      <Field label="预期输出" htmlFor="quick-expected" className="md:col-span-2 xl:col-span-4">
        <Textarea
          id="quick-expected"
          name="expectedOutput"
          maxLength={2_000}
          placeholder="填写本次投入预期形成的结果"
          aria-invalid={Boolean(fieldErrors.expectedOutput)}
          aria-describedby={fieldErrors.expectedOutput ? "quick-expected-error" : undefined}
          onChange={() => clearFieldError("expectedOutput")}
        />
        <FieldError id="quick-expected-error" messages={fieldErrors.expectedOutput} />
      </Field>
      <div className="flex gap-2 md:col-span-2 xl:col-span-4">
        <Button type="submit" disabled={disabled}>创建</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>取消</Button>
      </div>
    </form>
  );
}
