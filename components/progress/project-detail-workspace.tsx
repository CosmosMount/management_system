"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Filter,
  History,
  Play,
  Plus,
  RotateCcw,
  Search,
  XCircle,
  ArrowUpRight,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ApprovalDecision,
  Importance,
  ProjectStatus,
  StageStatus,
  TaskCategory,
  TaskStatus,
  Urgency,
} from "@prisma/client";
import {
  approveStageSubmission,
  rejectStageSubmission,
  submitStageEvidence,
} from "@/app/actions/progress/projectStages";
import { loadMoreProjectActivityLogs } from "@/app/actions/progress/activityLogs";
import { updateProjectStatus } from "@/app/actions/progress/updateProjectStatus";
import { updateTaskStatus } from "@/app/actions/progress/updateTask";
import { BackLink } from "@/components/back-link";
import { ProjectForm } from "@/components/progress/project-form";
import { ManualReminderButton } from "@/components/progress/manual-reminder-button";
import { ArchivedProjectDeleteButton } from "@/components/admin-delete-actions";
import { TaskForm } from "@/components/progress/task-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { cn } from "@/lib/utils";
import { routes } from "@/lib/routes";
import {
  importanceLabels,
  projectStatusLabels,
  stageStatusLabels,
  taskCategoryLabels,
  taskStatusLabels,
  urgencyLabels,
} from "@/lib/progress-labels";

export type ProjectDetailView = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  team: string;
  techGroup: string;
  ownerOpenId: string;
  ownerName: string;
  ownerOpenIds: string[];
  ownerNames: string;
  allowOwnerSelfApproval: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  stages: StageView[];
  tasks: TaskView[];
  activityLogs: ActivityLogView[];
  hasMoreActivityLogs: boolean;
};

export type StageView = {
  id: string;
  name: string;
  goal: string;
  sortOrder: number;
  status: StageStatus;
  evidenceUrl: string;
  ownerOpenId: string;
  ownerName: string;
  dueAt: string | null;
  currentSubmissionId: string | null;
  canSubmit: boolean;
  submissions: StageSubmissionView[];
};

export type StageSubmissionView = {
  id: string;
  feishuDocUrl: string;
  note: string;
  submittedBy: string;
  submitterName: string;
  submittedAt: string;
  canApprove: boolean;
  approvals: ApprovalView[];
};

export type ApprovalView = {
  id: string;
  decision: ApprovalDecision;
  approverName: string;
  comment: string;
  createdAt: string;
};

export type TaskView = {
  id: string;
  title: string;
  goal: string;
  category: TaskCategory;
  urgency: Urgency;
  importance: Importance;
  status: TaskStatus;
  isOverdue: boolean;
  assigneeNames: string;
  assigneeOpenIds: string[];
  stageId: string | null;
  stageName: string | null;
  metrics: string;
  dueAt: string;
  riskNote: string;
  submissionsCount: number;
  pendingDeletionRequest: {
    id: string;
    requesterName: string;
    createdAt: string;
  } | null;
};

export type ActivityLogView = {
  id: string;
  action: string;
  taskId: string | null;
  actorName: string;
  payload: string;
  createdAt: string;
};

type UserOption = { openId: string; name: string; avatar?: string | null };
type AcceptanceChecklistTemplateOption = { id: string; content: string };

type Props = {
  project: ProjectDetailView;
  users: UserOption[];
  acceptanceChecklistTemplates: AcceptanceChecklistTemplateOption[];
  canManage: boolean;
  canUpdateLifecycle: boolean;
  isSuperAdmin?: boolean;
  userOpenId?: string;
};

type TaskScope = "stage" | "project";
type TaskFilters = {
  search: string;
  status: TaskStatus | "ALL";
  mine: boolean;
  overdue: boolean;
  pending: boolean;
  unfinished: boolean;
};
type ActivityFilter = "ALL" | "PROJECT" | "STAGE" | "TASK" | "REVIEW";
type ActivityHistoryState = {
  sourceKey: string;
  extraLogs: ActivityLogView[];
  hasMore: boolean;
};

const taskStatusOptions: Array<TaskStatus | "ALL"> = [
  "ALL",
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
  "COMPLETED",
  "ARCHIVED",
];

const activityFilters: Array<{ value: ActivityFilter; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "PROJECT", label: "项目" },
  { value: "STAGE", label: "阶段" },
  { value: "TASK", label: "任务" },
  { value: "REVIEW", label: "审核" },
];

