"use client";

import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createProject } from "@/app/actions/progress/createProject";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  createProjectSchema,
  type CreateProjectInput,
} from "@/lib/validations/progress";
import { Controller } from "react-hook-form";

export function ProjectForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      name: "",
      description: "",
      team: undefined,
      techGroup: undefined,
      milestones: [{ name: "阶段一验收" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "milestones",
  });

  async function onSubmit(data: CreateProjectInput) {
    setSubmitting(true);
    try {
      const project = await createProject(data);
      toast.success("项目已创建");
      router.push(`/progress/projects/${project.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>项目名称</Label>
            <Input {...form.register("name")} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>描述</Label>
            <Input {...form.register("description")} />
          </div>
          <div className="space-y-2">
            <Label>车组</Label>
            <Controller
              control={form.control}
              name="team"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onValueChange={(v) => field.onChange(v ?? undefined)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择车组" />
                  </SelectTrigger>
                  <SelectContent>
                    {TEAM_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-2">
            <Label>技术组</Label>
            <Controller
              control={form.control}
              name="techGroup"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onValueChange={(v) => field.onChange(v ?? undefined)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择技术组" />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_GROUP_OPTIONS.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>验收里程碑</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append({ name: "" })}
          >
            <Plus className="mr-1 h-4 w-4" />
            添加
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {fields.map((field, index) => (
            <div key={field.id} className="flex gap-2">
              <Input {...form.register(`milestones.${index}.name`)} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={fields.length <= 1}
                onClick={() => remove(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Button type="submit" disabled={submitting}>
        创建项目
      </Button>
    </form>
  );
}
