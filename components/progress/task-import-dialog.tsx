"use client";

import { useRef, useState } from "react";
import {
  AlertTriangle,
  FileSpreadsheet,
  RotateCcw,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { importProgressTasks } from "@/app/actions/progress/importTasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { UserMultiSearchSelect } from "@/components/user-search-select";
import { getActionErrorMessage } from "@/lib/action-error-message";
import {
  downloadProgressTaskImportTemplate,
  parseProgressTasksFromFile,
  type ImportedTaskWarning,
  type ParsedImportedTask,
} from "@/lib/import-progress-tasks";
import { TECH_GROUP_OPTIONS } from "@/lib/constants";
import { importanceLabels, urgencyLabels } from "@/lib/progress-labels";
import type { BatchTaskImportInput } from "@/lib/validations/progress";
import { cn } from "@/lib/utils";

type UserOption = { openId: string; name: string; avatar?: string | null };
type StageOption = { id: string; name: string };
type ImportMode = "create" | "request";

type EditableImportedTask = ParsedImportedTask & {
  stageId: string;
  ignored: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  users: UserOption[];
  stages: StageOption[];
  mode: ImportMode;
  onImported: () => void;
};

export function TaskImportDialog({
  open,
  onOpenChange,
  projectId,
  users,
  stages,
  mode,
  onImported,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tasks, setTasks] = useState<EditableImportedTask[]>([]);
  const [fileErrors, setFileErrors] = useState<ImportedTaskWarning[]>([]);
  const [bulkStageId, setBulkStageId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [showWarningsOnly, setShowWarningsOnly] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const selectedTask = tasks.find((task) => task.importId === selectedTaskId) ?? null;
  const activeTasks = tasks.filter((task) => !task.ignored);
  const visibleTasks = tasks.filter((task) => {
    if (!showWarningsOnly) return true;
    return getAllIssues(task).length > 0;
  });
  const blockingIssueCount = activeTasks.reduce(
    (total, task) => total + getValidationIssues(task).length,
    0,
  );
  const warningCount = tasks.reduce(
    (total, task) => total + getAllIssues(task).length,
    0,
  );
  const canSubmit =
    activeTasks.length > 0 && blockingIssueCount === 0 && !submitting && fileErrors.length === 0;

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setParsing(true);
    try {
      const result = await parseProgressTasksFromFile(file, users);
      setFileErrors(result.errors);
      const nextTasks = result.tasks.map((task) => ({
        ...task,
        stageId: "",
        ignored: false,
      }));
      setTasks(nextTasks);
      setSelectedTaskId(nextTasks[0]?.importId ?? "");
      setBulkStageId("");
      setShowWarningsOnly(false);
      if (result.errors.length > 0) {
        toast.error(result.errors[0]?.message ?? "文件结构不正确");
      } else {
        toast.success(`已解析 ${nextTasks.length} 条任务`);
      }
    } catch (error) {
      setTasks([]);
      setFileErrors([
        {
          field: "file",
          message: error instanceof Error ? error.message : "文件解析失败",
        },
      ]);
      toast.error(error instanceof Error ? error.message : "文件解析失败");
    } finally {
      setParsing(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function reset() {
    setTasks([]);
    setFileErrors([]);
    setBulkStageId("");
    setSelectedTaskId("");
    setShowWarningsOnly(false);
    setSubmitting(false);
  }

  function applyBulkStage(stageId: string) {
    const nextStageId = stageId === "none" ? "" : stageId;
    setBulkStageId(nextStageId);
    setTasks((current) =>
      current.map((task) => (task.ignored ? task : { ...task, stageId: nextStageId })),
    );
  }

  function updateTask(importId: string, patch: Partial<EditableImportedTask>) {
    setTasks((current) =>
      current.map((task) =>
        task.importId === importId ? { ...task, ...patch } : task,
      ),
    );
  }

  function updateAssignees(task: EditableImportedTask, openIds: string[]) {
    const selectedUsers = openIds
      .map((openId) => users.find((user) => user.openId === openId))
      .filter((user): user is UserOption => !!user);
    updateTask(task.importId, {
      assigneeOpenIds: openIds,
      assigneeNames: selectedUsers.map((user) => user.name),
    });
  }

  async function handleSubmit() {
    if (activeTasks.length === 0) {
      toast.error("没有可提交的任务");
      return;
    }
    if (blockingIssueCount > 0) {
      toast.error("请先补齐任务列表中的必填信息");
      setShowWarningsOnly(true);
      return;
    }

    setSubmitting(true);
    try {
      const payload: BatchTaskImportInput = {
        projectId,
        defaultStageId: bulkStageId || activeTasks[0]?.stageId || "",
        mode,
        tasks: activeTasks.map((task) => ({
          importId: task.importId,
          stageId: task.stageId,
          title: task.title,
          goal: task.goal,
          taskTechGroups: task.taskTechGroups,
          urgency: task.urgency,
          importance: task.importance,
          assigneeOpenIds: task.assigneeOpenIds,
          metrics: task.metrics,
          dueAt: task.dueAt,
          needsOfflineConfirmation: false,
          needsWeeklyReport: task.needsWeeklyReport,
          acceptanceChecklistItems: [],
        })),
      };
      const result = await importProgressTasks(payload);
      toast.success(
        result.mode === "request"
          ? `已提交 ${result.count} 个任务申请`
          : `已创建 ${result.count} 个任务`,
      );
      reset();
      onOpenChange(false);
      onImported();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "导入失败"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[1120px]">
        <DialogHeader>
          <DialogTitle>从验收标准导入任务</DialogTitle>
          <DialogDescription>
            上传 Excel/CSV 后先预览和修正任务；提交前必须选择所属阶段。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              data-testid="progress-task-import-file"
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              type="button"
              variant="outline"
              disabled={parsing}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              {parsing ? "解析中…" : "选择文件"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => downloadProgressTaskImportTemplate()}
            >
              <FileSpreadsheet className="h-4 w-4" />
              下载模板
            </Button>
            {tasks.length > 0 && (
              <div className="ml-auto flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">解析 {tasks.length} 条</Badge>
                <Badge variant={warningCount > 0 ? "destructive" : "outline"}>
                  警报 {warningCount}
                </Badge>
                <Badge variant={blockingIssueCount > 0 ? "destructive" : "outline"}>
                  待补 {blockingIssueCount}
                </Badge>
              </div>
            )}
          </div>

          {fileErrors.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {fileErrors.map((error) => (
                <p key={`${error.field}-${error.message}`}>{error.message}</p>
              ))}
            </div>
          )}

          {tasks.length > 0 && (
            <>
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <div className="space-y-2">
                  <Label>批量所属阶段</Label>
                  <Select
                    value={bulkStageId || "none"}
                    onValueChange={(value) => applyBulkStage(value ?? "none")}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="批量所属阶段"
                      data-testid="progress-task-import-bulk-stage"
                    >
                      <SelectValue placeholder="请选择阶段">
                        {(value) =>
                          value === "none"
                            ? "请选择阶段"
                            : stages.find((stage) => stage.id === value)?.name
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">请选择阶段</SelectItem>
                      {stages.map((stage) => (
                        <SelectItem key={stage.id} value={stage.id}>
                          {stage.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  variant={showWarningsOnly ? "default" : "outline"}
                  onClick={() => setShowWarningsOnly((value) => !value)}
                >
                  <AlertTriangle className="h-4 w-4" />
                  只看警报
                </Button>
              </div>

              <div className="grid min-h-[420px] gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
                <div
                  className="max-h-[520px] space-y-2 overflow-y-auto pr-1"
                  data-testid="progress-task-import-list"
                >
                  {visibleTasks.length === 0 ? (
                    <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                      当前没有符合筛选的任务。
                    </div>
                  ) : (
                    visibleTasks.map((task) => (
                      <TaskImportListItem
                        key={task.importId}
                        task={task}
                        selected={task.importId === selectedTaskId}
                        stageName={stageName(stages, task.stageId)}
                        issueCount={getAllIssues(task).length}
                        validationIssueCount={getValidationIssues(task).length}
                        onSelect={() => setSelectedTaskId(task.importId)}
                        onToggleIgnored={() =>
                          updateTask(task.importId, { ignored: !task.ignored })
                        }
                      />
                    ))
                  )}
                </div>

                <div className="min-w-0">
                  {selectedTask ? (
                    <TaskImportDetailCard
                      task={selectedTask}
                      users={users}
                      stages={stages}
                      issues={getAllIssues(selectedTask)}
                      onChange={(patch) => updateTask(selectedTask.importId, patch)}
                      onAssigneesChange={(openIds) => updateAssignees(selectedTask, openIds)}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                      选择左侧任务查看和编辑详情。
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            data-testid="progress-task-import-submit"
          >
            {submitting
              ? "提交中…"
              : mode === "request"
                ? `提交 ${activeTasks.length} 个任务申请`
                : `创建 ${activeTasks.length} 个任务`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskImportListItem({
  task,
  selected,
  stageName,
  issueCount,
  validationIssueCount,
  onSelect,
  onToggleIgnored,
}: {
  task: EditableImportedTask;
  selected: boolean;
  stageName: string;
  issueCount: number;
  validationIssueCount: number;
  onSelect: () => void;
  onToggleIgnored: () => void;
}) {
  return (
    <div
      data-testid="progress-task-import-row"
      className="relative w-full rounded-lg"
    >
      <button
        type="button"
        aria-label={`查看第 ${task.rowNumber} 行任务详情`}
        onClick={onSelect}
        className={cn(
          "absolute inset-0 rounded-lg border text-left transition hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          selected && "border-primary bg-primary/5",
          task.ignored && "opacity-60",
        )}
      />
      <div
        className={cn(
          "pointer-events-none relative z-10 p-3 pb-0",
          task.ignored && "opacity-60",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              第 {task.rowNumber} 行 · {task.title || "未填写任务目标"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {stageName || "未选阶段"} ·{" "}
              {task.taskTechGroups.join("、") || "未选技术组"} ·{" "}
              {task.assigneeNames.join("、") || "未选负责人"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1">
            {task.ignored && <Badge variant="outline">已忽略</Badge>}
            {issueCount > 0 && (
              <Badge variant={validationIssueCount > 0 ? "destructive" : "outline"}>
                {issueCount} 个警报
              </Badge>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {task.dueAt ? new Date(task.dueAt).toLocaleString("zh-CN") : "未选 DDL"}
          </span>
          <span>紧急：{urgencyLabels[task.urgency]}</span>
          <span>重要：{importanceLabels[task.importance]}</span>
          {task.needsWeeklyReport && <span>需要周报</span>}
        </div>
      </div>
      <div className="relative z-20 flex flex-wrap gap-2 px-3 py-2">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onToggleIgnored}
        >
          {task.ignored ? (
            <>
              <RotateCcw className="h-3 w-3" />
              恢复
            </>
          ) : (
            "忽略"
          )}
        </Button>
      </div>
    </div>
  );
}

function TaskImportDetailCard({
  task,
  users,
  stages,
  issues,
  onChange,
  onAssigneesChange,
}: {
  task: EditableImportedTask;
  users: UserOption[];
  stages: StageOption[];
  issues: ImportedTaskWarning[];
  onChange: (patch: Partial<EditableImportedTask>) => void;
  onAssigneesChange: (openIds: string[]) => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="progress-task-import-detail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">任务详情</p>
          <p className="text-xs text-muted-foreground">第 {task.rowNumber} 行</p>
        </div>
        <Badge variant={issues.length > 0 ? "destructive" : "outline"}>
          {issues.length > 0 ? `${issues.length} 个警报` : "信息完整"}
        </Badge>
      </div>

      {issues.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          {issues.map((issue, index) => (
            <p key={`${issue.field}-${issue.message}-${index}`}>{issue.message}</p>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Label>任务目标</Label>
        <Input
          value={task.title}
          onChange={(event) => onChange({ title: event.target.value })}
          aria-label="导入任务目标"
        />
      </div>
      <div className="space-y-2">
        <Label>所属阶段</Label>
        <Select
          value={task.stageId || "none"}
          onValueChange={(value) =>
            onChange({ stageId: !value || value === "none" ? "" : value })
          }
        >
          <SelectTrigger className="w-full" aria-label="导入任务所属阶段">
            <SelectValue placeholder="请选择阶段">
              {(value) =>
                value === "none"
                  ? "请选择阶段"
                  : stages.find((stage) => stage.id === value)?.name
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">请选择阶段</SelectItem>
            {stages.map((stage) => (
              <SelectItem key={stage.id} value={stage.id}>
                {stage.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>任务技术组</Label>
        <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
          {TECH_GROUP_OPTIONS.map((group) => {
            const selected = task.taskTechGroups.includes(group);
            return (
              <label key={group} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => {
                    const next = new Set(task.taskTechGroups);
                    if (event.target.checked) next.add(group);
                    else next.delete(group);
                    onChange({ taskTechGroups: [...next] });
                  }}
                />
                {group}
              </label>
            );
          })}
        </div>
      </div>
      <div className="space-y-2">
        <Label>负责人</Label>
        <UserMultiSearchSelect
          users={users}
          value={task.assigneeOpenIds}
          onChange={onAssigneesChange}
          placeholder="搜索负责人姓名"
        />
      </div>
      <div className="space-y-2">
        <Label>定量/定性指标</Label>
        <Textarea
          value={task.metrics}
          onChange={(event) => onChange({ metrics: event.target.value })}
          rows={3}
        />
      </div>
      <div className="space-y-2">
        <Label>详细说明</Label>
        <Textarea
          value={task.goal}
          onChange={(event) => onChange({ goal: event.target.value })}
          rows={4}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>紧急程度</Label>
          <Select
            value={task.urgency}
            onValueChange={(value) => onChange({ urgency: value as EditableImportedTask["urgency"] })}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {(value) => urgencyLabels[value as keyof typeof urgencyLabels]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(urgencyLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>重要程度</Label>
          <Select
            value={task.importance}
            onValueChange={(value) =>
              onChange({ importance: value as EditableImportedTask["importance"] })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {(value) => importanceLabels[value as keyof typeof importanceLabels]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(importanceLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label>最晚完成时间</Label>
        <Input
          type="datetime-local"
          value={task.dueAt}
          onChange={(event) => onChange({ dueAt: event.target.value })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={task.needsWeeklyReport}
          onChange={(event) => onChange({ needsWeeklyReport: event.target.checked })}
        />
        需要定期周报
      </label>
    </div>
  );
}

function getAllIssues(task: EditableImportedTask): ImportedTaskWarning[] {
  return [...task.warnings, ...getValidationIssues(task)];
}

function getValidationIssues(task: EditableImportedTask): ImportedTaskWarning[] {
  if (task.ignored) return [];
  const issues: ImportedTaskWarning[] = [];
  if (!task.title.trim()) issues.push({ field: "title", message: "缺少任务目标" });
  if (!task.stageId) issues.push({ field: "stageId", message: "请选择所属阶段" });
  if (task.taskTechGroups.length === 0) {
    issues.push({ field: "taskTechGroups", message: "请选择任务技术组" });
  }
  if (task.assigneeOpenIds.length === 0) {
    issues.push({ field: "assigneeOpenIds", message: "请选择负责人" });
  }
  if (!task.metrics.trim()) {
    issues.push({ field: "metrics", message: "请填写定量/定性指标" });
  }
  if (!task.dueAt || Number.isNaN(new Date(task.dueAt).getTime())) {
    issues.push({ field: "dueAt", message: "请选择有效最晚完成时间" });
  }
  return issues;
}

function stageName(stages: StageOption[], stageId: string) {
  return stages.find((stage) => stage.id === stageId)?.name ?? "";
}
