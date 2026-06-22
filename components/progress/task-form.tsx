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
import {
  createTaskSchema,
  type CreateTaskInput,
} from "@/lib/validations/progress";
import {
  taskCategoryLabels,
  urgencyLabels,
  importanceLabels,
} from "@/lib/progress-labels";

type UserOption = { openId: string; name: string };

type Props = {
  projectId: string;
  users: UserOption[];
};

export function TaskForm({ projectId, users }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateTaskInput>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      projectId,
      title: "",
      goal: "",
      category: "RND",
      urgency: "MEDIUM",
      importance: "MEDIUM",
      assigneeOpenId: "",
      metrics: "",
      dueAt: "",
    },
  });

  async function onSubmit(data: CreateTaskInput) {
    setSubmitting(true);
    try {
      const task = await createTask(data);
      toast.success("任务已创建");
      router.push(`/progress/tasks/${task.id}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
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
                <SelectTrigger>
                  <SelectValue />
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
                <SelectTrigger>
                  <SelectValue />
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
                <SelectTrigger>
                  <SelectValue />
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
          name="assigneeOpenId"
          render={({ field }) => (
            <Select
              value={field.value ?? ""}
              onValueChange={(v) => field.onChange(v ?? undefined)}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择负责人" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.openId} value={u.openId}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
      <Button type="submit" disabled={submitting}>
        创建任务
      </Button>
    </form>
  );
}
