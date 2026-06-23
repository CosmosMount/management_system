"use client";

import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
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
import { getDefaultStageDueAt, REAL_CAR_STAGE_TEMPLATE } from "@/lib/progress-templates";
import {
  createProjectSchema,
  type CreateProjectInput,
} from "@/lib/validations/progress";
import { UserSearchSelect } from "@/components/user-search-select";
import { Textarea } from "@/components/ui/textarea";

type UserOption = { openId: string; name: string; avatar?: string | null };

type Props = {
  users: UserOption[];
};

function realCarStages(defaultOwner = "") {
  return REAL_CAR_STAGE_TEMPLATE.map((stage, index) => ({
    name: stage.name,
    goal: stage.goal,
    ownerOpenId: defaultOwner,
    dueAt: getDefaultStageDueAt(index),
  }));
}

export function ProjectForm({ users }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      name: "",
      description: "",
      team: undefined,
      techGroup: undefined,
      ownerOpenId: "",
      allowOwnerSelfApproval: false,
      template: "real-car",
      stages: realCarStages(),
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "stages",
  });

  const ownerOpenId = useWatch({
    control: form.control,
    name: "ownerOpenId",
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

  function applyRealCarTemplate() {
    form.setValue("template", "real-car");
    form.setValue("stages", realCarStages(ownerOpenId));
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
          <div className="space-y-2 sm:col-span-2">
            <Label>项目负责人</Label>
            <Controller
              control={form.control}
              name="ownerOpenId"
              render={({ field }) => (
                <UserSearchSelect
                  users={users}
                  value={field.value ?? ""}
                  onChange={(v) => {
                    field.onChange(v || undefined);
                    const stages = form.getValues("stages");
                    form.setValue(
                      "stages",
                      stages.map((stage) => ({
                        ...stage,
                        ownerOpenId: stage.ownerOpenId || v,
                      })),
                    );
                  }}
                  placeholder="搜索项目负责人"
                />
              )}
            />
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
          <CardTitle>项目阶段</CardTitle>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={applyRealCarTemplate}
            >
              实车模板
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                append({
                  name: "",
                  goal: "",
                  ownerOpenId: ownerOpenId ?? "",
                  dueAt: getDefaultStageDueAt(fields.length),
                })
              }
            >
              <Plus className="mr-1 h-4 w-4" />
              添加
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {fields.map((field, index) => (
            <div key={field.id} className="rounded-lg border p-4">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                <div className="space-y-2">
                  <Label>阶段名称</Label>
                  <Input {...form.register(`stages.${index}.name`)} />
                </div>
                <div className="space-y-2">
                  <Label>DDL</Label>
                  <Input
                    type="datetime-local"
                    {...form.register(`stages.${index}.dueAt`)}
                  />
                </div>
                <div className="flex items-end">
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
              </div>
              <div className="mt-3 space-y-2">
                <Label>阶段目标</Label>
                <Textarea {...form.register(`stages.${index}.goal`)} />
              </div>
              <div className="mt-3 space-y-2">
                <Label>阶段负责人</Label>
                <Controller
                  control={form.control}
                  name={`stages.${index}.ownerOpenId`}
                  render={({ field }) => (
                    <UserSearchSelect
                      users={users}
                      value={field.value ?? ""}
                      onChange={(v) => field.onChange(v || undefined)}
                      placeholder="搜索阶段负责人"
                    />
                  )}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>审批策略</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...form.register("allowOwnerSelfApproval")} />
            允许项目负责人审批自己提交的阶段
          </label>
        </CardContent>
      </Card>

      <Button type="submit" disabled={submitting}>
        创建项目
      </Button>
    </form>
  );
}
