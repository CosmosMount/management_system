"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock3,
  FileSpreadsheet,
  Filter,
  History,
  Play,
  Plus,
  RotateCcw,
  Search,
  ArrowUpRight,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ApprovalDecision,
  Importance,
  ProjectDdlChangeRequestStatus,
  ProjectDdlChangeRequestType,
  ProjectStatus,
  StageStatus,
  TaskCreationRequestStatus,
  TaskStatus,
  Urgency,
} from "@prisma/client";
import {
  approveStageSubmission,
  rejectStageSubmission,
  submitStageEvidence,
} from "@/app/actions/progress/projectStages";
import {
  requestProjectStageBatchDdlChange,
  requestProjectStageDueDateChange,
  reviewProjectStageBatchDdlChangeRequest,
  reviewProjectStageDueDateChangeRequest,
} from "@/app/actions/progress/projectDdlChanges";
import { loadMoreProjectActivityLogs } from "@/app/actions/progress/activityLogs";
import { reviewTaskCreationRequest } from "@/app/actions/progress/requestTaskCreation";
import { rollbackProjectStage } from "@/app/actions/progress/rollbackProjectStage";
import { updateProjectStatus } from "@/app/actions/progress/updateProjectStatus";
import { reviewProjectEstablishment } from "@/app/actions/progress/createProject";
import { updateTaskStatus } from "@/app/actions/progress/updateTask";
import { BackLink } from "@/components/back-link";
import { ReasonConfirmDialog } from "@/components/reason-confirm-dialog";
import { ProjectForm } from "@/components/progress/project-form";
import { ManualReminderButton } from "@/components/progress/manual-reminder-button";
import { ArchivedProjectDeleteButton } from "@/components/admin-delete-actions";
import { TaskForm } from "@/components/progress/task-form";
import { TaskImportDialog } from "@/components/progress/task-import-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  taskStatusLabels,
  urgencyLabels,
} from "@/lib/progress-labels";

const projectHeaderActionButtonClassName = "h-8 min-w-24 gap-1.5 px-3 text-sm";

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
  participantOpenIds: string[];
  participantNames: string;
  requesterOpenId: string;
  requesterName: string;
  submittedAt: string | null;
  reviewerOpenId: string;
  reviewerName: string;
  reviewComment: string;
  reviewedAt: string | null;
  allowOwnerSelfApproval: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  stages: StageView[];
  tasks: TaskView[];
  ddlChangeRequests: DdlChangeRequestView[];
  taskCreationRequests: TaskCreationRequestView[];
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
  extensionCount: number;
  advanceCount: number;
  benignExtensionCount: number;
  currentSubmissionId: string | null;
  canSubmit: boolean;
  canRequestExtension: boolean;
  canRequestDueDateChange: boolean;
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
  taskTechGroups: string[];
  urgency: Urgency;
  importance: Importance;
  status: TaskStatus;
  isOverdue: boolean;
  assigneeNames: string;
  assigneeOpenIds: string[];
  relatedOpenIds: string[];
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

export type TaskCreationRequestView = {
  id: string;
  requesterOpenId: string;
  requesterName: string;
  status: TaskCreationRequestStatus;
  reviewerName: string;
  reviewComment: string;
  reviewedAt: string | null;
  createdTaskId: string | null;
  createdAt: string;
  draft: {
    title: string;
    goal: string;
    stageName: string;
    taskTechGroups: string[];
    urgency: Urgency;
    importance: Importance;
    assigneeNames: string;
    dueAt: string;
    metrics: string;
    needsOfflineConfirmation: boolean;
    needsWeeklyReport: boolean;
    acceptanceChecklistItems: Array<{ content: string }>;
    summary: string;
  } | null;
};

export type DdlChangeRequestView = {
  id: string;
  type: ProjectDdlChangeRequestType;
  status: ProjectDdlChangeRequestStatus;
  stageId: string;
  stageName: string;
  requesterOpenId: string;
  requesterName: string;
  reason: string;
  oldDueAt: string | null;
  newDueAt: string | null;
  durationDays: number | null;
  requestedIsBenign: boolean | null;
  finalIsBenign: boolean | null;
  reviewerName: string;
  reviewComment: string;
  reviewedAt: string | null;
  createdAt: string;
  canReview: boolean;
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
  canRequestTaskCreation: boolean;
  canUpdateLifecycle: boolean;
  canReviewEstablishment: boolean;
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
type ProjectRollbackPreview = {
  targetStage: StageView;
  fromStage: StageView | null;
  description: string;
};

const taskStatusOptions: Array<TaskStatus | "ALL"> = [
  "ALL",
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
  "COMPLETED",
  "ARCHIVED",
  "PROJECT_CANCELED",
];

const activityFilters: Array<{ value: ActivityFilter; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "PROJECT", label: "项目" },
  { value: "STAGE", label: "阶段" },
  { value: "TASK", label: "任务" },
  { value: "REVIEW", label: "审核" },
];

const ddlChangeTypeLabels: Record<ProjectDdlChangeRequestType, string> = {
  CASCADE_EXTENSION: "批量 DDL 调整",
  SINGLE_STAGE_ADJUSTMENT: "单阶段 DDL 修改",
};

const ddlChangeStatusLabels: Record<ProjectDdlChangeRequestStatus, string> = {
  PENDING: "待审批",
  APPROVED: "已通过",
  REJECTED: "已驳回",
};

