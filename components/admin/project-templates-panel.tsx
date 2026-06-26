"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createProjectTemplate,
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
import { Textarea } from "@/components/ui/textarea";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { cn } from "@/lib/utils";

type StageDraft = {
  key: string;
  name: string;
  goal: string;
  dueOffsetDays: string;
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
  const [editingTemplate, setEditingTemplate] =
    useState<AdminProjectTemplate | null>(null);
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

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>项目模板</CardTitle>
            <CardDescription>
              管理新建项目时可套用的阶段模板；相对 DDL 表示创建项目后第 N 天截止。
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
            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              {sortedTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  pending={pending}
                  onEdit={() => openEditDialog(template)}
                  onSetDefault={() => handleSetDefault(template.id)}
                  onToggleEnabled={() => handleToggleEnabled(template)}
                />
              ))}
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
    </div>
  );
}

function TemplateCard({
  template,
  pending,
  onEdit,
  onSetDefault,
  onToggleEnabled,
}: {
  template: AdminProjectTemplate;
  pending: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
  onToggleEnabled: () => void;
}) {
  return (
    <div
      data-testid="project-template-card"
      className={cn(
        "min-w-0 rounded-lg border bg-background p-4",
        template.isDefault && "border-primary/40 bg-primary/5",
        !template.enabled && "opacity-70",
      )}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{template.name}</h2>
            {template.isDefault && (
              <Badge data-testid="project-template-default-badge">默认</Badge>
            )}
            <Badge variant={template.enabled ? "secondary" : "outline"}>
              {template.enabled ? "启用" : "停用"}
            </Badge>
          </div>
          {template.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {template.description}
            </p>
          )}
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
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {template.stages.map((stage) => (
          <div
            key={stage.id}
            className="grid min-w-0 gap-2 rounded-md border px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_5rem]"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{stage.name}</p>
              <p className="truncate text-muted-foreground">{stage.goal}</p>
            </div>
            <p className="text-right font-medium tabular-nums">
              第 {stage.dueOffsetDays} 天
            </p>
          </div>
        ))}
      </div>
    </div>
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
    const last = draft.stages.at(-1);
    const nextOffset = Number(last?.dueOffsetDays || 0) + 7;
    onDraftChange({
      ...draft,
      stages: [
        ...draft.stages,
        createEmptyStage(draft.stages.length, String(nextOffset)),
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
                  相对 DDL 天数允许相同，但后续阶段不能早于前一阶段。
                </p>
              </div>
              <Button type="button" variant="outline" onClick={addStage}>
                <Plus className="h-4 w-4" />
                添加阶段
              </Button>
            </div>
            <FormFieldError message={errors.stages} />

            {draft.stages.map((stage, index) => (
              <div key={stage.key} className="rounded-lg border p-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                  <div className="space-y-2">
                    <Label>阶段名称</Label>
                    <Input
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
                    <Label>第 N 天截止</Label>
                    <Input
                      type="number"
                      min={0}
                      max={3650}
                      value={stage.dueOffsetDays}
                      aria-invalid={!!errors[`stages.${index}.dueOffsetDays`]}
                      aria-describedby={
                        errors[`stages.${index}.dueOffsetDays`]
                          ? `template-stage-${index}-due-error`
                          : undefined
                      }
                      onChange={(event) =>
                        updateStage(index, {
                          dueOffsetDays: event.target.value,
                        })
                      }
                    />
                    <FormFieldError
                      id={`template-stage-${index}-due-error`}
                      message={errors[`stages.${index}.dueOffsetDays`]}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={draft.stages.length <= 1}
                      onClick={() => removeStage(index)}
                      aria-label="删除阶段"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  <Label>阶段目标</Label>
                  <Textarea
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
              </div>
            ))}
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
      createEmptyStage(1, "14"),
      createEmptyStage(2, "21"),
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
      dueOffsetDays: String(stage.dueOffsetDays),
    })),
  };
}

function createEmptyStage(index: number, dueOffsetDays: string): StageDraft {
  return {
    key: `new-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
    name: "",
    goal: "",
    dueOffsetDays,
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
      dueOffsetDays: Number(stage.dueOffsetDays),
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

  let previousOffset: number | null = null;
  draft.stages.forEach((stage, index) => {
    if (!stage.name.trim()) {
      errors[`stages.${index}.name`] = "阶段名称不能为空";
    }
    if (!stage.goal.trim()) {
      errors[`stages.${index}.goal`] = "请填写阶段目标";
    }
    const offset = Number(stage.dueOffsetDays);
    if (!stage.dueOffsetDays.trim() || !Number.isInteger(offset)) {
      errors[`stages.${index}.dueOffsetDays`] = "相对 DDL 天数必须是整数";
      return;
    }
    if (offset < 0 || offset > 3650) {
      errors[`stages.${index}.dueOffsetDays`] =
        "相对 DDL 天数需要在 0 到 3650 天之间";
      return;
    }
    if (previousOffset !== null && offset < previousOffset) {
      errors[`stages.${index}.dueOffsetDays`] =
        "阶段相对 DDL 天数需要按顺序递增或相同";
    }
    previousOffset = offset;
  });

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
