"use client";

import {
  Controller,
  type Resolver,
  useFieldArray,
  useForm,
  useWatch,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createProject } from "@/app/actions/progress/createProject";
import { updateProject } from "@/app/actions/progress/updateProject";
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
  updateProjectSchema,
} from "@/lib/validations/progress";
import { UserMultiSearchSelect, UserSearchSelect } from "@/components/user-search-select";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { Textarea } from "@/components/ui/textarea";
import { routes } from "@/lib/routes";

type UserOption = { openId: string; name: string; avatar?: string | null };
type TeamFormValue = (typeof TEAM_OPTIONS)[number] | "";
type TechGroupFormValue = (typeof TECH_GROUP_OPTIONS)[number] | "";
type ProjectFormValues = {
  projectId?: string;
  expectedUpdatedAt?: string;
  name: string;
  description?: string;
  team?: TeamFormValue;
  techGroup?: TechGroupFormValue;
  ownerOpenId?: string;
  ownerOpenIds?: string[];
  allowOwnerSelfApproval: boolean;
  template?: "real-car" | "custom";
  stages: Array<{
    name: string;
    goal: string;
    ownerOpenId: string;
    dueAt: string;
  }>;
};

type Props = {
  users: UserOption[];
  mode?: "create" | "edit";
  initialProject?: {
    id: string;
    updatedAt: string;
    name: string;
    description: string;
    team: string;
    techGroup: string;
    ownerOpenIds: string[];
    allowOwnerSelfApproval: boolean;
  };
  submitLabel?: string;
  onSaved?: () => void;
};

function realCarStages(defaultOwner = "") {
  return REAL_CAR_STAGE_TEMPLATE.map((stage, index) => ({
    name: stage.name,
    goal: stage.goal,
    ownerOpenId: defaultOwner,
    dueAt: getDefaultStageDueAt(index),
  }));
}

function toTeamFormValue(value: string | undefined): TeamFormValue {
  return (TEAM_OPTIONS as readonly string[]).includes(value ?? "")
    ? (value as TeamFormValue)
    : "";
}

function toTechGroupFormValue(value: string | undefined): TechGroupFormValue {
  return (TECH_GROUP_OPTIONS as readonly string[]).includes(value ?? "")
    ? (value as TechGroupFormValue)
    : "";
}

export function ProjectForm({
  users,
  mode = "create",
  initialProject,
  submitLabel,
  onSaved,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [liveRefreshPending, setLiveRefreshPending] = useState(false);
  const editing = mode === "edit";
  const initialOwnerOpenIds = initialProject?.ownerOpenIds ?? [];
  const primaryInitialOwner = initialOwnerOpenIds[0] ?? "";

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(
      editing ? updateProjectSchema : createProjectSchema,
    ) as unknown as Resolver<ProjectFormValues>,
    defaultValues: {
      projectId: initialProject?.id,
      expectedUpdatedAt: initialProject?.updatedAt,
      name: initialProject?.name ?? "",
      description: initialProject?.description ?? "",
      team: toTeamFormValue(initialProject?.team),
      techGroup: toTechGroupFormValue(initialProject?.techGroup),
      ownerOpenId: primaryInitialOwner,
      ownerOpenIds: initialOwnerOpenIds,
      allowOwnerSelfApproval: initialProject?.allowOwnerSelfApproval ?? false,
      template: "real-car",
      stages: editing ? [] : realCarStages(),
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "stages",
  });

  const ownerOpenIds = useWatch({
    control: form.control,
    name: "ownerOpenIds",
  });
  const team = useWatch({ control: form.control, name: "team" });
  const techGroup = useWatch({ control: form.control, name: "techGroup" });
  const primaryOwnerOpenId = ownerOpenIds?.[0] ?? "";
  const scopeWarning =
    team && !techGroup
      ? "仅选择车组时，只有该车组组长和全局管理角色会参与管理/审批。"
      : !team && techGroup
        ? "仅选择技术组时，只有该技术组组长和全局管理角色会参与管理/审批。"
        : "";

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

  async function onSubmit(data: ProjectFormValues) {
    setSubmitting(true);
    try {
      if (editing) {
        await updateProject({
          projectId: data.projectId ?? "",
          expectedUpdatedAt: data.expectedUpdatedAt ?? "",
          name: data.name,
          description: data.description,
          team: data.team ?? "",
          techGroup: data.techGroup ?? "",
          ownerOpenId: data.ownerOpenId,
          ownerOpenIds: data.ownerOpenIds ?? [],
          allowOwnerSelfApproval: data.allowOwnerSelfApproval,
        });
        toast.success("项目已更新");
        onSaved?.();
        router.refresh();
      } else {
        const project = await createProject({
          name: data.name,
          description: data.description,
          team: data.team,
          techGroup: data.techGroup,
          ownerOpenId: data.ownerOpenId,
          ownerOpenIds: data.ownerOpenIds,
          allowOwnerSelfApproval: data.allowOwnerSelfApproval,
          template: data.template,
          stages: data.stages,
        });
        toast.success("项目已创建");
        router.push(`${routes.progress.project(project.id)}`);
      }
    } catch (err) {
      toast.error(getActionErrorMessage(err, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  }

  function applyRealCarTemplate() {
    form.setValue("template", "real-car");
    form.setValue("stages", realCarStages(primaryOwnerOpenId));
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      {liveRefreshPending && (
        <div
          data-testid="live-refresh-pending-alert"
          className="sticky top-0 z-10 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>页面数据已更新，保存旧表单可能会失败；建议刷新后再编辑。</span>
        </div>
      )}
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
              name="ownerOpenIds"
              render={({ field }) => (
                <UserMultiSearchSelect
                  users={users}
                  value={field.value ?? []}
                  onChange={(values) => {
                    field.onChange(values);
                    form.setValue("ownerOpenId", values[0] ?? "");
                    const stages = form.getValues("stages");
                    form.setValue(
                      "stages",
                      stages.map((stage) => ({
                        ...stage,
                        ownerOpenId: stage.ownerOpenId || values[0] || "",
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
                  value={field.value || "none"}
                  onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择车组或未指定" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未指定</SelectItem>
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
                  value={field.value || "none"}
                  onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择技术组或未指定" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">未指定</SelectItem>
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
          {scopeWarning && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{scopeWarning}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {!editing && (
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
                    ownerOpenId: primaryOwnerOpenId,
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
      )}

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
        {submitLabel ?? (editing ? "保存修改" : "创建项目")}
      </Button>
    </form>
  );
}