export function ProjectDetailWorkspace({
  project,
  users,
  acceptanceChecklistTemplates,
  canManage,
  canUpdateLifecycle,
  isSuperAdmin = false,
  userOpenId,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentStage = getCurrentStage(project.stages);
  const selectedStageId =
    searchParams.get("stage") ?? currentStage?.id ?? project.stages[0]?.id ?? "";
  const [taskScope, setTaskScope] = useState<TaskScope>("stage");
  const [taskFilters, setTaskFilters] = useState<TaskFilters>({
    search: "",
    status: "ALL",
    mine: false,
    overdue: false,
    pending: false,
    unfinished: false,
  });
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  const selectedStage =
    project.stages.find((stage) => stage.id === selectedStageId) ??
    currentStage ??
    project.stages[0] ??
    null;
  const selectedStageIdSafe = selectedStage?.id ?? "";
  const isViewingCurrentStage =
    !!selectedStage && selectedStage.id === currentStage?.id;

  const visibleTasks = useMemo(() => {
    const scoped =
      taskScope === "stage" && selectedStage
        ? project.tasks.filter((task) => task.stageId === selectedStage.id)
        : project.tasks;
    return applyTaskFilters(scoped, taskFilters, userOpenId);
  }, [project.tasks, selectedStage, taskFilters, taskScope, userOpenId]);

  const scopedTasks = useMemo(
    () =>
      taskScope === "stage" && selectedStage
        ? project.tasks.filter((task) => task.stageId === selectedStage.id)
        : project.tasks,
    [project.tasks, selectedStage, taskScope],
  );

  const allStagesCompleted =
    project.stages.length > 0 &&
    project.stages.every((stage) => stage.status === "COMPLETED");
  const canCreateTask =
    canManage &&
    selectedStage &&
    project.status !== "COMPLETED" &&
    project.status !== "CANCELED" &&
    selectedStage.status !== "COMPLETED";

  function selectStage(stageId: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("stage", stageId);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  function returnToCurrentStage() {
    if (currentStage) selectStage(currentStage.id);
  }

  return (
    <main
      data-testid="project-detail-workspace"
      className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8"
    >
      <BackLink href={routes.progress.root} label="返回进度管理" />

      <ProjectOverview
        project={project}
        currentStage={currentStage}
        allStagesCompleted={allStagesCompleted}
        canUpdateLifecycle={canUpdateLifecycle}
        canEdit={canManage && project.status !== "COMPLETED" && project.status !== "CANCELED"}
        canRemind={
          canManage &&
          project.status !== "COMPLETED" &&
          project.status !== "CANCELED"
        }
        isSuperAdmin={isSuperAdmin}
        onOpenEdit={() => setProjectDialogOpen(true)}
      />

      <div className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>项目阶段</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <StageTimeline
                stages={project.stages}
                selectedStageId={selectedStageIdSafe}
                currentStageId={currentStage?.id ?? ""}
                onSelectStage={selectStage}
              />
              {selectedStage && !isViewingCurrentStage && currentStage && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <span>
                    当前正在查看阶段“{selectedStage.name}”，项目当前阶段为“
                    {currentStage.name}”。
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={returnToCurrentStage}
                  >
                    <RotateCcw className="h-4 w-4" />
                    返回当前阶段
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {selectedStage ? (
            <>
              <StageDetailPanel
                projectId={project.id}
                projectStatus={project.status}
                stage={selectedStage}
                isCurrentStage={isViewingCurrentStage}
              />
              <StageTaskList
                tasks={visibleTasks}
                scopedTasks={scopedTasks}
                selectedStage={selectedStage}
                taskScope={taskScope}
                filters={taskFilters}
                canManage={canManage}
                canCreateTask={!!canCreateTask}
                userOpenId={userOpenId}
                onTaskScopeChange={setTaskScope}
                onFiltersChange={setTaskFilters}
                onOpenTaskDialog={() => setTaskDialogOpen(true)}
              />
            </>
          ) : (
            <Card>
              <CardContent className="py-10 text-sm text-muted-foreground">
                该项目暂未配置阶段。
              </CardContent>
            </Card>
          )}
        </div>

        <ProjectActivityPanel
          projectId={project.id}
          logs={project.activityLogs}
          hasMoreLogs={project.hasMoreActivityLogs}
          stages={project.stages}
          tasks={project.tasks}
          onSelectStage={selectStage}
        />
      </div>

      <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>新增任务</DialogTitle>
            <DialogDescription>
              新任务会默认挂到当前选中的阶段，可在表单内调整。
            </DialogDescription>
          </DialogHeader>
          {selectedStage && (
            <TaskForm
              key={selectedStage.id}
              projectId={project.id}
              users={users}
              acceptanceChecklistTemplates={acceptanceChecklistTemplates}
              stages={project.stages.map((stage) => ({
                id: stage.id,
                name: stage.name,
              }))}
              defaultStageId={selectedStage.id}
              redirectOnCreate={false}
              submitLabel="创建任务"
              onCreated={() => {
                setTaskDialogOpen(false);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>编辑项目</DialogTitle>
            <DialogDescription>
              本次只编辑项目基础信息；阶段结构保持不变。
            </DialogDescription>
          </DialogHeader>
          <ProjectForm
            mode="edit"
            users={users}
            initialProject={{
              id: project.id,
              updatedAt: project.updatedAt,
              name: project.name,
              description: project.description,
              team: project.team,
              techGroup: project.techGroup,
              ownerOpenIds: project.ownerOpenIds,
              allowOwnerSelfApproval: project.allowOwnerSelfApproval,
            }}
            submitLabel="保存修改"
            onSaved={() => setProjectDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}

function ProjectOverview({
  project,
  currentStage,
  allStagesCompleted,
  canUpdateLifecycle,
  canEdit,
  canRemind,
  isSuperAdmin,
  onOpenEdit,
}: {
  project: ProjectDetailView;
  currentStage: StageView | null;
  allStagesCompleted: boolean;
  canUpdateLifecycle: boolean;
  canEdit: boolean;
  canRemind: boolean;
  isSuperAdmin: boolean;
  onOpenEdit: () => void;
}) {
  const router = useRouter();
  const [loadingStatus, setLoadingStatus] = useState<ProjectStatus | null>(null);
  const completedStages = project.stages.filter(
    (stage) => stage.status === "COMPLETED",
  ).length;
  const projectDeadline =
    [...project.stages]
      .reverse()
      .find((stage) => !!stage.dueAt)?.dueAt ?? null;

  async function handleProjectStatus(next: ProjectStatus) {
    const actionLabel =
      next === "IN_PROGRESS"
        ? "启动项目"
        : next === "COMPLETED"
          ? "完成项目"
          : "取消项目";
    if (
      (next === "COMPLETED" || next === "CANCELED") &&
      !window.confirm(`确认${actionLabel}？`)
    ) {
      return;
    }
    setLoadingStatus(next);
    try {
      await updateProjectStatus(project.id, next);
      toast.success(`${actionLabel}成功`);
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, `${actionLabel}失败`));
    } finally {
      setLoadingStatus(null);
    }
  }

  return (
    <Card data-testid="project-overview">
      <CardContent className="flex flex-col gap-5 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-2xl font-semibold leading-tight">
              {project.name}
            </h1>
            <Badge>{projectStatusLabels[project.status]}</Badge>
            <Badge variant="outline">{formatScopeItem(project.team)}</Badge>
            <Badge variant="outline">{formatScopeItem(project.techGroup)}</Badge>
          </div>
          {project.description && (
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {project.description}
            </p>
          )}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <OverviewItem label="负责人" value={project.ownerNames} />
            <OverviewItem label="当前阶段" value={currentStage?.name ?? "未配置"} />
            <OverviewItem
              label="项目截止"
              value={projectDeadline ? formatDate(projectDeadline) : "未设置"}
            />
            <OverviewItem
              label="项目进度"
              value={`${completedStages} / ${project.stages.length} 阶段`}
            />
          </dl>
        </div>

        {(canEdit || canUpdateLifecycle || canRemind || isSuperAdmin) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canEdit && (
              <Button type="button" variant="outline" onClick={onOpenEdit}>
                <Pencil className="h-4 w-4" />
                编辑项目
              </Button>
            )}
            {canRemind && (
              <ManualReminderButton
                targetType="PROJECT"
                targetId={project.id}
                label="催促项目"
              />
            )}
            {project.status === "NOT_STARTED" && (
              <Button
                type="button"
                disabled={loadingStatus !== null}
                onClick={() => handleProjectStatus("IN_PROGRESS")}
              >
                <Play className="h-4 w-4" />
                启动项目
              </Button>
            )}
            {project.status === "IN_PROGRESS" && (
              <Button
                type="button"
                variant="outline"
                disabled={loadingStatus !== null || !allStagesCompleted}
                onClick={() => handleProjectStatus("COMPLETED")}
              >
                <Check className="h-4 w-4" />
                完成项目
              </Button>
            )}
            {(project.status === "NOT_STARTED" ||
              project.status === "IN_PROGRESS") && (
              <Button
                type="button"
                variant="destructive"
                disabled={loadingStatus !== null}
                onClick={() => handleProjectStatus("CANCELED")}
              >
                <XCircle className="h-4 w-4" />
                取消项目
              </Button>
            )}
            <ArchivedProjectDeleteButton
              projectId={project.id}
              status={project.status}
              isSuperAdmin={isSuperAdmin}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OverviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function StageTimeline({
  stages,
  selectedStageId,
  currentStageId,
  onSelectStage,
}: {
  stages: StageView[];
  selectedStageId: string;
  currentStageId: string;
  onSelectStage: (stageId: string) => void;
}) {
  return (
    <div className="w-full overflow-x-auto pb-2">
      <ol className="flex min-w-max items-start gap-0">
        {stages.map((stage, index) => {
          const isSelected = stage.id === selectedStageId;
          const isCurrent = stage.id === currentStageId;
          const reviewState = getStageReviewState(stage);
          const isLast = index === stages.length - 1;
          return (
            <li key={stage.id} className="flex items-start">
              <button
                type="button"
                className="group flex w-32 flex-col items-center gap-2 rounded-md px-2 py-1 text-center outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelectStage(stage.id)}
              >
                <span
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full border-2 bg-background text-sm font-semibold",
                    stage.status === "COMPLETED" &&
                      "border-green-600 bg-green-50 text-green-700",
                    stage.status === "PENDING_ACCEPTANCE" &&
                      "border-orange-500 bg-orange-50 text-orange-700",
                    reviewState === "REJECTED" &&
                      "border-destructive bg-destructive/10 text-destructive",
                    stage.status === "IN_PROGRESS" &&
                      reviewState !== "REJECTED" &&
                      "border-primary bg-primary/10 text-primary",
                    stage.status === "NOT_STARTED" &&
                      "border-muted-foreground/30 text-muted-foreground",
                    isSelected && "ring-4 ring-primary/15",
                  )}
                >
                  {stage.status === "COMPLETED" ? (
                    <CheckCircle2 className="h-5 w-5" />
                  ) : stage.status === "PENDING_ACCEPTANCE" ? (
                    <Clock3 className="h-5 w-5" />
                  ) : reviewState === "REJECTED" ? (
                    <AlertCircle className="h-5 w-5" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="max-w-full truncate text-sm font-medium">
                  {stage.name}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {isCurrent && <Circle className="h-2 w-2 fill-primary text-primary" />}
                  {reviewState === "REJECTED"
                    ? "需修改"
                    : stageStatusLabels[stage.status]}
                </span>
              </button>
              {!isLast && (
                <div
                  className={cn(
                    "mt-5 h-0.5 w-12 shrink-0",
                    stage.status === "COMPLETED" ? "bg-green-600" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StageDetailPanel({
  projectId,
  projectStatus,
  stage,
  isCurrentStage,
}: {
  projectId: string;
  projectStatus: ProjectStatus;
  stage: StageView;
  isCurrentStage: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [note, setNote] = useState("");
  const [comments, setComments] = useState<Record<string, string>>({});
  const pendingSubmission = stage.submissions.find(
    (submission) => submission.id === stage.currentSubmissionId,
  );
  const latestApproval = getLatestApproval(stage);
  const canSubmit =
    stage.canSubmit &&
    isCurrentStage &&
    projectStatus === "IN_PROGRESS" &&
    stage.status === "IN_PROGRESS";
  const canApprove =
    pendingSubmission?.canApprove && stage.status === "PENDING_ACCEPTANCE";

  async function handleStageSubmit() {
    if (!evidenceUrl.trim()) {
      toast.error("请填写文档或归档链接");
      return;
    }
    setLoading(true);
    try {
      await submitStageEvidence({
        projectId,
        stageId: stage.id,
        evidenceUrl,
        note,
      });
      toast.success("阶段材料已提交");
      setEvidenceUrl("");
      setNote("");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleReview(submissionId: string, pass: boolean) {
    setLoading(true);
    try {
      const input = {
        submissionId,
        comment: comments[submissionId] ?? "",
      };
      if (pass) {
        await approveStageSubmission(input);
      } else {
        await rejectStageSubmission(input);
      }
      toast.success(pass ? "阶段已通过" : "阶段已驳回");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "操作失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>
              阶段 {stage.sortOrder + 1}：{stage.name}
            </CardTitle>
            <div className="mt-2 flex flex-wrap gap-2">
              <StageBadge stage={stage} />
              <Badge variant="outline">负责人 {stage.ownerName || "未设置"}</Badge>
              {stage.dueAt && (
                <Badge variant="outline">DDL {formatDateTime(stage.dueAt)}</Badge>
              )}
            </div>
          </div>
          {!isCurrentStage && (
            <Badge variant="secondary">
              <History className="h-3 w-3" />
              历史/规划视图
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <h3 className="text-sm font-medium">阶段目标</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {stage.goal || "该阶段暂未配置详细目标。"}
          </p>
        </section>

        <section>
          <h3 className="text-sm font-medium">阶段材料</h3>
          <div className="mt-2 space-y-2 text-sm">
            {pendingSubmission && stage.status === "PENDING_ACCEPTANCE" ? (
              <MaterialRow
                title="本次提交材料"
                href={pendingSubmission.feishuDocUrl}
                meta={`${pendingSubmission.submitterName} · ${formatDateTime(
                  pendingSubmission.submittedAt,
                )}`}
              />
            ) : stage.evidenceUrl ? (
              <MaterialRow
                title="当前归档材料"
                href={stage.evidenceUrl}
                meta={
                  latestApproval?.decision === "APPROVED"
                    ? `已通过 · ${latestApproval.approverName}`
                    : "最近提交"
                }
              />
            ) : (
              <p className="rounded-md border border-dashed px-3 py-4 text-muted-foreground">
                暂无阶段材料。
              </p>
            )}
          </div>
        </section>

        {canSubmit && (
          <section className="rounded-md border bg-muted/20 p-4">
            <h3 className="text-sm font-medium">提交阶段材料</h3>
            <div className="mt-3 grid gap-3">
              <Input
                placeholder="文档或文件归档链接"
                value={evidenceUrl}
                onChange={(event) => setEvidenceUrl(event.target.value)}
              />
              <Textarea
                placeholder="提交说明（可选）"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Button
                type="button"
                className="w-fit"
                disabled={loading}
                onClick={handleStageSubmit}
              >
                提交阶段审批
              </Button>
            </div>
          </section>
        )}

        {pendingSubmission && stage.status === "PENDING_ACCEPTANCE" && (
          <section className="rounded-md border bg-orange-50/50 p-4">
            <h3 className="text-sm font-medium">阶段审核</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              提交人：{pendingSubmission.submitterName} ·{" "}
              {formatDateTime(pendingSubmission.submittedAt)}
            </p>
            {canApprove && (
              <div className="mt-3 grid gap-3">
                <Textarea
                  placeholder="审批意见（可选）"
                  value={comments[pendingSubmission.id] ?? ""}
                  onChange={(event) =>
                    setComments((prev) => ({
                      ...prev,
                      [pendingSubmission.id]: event.target.value,
                    }))
                  }
                />
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    disabled={loading}
                    onClick={() => handleReview(pendingSubmission.id, true)}
                  >
                    通过
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={loading}
                    onClick={() => handleReview(pendingSubmission.id, false)}
                  >
                    驳回
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {stage.submissions.length > 0 && (
          <section>
            <h3 className="text-sm font-medium">提交历史</h3>
            <div className="mt-2 space-y-2 text-sm">
              {stage.submissions.map((submission) => (
                <div key={submission.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={submission.feishuDocUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      归档材料
                    </a>
                    <span className="text-muted-foreground">
                      {submission.submitterName} ·{" "}
                      {formatDateTime(submission.submittedAt)}
                    </span>
                  </div>
                  {submission.note && (
                    <p className="mt-1 text-muted-foreground">{submission.note}</p>
                  )}
                  {submission.approvals.map((approval) => (
                    <p key={approval.id} className="mt-1 text-muted-foreground">
                      {approval.approverName}：
                      {approval.decision === "APPROVED" ? "通过" : "驳回"}
                      {approval.comment ? ` · ${approval.comment}` : ""}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function StageTaskList({
  tasks,
  scopedTasks,
  selectedStage,
  taskScope,
  filters,
  canManage,
  canCreateTask,
  userOpenId,
  onTaskScopeChange,
  onFiltersChange,
  onOpenTaskDialog,
}: {
  tasks: TaskView[];
  scopedTasks: TaskView[];
  selectedStage: StageView;
  taskScope: TaskScope;
  filters: TaskFilters;
  canManage: boolean;
  canCreateTask: boolean;
  userOpenId?: string;
  onTaskScopeChange: (scope: TaskScope) => void;
  onFiltersChange: (filters: TaskFilters) => void;
  onOpenTaskDialog: () => void;
}) {
  const stats = getTaskStats(scopedTasks);

  function updateFilters(next: Partial<TaskFilters>) {
    onFiltersChange({ ...filters, ...next });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>
              {taskScope === "stage" ? `${selectedStage.name}阶段任务` : "全项目任务"}
            </CardTitle>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>任务 {stats.total}</span>
              <span>已完成 {stats.completed}</span>
              <span>进行中 {stats.inProgress}</span>
              <span>待审核 {stats.pending}</span>
              <span>已逾期 {stats.overdue}</span>
            </div>
          </div>
          {canCreateTask && (
            <Button type="button" onClick={onOpenTaskDialog}>
              <Plus className="h-4 w-4" />
              新增任务
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={taskScope === "stage" ? "default" : "outline"}
              onClick={() => onTaskScopeChange("stage")}
            >
              当前阶段任务
            </Button>
            <Button
              type="button"
              size="sm"
              variant={taskScope === "project" ? "default" : "outline"}
              onClick={() => onTaskScopeChange("project")}
            >
              全项目任务
            </Button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-64">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="搜索任务"
                value={filters.search}
                onChange={(event) => updateFilters({ search: event.target.value })}
              />
            </div>
            <Select
              value={filters.status}
              onValueChange={(value) =>
                updateFilters({ status: value as TaskFilters["status"] })
              }
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {taskStatusOptions.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status === "ALL" ? "全部状态" : taskStatusLabels[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <FilterToggle
            active={filters.mine}
            onClick={() => updateFilters({ mine: !filters.mine })}
          >
            只看我的任务
          </FilterToggle>
          <FilterToggle
            active={filters.overdue}
            onClick={() => updateFilters({ overdue: !filters.overdue })}
          >
            只看逾期
          </FilterToggle>
          <FilterToggle
            active={filters.pending}
            onClick={() => updateFilters({ pending: !filters.pending })}
          >
            只看待审核
          </FilterToggle>
          <FilterToggle
            active={filters.unfinished}
            onClick={() => updateFilters({ unfinished: !filters.unfinished })}
          >
            只看未完成
          </FilterToggle>
        </div>

        {tasks.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            当前范围没有符合条件的任务。
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>任务名称</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>负责人</TableHead>
                    {taskScope === "project" && <TableHead>所属阶段</TableHead>}
                    <TableHead>优先级</TableHead>
                    <TableHead>截止时间</TableHead>
                    <TableHead>材料</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((task) => (
                    <TaskTableRow
                      key={task.id}
                      task={task}
                      showStage={taskScope === "project"}
                      canStart={
                        task.status === "TODO" &&
                        (canManage ||
                          (!!userOpenId && task.assigneeOpenIds.includes(userOpenId)))
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2 md:hidden">
              {tasks.map((task) => (
                <TaskMobileCard
                  key={task.id}
                  task={task}
                  canStart={
                    task.status === "TODO" &&
                    (canManage ||
                      (!!userOpenId && task.assigneeOpenIds.includes(userOpenId)))
                  }
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TaskTableRow({
  task,
  showStage,
  canStart,
}: {
  task: TaskView;
  showStage: boolean;
  canStart: boolean;
}) {
  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <Link
          href={`${routes.progress.task(task.id)}`}
          className="font-medium text-primary hover:underline"
        >
          {task.title}
        </Link>
        {task.riskNote && (
          <Badge variant="destructive" className="ml-2 align-middle">
            风险
          </Badge>
        )}
        {task.pendingDeletionRequest && (
          <Badge variant="outline" className="ml-2 align-middle">
            删除待审
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <TaskStatusBadge task={task} />
      </TableCell>
      <TableCell>{task.assigneeNames}</TableCell>
      {showStage && <TableCell>{task.stageName ?? "无阶段"}</TableCell>}
      <TableCell>
        {urgencyLabels[task.urgency]} / {importanceLabels[task.importance]}
      </TableCell>
      <TableCell>{formatDate(task.dueAt)}</TableCell>
      <TableCell>{getTaskMaterialStatus(task)}</TableCell>
      <TableCell className="text-right">
        {canStart ? <StartTaskButton taskId={task.id} /> : null}
      </TableCell>
    </TableRow>
  );
}

function TaskMobileCard({ task, canStart }: { task: TaskView; canStart: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <Link
          href={`${routes.progress.task(task.id)}`}
          className="font-medium text-primary hover:underline"
        >
          {task.title}
        </Link>
        <TaskStatusBadge task={task} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {task.assigneeNames} · {task.stageName ?? "无阶段"} · 截止{" "}
        {formatDate(task.dueAt)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{taskCategoryLabels[task.category]}</Badge>
        <Badge variant="secondary">
          {urgencyLabels[task.urgency]} / {importanceLabels[task.importance]}
        </Badge>
        <span>{getTaskMaterialStatus(task)}</span>
        {task.riskNote && <Badge variant="destructive">风险</Badge>}
        {task.pendingDeletionRequest && <Badge variant="outline">删除待审</Badge>}
      </div>
      {canStart && (
        <div className="mt-3">
          <StartTaskButton taskId={task.id} />
        </div>
      )}
    </div>
  );
}

function StartTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleStart() {
    setLoading(true);
    try {
      await updateTaskStatus(taskId, "IN_PROGRESS");
      toast.success("任务已开始");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "启动任务失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={loading}
      onClick={handleStart}
    >
      <Play className="h-4 w-4" />
      开始
    </Button>
  );
}

function ProjectActivityPanel({
  projectId,
  logs,
  hasMoreLogs,
  stages,
  tasks,
  onSelectStage,
}: {
  projectId: string;
  logs: ActivityLogView[];
  hasMoreLogs: boolean;
  stages: StageView[];
  tasks: TaskView[];
  onSelectStage: (stageId: string) => void;
}) {
  const [filter, setFilter] = useState<ActivityFilter>("ALL");
  const logsKey = useMemo(
    () => `${hasMoreLogs}:${logs.map((log) => log.id).join("|")}`,
    [hasMoreLogs, logs],
  );
  const [historyState, setHistoryState] = useState<ActivityHistoryState>({
    sourceKey: logsKey,
    extraLogs: [],
    hasMore: hasMoreLogs,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const effectiveHistoryState =
    historyState.sourceKey === logsKey
      ? historyState
      : {
          sourceKey: logsKey,
          extraLogs: historyState.extraLogs,
          hasMore: historyState.hasMore || hasMoreLogs,
        };
  const activityLogs = mergeActivityLogs(logs, effectiveHistoryState.extraLogs);
  const hasMoreActivityLogs = effectiveHistoryState.hasMore;

  const filteredLogs = activityLogs.filter((log) => {
    if (filter === "ALL") return true;
    return getActivityType(log.action) === filter;
  });
  const stageById = useMemo(
    () => new Map(stages.map((stage) => [stage.id, stage])),
    [stages],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );

  async function handleLoadMore() {
    const cursorId = activityLogs.at(-1)?.id;
    setLoadingMore(true);
    try {
      const page = await loadMoreProjectActivityLogs(projectId, cursorId);
      setHistoryState({
        sourceKey: logsKey,
        extraLogs: mergeActivityLogs(effectiveHistoryState.extraLogs, page.logs),
        hasMore: page.hasMore,
      });
    } catch (err) {
      toast.error(getActionErrorMessage(err, "加载历史动态失败"));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <aside className="min-w-0 xl:sticky xl:top-24 xl:self-start">
      <Card data-testid="project-activity-panel">
        <CardHeader className="pb-3">
          <CardTitle>最近动态</CardTitle>
          <p className="text-xs text-muted-foreground">
            默认显示近 7 天动态，可继续加载更早历史。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {activityFilters.map((item) => (
              <Button
                key={item.value}
                type="button"
                size="xs"
                variant={filter === item.value ? "default" : "outline"}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {filteredLogs.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
              近 7 天暂无项目动态。
            </p>
          ) : (
            <div className="max-h-[calc(100vh-18rem)] min-h-64 space-y-3 overflow-y-auto pr-1">
              {filteredLogs.map((log) => (
                <ActivityItem
                  key={log.id}
                  log={log}
                  stageById={stageById}
                  taskById={taskById}
                  onSelectStage={onSelectStage}
                />
              ))}
            </div>
          )}
          {hasMoreActivityLogs && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full"
              disabled={loadingMore}
              onClick={handleLoadMore}
            >
              <History className="h-4 w-4" />
              {loadingMore ? "加载中..." : "加载更早动态"}
            </Button>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}

function ActivityItem({
  log,
  stageById,
  taskById,
  onSelectStage,
}: {
  log: ActivityLogView;
  stageById: Map<string, StageView>;
  taskById: Map<string, TaskView>;
  onSelectStage: (stageId: string) => void;
}) {
  const payload = parseActivityPayload(log.payload);
  const task = log.taskId ? taskById.get(log.taskId) : null;
  const stageId =
    getPayloadString(payload.stageId) ??
    task?.stageId ??
    getPayloadString(payload.stage);
  const stage = stageId ? stageById.get(stageId) : null;
  const targetLabel = getActivityTargetLabel(log.action, task, stage, payload);

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{log.actorName}</p>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatDateTime(log.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-muted-foreground">{activityLabel(log.action)}</p>
      {targetLabel && <p className="mt-2 font-medium">{targetLabel}</p>}
      {stage && (
        <p className="mt-1 text-xs text-muted-foreground">阶段：{stage.name}</p>
      )}
      <ActivityChangeList payload={payload} />
      <div className="mt-3 flex flex-wrap gap-2">
        {stage && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onSelectStage(stage.id)}
          >
            查看阶段
          </Button>
        )}
        {task && (
          <Link
            href={`${routes.progress.task(task.id)}`}
            className={buttonVariants({ size: "xs", variant: "outline" })}
          >
            打开任务
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

function FilterToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={active ? "default" : "outline"}
      onClick={onClick}
    >
      <Filter className="h-3 w-3" />
      {children}
    </Button>
  );
}

function ActivityChangeList({ payload }: { payload: Record<string, unknown> }) {
  const changes = Array.isArray(payload.changes)
    ? payload.changes.filter((change): change is string => typeof change === "string")
    : [];
  const reason = getPayloadString(payload.reason);
  const reviewComment = getPayloadString(payload.reviewComment);
  if (changes.length === 0 && !reason && !reviewComment) return null;
  return (
    <ul className="mt-2 space-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      {changes.map((change, index) => (
        <li key={`${change}-${index}`}>{change}</li>
      ))}
      {reason && <li>原因：{reason}</li>}
      {reviewComment && <li>审核意见：{reviewComment}</li>}
    </ul>
  );
}

function MaterialRow({
  title,
  href,
  meta,
}: {
  title: string;
  href: string;
  meta: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
      <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
        {title}
      </a>
      <span className="text-muted-foreground">{meta}</span>
    </div>
  );
}

function StageBadge({ stage }: { stage: StageView }) {
  const reviewState = getStageReviewState(stage);
  if (reviewState === "REJECTED") {
    return <Badge variant="destructive">需修改</Badge>;
  }
  if (stage.status === "PENDING_ACCEPTANCE") {
    return <Badge variant="secondary">待审批</Badge>;
  }
  if (stage.status === "COMPLETED") {
    return <Badge className="bg-green-600 text-white">已完成</Badge>;
  }
  return <Badge variant={stage.status === "IN_PROGRESS" ? "default" : "outline"}>{stageStatusLabels[stage.status]}</Badge>;
}

function TaskStatusBadge({ task }: { task: TaskView }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant={task.status === "COMPLETED" ? "default" : "secondary"}>
        {taskStatusLabels[task.status]}
      </Badge>
      {task.isOverdue && <Badge variant="destructive">逾期</Badge>}
    </div>
  );
}

function getCurrentStage(stages: StageView[]): StageView | null {
  return (
    stages.find((stage) => stage.status === "PENDING_ACCEPTANCE") ??
    stages.find((stage) => stage.status === "IN_PROGRESS") ??
    stages.find((stage) => stage.status === "NOT_STARTED") ??
    stages.at(-1) ??
    null
  );
}

function getStageReviewState(stage: StageView): "REJECTED" | "APPROVED" | null {
  const latestApproval = getLatestApproval(stage);
  if (!latestApproval) return null;
  return latestApproval.decision === "REJECTED" ? "REJECTED" : "APPROVED";
}

function getLatestApproval(stage: StageView): ApprovalView | null {
  const approvals = stage.submissions.flatMap((submission) => submission.approvals);
  if (approvals.length === 0) return null;
  return approvals.reduce((latest, approval) =>
    new Date(approval.createdAt).getTime() > new Date(latest.createdAt).getTime()
      ? approval
      : latest,
  );
}

function applyTaskFilters(
  tasks: TaskView[],
  filters: TaskFilters,
  userOpenId?: string,
): TaskView[] {
  const search = filters.search.trim().toLowerCase();
  return tasks.filter((task) => {
    if (search && !task.title.toLowerCase().includes(search)) return false;
    if (filters.status !== "ALL" && task.status !== filters.status) return false;
    if (filters.mine && (!userOpenId || !task.assigneeOpenIds.includes(userOpenId))) {
      return false;
    }
    if (filters.overdue && !task.isOverdue) return false;
    if (filters.pending && task.status !== "PENDING_ACCEPTANCE") return false;
    if (
      filters.unfinished &&
      (task.status === "COMPLETED" || task.status === "ARCHIVED")
    ) {
      return false;
    }
    return true;
  });
}

function getTaskStats(tasks: TaskView[]) {
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.status === "COMPLETED").length,
    inProgress: tasks.filter((task) => task.status === "IN_PROGRESS").length,
    pending: tasks.filter((task) => task.status === "PENDING_ACCEPTANCE").length,
    overdue: tasks.filter((task) => task.isOverdue).length,
  };
}

function getTaskMaterialStatus(task: TaskView): string {
  if (task.status === "PENDING_ACCEPTANCE") return "已提交";
  if (task.status === "COMPLETED" && task.submissionsCount > 0) return "已验收";
  if (task.submissionsCount > 0) return "有历史提交";
  return "未提交";
}

function getActivityType(action: string): ActivityFilter {
  if (action.includes("approved") || action.includes("rejected")) return "REVIEW";
  if (action.startsWith("project.")) return "PROJECT";
  if (action.startsWith("stage.")) return "STAGE";
  if (action.startsWith("task.")) return "TASK";
  return "ALL";
}

function parseActivityPayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getPayloadString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getActivityTargetLabel(
  action: string,
  task: TaskView | null | undefined,
  stage: StageView | null | undefined,
  payload: Record<string, unknown>,
): string | null {
  if (task) return `任务：${task.title}`;
  if (stage) return `阶段：${stage.name}`;

  const title =
    getPayloadString(payload.taskTitle) ?? getPayloadString(payload.title);
  if (action.startsWith("task.") && title) return `任务：${title}`;

  const projectName = getPayloadString(payload.name);
  if (action.startsWith("project.") && projectName) return `项目：${projectName}`;

  return null;
}

function activityLabel(action: string): string {
  const labels: Record<string, string> = {
    "project.created": "创建了项目",
    "project.updated": "更新了项目信息",
    "project.status_changed": "更新了项目状态",
    "project.reminded": "发送了项目催促提醒",
    "stage.evidence_submitted": "提交了阶段材料",
    "stage.approved": "通过了阶段审核",
    "stage.rejected": "驳回了阶段审核",
    "task.created": "创建了任务",
    "task.updated": "更新了任务信息",
    "task.status_changed": "更新了任务状态",
    "task.delivery_submitted": "提交了任务交付",
    "task.approved": "通过了任务验收",
    "task.rejected": "驳回了任务验收",
    "task.weekly_report": "提交了任务周报",
    "task.risk_synced": "同步了任务风险",
    "task.archived": "归档了任务",
    "task.delete_requested": "申请删除任务",
    "task.delete_rejected": "驳回了删除申请",
    "task.deleted": "删除了任务",
    "task.reminded": "发送了任务催促提醒",
  };
  return labels[action] ?? action;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN");
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatScopeItem(value: string): string {
  return value || "未指定";
}

function mergeActivityLogs<T extends { id: string }>(
  current: T[],
  next: T[],
): T[] {
  const seen = new Set(current.map((log) => log.id));
  return [...current, ...next.filter((log) => !seen.has(log.id))];
}