export function ProjectDetailWorkspace({
  project,
  users,
  acceptanceChecklistTemplates,
  canManage,
  canRequestTaskCreation,
  canUpdateLifecycle,
  canReviewEstablishment,
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
  const [taskRequestDialogOpen, setTaskRequestDialogOpen] = useState(false);
  const [taskImportDialogOpen, setTaskImportDialogOpen] = useState(false);
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
    return applyTaskFilters(
      scoped,
      taskFilters,
      userOpenId,
    );
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
  const unfinishedStageCount = project.stages.filter(
    (stage) => stage.status !== "COMPLETED",
  ).length;
  const unfinishedTaskCount = project.tasks.filter(
    (task) => !isCompletedOrArchivedTaskStatus(task.status),
  ).length;
  const projectCanAcceptWork =
    project.status === "NOT_STARTED" || project.status === "IN_PROGRESS";
  const canCreateTask =
    canManage &&
    selectedStage &&
    projectCanAcceptWork &&
    selectedStage.status !== "COMPLETED";
  const canRequestTaskForSelectedStage =
    !!userOpenId &&
    !!selectedStage &&
    (project.ownerOpenIds.includes(userOpenId) ||
      project.participantOpenIds.includes(userOpenId) ||
      selectedStage.ownerOpenId === userOpenId ||
      project.tasks.some((task) => task.assigneeOpenIds.includes(userOpenId)));
  const importableStages = useMemo(() => {
    if (canCreateTask) return project.stages;
    if (!userOpenId || !canRequestTaskCreation) return [];
    const canRequestAnyStage =
      project.ownerOpenIds.includes(userOpenId) ||
      project.participantOpenIds.includes(userOpenId) ||
      project.tasks.some((task) => task.assigneeOpenIds.includes(userOpenId));
    return project.stages.filter(
      (stage) => canRequestAnyStage || stage.ownerOpenId === userOpenId,
    );
  }, [
    canCreateTask,
    canRequestTaskCreation,
    project.ownerOpenIds,
    project.participantOpenIds,
    project.stages,
    project.tasks,
    userOpenId,
  ]);
  const canRequestNewTask =
    canRequestTaskCreation &&
    canRequestTaskForSelectedStage &&
    selectedStage &&
    projectCanAcceptWork &&
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
        unfinishedStageCount={unfinishedStageCount}
        unfinishedTaskCount={unfinishedTaskCount}
        canUpdateLifecycle={canUpdateLifecycle}
        canReviewEstablishment={canReviewEstablishment}
        canResubmitEstablishment={
          project.status === "ESTABLISHMENT_REJECTED" &&
          !!userOpenId &&
          project.requesterOpenId === userOpenId
        }
        canEdit={
          canManage &&
          (project.status === "NOT_STARTED" || project.status === "IN_PROGRESS")
        }
        canRemind={
          canManage &&
          (project.status === "NOT_STARTED" || project.status === "IN_PROGRESS")
        }
        canImportTasks={!!canCreateTask || !!canRequestNewTask}
        isSuperAdmin={isSuperAdmin}
        onOpenEdit={() => setProjectDialogOpen(true)}
        onOpenTaskImportDialog={() => setTaskImportDialogOpen(true)}
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
                stages={project.stages}
                ddlChangeRequests={project.ddlChangeRequests}
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
                canRequestTaskCreation={!!canRequestNewTask}
                userOpenId={userOpenId}
                onTaskScopeChange={setTaskScope}
                onFiltersChange={setTaskFilters}
                onOpenTaskDialog={() => setTaskDialogOpen(true)}
                onOpenTaskRequestDialog={() => setTaskRequestDialogOpen(true)}
              />
              {project.taskCreationRequests.length > 0 && (
                <TaskCreationRequestPanel
                  requests={project.taskCreationRequests}
                  canManage={canManage}
                />
              )}
              <ProjectDdlChangeHistoryPanel requests={project.ddlChangeRequests} />
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

      <Dialog open={taskRequestDialogOpen} onOpenChange={setTaskRequestDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>申请新任务</DialogTitle>
            <DialogDescription>
              申请提交后会通知项目管理者审核，通过后才会创建真实任务。
            </DialogDescription>
          </DialogHeader>
          {selectedStage && (
            <TaskForm
              key={`request-${selectedStage.id}`}
              projectId={project.id}
              users={users}
              acceptanceChecklistTemplates={acceptanceChecklistTemplates}
              stages={project.stages.map((stage) => ({
                id: stage.id,
                name: stage.name,
              }))}
              defaultStageId={selectedStage.id}
              redirectOnCreate={false}
              createVariant="request"
              submitLabel="提交任务申请"
              onSubmitted={() => {
                setTaskRequestDialogOpen(false);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <TaskImportDialog
        open={taskImportDialogOpen}
        onOpenChange={setTaskImportDialogOpen}
        projectId={project.id}
        users={users}
        stages={importableStages.map((stage) => ({ id: stage.id, name: stage.name }))}
        mode={canCreateTask ? "create" : "request"}
        onImported={() => router.refresh()}
      />

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
              participantOpenIds: project.participantOpenIds,
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
  unfinishedStageCount,
  unfinishedTaskCount,
  canUpdateLifecycle,
  canReviewEstablishment,
  canResubmitEstablishment,
  canEdit,
  canRemind,
  canImportTasks,
  isSuperAdmin,
  onOpenEdit,
  onOpenTaskImportDialog,
}: {
  project: ProjectDetailView;
  currentStage: StageView | null;
  allStagesCompleted: boolean;
  unfinishedStageCount: number;
  unfinishedTaskCount: number;
  canUpdateLifecycle: boolean;
  canReviewEstablishment: boolean;
  canResubmitEstablishment: boolean;
  canEdit: boolean;
  canRemind: boolean;
  canImportTasks: boolean;
  isSuperAdmin: boolean;
  onOpenEdit: () => void;
  onOpenTaskImportDialog: () => void;
}) {
  const router = useRouter();
  const [loadingStatus, setLoadingStatus] = useState<ProjectStatus | null>(null);
  const [reviewingEstablishment, setReviewingEstablishment] = useState(false);
  const rollbackPreview = getProjectRollbackPreview(project);
  const completedStages = project.stages.filter(
    (stage) => stage.status === "COMPLETED",
  ).length;
  const projectDeadline =
    [...project.stages]
      .reverse()
      .find((stage) => !!stage.dueAt)?.dueAt ?? null;
  const completeDisabledReason = getProjectCompleteDisabledReason({
    loadingStatus,
    stageCount: project.stages.length,
    allStagesCompleted,
    unfinishedStageCount,
    unfinishedTaskCount,
  });

  async function handleProjectStatus(next: ProjectStatus, reason = "") {
    const actionLabel =
      next === "IN_PROGRESS"
        ? "启动项目"
        : next === "COMPLETED"
          ? "完成项目"
          : "取消项目";
    setLoadingStatus(next);
    try {
      await updateProjectStatus(project.id, next, reason);
      toast.success(`${actionLabel}成功`);
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, `${actionLabel}失败`));
    } finally {
      setLoadingStatus(null);
    }
  }

  async function handleEstablishmentReview(
    decision: "APPROVED" | "REJECTED",
    comment = "",
  ) {
    setReviewingEstablishment(true);
    try {
      await reviewProjectEstablishment({
        projectId: project.id,
        decision,
        comment,
      });
      toast.success(decision === "APPROVED" ? "立项已通过" : "立项已驳回");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "审核立项失败"));
    } finally {
      setReviewingEstablishment(false);
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
            <OverviewItem
              label="参与人员"
              value={project.participantNames || "未配置"}
            />
            <OverviewItem label="当前阶段" value={currentStage?.name ?? "未配置"} />
            <OverviewItem
              label="项目截止"
              value={projectDeadline ? formatDate(projectDeadline) : "未设置"}
            />
            <OverviewItem
              label="项目进度"
              value={`${completedStages} / ${project.stages.length} 阶段`}
            />
            {(project.status === "ESTABLISHING" ||
              project.status === "ESTABLISHMENT_REJECTED") && (
              <>
                <OverviewItem
                  label="立项申请人"
                  value={project.requesterName || "未知"}
                />
                <OverviewItem
                  label="提交时间"
                  value={
                    project.submittedAt ? formatDateTime(project.submittedAt) : "未记录"
                  }
                />
                {project.reviewComment && (
                  <OverviewItem label="审核意见" value={project.reviewComment} />
                )}
              </>
            )}
          </dl>
        </div>

        {(canEdit ||
          canUpdateLifecycle ||
          canReviewEstablishment ||
          canResubmitEstablishment ||
          canRemind ||
          canImportTasks ||
          isSuperAdmin) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canReviewEstablishment && project.status === "ESTABLISHING" && (
              <>
                <Button
                  type="button"
                  className={projectHeaderActionButtonClassName}
                  disabled={reviewingEstablishment}
                  onClick={() => handleEstablishmentReview("APPROVED")}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  通过立项
                </Button>
                <ReasonConfirmDialog
                  triggerLabel="驳回立项"
                  title="确认驳回立项"
                  description="驳回后申请人可以在原项目基础上修改并重新提交。"
                  reasonLabel="审核意见"
                  confirmLabel="确认驳回"
                  variant="destructive"
                  disabled={reviewingEstablishment}
                  triggerSize="default"
                  triggerClassName={projectHeaderActionButtonClassName}
                  onConfirm={(reason) =>
                    handleEstablishmentReview("REJECTED", reason)
                  }
                />
              </>
            )}
            {canResubmitEstablishment && (
              <Link
                href={`${routes.progress.new}?fromProject=${encodeURIComponent(
                  project.id,
                )}`}
                className={buttonVariants({
                  variant: "outline",
                  size: "default",
                  className: projectHeaderActionButtonClassName,
                })}
              >
                <Pencil className="h-4 w-4" />
                修改后重提
              </Link>
            )}
            {canEdit && (
              <Button
                type="button"
                variant="outline"
                className={projectHeaderActionButtonClassName}
                onClick={onOpenEdit}
              >
                <Pencil className="h-4 w-4" />
                编辑项目
              </Button>
            )}
            {canImportTasks && (
              <Button
                type="button"
                variant="outline"
                className={projectHeaderActionButtonClassName}
                onClick={onOpenTaskImportDialog}
              >
                <FileSpreadsheet className="h-4 w-4" />
                导入任务
              </Button>
            )}
            {canRemind && (
              <ManualReminderButton
                targetType="PROJECT"
                targetId={project.id}
                label="催促项目"
                buttonClassName={projectHeaderActionButtonClassName}
              />
            )}
            {canUpdateLifecycle && rollbackPreview && (
              <ProjectRollbackButton
                projectId={project.id}
                preview={rollbackPreview}
              />
            )}
            {project.status === "NOT_STARTED" && (
              <Button
                type="button"
                className={projectHeaderActionButtonClassName}
                disabled={loadingStatus !== null}
                onClick={() => handleProjectStatus("IN_PROGRESS")}
              >
                <Play className="h-4 w-4" />
                启动项目
              </Button>
            )}
            {project.status === "IN_PROGRESS" && (
              completeDisabledReason ? (
                <DisabledCompleteProjectButton reason={completeDisabledReason} />
              ) : (
                <ReasonConfirmDialog
                  triggerLabel="完成项目"
                  title="确认完成项目"
                  description="项目完成后将进入归档状态。需完成全部阶段和全部任务后才能完成项目。"
                  reasonLabel="完成说明"
                  confirmLabel="确认完成"
                  variant="outline"
                  triggerSize="default"
                  triggerClassName={projectHeaderActionButtonClassName}
                  onConfirm={(reason) => handleProjectStatus("COMPLETED", reason)}
                />
              )
            )}
            {(project.status === "NOT_STARTED" ||
              project.status === "IN_PROGRESS") && (
              <ReasonConfirmDialog
                triggerLabel="取消项目"
                title="确认取消项目"
                description="项目取消后将进入归档状态，后续不能继续推进阶段。"
                reasonLabel="取消原因"
                confirmLabel="确认取消"
                variant="destructive"
                disabled={loadingStatus !== null}
                triggerSize="default"
                triggerClassName={projectHeaderActionButtonClassName}
                onConfirm={(reason) => handleProjectStatus("CANCELED", reason)}
              />
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

function DisabledCompleteProjectButton({ reason }: { reason: string }) {
  return (
    <span
      className="group relative inline-flex outline-none"
      title={reason}
      tabIndex={0}
      aria-describedby="project-complete-disabled-reason"
    >
      <Button
        type="button"
        variant="outline"
        size="default"
        className={projectHeaderActionButtonClassName}
        disabled
        aria-describedby="project-complete-disabled-reason"
      >
        完成项目
      </Button>
      <span
        id="project-complete-disabled-reason"
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-max max-w-72 -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus:opacity-100"
      >
        {reason}
      </span>
    </span>
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

function ProjectRollbackButton({
  projectId,
  preview,
}: {
  projectId: string;
  preview: ProjectRollbackPreview;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRollback() {
    if (!reason.trim()) {
      toast.error("请填写回退原因");
      return;
    }
    setLoading(true);
    try {
      const result = await rollbackProjectStage({ projectId, reason });
      toast.success(`已回退到「${result.targetStageName}」`);
      setOpen(false);
      setReason("");
      router.push(routes.progress.projectStage(projectId, result.targetStageId));
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "回退流程失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={projectHeaderActionButtonClassName}
        onClick={() => setOpen(true)}
      >
        <RotateCcw className="h-4 w-4" />
        回退流程
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>回退项目流程</DialogTitle>
            <DialogDescription>
              历史提交和审批记录会保留，本次操作只调整当前流程位置。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/40 px-3 py-2">
              <p className="font-medium">目标阶段：{preview.targetStage.name}</p>
              <p className="mt-1 text-muted-foreground">{preview.description}</p>
            </div>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="填写回退原因"
              className="min-h-28"
              maxLength={1000}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={loading} onClick={handleRollback}>
              {loading ? "回退中..." : "确认回退"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
                className="group flex w-40 flex-col items-center gap-2 rounded-md px-2 py-1 text-center outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
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
                <span className="max-w-full truncate text-[11px] text-muted-foreground">
                  DDL {stage.dueAt ? formatDate(stage.dueAt) : "未设置"}
                </span>
                <span className="flex max-w-full flex-wrap justify-center gap-1">
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    延期 {stage.extensionCount}
                  </Badge>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    提前 {stage.advanceCount}
                  </Badge>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    良性 {stage.benignExtensionCount}
                  </Badge>
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
  stages,
  ddlChangeRequests,
  isCurrentStage,
}: {
  projectId: string;
  projectStatus: ProjectStatus;
  stage: StageView;
  stages: StageView[];
  ddlChangeRequests: DdlChangeRequestView[];
  isCurrentStage: boolean;
}) {
  const router = useRouter();
  const evidenceUrlInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceUrlError, setEvidenceUrlError] = useState("");
  const [note, setNote] = useState("");
  const [comments, setComments] = useState<Record<string, string>>({});
  const pendingSubmission = stage.submissions.find(
    (submission) => submission.id === stage.currentSubmissionId,
  );
  const stageDdlRequests = ddlChangeRequests.filter(
    (request) => request.stageId === stage.id,
  );
  const pendingDdlRequests = stageDdlRequests.filter(
    (request) => request.status === "PENDING",
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
    const error = validateRequiredUrl(
      evidenceUrl,
      "请填写文档或归档链接",
      "请输入有效的文档或归档链接",
    );
    if (error) {
      setEvidenceUrlError(error);
      toast.error(error);
      focusInput(evidenceUrlInputRef.current);
      return;
    }

    setEvidenceUrlError("");
    setLoading(true);
    try {
      await submitStageEvidence({
        projectId,
        stageId: stage.id,
        evidenceUrl: evidenceUrl.trim(),
        note: note.trim(),
      });
      toast.success("阶段材料已提交");
      setEvidenceUrl("");
      setEvidenceUrlError("");
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
              <Badge variant="outline">
                <CalendarClock className="h-3 w-3" />
                DDL {stage.dueAt ? formatDateTime(stage.dueAt) : "未设置"}
              </Badge>
              <Badge variant="outline">延期 {stage.extensionCount} 次</Badge>
              <Badge variant="outline">提前 {stage.advanceCount} 次</Badge>
              <Badge variant="outline">良性 {stage.benignExtensionCount} 次</Badge>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {stage.canRequestExtension && stage.dueAt && (
              <ProjectStageBatchDdlChangeDialog
                projectId={projectId}
                stage={stage}
                stages={stages}
              />
            )}
            {stage.canRequestDueDateChange && (
              <ProjectStageDueDateChangeDialog
                projectId={projectId}
                stage={stage}
                stages={stages}
              />
            )}
            {!isCurrentStage && (
              <Badge variant="secondary">
                <History className="h-3 w-3" />
                历史/规划视图
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <h3 className="text-sm font-medium">阶段目标</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {stage.goal || "该阶段暂未配置详细目标。"}
          </p>
        </section>

        {pendingDdlRequests.length > 0 && (
          <PendingDdlChangeRequestPanel requests={pendingDdlRequests} />
        )}

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
                ref={evidenceUrlInputRef}
                placeholder="文档或文件归档链接"
                value={evidenceUrl}
                onChange={(event) => {
                  setEvidenceUrl(event.target.value);
                  if (evidenceUrlError) setEvidenceUrlError("");
                }}
                inputMode="url"
                aria-invalid={!!evidenceUrlError}
                aria-describedby={
                  evidenceUrlError ? "stage-evidence-url-error" : undefined
                }
              />
              {evidenceUrlError && (
                <p
                  id="stage-evidence-url-error"
                  className="text-sm text-destructive"
                >
                  {evidenceUrlError}
                </p>
              )}
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

function ProjectStageBatchDdlChangeDialog({
  projectId,
  stage,
  stages,
}: {
  projectId: string;
  stage: StageView;
  stages: StageView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"DELAY" | "ADVANCE">("DELAY");
  const [reason, setReason] = useState("");
  const [durationDays, setDurationDays] = useState("");
  const [isBenign, setIsBenign] = useState("true");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{
    reason?: string;
    durationDays?: string;
    ddlOrder?: string;
  }>({});
  const parsedDurationDays = Number.parseInt(durationDays, 10);
  const durationIsValid =
    Number.isInteger(parsedDurationDays) &&
    parsedDurationDays >= 1 &&
    parsedDurationDays <= 365;
  const signedDurationDays =
    direction === "DELAY" ? parsedDurationDays : -parsedDurationDays;
  const affectedStages = stages.filter(
    (item) => item.sortOrder >= stage.sortOrder,
  );
  const ddlOrderError = durationIsValid
    ? getStageDdlOrderError(
        stages,
        new Map(
          affectedStages.map((item) => [
            item.id,
            item.dueAt && durationIsValid
              ? addDaysToIso(item.dueAt, signedDurationDays)
              : null,
          ]),
        ),
      )
    : "";

  async function handleSubmit() {
    const nextErrors: typeof errors = {};
    if (!reason.trim()) nextErrors.reason = "请填写调整原因";
    if (!durationIsValid) nextErrors.durationDays = "调整时长需为 1-365 天";
    if (ddlOrderError) nextErrors.ddlOrder = ddlOrderError;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("请完善批量 DDL 调整申请信息");
      return;
    }

    setLoading(true);
    try {
      await requestProjectStageBatchDdlChange({
        projectId,
        stageId: stage.id,
        direction,
        reason: reason.trim(),
        durationDays: parsedDurationDays,
        isBenign: direction === "DELAY" && isBenign === "true",
      });
      toast.success(
        direction === "DELAY" ? "批量延期申请已提交" : "批量提前申请已提交",
      );
      setOpen(false);
      setDirection("DELAY");
      setReason("");
      setDurationDays("");
      setIsBenign("true");
      setErrors({});
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交批量 DDL 调整申请失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        申请批量延期/提前
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[680px]">
          <DialogHeader>
            <DialogTitle>申请批量延期/提前</DialogTitle>
            <DialogDescription>
              通过后会按当前阶段及后续阶段一起调整 DDL。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="stage-extension-stage">调整起始阶段</Label>
              <Input id="stage-extension-stage" value={stage.name} readOnly />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="stage-adjust-direction">调整类型</Label>
              <Select
                value={direction}
                onValueChange={(value) => {
                  setDirection(value === "ADVANCE" ? "ADVANCE" : "DELAY");
                  if (errors.ddlOrder) {
                    setErrors((prev) => ({ ...prev, ddlOrder: "" }));
                  }
                }}
              >
                <SelectTrigger id="stage-adjust-direction">
                  <SelectValue>
                    {direction === "DELAY" ? "延期" : "提前"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DELAY">延期</SelectItem>
                  <SelectItem value="ADVANCE">提前</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="stage-extension-reason">调整原因</Label>
              <Textarea
                id="stage-extension-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (errors.reason) setErrors((prev) => ({ ...prev, reason: "" }));
                }}
                className="min-h-24"
                aria-invalid={!!errors.reason}
              />
              {errors.reason && (
                <p className="text-sm text-destructive">{errors.reason}</p>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="stage-extension-duration">调整时长（天）</Label>
                <Input
                  id="stage-extension-duration"
                  type="number"
                  min={1}
                  max={365}
                  value={durationDays}
                  onChange={(event) => {
                    setDurationDays(event.target.value);
                    if (errors.durationDays) {
                      setErrors((prev) => ({ ...prev, durationDays: "" }));
                    }
                    if (errors.ddlOrder) {
                      setErrors((prev) => ({ ...prev, ddlOrder: "" }));
                    }
                  }}
                  aria-invalid={!!errors.durationDays}
                />
                {errors.durationDays && (
                  <p className="text-sm text-destructive">
                    {errors.durationDays}
                  </p>
                )}
              </div>
              {direction === "DELAY" && (
                <div className="grid gap-2">
                  <Label>延期是否良性</Label>
                  <Select
                    value={isBenign}
                    onValueChange={(value) => setIsBenign(value ?? "false")}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {isBenign === "true" ? "良性延期" : "非良性延期"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">良性延期</SelectItem>
                      <SelectItem value="false">非良性延期</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">影响预览</p>
              <p className="mt-1 text-xs text-muted-foreground">
                当前阶段及后续阶段会一起
                {direction === "DELAY" ? "延期" : "提前"}
                {durationIsValid ? ` ${parsedDurationDays} 天` : ""}。
              </p>
              <div className="mt-2 space-y-1 text-muted-foreground">
                {affectedStages.map((item) => (
                  <p key={item.id}>
                    {item.name}：{item.dueAt ? formatDateTime(item.dueAt) : "未设置"}{" "}
                    {durationIsValid && item.dueAt
                      ? `-> ${formatDateTime(addDaysToIso(item.dueAt, signedDurationDays))}`
                      : ""}
                  </p>
                ))}
              </div>
              {(errors.ddlOrder || ddlOrderError) && (
                <p className="mt-2 text-sm text-destructive">
                  {errors.ddlOrder || ddlOrderError}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={loading} onClick={handleSubmit}>
              {loading ? "提交中..." : "提交批量调整申请"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProjectStageDueDateChangeDialog({
  projectId,
  stage,
  stages,
}: {
  projectId: string;
  stage: StageView;
  stages: StageView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [proposedDueAt, setProposedDueAt] = useState(
    stage.dueAt ? formatDateTimeInputValue(stage.dueAt) : "",
  );
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ proposedDueAt?: string; reason?: string }>({});
  const ddlOrderError = proposedDueAt
    ? getStageDdlOrderError(stages, new Map([[stage.id, proposedDueAt]]))
    : "";

  async function handleSubmit() {
    const nextErrors: typeof errors = {};
    if (!proposedDueAt) nextErrors.proposedDueAt = "请选择新的阶段 DDL";
    if (ddlOrderError) nextErrors.proposedDueAt = ddlOrderError;
    if (!reason.trim()) nextErrors.reason = "请填写修改原因";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("请完善 DDL 修改申请信息");
      return;
    }

    setLoading(true);
    try {
      await requestProjectStageDueDateChange({
        projectId,
        stageId: stage.id,
        proposedDueAt,
        reason: reason.trim(),
      });
      toast.success("DDL 修改申请已提交");
      setOpen(false);
      setReason("");
      setErrors({});
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交 DDL 修改申请失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        申请修改 DDL
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>申请修改阶段 DDL</DialogTitle>
            <DialogDescription>
              该申请只修改当前阶段，不顺延后续阶段。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">{stage.name}</p>
              <p className="mt-1 text-muted-foreground">
                当前 DDL：{stage.dueAt ? formatDateTime(stage.dueAt) : "未设置"}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="stage-due-change-new">新的阶段 DDL</Label>
              <Input
                id="stage-due-change-new"
                type="datetime-local"
                value={proposedDueAt}
                onChange={(event) => {
                  setProposedDueAt(event.target.value);
                  if (errors.proposedDueAt) {
                    setErrors((prev) => ({ ...prev, proposedDueAt: "" }));
                  }
                }}
                aria-invalid={!!errors.proposedDueAt}
              />
              {errors.proposedDueAt && (
                <p className="text-sm text-destructive">
                  {errors.proposedDueAt}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="stage-due-change-reason">修改原因</Label>
              <Textarea
                id="stage-due-change-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (errors.reason) setErrors((prev) => ({ ...prev, reason: "" }));
                }}
                className="min-h-24"
                aria-invalid={!!errors.reason}
              />
              {errors.reason && (
                <p className="text-sm text-destructive">{errors.reason}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={loading} onClick={handleSubmit}>
              {loading ? "提交中..." : "提交修改申请"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PendingDdlChangeRequestPanel({
  requests,
}: {
  requests: DdlChangeRequestView[];
}) {
  return (
    <section className="rounded-md border bg-orange-50/50 p-4">
      <h3 className="text-sm font-medium">待审批 DDL 变更</h3>
      <div className="mt-3 space-y-3">
        {requests.map((request) => (
          <PendingDdlChangeRequestCard key={request.id} request={request} />
        ))}
      </div>
    </section>
  );
}

function PendingDdlChangeRequestCard({
  request,
}: {
  request: DdlChangeRequestView;
}) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [finalIsBenign, setFinalIsBenign] = useState(
    request.requestedIsBenign ? "true" : "false",
  );
  const [loadingDecision, setLoadingDecision] =
    useState<ProjectDdlChangeRequestStatus | null>(null);
  const [commentError, setCommentError] = useState("");

  async function handleReview(decision: "APPROVED" | "REJECTED") {
    if (!comment.trim()) {
      setCommentError("请填写审批意见");
      toast.error("请填写审批意见");
      return;
    }
    setLoadingDecision(decision);
    try {
      if (request.type === "CASCADE_EXTENSION") {
        await reviewProjectStageBatchDdlChangeRequest({
          requestId: request.id,
          decision,
          comment: comment.trim(),
          finalIsBenign: finalIsBenign === "true",
        });
      } else {
        await reviewProjectStageDueDateChangeRequest({
          requestId: request.id,
          decision,
          comment: comment.trim(),
        });
      }
      toast.success(decision === "APPROVED" ? "DDL 变更已通过" : "DDL 变更已驳回");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "审核 DDL 变更失败"));
    } finally {
      setLoadingDecision(null);
    }
  }

  return (
    <div className="rounded-md border bg-background p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{ddlChangeTypeLabels[request.type]}</p>
          <p className="mt-1 text-muted-foreground">
            申请人：{request.requesterName} · {formatDateTime(request.createdAt)}
          </p>
        </div>
        <Badge variant="secondary">{ddlChangeStatusLabels[request.status]}</Badge>
      </div>
      <div className="mt-2 grid gap-2 text-muted-foreground sm:grid-cols-2">
        <p>原 DDL：{formatNullableDateTime(request.oldDueAt)}</p>
        <p>新 DDL：{formatNullableDateTime(request.newDueAt)}</p>
        {request.durationDays ? (
          <p>调整：{formatDdlAdjustment(request.durationDays)}</p>
        ) : null}
        {isBatchDdlDelay(request) && request.requestedIsBenign !== null ? (
          <p>申请良性：{request.requestedIsBenign ? "是" : "否"}</p>
        ) : null}
      </div>
      <p className="mt-2 rounded-md bg-muted px-3 py-2 text-muted-foreground">
        原因：{request.reason}
      </p>
      {request.canReview ? (
        <div className="mt-3 grid gap-2">
          {isBatchDdlDelay(request) && (
            <div className="grid gap-2 sm:max-w-48">
              <Label>最终是否良性</Label>
              <Select
                value={finalIsBenign}
                onValueChange={(value) => setFinalIsBenign(value ?? "false")}
              >
                <SelectTrigger>
                  <SelectValue>
                    {finalIsBenign === "true" ? "良性延期" : "非良性延期"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">良性延期</SelectItem>
                  <SelectItem value="false">非良性延期</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <Textarea
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
              if (commentError) setCommentError("");
            }}
            placeholder="审批意见（通过和驳回都必填）"
            className="min-h-20"
            aria-invalid={!!commentError}
          />
          {commentError && (
            <p className="text-sm text-destructive">{commentError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={loadingDecision !== null}
              onClick={() => handleReview("APPROVED")}
            >
              通过
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingDecision !== null}
              onClick={() => handleReview("REJECTED")}
            >
              驳回
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">等待有权限人员审批。</p>
      )}
    </div>
  );
}

function ProjectDdlChangeHistoryPanel({
  requests,
}: {
  requests: DdlChangeRequestView[];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>DDL 变动历史</CardTitle>
      </CardHeader>
      <CardContent>
        {requests.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            暂无 DDL 变动记录。
          </p>
        ) : (
          <div className="space-y-2">
            {requests.map((request) => (
              <div key={request.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {request.stageName} · {ddlChangeTypeLabels[request.type]}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {request.requesterName} · {formatDateTime(request.createdAt)}
                    </p>
                  </div>
                  <Badge
                    variant={
                      request.status === "APPROVED"
                        ? "default"
                        : request.status === "REJECTED"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {ddlChangeStatusLabels[request.status]}
                  </Badge>
                </div>
                <div className="mt-2 grid gap-2 text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                  <p>原 DDL：{formatNullableDateTime(request.oldDueAt)}</p>
                  <p>新 DDL：{formatNullableDateTime(request.newDueAt)}</p>
                  <p>
                    调整：
                    {request.durationDays
                      ? formatDdlAdjustment(request.durationDays)
                      : "不适用"}
                  </p>
                  <p>
                    良性：
                    {isBatchDdlDelay(request)
                      ? formatBenignFlag(
                          request.finalIsBenign,
                          request.requestedIsBenign,
                        )
                      : "不适用"}
                  </p>
                </div>
                <p className="mt-2 text-muted-foreground">原因：{request.reason}</p>
                {request.reviewedAt && (
                  <p className="mt-1 text-muted-foreground">
                    审批：{request.reviewerName || "未知"} ·{" "}
                    {formatDateTime(request.reviewedAt)}
                    {request.reviewComment ? ` · ${request.reviewComment}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
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
  canRequestTaskCreation,
  userOpenId,
  onTaskScopeChange,
  onFiltersChange,
  onOpenTaskDialog,
  onOpenTaskRequestDialog,
}: {
  tasks: TaskView[];
  scopedTasks: TaskView[];
  selectedStage: StageView;
  taskScope: TaskScope;
  filters: TaskFilters;
  canManage: boolean;
  canCreateTask: boolean;
  canRequestTaskCreation: boolean;
  userOpenId?: string;
  onTaskScopeChange: (scope: TaskScope) => void;
  onFiltersChange: (filters: TaskFilters) => void;
  onOpenTaskDialog: () => void;
  onOpenTaskRequestDialog: () => void;
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
              <span>项目已取消 {stats.projectCanceled}</span>
              <span>进行中 {stats.inProgress}</span>
              <span>待审核 {stats.pending}</span>
              <span>已逾期 {stats.overdue}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {canCreateTask && (
              <Button type="button" onClick={onOpenTaskDialog}>
                <Plus className="h-4 w-4" />
                新增任务
              </Button>
            )}
            {!canCreateTask && canRequestTaskCreation && (
              <Button type="button" variant="outline" onClick={onOpenTaskRequestDialog}>
                <Plus className="h-4 w-4" />
                申请新任务
              </Button>
            )}
          </div>
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

function TaskCreationRequestPanel({
  requests,
  canManage,
}: {
  requests: TaskCreationRequestView[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [comments, setComments] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [detailRequest, setDetailRequest] =
    useState<TaskCreationRequestView | null>(null);

  async function handleReview(
    request: TaskCreationRequestView,
    decision: "APPROVED" | "REJECTED",
  ) {
    const comment = comments[request.id] ?? "";
    if (decision === "REJECTED" && !comment.trim()) {
      toast.error("驳回任务申请时请填写审核意见");
      return;
    }
    setLoadingId(request.id);
    try {
      await reviewTaskCreationRequest({
        requestId: request.id,
        decision,
        comment,
      });
      toast.success(decision === "APPROVED" ? "任务申请已通过" : "任务申请已驳回");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "审核任务申请失败"));
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>任务申请</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {requests.map((request) => (
            <div key={request.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {request.draft?.summary ?? "任务申请内容无法解析"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    申请人：{request.requesterName} ·{" "}
                    {formatDateTime(request.createdAt)}
                  </p>
                  {request.draft && (
                    <p className="mt-1 text-muted-foreground">
                      指标：{request.draft.metrics || "未填写"} · 截止{" "}
                      {request.draft.dueAt
                        ? formatDateTime(request.draft.dueAt)
                        : "未填写"}
                    </p>
                  )}
                </div>
                <Badge
                  variant={request.status === "PENDING" ? "secondary" : "outline"}
                >
                  {request.status === "PENDING"
                    ? "待审核"
                    : request.status === "APPROVED"
                      ? "已通过"
                      : "已驳回"}
                </Badge>
              </div>
              {request.reviewComment && (
                <p className="mt-2 rounded-md bg-muted px-3 py-2 text-muted-foreground">
                  审核意见：{request.reviewComment}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDetailRequest(request)}
                >
                  查看申请详情
                </Button>
                {request.createdTaskId && (
                  <Link
                    href={routes.progress.task(request.createdTaskId)}
                    className={buttonVariants({ size: "sm", variant: "outline" })}
                    data-testid="task-creation-request-task-link"
                  >
                    查看任务详情
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
              {canManage && request.status === "PENDING" && (
                <div className="mt-3 space-y-2">
                  <Textarea
                    value={comments[request.id] ?? ""}
                    onChange={(event) =>
                      setComments({
                        ...comments,
                        [request.id]: event.target.value,
                      })
                    }
                    placeholder="审核意见；驳回时必填"
                    className="min-h-20"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={loadingId === request.id}
                      onClick={() => handleReview(request, "APPROVED")}
                    >
                      通过并创建任务
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={loadingId === request.id}
                      onClick={() => handleReview(request, "REJECTED")}
                    >
                      驳回申请
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <TaskCreationRequestDetailDialog
        request={detailRequest}
        onOpenChange={(open) => {
          if (!open) setDetailRequest(null);
        }}
      />
    </>
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
        <div className="flex justify-end gap-2">
          {canStart ? <StartTaskButton taskId={task.id} /> : null}
          <Link
            href={routes.progress.task(task.id)}
            className={buttonVariants({ size: "sm", variant: "outline" })}
            data-testid="task-detail-link"
          >
            查看详情
          </Link>
        </div>
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
        {task.taskTechGroups.map((group) => (
          <Badge key={group} variant="outline">
            {group}
          </Badge>
        ))}
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
      <div className="mt-3">
        <Link
          href={routes.progress.task(task.id)}
          className={buttonVariants({ size: "sm", variant: "outline" })}
          data-testid="task-detail-link"
        >
          查看详情
        </Link>
      </div>
    </div>
  );
}

function TaskCreationRequestDetailDialog({
  request,
  onOpenChange,
}: {
  request: TaskCreationRequestView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const draft = request?.draft ?? null;

  return (
    <Dialog open={!!request} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>任务申请详情</DialogTitle>
          <DialogDescription>
            通过前这是任务草案；审核通过后会生成正式任务详情页。
          </DialogDescription>
        </DialogHeader>
        {!request ? null : draft ? (
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">任务名称</p>
              <p className="mt-1 font-medium">{draft.title}</p>
            </div>
            {draft.goal && (
              <div>
                <p className="text-xs text-muted-foreground">任务说明</p>
                <p className="mt-1 whitespace-pre-wrap">{draft.goal}</p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <RequestDetailItem label="所属阶段" value={draft.stageName} />
              <RequestDetailItem label="负责人" value={draft.assigneeNames} />
              <RequestDetailItem
                label="任务技术组"
                value={
                  draft.taskTechGroups.length > 0
                    ? draft.taskTechGroups.join("、")
                    : "未填写"
                }
              />
              <RequestDetailItem
                label="优先级"
                value={`${urgencyLabels[draft.urgency] ?? "未填写"} / ${importanceLabels[draft.importance] ?? "未填写"}`}
              />
              <RequestDetailItem
                label="截止时间"
                value={draft.dueAt ? formatDateTime(draft.dueAt) : "未填写"}
              />
              <RequestDetailItem
                label="线下确认"
                value={draft.needsOfflineConfirmation ? "需要" : "不需要"}
              />
              <RequestDetailItem
                label="定期周报"
                value={draft.needsWeeklyReport ? "需要" : "不需要"}
              />
              <RequestDetailItem
                label="验收清单"
                value={
                  draft.acceptanceChecklistItems.length > 0
                    ? `${draft.acceptanceChecklistItems.length} 条`
                    : "未配置"
                }
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">验收指标</p>
              <p className="mt-1 whitespace-pre-wrap">
                {draft.metrics || "未填写"}
              </p>
            </div>
            {draft.acceptanceChecklistItems.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground">验收条例</p>
                <ul className="mt-2 space-y-1 rounded-md bg-muted/50 px-3 py-2">
                  {draft.acceptanceChecklistItems.map((item, index) => (
                    <li key={`${item.content}-${index}`}>
                      {index + 1}. {item.content}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-md bg-muted px-3 py-2 text-muted-foreground">
              申请人：{request.requesterName} · 提交时间：
              {formatDateTime(request.createdAt)}
            </div>
            {request.createdTaskId && (
              <Link
                href={routes.progress.task(request.createdTaskId)}
                className={buttonVariants({ size: "sm", variant: "outline" })}
                data-testid="task-creation-request-dialog-task-link"
              >
                查看任务详情
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        ) : (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            任务申请内容无法解析。
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RequestDetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
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
  const reviewComment =
    getPayloadString(payload.reviewComment) ?? getPayloadString(payload.comment);
  const fromProjectStatus = getPayloadString(payload.fromProjectStatus);
  const toProjectStatus = getPayloadString(payload.toProjectStatus);
  const fromStageName = getPayloadString(payload.fromStageName);
  const oldDueAt = getPayloadString(payload.oldDueAt);
  const newDueAt = getPayloadString(payload.newDueAt);
  const durationDays =
    typeof payload.durationDays === "number" ? payload.durationDays : null;
  const finalIsBenign =
    typeof payload.finalIsBenign === "boolean" ? payload.finalIsBenign : null;
  const requestedIsBenign =
    typeof payload.requestedIsBenign === "boolean"
      ? payload.requestedIsBenign
      : null;
  const importedTaskCount =
    typeof payload.count === "number" ? payload.count : null;
  const importedTaskTitles = Array.isArray(payload.titles)
    ? payload.titles.filter((title): title is string => typeof title === "string")
    : [];
  const projectStatusChange =
    fromProjectStatus &&
    toProjectStatus &&
    isProjectStatus(fromProjectStatus) &&
    isProjectStatus(toProjectStatus)
      ? `项目状态：${projectStatusLabels[fromProjectStatus]} -> ${projectStatusLabels[toProjectStatus]}`
      : null;
  if (
    changes.length === 0 &&
    !reason &&
    !reviewComment &&
    !projectStatusChange &&
    !fromStageName &&
    !oldDueAt &&
    !newDueAt &&
    durationDays === null &&
    finalIsBenign === null &&
    requestedIsBenign === null &&
    importedTaskCount === null &&
    importedTaskTitles.length === 0
  ) return null;
  return (
    <ul className="mt-2 space-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      {importedTaskCount !== null && <li>任务数量：{importedTaskCount} 条</li>}
      {importedTaskTitles.length > 0 && (
        <li>
          任务列表：
          {importedTaskTitles.slice(0, 5).join("、")}
          {importedTaskTitles.length > 5
            ? ` 等 ${importedTaskTitles.length} 条`
            : ""}
        </li>
      )}
      {projectStatusChange && <li>{projectStatusChange}</li>}
      {fromStageName && <li>原阶段：{fromStageName}</li>}
      {oldDueAt && <li>原 DDL：{formatNullableDateTime(oldDueAt)}</li>}
      {newDueAt && <li>新 DDL：{formatNullableDateTime(newDueAt)}</li>}
      {durationDays !== null && <li>调整：{formatDdlAdjustment(durationDays)}</li>}
      {requestedIsBenign !== null && (
        <li>申请良性：{requestedIsBenign ? "是" : "否"}</li>
      )}
      {finalIsBenign !== null && <li>最终良性：{finalIsBenign ? "是" : "否"}</li>}
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
      <Badge
        variant={
          task.status === "PROJECT_CANCELED"
            ? "destructive"
            : task.status === "COMPLETED"
              ? "default"
              : "secondary"
        }
      >
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
    if (
      filters.mine &&
      (!userOpenId || !task.relatedOpenIds.includes(userOpenId))
    ) {
      return false;
    }
    if (filters.overdue && !task.isOverdue) return false;
    if (filters.pending && task.status !== "PENDING_ACCEPTANCE") return false;
    if (
      filters.unfinished &&
      isEndedTaskStatus(task.status)
    ) {
      return false;
    }
    return true;
  });
}

function getTaskStats(tasks: TaskView[]) {
  return {
    total: tasks.length,
    completed: tasks.filter((task) =>
      isCompletedOrArchivedTaskStatus(task.status),
    ).length,
    projectCanceled: tasks.filter((task) => task.status === "PROJECT_CANCELED")
      .length,
    inProgress: tasks.filter((task) => task.status === "IN_PROGRESS").length,
    pending: tasks.filter((task) => task.status === "PENDING_ACCEPTANCE").length,
    overdue: tasks.filter((task) => task.isOverdue).length,
  };
}

function getTaskMaterialStatus(task: TaskView): string {
  if (task.status === "PROJECT_CANCELED") return "项目已取消";
  if (task.status === "PENDING_ACCEPTANCE") return "已提交";
  if (task.status === "COMPLETED" && task.submissionsCount > 0) return "已验收";
  if (task.submissionsCount > 0) return "有历史提交";
  return "未提交";
}

function isCompletedOrArchivedTaskStatus(status: TaskStatus): boolean {
  return status === "COMPLETED" || status === "ARCHIVED";
}

function isEndedTaskStatus(status: TaskStatus): boolean {
  return (
    isCompletedOrArchivedTaskStatus(status) || status === "PROJECT_CANCELED"
  );
}

function getProjectCompleteDisabledReason({
  loadingStatus,
  stageCount,
  allStagesCompleted,
  unfinishedStageCount,
  unfinishedTaskCount,
}: {
  loadingStatus: ProjectStatus | null;
  stageCount: number;
  allStagesCompleted: boolean;
  unfinishedStageCount: number;
  unfinishedTaskCount: number;
}): string | null {
  if (loadingStatus !== null) return "正在处理，请稍候";
  if (stageCount === 0) {
    return `请先配置项目阶段；还有 ${unfinishedStageCount} 个阶段未完成，${unfinishedTaskCount} 个任务未完成`;
  }
  if (!allStagesCompleted || unfinishedTaskCount > 0) {
    return `还有 ${unfinishedStageCount} 个阶段未完成，${unfinishedTaskCount} 个任务未完成`;
  }
  return null;
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

function isProjectStatus(value: string): value is ProjectStatus {
  return value in projectStatusLabels;
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
    "project.establishment_requested": "提交了项目立项",
    "project.establishment_resubmitted": "重新提交了项目立项",
    "project.establishment_approved": "通过了项目立项",
    "project.establishment_rejected": "驳回了项目立项",
    "project.updated": "更新了项目信息",
    "project.status_changed": "更新了项目状态",
    "project.stage_rollback": "回退了项目流程",
    "project.ddl_extension_requested": "申请了阶段延期",
    "project.ddl_extension_approved": "通过了阶段延期申请",
    "project.ddl_extension_rejected": "驳回了阶段延期申请",
    "project.stage_batch_due_change_requested": "申请了批量 DDL 调整",
    "project.stage_batch_due_change_approved": "通过了批量 DDL 调整",
    "project.stage_batch_due_change_rejected": "驳回了批量 DDL 调整",
    "project.stage_due_change_requested": "申请修改阶段 DDL",
    "project.stage_due_change_approved": "通过了阶段 DDL 修改",
    "project.stage_due_change_rejected": "驳回了阶段 DDL 修改",
    "project.reminded": "发送了项目催促提醒",
    "stage.evidence_submitted": "提交了阶段材料",
    "stage.approved": "通过了阶段审核",
    "stage.rejected": "驳回了阶段审核",
    "task.created": "创建了任务",
    "task.updated": "更新了任务信息",
    "task.status_changed": "更新了任务状态",
    "task.project_canceled": "项目取消后同步取消了任务",
    "task.delivery_submitted": "提交了任务交付",
    "task.approved": "通过了任务验收",
    "task.rejected": "驳回了任务验收",
    "task.weekly_report": "提交了任务周报",
    "task.risk_synced": "同步了任务风险",
    "task.archived": "归档了任务",
    "task.creation_requested": "申请创建任务",
    "task.creation_approved": "通过了任务创建申请",
    "task.creation_rejected": "驳回了任务创建申请",
    "task.bulk_imported": "批量导入了任务",
    "task.bulk_creation_requested": "批量申请创建任务",
    "task.delete_requested": "申请删除任务",
    "task.delete_rejected": "驳回了删除申请",
    "task.deleted": "删除了任务",
    "task.reminded": "发送了任务催促提醒",
  };
  return labels[action] ?? action;
}

function getProjectRollbackPreview(
  project: ProjectDetailView,
): ProjectRollbackPreview | null {
  if (project.stages.length === 0) return null;

  if (project.status === "COMPLETED") {
    const targetStage = [...project.stages]
      .reverse()
      .find((stage) => stage.status === "COMPLETED");
    if (!targetStage) return null;
    return {
      targetStage,
      fromStage: null,
      description: `项目会重新变为进行中，「${targetStage.name}」会变为当前进行阶段。`,
    };
  }

  if (project.status !== "IN_PROGRESS") return null;

  const pendingStage = project.stages.find(
    (stage) => stage.status === "PENDING_ACCEPTANCE",
  );
  if (pendingStage) {
    return {
      targetStage: pendingStage,
      fromStage: pendingStage,
      description: `「${pendingStage.name}」会从待审批退回到进行中，当前提交材料不再作为待审批材料。`,
    };
  }

  const activeStage = project.stages.find(
    (stage) => stage.status === "IN_PROGRESS",
  );
  if (activeStage) {
    const previousCompletedStage = [...project.stages]
      .filter(
        (stage) =>
          stage.sortOrder < activeStage.sortOrder &&
          stage.status === "COMPLETED",
      )
      .at(-1);
    if (!previousCompletedStage) return null;
    return {
      targetStage: previousCompletedStage,
      fromStage: activeStage,
      description: `当前阶段「${activeStage.name}」及后续阶段会回到未开始，「${previousCompletedStage.name}」会重新变为进行中。`,
    };
  }

  const lastCompletedStage = [...project.stages]
    .reverse()
    .find((stage) => stage.status === "COMPLETED");
  if (!lastCompletedStage) return null;
  return {
    targetStage: lastCompletedStage,
    fromStage: null,
    description: `「${lastCompletedStage.name}」会重新变为进行中，后续流程需重新提交审批。`,
  };
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatNullableDateTime(value: string | null): string {
  return value ? formatDateTime(value) : "未设置";
}

function formatBenignFlag(
  finalIsBenign: boolean | null,
  requestedIsBenign: boolean | null,
): string {
  const value = finalIsBenign ?? requestedIsBenign;
  if (value === null) return "不适用";
  return value ? "是" : "否";
}

function formatDdlAdjustment(durationDays: number): string {
  const label = durationDays < 0 ? "提前" : "延期";
  return `${label} ${Math.abs(durationDays)} 天`;
}

function isBatchDdlDelay(request: DdlChangeRequestView): boolean {
  return request.type === "CASCADE_EXTENSION" && (request.durationDays ?? 0) > 0;
}

function formatDateTimeInputValue(value: string): string {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function addDaysToIso(value: string, days: number): string {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function getStageDdlOrderError(
  stages: StageView[],
  dueAtOverrides: Map<string, string | null>,
): string {
  const sortedStages = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
  let previous: { name: string; dueAt: Date } | null = null;

  for (const stage of sortedStages) {
    const dueAtValue = dueAtOverrides.has(stage.id)
      ? dueAtOverrides.get(stage.id) ?? null
      : stage.dueAt;
    if (!dueAtValue) {
      return `阶段「${stage.name}」未设置 DDL，无法提交 DDL 变更申请`;
    }
    const dueAt = new Date(dueAtValue);
    if (Number.isNaN(dueAt.getTime())) {
      return `阶段「${stage.name}」DDL 无效`;
    }
    if (previous && previous.dueAt.getTime() > dueAt.getTime()) {
      return `阶段 DDL 必须按流程非严格递增：「${previous.name}」不能晚于「${stage.name}」`;
    }
    previous = { name: stage.name, dueAt };
  }

  return "";
}

function validateRequiredUrl(
  value: string,
  emptyMessage: string,
  invalidMessage: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return emptyMessage;

  try {
    new URL(trimmed);
    return null;
  } catch {
    return invalidMessage;
  }
}

function focusInput(input: HTMLInputElement | null) {
  input?.scrollIntoView({ behavior: "smooth", block: "center" });
  input?.focus();
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
