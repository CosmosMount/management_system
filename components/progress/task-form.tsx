"use client";

import {
  useForm,
  Controller,
  useFieldArray,
  type Resolver,
  type SubmitErrorHandler,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertCircle, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { createTask } from "@/app/actions/progress/createTask";
import { requestTaskCreation } from "@/app/actions/progress/requestTaskCreation";
import { updateTask } from "@/app/actions/progress/updateTask";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserMultiSearchSelect } from "@/components/user-search-select";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  createTaskSchema,
  MAX_ACCEPTANCE_CHECKLIST_ITEMS,
  type CreateTaskInput,
  updateTaskSchema,
} from "@/lib/validations/progress";
import { routes } from "@/lib/routes";
import {
  urgencyLabels,
  importanceLabels,
} from "@/lib/progress-labels";

type UserOption = { openId: string; name: string; avatar?: string | null };
type StageOption = { id: string; name: string };
type AcceptanceChecklistTemplateOption = { id: string; content: string };
type TaskFormValues = Omit<CreateTaskInput, "dueAt" | "taskTechGroups"> & {
  dueAt?: string;
  taskTechGroups: string[];
  taskId?: string;
  expectedUpdatedAt?: string;
};

type Props = {
  projectId: string;
  users: UserOption[];
  stages?: StageOption[];
  acceptanceChecklistTemplates?: AcceptanceChecklistTemplateOption[];
  defaultStageId?: string;
  mode?: "create" | "edit";
  initialTask?: {
    id: string;
    updatedAt: string;
    stageId: string | null;
    title: string;
    goal: string;
    taskTechGroups: string[];
    urgency: CreateTaskInput["urgency"];
    importance: CreateTaskInput["importance"];
    assigneeOpenIds: string[];
    metrics: string;
    dueAt: string;
    needsOfflineConfirmation: boolean;
    needsWeeklyReport: boolean;
    acceptanceChecklistItems: { id?: string; content: string }[];
    acceptanceChecklistLocked?: boolean;
  };
  redirectOnCreate?: boolean;
  createVariant?: "direct" | "request";
  submitLabel?: string;
  onCreated?: (taskId: string) => void;
  onSubmitted?: () => void;
  onSaved?: () => void;
};

