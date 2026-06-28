"use client";

import {
  Controller,
  type Resolver,
  type SubmitErrorHandler,
  useFieldArray,
  useForm,
  useWatch,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createProject } from "@/app/actions/progress/createProject";
import { updateProject } from "@/app/actions/progress/updateProject";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SortableCardList } from "@/components/ui/sortable-card-list";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  getStageDueAtByOffsetDays,
  REAL_CAR_STAGE_TEMPLATE,
} from "@/lib/progress-templates";
import {
  createProjectSchema,
  updateProjectSchema,
} from "@/lib/validations/progress";
import { UserMultiSearchSelect, UserSearchSelect } from "@/components/user-search-select";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { Textarea } from "@/components/ui/textarea";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type UserOption = { openId: string; name: string; avatar?: string | null };
type ProjectTemplateOption = {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  stages: Array<{
    name: string;
    goal: string;
    durationDays: number;
  }>;
};
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
  participantOpenIds?: string[];
  allowOwnerSelfApproval: boolean;
  template?: "real-car" | "custom";
  stages: Array<{
    name: string;
    goal: string;
    ownerOpenId: string;
    durationDays: string;
  }>;
};

type Props = {
  users: UserOption[];
  projectTemplates?: ProjectTemplateOption[];
  mode?: "create" | "edit";
  initialProject?: {
    id: string;
    updatedAt: string;
    name: string;
    description: string;
    team: string;
    techGroup: string;
    ownerOpenIds: string[];
    participantOpenIds: string[];
    allowOwnerSelfApproval: boolean;
  };
  submitLabel?: string;
  onSaved?: () => void;
};

const DEFAULT_STAGE_DURATION_DAYS = 7;

function realCarStages(defaultOwner = "") {
  return REAL_CAR_STAGE_TEMPLATE.map((stage) => ({
    name: stage.name,
    goal: stage.goal,
    ownerOpenId: defaultOwner,
    durationDays: String(DEFAULT_STAGE_DURATION_DAYS),
  }));
}

