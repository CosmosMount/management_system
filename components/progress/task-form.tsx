"use client";

import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { createTask } from "@/app/actions/progress/createTask";
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
import {
  createTaskSchema,
  MAX_ACCEPTANCE_CHECKLIST_ITEMS,
  type CreateTaskInput,
  updateTaskSchema,
} from "@/lib/validations/progress";
import { routes } from "@/lib/routes";
import {
  taskCategoryLabels,
  urgencyLabels,
  importanceLabels,
} from "@/lib/progress-labels";

type UserOption = { openId: string; name: string; avatar?: string | null };
type StageOption = { id: string; name: string };
type AcceptanceChecklistTemplateOption = { id: string; content: string };
type TaskFormValues = CreateTaskInput & { taskId?: string };

type Props = {
  projectId: string;
  users: UserOption[];
  stages?: StageOption[];
  acceptanceChecklistTemplates?: AcceptanceChecklistTemplateOption[];
  defaultStageId?: string;
  mode?: "create" | "edit";
  initialTask?: {
    id: string;
    stageId: string | null;
    title: string;
    goal: string;
    category: CreateTaskInput["category"];
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
  submitLabel?: string;
  onCreated?: (taskId: string) => void;
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
  submitLabel = "创建任务",
  onCreated,
  onSaved,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const editing = mode === "edit";

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(editing ? updateTaskSchema : createTaskSchema),
    defaultValues: {
      taskId: initialTask?.id,
      projectId,
      stageId: initialTask?.stageId ?? defaultStageId,
      title: initialTask?.title ?? "",
      goal: initialTask?.goal ?? "",
      category: initialTask?.category ?? "RND",
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
  const checklistFields = useFieldArray({
    control: form.control,
    name: "acceptanceChecklistItems",
  });
  const checklistReadOnly =
    editing && !!initialTask?.acceptanceChecklistLocked;

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
          projectId: data.projectId,
          stageId: data.stageId,
          title: data.title,
          goal: data.goal,
          category: data.category,
          urgency: data.urgency,
          importance: data.importance,
          assigneeOpenId: data.assigneeOpenId,
          assigneeOpenIds: data.assigneeOpenIds,
          metrics: data.metrics,
          dueAt: data.dueAt,
          needsOfflineConfirmation: data.needsOfflineConfirmation,
          needsWeeklyReport: data.needsWeeklyReport,
          acceptanceChecklistItems: data.acceptanceChecklistItems,
        });
        toast.success("任务已更新");
        onSaved?.();
      } else {
        const task = await createTask(data);
        toast.success("任务已创建");
        if (redirectOnCreate) {
          router.push(`${routes.progress.task(task.id)}`);
        }
        onCreated?.(task.id);
      }
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label>任务目标</Label>
        <Input {...form.register("title")} />
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
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label>类别</Label>
          <Controller
            control={form.control}
            name="category"
            render={({ field }) => (
              <Select
                value={field.value ?? ""}
                onValueChange={(v) => field.onChange(v ?? undefined)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      taskCategoryLabels[
                        value as keyof typeof taskCategoryLabels
                      ] ?? "选择类别"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(taskCategoryLabels).map(([k, v]) => (
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
            />
          )}
        />
      </div>
      <div className="space-y-2">
        <Label>定量/定性指标</Label>
        <Input {...form.register("metrics")} />
      </div>
      <div className="space-y-2">
        <Label>最晚完成时间</Label>
        <Input type="datetime-local" {...form.register("dueAt")} />
      </div>
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
                <Input
                  {...form.register(
                    `acceptanceChecklistItems.${index}.content`,
                  )}
                  disabled={checklistReadOnly}
                  placeholder={`验收条例 ${index + 1}`}
                />
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
        {form.formState.errors.acceptanceChecklistItems?.message && (
          <p className="text-sm text-destructive">
            {form.formState.errors.acceptanceChecklistItems.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={submitting}>
        {editing ? (submitLabel ?? "保存修改") : submitLabel}
      </Button>
    </form>
  );
}

function toDatetimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