export function TaskForm({
  projectId,
  users,
  stages = [],
  acceptanceChecklistTemplates = [],
  defaultStageId = "",
  mode = "create",
  initialTask,
  redirectOnCreate = true,
  createVariant = "direct",
  submitLabel = "创建任务",
  onCreated,
  onSubmitted,
  onSaved,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [liveRefreshPending, setLiveRefreshPending] = useState(false);
  const editing = mode === "edit";

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(
      editing ? updateTaskSchema : createTaskSchema,
    ) as Resolver<TaskFormValues>,
    defaultValues: {
      taskId: initialTask?.id,
      expectedUpdatedAt: initialTask?.updatedAt,
      projectId,
      stageId: initialTask?.stageId ?? defaultStageId,
      title: initialTask?.title ?? "",
      goal: initialTask?.goal ?? "",
      taskTechGroups: initialTask?.taskTechGroups ?? ["通用"],
      urgency: initialTask?.urgency ?? "MEDIUM",
      importance: initialTask?.importance ?? "MEDIUM",
      assigneeOpenIds: initialTask?.assigneeOpenIds ?? [],
      metrics: initialTask?.metrics ?? "",
      dueAt: initialTask ? toDatetimeLocal(initialTask.dueAt) : "",
      needsOfflineConfirmation:
        initialTask?.needsOfflineConfirmation ?? false,
      needsWeeklyReport: initialTask?.needsWeeklyReport ?? false,
      acceptanceChecklistItems: initialTask?.acceptanceChecklistItems ?? [],
    },
  });
  const errors = form.formState.errors;
  const checklistFields = useFieldArray({
    control: form.control,
    name: "acceptanceChecklistItems",
  });
  const checklistReadOnly =
    editing && !!initialTask?.acceptanceChecklistLocked;

  useEffect(() => {
    if (!editing) return;
    const onPending = () => setLiveRefreshPending(true);
    const onClear = () => setLiveRefreshPending(false);
    window.addEventListener("pnx-live-refresh-pending", onPending);
    window.addEventListener("pnx-live-refresh-clear", onClear);
    return () => {
      window.removeEventListener("pnx-live-refresh-pending", onPending);
      window.removeEventListener("pnx-live-refresh-clear", onClear);
    };
  }, [editing]);

  function addChecklistItem(content = "") {
    const current = form.getValues("acceptanceChecklistItems") ?? [];
    const normalized = content.trim().replace(/\s+/g, " ");
    if (current.length >= MAX_ACCEPTANCE_CHECKLIST_ITEMS) {
      toast.error(`验收条例最多 ${MAX_ACCEPTANCE_CHECKLIST_ITEMS} 条`);
      return;
    }
    if (
      normalized &&
      current.some((item) => item.content.trim() === normalized)
    ) {
      toast.error("该验收条例已在清单中");
      return;
    }
    checklistFields.append({ content: normalized });
  }

  async function onSubmit(data: TaskFormValues) {
    setSubmitting(true);
    try {
      if (editing) {
        await updateTask({
          taskId: data.taskId ?? "",
          expectedUpdatedAt: data.expectedUpdatedAt ?? "",
          projectId: data.projectId,
          stageId: data.stageId,
          title: data.title,
          goal: data.goal,
          taskTechGroups: data.taskTechGroups as CreateTaskInput["taskTechGroups"],
          urgency: data.urgency,
          importance: data.importance,
          assigneeOpenId: data.assigneeOpenId,
          assigneeOpenIds: data.assigneeOpenIds,
          metrics: data.metrics,
          needsOfflineConfirmation: data.needsOfflineConfirmation,
          needsWeeklyReport: data.needsWeeklyReport,
          acceptanceChecklistItems: data.acceptanceChecklistItems,
        });
        toast.success("任务已更新");
        onSaved?.();
      } else {
        if (createVariant === "request") {
          await requestTaskCreation({
            ...data,
            dueAt: data.dueAt ?? "",
            taskTechGroups: data.taskTechGroups as CreateTaskInput["taskTechGroups"],
          });
          toast.success("任务申请已提交");
          onSubmitted?.();
        } else {
          const task = await createTask({
            ...data,
            dueAt: data.dueAt ?? "",
            taskTechGroups: data.taskTechGroups as CreateTaskInput["taskTechGroups"],
          });
          toast.success("任务已创建");
          if (redirectOnCreate) {
            router.push(`${routes.progress.task(task.id)}`);
          }
          onCreated?.(task.id);
        }
      }
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  }

  const onInvalid: SubmitErrorHandler<TaskFormValues> = (_errors, event) => {
    toast.error("请先补全任务表单中的必填项");
    const formElement =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    window.setTimeout(() => focusFirstInvalidControl(formElement), 0);
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-4">
      {liveRefreshPending && (
        <div
          data-testid="live-refresh-pending-alert"
          className="sticky top-0 z-10 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>页面数据已更新，保存旧表单可能会失败；建议刷新后再编辑。</span>
        </div>
      )}
      <div className="space-y-2">
        <Label>任务目标</Label>
        <Input
          {...form.register("title")}
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? "task-title-error" : undefined}
        />
        <FormFieldError id="task-title-error" message={errors.title?.message} />
      </div>
      <div className="space-y-2">
        <Label>详细说明</Label>
        <Input {...form.register("goal")} />
      </div>
      {stages.length > 0 && (
        <div className="space-y-2">
          <Label>所属阶段</Label>
          <Controller
            control={form.control}
            name="stageId"
            render={({ field }) => (
              <Select
                value={field.value || "none"}
                onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      value === "none"
                        ? "无阶段"
                        : (stages.find((stage) => stage.id === value)?.name ??
                          "无阶段")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">无阶段</SelectItem>
                  {stages.map((stage) => (
                    <SelectItem key={stage.id} value={stage.id}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FormFieldError
            id="task-stage-error"
            message={errors.stageId?.message}
          />
        </div>
      )}
      <div className="space-y-2">
        <Label>任务技术组</Label>
        <Controller
          control={form.control}
          name="taskTechGroups"
          render={({ field }) => {
            const selected = new Set(field.value ?? []);
            return (
              <div
                className="grid gap-2 rounded-lg border p-3 sm:grid-cols-3"
                aria-invalid={!!errors.taskTechGroups}
                aria-describedby={
                  errors.taskTechGroups ? "task-tech-groups-error" : undefined
                }
              >
                {TECH_GROUP_OPTIONS.map((group) => (
                  <label
                    key={group}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(group)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) {
                          next.add(group);
                        } else {
                          next.delete(group);
                        }
                        field.onChange([...next]);
                      }}
                    />
                    {group}
                  </label>
                ))}
              </div>
            );
          }}
        />
        <FormFieldError
          id="task-tech-groups-error"
          message={errors.taskTechGroups?.message}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>紧急程度</Label>
          <Controller
            control={form.control}
            name="urgency"
            render={({ field }) => (
              <Select
                value={field.value ?? ""}
                onValueChange={(v) => field.onChange(v ?? undefined)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      urgencyLabels[value as keyof typeof urgencyLabels] ??
                      "选择紧急程度"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(urgencyLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="space-y-2">
          <Label>重要程度</Label>
          <Controller
            control={form.control}
            name="importance"
            render={({ field }) => (
              <Select
                value={field.value ?? ""}
                onValueChange={(v) => field.onChange(v ?? undefined)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      importanceLabels[
                        value as keyof typeof importanceLabels
                      ] ?? "选择重要程度"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(importanceLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>负责人</Label>
        <Controller
          control={form.control}
          name="assigneeOpenIds"
          render={({ field }) => (
            <UserMultiSearchSelect
              users={users}
              value={field.value ?? []}
              onChange={field.onChange}
              placeholder="搜索负责人姓名"
              inputProps={{
                "aria-invalid": !!errors.assigneeOpenIds,
                "aria-describedby": errors.assigneeOpenIds
                  ? "task-assignees-error"
                  : undefined,
              }}
            />
          )}
        />
        <FormFieldError
          id="task-assignees-error"
          message={errors.assigneeOpenIds?.message}
        />
      </div>
      <div className="space-y-2">
        <Label>定量/定性指标</Label>
        <Input
          {...form.register("metrics")}
          aria-invalid={!!errors.metrics}
          aria-describedby={errors.metrics ? "task-metrics-error" : undefined}
        />
        <FormFieldError id="task-metrics-error" message={errors.metrics?.message} />
      </div>
      {editing ? (
        <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
          <Label>最晚完成时间</Label>
          <p className="text-sm font-medium">
            {initialTask?.dueAt
              ? new Date(initialTask.dueAt).toLocaleString("zh-CN")
              : "未设置"}
          </p>
          <p className="text-xs text-muted-foreground">
            如需修改最晚完成时间，请在任务详情页使用“申请修改 DDL”。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label>最晚完成时间</Label>
          <Input
            type="datetime-local"
            {...form.register("dueAt")}
            aria-invalid={!!errors.dueAt}
            aria-describedby={errors.dueAt ? "task-due-at-error" : undefined}
          />
          <FormFieldError id="task-due-at-error" message={errors.dueAt?.message} />
        </div>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" {...form.register("needsOfflineConfirmation")} />
          需要线下确认
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" {...form.register("needsWeeklyReport")} />
          需要定期周报
        </label>
      </div>
      <div className="space-y-3 rounded-lg border p-4">
        <div className="space-y-1">
          <Label>验收清单</Label>
          <p className="text-xs text-muted-foreground">
            可为空；配置后验收人必须逐项手动确认才能通过。
          </p>
          {checklistReadOnly && (
            <p className="text-xs text-amber-700">
              该任务已有交付记录，验收清单已锁定。
            </p>
          )}
        </div>

        {acceptanceChecklistTemplates.length > 0 && !checklistReadOnly && (
          <div className="flex flex-wrap gap-2">
            {acceptanceChecklistTemplates.map((template) => (
              <Button
                key={template.id}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => addChecklistItem(template.content)}
              >
                <Plus className="h-3 w-3" />
                {template.content}
              </Button>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {checklistFields.fields.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              暂未配置验收清单。
            </p>
          ) : (
            checklistFields.fields.map((field, index) => (
              <div key={field.id} className="flex gap-2">
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    {...form.register(
                      `acceptanceChecklistItems.${index}.content`,
                    )}
                    disabled={checklistReadOnly}
                    placeholder={`验收条例 ${index + 1}`}
                    aria-invalid={
                      !!errors.acceptanceChecklistItems?.[index]?.content
                    }
                    aria-describedby={
                      errors.acceptanceChecklistItems?.[index]?.content
                        ? `task-checklist-${index}-error`
                        : undefined
                    }
                  />
                  <FormFieldError
                    id={`task-checklist-${index}-error`}
                    message={
                      errors.acceptanceChecklistItems?.[index]?.content?.message
                    }
                  />
                </div>
                {!checklistReadOnly && (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="删除验收条例"
                    onClick={() => checklistFields.remove(index)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        {!checklistReadOnly && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => addChecklistItem()}
          >
            <Plus className="h-4 w-4" />
            添加自定义条例
          </Button>
        )}
        {typeof errors.acceptanceChecklistItems?.message === "string" && (
          <FormFieldError message={errors.acceptanceChecklistItems.message} />
        )}
      </div>
      <Button type="submit" disabled={submitting}>
        {editing ? (submitLabel ?? "保存修改") : submitLabel}
      </Button>
    </form>
  );
}

function FormFieldError({
  id,
  message,
}: {
  id?: string;
  message?: string;
}) {
  if (!message) return null;

  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

function focusFirstInvalidControl(container: HTMLElement | null) {
  const target = container?.querySelector<HTMLElement>(
    'input[aria-invalid="true"], textarea[aria-invalid="true"], button[aria-invalid="true"], [role="button"][aria-invalid="true"]',
  );
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.focus();
}

function toDatetimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