function stagesFromTemplate(
  template: ProjectTemplateOption,
  defaultOwner = "",
) {
  return template.stages.map((stage) => ({
    name: stage.name,
    goal: stage.goal,
    ownerOpenId: defaultOwner,
    durationDays: String(stage.durationDays),
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
  projectTemplates = [],
  mode = "create",
  initialProject,
  submitLabel,
  onSaved,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [liveRefreshPending, setLiveRefreshPending] = useState(false);
  const [stagePlanBaseDate] = useState(() => new Date());
  const editing = mode === "edit";
  const initialOwnerOpenIds = initialProject?.ownerOpenIds ?? [];
  const initialParticipantOpenIds = initialProject?.participantOpenIds ?? [];
  const primaryInitialOwner = initialOwnerOpenIds[0] ?? "";
  const defaultProjectTemplate =
    projectTemplates.find((template) => template.isDefault) ??
    projectTemplates[0] ??
    null;
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    defaultProjectTemplate?.id ?? "real-car",
  );

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
      participantOpenIds: initialParticipantOpenIds,
      allowOwnerSelfApproval: initialProject?.allowOwnerSelfApproval ?? false,
      template: "real-car",
      stages: editing
        ? []
        : defaultProjectTemplate
          ? stagesFromTemplate(defaultProjectTemplate)
          : realCarStages(),
    },
  });
  const errors = form.formState.errors;

  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: "stages",
  });

  const ownerOpenIds = useWatch({
    control: form.control,
    name: "ownerOpenIds",
  });
  const watchedStages =
    useWatch({
      control: form.control,
      name: "stages",
    }) ?? [];
  const team = useWatch({ control: form.control, name: "team" });
  const techGroup = useWatch({ control: form.control, name: "techGroup" });
  const primaryOwnerOpenId = ownerOpenIds?.[0] ?? "";
  const scopeErrorMessage = errors.team?.message ?? errors.techGroup?.message;
  const selectedTemplateLabel =
    projectTemplates.find((template) => template.id === selectedTemplateId)
      ?.name ?? "实车模板";
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
          participantOpenIds: data.participantOpenIds ?? [],
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
          participantOpenIds: data.participantOpenIds,
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

  const onInvalid: SubmitErrorHandler<ProjectFormValues> = (_errors, event) => {
    toast.error("请先补全项目表单中的必填项");
    const formElement =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    window.setTimeout(() => focusFirstInvalidControl(formElement), 0);
  };

  function applySelectedTemplate() {
    const template = projectTemplates.find(
      (item) => item.id === selectedTemplateId,
    );
    if (template) {
      form.setValue("template", "custom");
      form.setValue("stages", stagesFromTemplate(template, primaryOwnerOpenId));
      toast.success(`已套用「${template.name}」`);
      return;
    }

    form.setValue("template", "real-car");
    form.setValue("stages", realCarStages(primaryOwnerOpenId));
    toast.success("已套用实车模板");
  }

  function getCumulativeDurationDays(index: number) {
    return watchedStages
      .slice(0, index + 1)
      .reduce((total, stage) => total + (Number(stage?.durationDays) || 0), 0);
  }

  function getStageDuePreview(index: number) {
    const cumulativeDays = getCumulativeDurationDays(index);
    if (cumulativeDays <= 0) return "请先填写有效耗时";
    return formatDateTimeLocal(
      getStageDueAtByOffsetDays(cumulativeDays, stagePlanBaseDate),
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-6">
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
            <Input
              {...form.register("name")}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "project-name-error" : undefined}
            />
            <FormFieldError id="project-name-error" message={errors.name?.message} />
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
                  inputProps={{
                    "aria-invalid": !!errors.ownerOpenIds,
                    "aria-describedby": errors.ownerOpenIds
                      ? "project-owners-error"
                      : undefined,
                  }}
                />
              )}
            />
            <FormFieldError
              id="project-owners-error"
              message={errors.ownerOpenIds?.message}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>参与人员</Label>
            <Controller
              control={form.control}
              name="participantOpenIds"
              render={({ field }) => (
                <UserMultiSearchSelect
                  users={users}
                  value={field.value ?? []}
                  onChange={field.onChange}
                  placeholder="搜索参与人员"
                />
              )}
            />
            <p className="text-xs text-muted-foreground">
              参与人员可以查看项目并提交任务创建/撤销申请；项目负责人无需重复加入。
            </p>
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
                  <SelectTrigger
                    className="w-full"
                    aria-invalid={!!scopeErrorMessage}
                    aria-describedby={
                      scopeErrorMessage ? "project-scope-error" : undefined
                    }
                  >
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
                  <SelectTrigger
                    className="w-full"
                    aria-invalid={!!scopeErrorMessage}
                    aria-describedby={
                      scopeErrorMessage ? "project-scope-error" : undefined
                    }
                  >
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
          <FormFieldError
            className="sm:col-span-2"
            id="project-scope-error"
            message={scopeErrorMessage}
          />
        </CardContent>
      </Card>

      {!editing && (
        <Card>
          <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>项目阶段</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                可套用管理员维护的模板；套用后仍可手动调整阶段和 DDL。
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={selectedTemplateId}
                onValueChange={(value) => setSelectedTemplateId(value ?? "")}
              >
                <SelectTrigger className="w-full sm:w-44" aria-label="项目模板">
                  <SelectValue placeholder="选择项目模板">
                    {() => selectedTemplateLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {projectTemplates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                      {template.isDefault ? "（默认）" : ""}
                    </SelectItem>
                  ))}
                  {projectTemplates.length === 0 && (
                    <SelectItem value="real-car">实车模板</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={applySelectedTemplate}
              >
                套用模板
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
                    durationDays: String(DEFAULT_STAGE_DURATION_DAYS),
                  })
                }
              >
                <Plus className="mr-1 h-4 w-4" />
                添加
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <SortableCardList
              items={fields}
              getKey={(field) => field.id}
              getItemLabel={(_field, index) =>
                watchedStages[index]?.name || `阶段 ${index + 1}`
              }
              ariaLabel="项目阶段排序"
              className="space-y-3"
              itemTestId="project-stage-editor"
              itemClassName={(_field, _index, isDragging) =>
                cn(
                  "rounded-lg border bg-card p-4",
                  isDragging && "border-primary/50 bg-primary/5",
                )
              }
              onReorder={(_nextFields, _movedField, fromIndex, toIndex) =>
                move(fromIndex, toIndex)
              }
              renderItem={(_field, { index, dragHandleProps, moveItem }) => {
                const cumulativeDays = getCumulativeDurationDays(index);
                return (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-3 border-b pb-3">
                      <button
                        type="button"
                        {...dragHandleProps}
                        className="inline-flex h-8 cursor-grab items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`拖动阶段 ${index + 1}`}
                      >
                        <GripVertical className="h-4 w-4" />
                        阶段 {index + 1}
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={index === 0}
                          onClick={() => moveItem(index - 1)}
                          aria-label="上移阶段"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={index === fields.length - 1}
                          onClick={() => moveItem(index + 1)}
                          aria-label="下移阶段"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={fields.length <= 1}
                          onClick={() => remove(index)}
                          aria-label="删除阶段"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_11rem]">
                      <div className="space-y-2">
                        <Label>阶段名称</Label>
                        <Input
                          {...form.register(`stages.${index}.name`)}
                          aria-invalid={!!errors.stages?.[index]?.name}
                          aria-describedby={
                            errors.stages?.[index]?.name
                              ? `project-stage-${index}-name-error`
                              : undefined
                          }
                        />
                        <FormFieldError
                          id={`project-stage-${index}-name-error`}
                          message={errors.stages?.[index]?.name?.message}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>本阶段耗时（天）</Label>
                        <Input
                          type="number"
                          min={1}
                          max={3650}
                          {...form.register(`stages.${index}.durationDays`)}
                          aria-label={`阶段 ${index + 1} 耗时`}
                          aria-invalid={!!errors.stages?.[index]?.durationDays}
                          aria-describedby={
                            errors.stages?.[index]?.durationDays
                              ? `project-stage-${index}-duration-error`
                              : undefined
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          预计 {getStageDuePreview(index)} 截止
                          {cumulativeDays > 0 ? ` / 累计第 ${cumulativeDays} 天` : ""}
                        </p>
                        <FormFieldError
                          id={`project-stage-${index}-duration-error`}
                          message={errors.stages?.[index]?.durationDays?.message}
                        />
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      <Label>阶段目标</Label>
                      <Textarea
                        {...form.register(`stages.${index}.goal`)}
                        aria-invalid={!!errors.stages?.[index]?.goal}
                        aria-describedby={
                          errors.stages?.[index]?.goal
                            ? `project-stage-${index}-goal-error`
                            : undefined
                        }
                      />
                      <FormFieldError
                        id={`project-stage-${index}-goal-error`}
                        message={errors.stages?.[index]?.goal?.message}
                      />
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
                            inputProps={{
                              "aria-invalid":
                                !!errors.stages?.[index]?.ownerOpenId,
                              "aria-describedby": errors.stages?.[index]?.ownerOpenId
                                ? `project-stage-${index}-owner-error`
                                : undefined,
                            }}
                          />
                        )}
                      />
                      <FormFieldError
                        id={`project-stage-${index}-owner-error`}
                        message={errors.stages?.[index]?.ownerOpenId?.message}
                      />
                    </div>
                  </>
                );
              }}
            />
            {typeof errors.stages?.message === "string" && (
              <FormFieldError message={errors.stages.message} />
            )}
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

function focusFirstInvalidControl(container: HTMLElement | null) {
  const target = container?.querySelector<HTMLElement>(
    'input[aria-invalid="true"], textarea[aria-invalid="true"], button[aria-invalid="true"], [role="button"][aria-invalid="true"]',
  );
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.focus();
}

function formatDateTimeLocal(value: string) {
  const [datePart, timePart = ""] = value.split("T");
  const [year, month, day] = (datePart ?? "").split("-");
  const [hour = "00", minute = "00"] = timePart.split(":");
  if (!year || !month || !day) return value;
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function FormFieldError({
  id,
  message,
  className,
}: {
  id?: string;
  message?: string;
  className?: string;
}) {
  if (!message) return null;

  return (
    <p id={id} className={cn("text-sm text-destructive", className)}>
      {message}
    </p>
  );
}
