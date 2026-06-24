"use client";

import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createTask } from "@/app/actions/progress/createTask";
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
  type CreateTaskInput,
} from "@/lib/validations/progress";
import {
  taskCategoryLabels,
  urgencyLabels,
  importanceLabels,
} from "@/lib/progress-labels";

type UserOption = { openId: string; name: string; avatar?: string | null };
type StageOption = { id: string; name: string };

type Props = {
  projectId: string;
  users: UserOption[];
  stages?: StageOption[];
  defaultStageId?: string;
  redirectOnCreate?: boolean;
  submitLabel?: string;
  onCreated?: (taskId: string) => void;
};

export function TaskForm({
  projectId,
  users,
  stages = [],
  defaultStageId = "",
  redirectOnCreate = true,
  submitLabel = "创建任务",
  onCreated,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateTaskInput>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      projectId,
      stageId: defaultStageId,
      title: "",
      goal: "",
      category: "RND",
      urgency: "MEDIUM",
      importance: "MEDIUM",
      assigneeOpenIds: [],
      metrics: "",
      dueAt: "",
      needsOfflineConfirmation: false,
      needsWeeklyReport: false,
    },
  });

  async function onSubmit(data: CreateTaskInput) {
    setSubmitting(true);
    try {
      const task = await createTask(data);
      toast.success("任务已创建");
      if (redirectOnCreate) {
        router.push(`/progress/tasks/${task.id}`);
      }
      onCreated?.(task.id);
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "创建失败"));
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
      <Button type="submit" disabled={submitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
