"use client";

import {
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  createProjectTemplate,
  deleteProjectTemplate,
  setDefaultProjectTemplate,
  updateProjectTemplate,
  updateProjectTemplateEnabled,
} from "@/app/actions/adminProjectTemplates";
import type { AdminProjectTemplate } from "@/components/admin/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SortableCardList } from "@/components/ui/sortable-card-list";
import { Textarea } from "@/components/ui/textarea";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { cn } from "@/lib/utils";

type StageDraft = {
  key: string;
  name: string;
  goal: string;
  durationDays: string;
};

type TemplateDraft = {
  templateId?: string;
  name: string;
  description: string;
  enabled: boolean;
  isDefault: boolean;
  stages: StageDraft[];
};

type DraftErrors = Record<string, string>;

export function ProjectTemplatesPanel({
  templates,
}: {
  templates: AdminProjectTemplate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] =
    useState<AdminProjectTemplate | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    templates[0]?.id ?? null,
  );
  const [draft, setDraft] = useState<TemplateDraft>(() => createEmptyDraft());
  const [errors, setErrors] = useState<DraftErrors>({});

  const sortedTemplates = useMemo(
    () =>
      [...templates].sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) ||
          Number(b.enabled) - Number(a.enabled) ||
          a.sortOrder - b.sortOrder ||
          a.createdAt.localeCompare(b.createdAt),
      ),
    [templates],
  );
  const selectedTemplate =
    sortedTemplates.find((template) => template.id === selectedTemplateId) ??
    sortedTemplates[0] ??
    null;

  function openCreateDialog() {
    setEditingTemplate(null);
    setDraft(createEmptyDraft());
    setErrors({});
    setDialogOpen(true);
  }

  function openEditDialog(template: AdminProjectTemplate) {
    setEditingTemplate(template);
    setDraft(createDraftFromTemplate(template));
    setErrors({});
    setDialogOpen(true);
  }

  function requestDelete(template: AdminProjectTemplate) {
    setSelectedTemplateId(template.id);
    setDeleteDialogOpen(true);
  }

  function handleSubmit() {
    const nextErrors = validateDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("请先修正项目模板表单");
      window.setTimeout(focusFirstInvalidControl, 0);
      return;
    }

    const payload = normalizeDraft(draft);
    startTransition(async () => {
      try {
        if (editingTemplate) {
          await updateProjectTemplate({
            templateId: editingTemplate.id,
            ...payload,
          });
          toast.success("项目模板已更新");
        } else {
          await createProjectTemplate(payload);
          toast.success("项目模板已创建");
        }
        setDialogOpen(false);
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "保存失败"));
      }
    });
  }

  function handleSetDefault(templateId: string) {
    startTransition(async () => {
      try {
        await setDefaultProjectTemplate({ templateId });
        toast.success("默认模板已更新");
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "设置失败"));
      }
    });
  }

  function handleToggleEnabled(template: AdminProjectTemplate) {
    startTransition(async () => {
      try {
        await updateProjectTemplateEnabled({
          templateId: template.id,
          enabled: !template.enabled,
        });
        toast.success(template.enabled ? "项目模板已停用" : "项目模板已启用");
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "更新失败"));
      }
    });
  }

  function handleDelete(template: AdminProjectTemplate) {
    startTransition(async () => {
      try {
        await deleteProjectTemplate({ templateId: template.id });
        toast.success("项目模板已删除");
        setDeleteDialogOpen(false);
        setSelectedTemplateId(null);
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "删除失败"));
      }
    });
  }

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>项目模板</CardTitle>
            <CardDescription>
              管理新建项目时可套用的阶段模板；阶段耗时会按顺序累加为项目 DDL。
            </CardDescription>
          </div>
          <Button type="button" onClick={openCreateDialog}>
            <Plus className="h-4 w-4" />
            新建模板
          </Button>
        </CardHeader>
        <CardContent className="min-w-0">
          {sortedTemplates.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              暂无项目模板，请先创建一个模板。
            </p>
          ) : (
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(15rem,0.75fr)_minmax(0,1.25fr)]">
              <div
                className="min-w-0 space-y-2"
                aria-label="项目模板列表"
                data-testid="project-template-list"
              >
                {sortedTemplates.map((template) => (
                  <TemplateSummaryButton
                    key={template.id}
                    template={template}
                    selected={selectedTemplate?.id === template.id}
                    onSelect={() => setSelectedTemplateId(template.id)}
                  />
                ))}
              </div>

              {selectedTemplate && (
                <TemplateDetailCard
                  template={selectedTemplate}
                  pending={pending}
                  onEdit={() => openEditDialog(selectedTemplate)}
                  onSetDefault={() => handleSetDefault(selectedTemplate.id)}
                  onToggleEnabled={() => handleToggleEnabled(selectedTemplate)}
                  onDelete={() => requestDelete(selectedTemplate)}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <TemplateEditorDialog
        open={dialogOpen}
        pending={pending}
        editing={!!editingTemplate}
        draft={draft}
        errors={errors}
        onOpenChange={setDialogOpen}
        onDraftChange={setDraft}
        onSubmit={handleSubmit}
      />

      <DeleteTemplateDialog
        open={deleteDialogOpen}
        pending={pending}
        template={selectedTemplate}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function TemplateSummaryButton({
  template,
  selected,
  onSelect,
}: {
  template: AdminProjectTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="project-template-summary"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-start justify-between gap-3 rounded-lg border bg-background px-3 py-3 text-left transition-colors hover:bg-muted/50",
        selected && "border-primary/50 bg-primary/5",
        !template.enabled && "opacity-70",
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{template.name}</span>
          {template.isDefault && <Badge>默认</Badge>}
          <Badge variant={template.enabled ? "secondary" : "outline"}>
            {template.enabled ? "启用" : "停用"}
          </Badge>
        </span>
        <span className="mt-1 block truncate text-sm text-muted-foreground">
          {template.description || "未填写描述"}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {template.stages.length} 阶段
      </span>
    </button>
  );
}

function TemplateDetailCard({
  template,
  pending,
  onEdit,
  onSetDefault,
  onToggleEnabled,
  onDelete,
}: {
  template: AdminProjectTemplate;
  pending: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const totalDurationDays = template.stages.reduce(
    (total, stage) => total + stage.durationDays,
    0,
  );

  return (
    <section
      data-testid="project-template-detail-card"
      className={cn(
        "min-w-0 rounded-lg border bg-background p-4",
        template.isDefault && "border-primary/40 bg-primary/5",
      )}
      aria-label={`项目模板详情：${template.name}`}
    >
      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{template.name}</h2>
            {template.isDefault && (
              <Badge data-testid="project-template-default-badge">默认</Badge>
            )}
            <Badge variant={template.enabled ? "secondary" : "outline"}>
              {template.enabled ? "启用" : "停用"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {template.description || "未填写模板描述"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            共 {template.stages.length} 个阶段，预计耗时 {totalDurationDays} 天。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={onEdit}
          >
            <Pencil className="h-4 w-4" />
            编辑
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || template.isDefault || !template.enabled}
            onClick={onSetDefault}
            title={
              template.isDefault
                ? "当前已是默认模板"
                : !template.enabled
                  ? "停用模板不能设为默认"
                  : undefined
            }
          >
            <Check className="h-4 w-4" />
            设默认
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || template.isDefault}
            onClick={onToggleEnabled}
            title={template.isDefault ? "默认模板不能停用" : undefined}
          >
            {template.enabled ? (
              <PowerOff className="h-4 w-4" />
            ) : (
              <Power className="h-4 w-4" />
            )}
            {template.enabled ? "停用" : "启用"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending || template.isDefault}
            onClick={onDelete}
            title={template.isDefault ? "默认模板不能删除" : undefined}
          >
            <Trash2 className="h-4 w-4" />
            删除
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {template.stages.map((stage, index) => {
          const cumulativeDays = template.stages
            .slice(0, index + 1)
            .reduce((total, item) => total + item.durationDays, 0);
          return (
            <div
              key={stage.id}
              className="grid min-w-0 gap-2 rounded-md border px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_8rem]"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {index + 1}. {stage.name}
                </p>
                <p className="truncate text-muted-foreground">{stage.goal}</p>
              </div>
              <p className="text-left font-medium tabular-nums sm:text-right">
                耗时 {stage.durationDays} 天
                <span className="block text-xs font-normal text-muted-foreground">
                  累计第 {cumulativeDays} 天
                </span>
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DeleteTemplateDialog({
  open,
  pending,
  template,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  template: AdminProjectTemplate | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (template: AdminProjectTemplate) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除项目模板</DialogTitle>
          <DialogDescription>
            删除模板不会影响已创建项目，但该模板将无法再被新项目套用。
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          确认删除「<span className="font-medium">{template?.name}</span>」？
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || !template || template.isDefault}
            onClick={() => template && onConfirm(template)}
          >
            删除模板
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateEditorDialog({
  open,
  pending,
  editing,
  draft,
  errors,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  editing: boolean;
  draft: TemplateDraft;
  errors: DraftErrors;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: TemplateDraft) => void;
  onSubmit: () => void;
}) {
  function updateStage(index: number, patch: Partial<StageDraft>) {
    onDraftChange({
      ...draft,
      stages: draft.stages.map((stage, stageIndex) =>
        stageIndex === index ? { ...stage, ...patch } : stage,
      ),
    });
  }

  function addStage() {
    onDraftChange({
      ...draft,
      stages: [
        ...draft.stages,
        createEmptyStage(draft.stages.length, "7"),
      ],
    });
  }

  function removeStage(index: number) {
    onDraftChange({
      ...draft,
      stages: draft.stages.filter((_, stageIndex) => stageIndex !== index),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑项目模板" : "新建项目模板"}</DialogTitle>
          <DialogDescription>
            模板只影响之后新建的项目，不会改动已有项目的阶段和 DDL。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>模板名称</Label>
              <Input
                aria-label="模板名称"
                value={draft.name}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "template-name-error" : undefined}
                onChange={(event) =>
                  onDraftChange({ ...draft, name: event.target.value })
                }
              />
              <FormFieldError id="template-name-error" message={errors.name} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    onDraftChange({ ...draft, enabled: event.target.checked })
                  }
                />
                启用
              </label>
              <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      isDefault: event.target.checked,
                      enabled: event.target.checked ? true : draft.enabled,
                    })
                  }
                />
                默认模板
              </label>
            </div>
          </div>
          <div className="space-y-2">
            <Label>模板描述</Label>
            <Textarea
              aria-label="模板描述"
              value={draft.description}
              onChange={(event) =>
                onDraftChange({ ...draft, description: event.target.value })
              }
            />
            <FormFieldError message={errors.description} />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">模板阶段</p>
                <p className="text-sm text-muted-foreground">
                  每个阶段填写本阶段预计消耗天数，系统会按顺序累加为项目 DDL。
                </p>
              </div>
              <Button type="button" variant="outline" onClick={addStage}>
                <Plus className="h-4 w-4" />
                添加阶段
              </Button>
            </div>
            <FormFieldError message={errors.stages} />

            <SortableCardList
              items={draft.stages}
              getKey={(stage) => stage.key}
              getItemLabel={(stage) => stage.name || "未命名阶段"}
              ariaLabel="模板阶段排序"
              className="space-y-3"
              itemTestId="project-template-stage-editor"
              itemClassName={(_stage, _index, isDragging) =>
                cn(
                  "rounded-lg border p-3 bg-card",
                  isDragging && "border-primary/50 bg-primary/5",
                )
              }
              onReorder={(nextStages) =>
                onDraftChange({ ...draft, stages: nextStages })
              }
              renderItem={(stage, { index, dragHandleProps, moveItem }) => {
                const cumulativeDays = draft.stages
                  .slice(0, index + 1)
                  .reduce((total, item) => total + (Number(item.durationDays) || 0), 0);
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
                          disabled={index === draft.stages.length - 1}
                          onClick={() => moveItem(index + 1)}
                          aria-label="下移阶段"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={draft.stages.length <= 1}
                          onClick={() => removeStage(index)}
                          aria-label="删除阶段"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                      <div className="space-y-2">
                        <Label>阶段名称</Label>
                        <Input
                          aria-label={`阶段 ${index + 1} 名称`}
                          value={stage.name}
                          aria-invalid={!!errors[`stages.${index}.name`]}
                          aria-describedby={
                            errors[`stages.${index}.name`]
                              ? `template-stage-${index}-name-error`
                              : undefined
                          }
                          onChange={(event) =>
                            updateStage(index, { name: event.target.value })
                          }
                        />
                        <FormFieldError
                          id={`template-stage-${index}-name-error`}
                          message={errors[`stages.${index}.name`]}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>本阶段耗时（天）</Label>
                        <Input
                          aria-label={`阶段 ${index + 1} 耗时`}
                          type="number"
                          min={1}
                          max={3650}
                          value={stage.durationDays}
                          aria-invalid={!!errors[`stages.${index}.durationDays`]}
                          aria-describedby={
                            errors[`stages.${index}.durationDays`]
                              ? `template-stage-${index}-duration-error`
                              : undefined
                          }
                          onChange={(event) =>
                            updateStage(index, {
                              durationDays: event.target.value,
                            })
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          累计第 {cumulativeDays} 天截止
                        </p>
                        <FormFieldError
                          id={`template-stage-${index}-duration-error`}
                          message={errors[`stages.${index}.durationDays`]}
                        />
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      <Label>阶段目标</Label>
                      <Textarea
                        aria-label={`阶段 ${index + 1} 目标`}
                        value={stage.goal}
                        aria-invalid={!!errors[`stages.${index}.goal`]}
                        aria-describedby={
                          errors[`stages.${index}.goal`]
                            ? `template-stage-${index}-goal-error`
                            : undefined
                        }
                        onChange={(event) =>
                          updateStage(index, { goal: event.target.value })
                        }
                      />
                      <FormFieldError
                        id={`template-stage-${index}-goal-error`}
                        message={errors[`stages.${index}.goal`]}
                      />
                    </div>
                  </>
                );
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" disabled={pending} onClick={onSubmit}>
            {editing ? "保存模板" : "创建模板"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function createEmptyDraft(): TemplateDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    isDefault: false,
    stages: [
      createEmptyStage(0, "7"),
      createEmptyStage(1, "7"),
      createEmptyStage(2, "7"),
    ],
  };
}

function createDraftFromTemplate(template: AdminProjectTemplate): TemplateDraft {
  return {
    templateId: template.id,
    name: template.name,
    description: template.description,
    enabled: template.enabled,
    isDefault: template.isDefault,
    stages: template.stages.map((stage, index) => ({
      key: stage.id || `stage-${index}`,
      name: stage.name,
      goal: stage.goal,
      durationDays: String(stage.durationDays),
    })),
  };
}

function createEmptyStage(index: number, durationDays: string): StageDraft {
  return {
    key: `new-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
    name: "",
    goal: "",
    durationDays,
  };
}

function normalizeDraft(draft: TemplateDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    isDefault: draft.isDefault,
    stages: draft.stages.map((stage) => ({
      name: stage.name.trim(),
      goal: stage.goal.trim(),
      durationDays: Number(stage.durationDays),
    })),
  };
}

function validateDraft(draft: TemplateDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.name.trim()) {
    errors.name = "请输入模板名称";
  }
  if (draft.name.trim().length > 100) {
    errors.name = "模板名称不能超过 100 个字符";
  }
  if (draft.description.trim().length > 1000) {
    errors.description = "模板描述不能超过 1000 个字符";
  }
  if (draft.stages.length === 0) {
    errors.stages = "至少添加一个阶段";
  }

  let totalDurationDays = 0;
  draft.stages.forEach((stage, index) => {
    if (!stage.name.trim()) {
      errors[`stages.${index}.name`] = "阶段名称不能为空";
    }
    if (!stage.goal.trim()) {
      errors[`stages.${index}.goal`] = "请填写阶段目标";
    }
    const durationDays = Number(stage.durationDays);
    if (!stage.durationDays.trim() || !Number.isInteger(durationDays)) {
      errors[`stages.${index}.durationDays`] = "阶段耗时必须是整数";
      return;
    }
    if (durationDays < 1 || durationDays > 3650) {
      errors[`stages.${index}.durationDays`] =
        "阶段耗时需要在 1 到 3650 天之间";
      return;
    }
    totalDurationDays += durationDays;
  });
  if (totalDurationDays > 3650) {
    errors.stages = "模板总耗时不能超过 3650 天";
  }

  return errors;
}

function focusFirstInvalidControl() {
  const target = document.querySelector<HTMLElement>(
    'input[aria-invalid="true"], textarea[aria-invalid="true"]',
  );
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.focus();
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
