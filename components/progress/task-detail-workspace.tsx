"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Archive,
  History,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ApprovalDecision,
  Importance,
  ProjectStatus,
  TaskCategory,
  TaskStatus,
  Urgency,
} from "@prisma/client";
import { TaskActionsPanel } from "@/components/progress/task-actions-panel";
import { TaskForm } from "@/components/progress/task-form";
import { ManualReminderButton } from "@/components/progress/manual-reminder-button";
import { loadMoreTaskActivityLogs } from "@/app/actions/progress/activityLogs";
import {
  deleteTaskDirectly,
  requestTaskDeletion,
  reviewTaskDeletionRequest,
} from "@/app/actions/progress/deleteTask";
import { BackLink } from "@/components/back-link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  archiveTask,
  restartTask,
  updateTaskStatus,
} from "@/app/actions/progress/updateTask";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { routes } from "@/lib/routes";
import {
  importanceLabels,
  taskCategoryLabels,
  taskStatusLabels,
  urgencyLabels,
} from "@/lib/progress-labels";

export type TaskDetailView = {
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
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  projectOwnerOpenIds: string[];
  updatedAt: string;
  stageId: string | null;
  stageName: string | null;
  team: string;
  techGroup: string;
  metrics: string;
  dueAt: string;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
  acceptanceChecklistItems: TaskAcceptanceChecklistItemView[];
  acceptanceChecklistLocked: boolean;
  riskNote: string;
  submissions: TaskSubmissionView[];
  weeklyReports: TaskWeeklyReportView[];
  deletionRequests: TaskDeletionRequestView[];
  activityLogs: TaskActivityLogView[];
  hasMoreActivityLogs: boolean;
};

export type TaskDeletionRequestView = {
  id: string;
  requesterName: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewerName: string;
  reviewComment: string;
  createdAt: string;
  reviewedAt: string | null;
};

export type TaskSubmissionView = {
  id: string;
  feishuDocUrl: string;
  keyDataUrl: string;
  note: string;
  failureReason: string;
  submittedAt: string;
  submitterName: string;
  approvals: TaskApprovalView[];
};

export type TaskApprovalView = {
  id: string;
  approverName: string;
  decision: ApprovalDecision;
  comment: string;
  createdAt: string;
  checklistConfirmations: TaskChecklistConfirmationView[];
};

export type TaskAcceptanceChecklistItemView = {
  id: string;
  content: string;
  sortOrder: number;
};

export type TaskChecklistConfirmationView = {
  id: string;
  content: string;
  sortOrder: number;
};

export type TaskWeeklyReportView = {
  id: string;
  weekStart: string;
  progress: string;
  risks: string;
  nextPlan: string;
  feishuDocUrl: string;
  submitterName: string;
  submittedAt: string;
};

export type TaskActivityLogView = {
  id: string;
  action: string;
  actorName: string;
  payload: string;
  createdAt: string;
};

type Props = {
  task: TaskDetailView;
  users: UserOption[];
  stages: StageOption[];
  acceptanceChecklistTemplates: AcceptanceChecklistTemplateOption[];
  isAssignee: boolean;
  canApprove: boolean;
  canManage: boolean;
  canRequestDeletion: boolean;
  isSuperAdmin?: boolean;
};

type UserOption = { openId: string; name: string; avatar?: string | null };
type StageOption = { id: string; name: string };
type AcceptanceChecklistTemplateOption = { id: string; content: string };

type ActivityFilter = "ALL" | "STATUS" | "DELIVERY" | "REVIEW" | "WEEKLY" | "RISK";
type ActivityHistoryState = {
  sourceKey: string;
  extraLogs: TaskActivityLogView[];
  hasMore: boolean;
};

const activityFilters: Array<{ value: ActivityFilter; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "STATUS", label: "状态" },
  { value: "DELIVERY", label: "交付" },
  { value: "REVIEW", label: "审核" },
  { value: "WEEKLY", label: "周报" },
  { value: "RISK", label: "风险" },
];

export function TaskDetailWorkspace({
  task,
  users,
  stages,
  acceptanceChecklistTemplates,
  isAssignee,
  canApprove,
  canManage,
  canRequestDeletion,
  isSuperAdmin = false,
}: Props) {
  const projectHref = projectStageHref(task.projectId, task.stageId);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const pendingDeletionRequest = task.deletionRequests.find(
    (request) => request.status === "PENDING",
  );
  const isProjectCanceledTask = task.status === "PROJECT_CANCELED";
  const canEdit =
    canManage &&
    task.status !== "ARCHIVED" &&
    !isProjectCanceledTask &&
    task.projectStatus !== "COMPLETED" &&
    task.projectStatus !== "CANCELED";
  const isProjectActive =
    task.projectStatus !== "COMPLETED" && task.projectStatus !== "CANCELED";

  return (
    <main
      data-testid="task-detail-workspace"
      className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8"
    >
      <BackLink href={projectHref} label={`返回项目 ${task.projectName}`} />

      <TaskOverview
        task={task}
        isAssignee={isAssignee}
        canManage={canManage}
        canEdit={canEdit}
        canRequestDeletion={canRequestDeletion}
        canRemind={
          canManage &&
          isProjectActive &&
          task.status !== "COMPLETED" &&
          task.status !== "ARCHIVED" &&
          !isProjectCanceledTask
        }
        projectHref={projectHref}
        onOpenEdit={() => setTaskDialogOpen(true)}
      />

      {pendingDeletionRequest && !isProjectCanceledTask && (
        <TaskDeletionRequestPanel
          request={pendingDeletionRequest}
          taskTitle={task.title}
          canManage={canManage}
          redirectTo={projectHref}
        />
      )}

      <div className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <TaskActionsPanel
            taskId={task.id}
            status={task.status}
            isAssignee={isAssignee}
            canSubmitDelivery={isAssignee || isSuperAdmin}
            canSubmitWeeklyReport={
              isProjectActive &&
              task.needsWeeklyReport &&
              (isAssignee || canManage)
            }
            canApprove={canApprove}
            canManage={canManage}
            needsOfflineConfirmation={task.needsOfflineConfirmation}
            needsWeeklyReport={task.needsWeeklyReport}
            acceptanceChecklistItems={task.acceptanceChecklistItems}
            submissions={task.submissions}
            showFlowActions={false}
          />

          <TaskWeeklyReports reports={task.weeklyReports} />
        </div>

        <TaskSidePanel task={task} />
      </div>

      <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>编辑任务</DialogTitle>
            <DialogDescription>
              修改任务基础信息后，系统会通知相关负责人和管理角色。
            </DialogDescription>
          </DialogHeader>
          <TaskForm
            mode="edit"
            projectId={task.projectId}
            users={users}
            stages={stages}
            acceptanceChecklistTemplates={acceptanceChecklistTemplates}
            initialTask={{
              id: task.id,
              updatedAt: task.updatedAt,
              stageId: task.stageId,
              title: task.title,
              goal: task.goal,
              category: task.category,
              urgency: task.urgency,
              importance: task.importance,
              assigneeOpenIds: task.assigneeOpenIds,
              metrics: task.metrics,
              dueAt: task.dueAt,
              needsOfflineConfirmation: task.needsOfflineConfirmation,
              needsWeeklyReport: task.needsWeeklyReport,
              acceptanceChecklistItems: task.acceptanceChecklistItems,
              acceptanceChecklistLocked: task.acceptanceChecklistLocked,
            }}
            submitLabel="保存修改"
            onSaved={() => setTaskDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}

function TaskOverview({
  task,
  isAssignee,
  canManage,
  canEdit,
  canRequestDeletion,
  canRemind,
  projectHref,
  onOpenEdit,
}: {
  task: TaskDetailView;
  isAssignee: boolean;
  canManage: boolean;
  canEdit: boolean;
  canRequestDeletion: boolean;
  canRemind: boolean;
  projectHref: string;
  onOpenEdit: () => void;
}) {
  const canStart = task.status === "TODO" && (isAssignee || canManage);
  const canArchive = task.status === "COMPLETED" && canManage;
  const isProjectCanceledTask = task.status === "PROJECT_CANCELED";
  const canRestart =
    canManage &&
    task.projectStatus === "IN_PROGRESS" &&
    (task.status === "PENDING_ACCEPTANCE" || task.status === "COMPLETED");
  const pendingDeletionRequest = task.deletionRequests.find(
    (request) => request.status === "PENDING",
  );

  return (
    <Card data-testid="task-overview">
      <CardContent className="flex flex-col gap-5 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-2xl font-semibold leading-tight">
              {task.title}
            </h1>
            <TaskStatusBadges task={task} />
            <Badge variant="outline">{taskCategoryLabels[task.category]}</Badge>
            <Badge variant="secondary">
              紧急 {urgencyLabels[task.urgency]} / 重要{" "}
              {importanceLabels[task.importance]}
            </Badge>
          </div>
          {task.goal && (
            <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">
              {task.goal}
            </p>
          )}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <OverviewItem label="负责人" value={task.assigneeNames} />
            <OverviewItem label="截止时间" value={formatDateTime(task.dueAt)} />
            <OverviewItem label="所属项目" value={task.projectName} />
            <OverviewItem label="所属阶段" value={task.stageName ?? "无阶段"} />
            <OverviewItem
              label="车组/技术组"
              value={`${formatScopeItem(task.team)} / ${formatScopeItem(task.techGroup)}`}
            />
            <OverviewItem
              label="线下确认"
              value={task.needsOfflineConfirmation ? "需要" : "不需要"}
            />
            <OverviewItem
              label="定期周报"
              value={task.needsWeeklyReport ? "需要" : "不需要"}
            />
            <OverviewItem
              label="验收清单"
              value={
                task.acceptanceChecklistItems.length > 0
                  ? `${task.acceptanceChecklistItems.length} 条`
                  : "未配置"
              }
            />
            <OverviewItem label="指标" value={task.metrics || "未填写"} />
          </dl>
          {task.riskNote && (
            <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              最新风险：{task.riskNote}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {canEdit && (
            <Button type="button" variant="outline" onClick={onOpenEdit}>
              <Pencil className="h-4 w-4" />
              编辑任务
            </Button>
          )}
          {canRemind && (
            <ManualReminderButton
              targetType="TASK"
              targetId={task.id}
              label="催促任务"
            />
          )}
          {canRestart && <RestartTaskButton task={task} />}
          {canStart && <StartTaskButton taskId={task.id} />}
          {canArchive && <ArchiveTaskButton taskId={task.id} />}
          {task.projectStatus === "IN_PROGRESS" &&
          !isProjectCanceledTask &&
          canManage ? (
            <TaskDirectDeleteButton taskId={task.id} redirectTo={projectHref} />
          ) : task.projectStatus === "IN_PROGRESS" &&
            !isProjectCanceledTask &&
            canRequestDeletion ? (
            <TaskDeletionRequestButton
              taskId={task.id}
              disabled={!!pendingDeletionRequest}
            />
          ) : null}
        </div>
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

function RestartTaskButton({ task }: { task: TaskDetailView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRestart() {
    if (!reason.trim()) {
      toast.error("请填写重启原因");
      return;
    }
    setLoading(true);
    try {
      await restartTask({ taskId: task.id, reason });
      toast.success("任务已重启");
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "重启任务失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <RotateCcw className="h-4 w-4" />
        重启任务
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重启任务</DialogTitle>
            <DialogDescription>
              任务会回到进行中，历史交付、审批和验收记录会保留。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/40 px-3 py-2">
              <p className="font-medium">任务：{task.title}</p>
              <p className="mt-1 text-muted-foreground">
                {taskStatusLabels[task.status]} {"->"} {taskStatusLabels.IN_PROGRESS}
              </p>
            </div>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="填写重启原因"
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
            <Button type="button" disabled={loading} onClick={handleRestart}>
              {loading ? "重启中..." : "确认重启"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskDirectDeleteButton({
  taskId,
  redirectTo,
}: {
  taskId: string;
  redirectTo: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    if (!reason.trim()) {
      toast.error("请填写删除原因");
      return;
    }
    setLoading(true);
    try {
      await deleteTaskDirectly({ taskId, reason });
      toast.success("任务已删除");
      setOpen(false);
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "删除任务失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
        删除任务
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除任务</DialogTitle>
            <DialogDescription>
              任务会从业务列表隐藏，但交付、周报和动态记录会保留用于审计。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="填写删除原因"
            className="min-h-28"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={loading}
              onClick={handleDelete}
            >
              {loading ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskDeletionRequestButton({
  taskId,
  disabled,
}: {
  taskId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRequest() {
    if (!reason.trim()) {
      toast.error("请填写删除原因");
      return;
    }
    setLoading(true);
    try {
      await requestTaskDeletion({ taskId, reason });
      toast.success("删除申请已提交");
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交删除申请失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
        {disabled ? "删除待审核" : "申请删除"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>申请删除任务</DialogTitle>
            <DialogDescription>
              申请会通知项目负责人和对应管理角色，审核通过后任务会从业务列表隐藏。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="填写删除原因"
            className="min-h-28"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={loading} onClick={handleRequest}>
              {loading ? "提交中..." : "提交申请"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskDeletionRequestPanel({
  request,
  taskTitle,
  canManage,
  redirectTo,
}: {
  request: TaskDeletionRequestView;
  taskTitle: string;
  canManage: boolean;
  redirectTo: string;
}) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState<"APPROVED" | "REJECTED" | null>(null);

  async function handleReview(decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && !comment.trim()) {
      toast.error("驳回删除申请时请填写审核意见");
      return;
    }
    setLoading(decision);
    try {
      await reviewTaskDeletionRequest({
        requestId: request.id,
        decision,
        comment,
      });
      toast.success(decision === "APPROVED" ? "任务已删除" : "已驳回删除申请");
      if (decision === "APPROVED") {
        router.push(redirectTo);
      }
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "审核删除申请失败"));
    } finally {
      setLoading(null);
    }
  }

  return (
    <Card className="mt-4 border-orange-200 bg-orange-50/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">删除申请待审核</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          <span className="text-muted-foreground">任务：</span>
          {taskTitle}
        </p>
        <p>
          <span className="text-muted-foreground">申请人：</span>
          {request.requesterName}
        </p>
        <p className="whitespace-pre-wrap">
          <span className="text-muted-foreground">原因：</span>
          {request.reason}
        </p>
        <p className="text-xs text-muted-foreground">
          提交时间：{formatDateTime(request.createdAt)}
        </p>
        {canManage && (
          <div className="space-y-3 pt-2">
            <Textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="审核意见；驳回时必填"
              className="min-h-24 bg-background"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={!!loading}
                onClick={() => handleReview("APPROVED")}
              >
                {loading === "APPROVED" ? "处理中..." : "通过并删除"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!!loading}
                onClick={() => handleReview("REJECTED")}
              >
                {loading === "REJECTED" ? "处理中..." : "驳回申请"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TaskWeeklyReports({ reports }: { reports: TaskWeeklyReportView[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>周报历史</CardTitle>
      </CardHeader>
      <CardContent>
        {reports.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            暂无周报记录。
          </p>
        ) : (
          <div className="grid gap-3 text-sm md:grid-cols-2">
            {reports.map((report) => (
              <div key={report.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    周起始 {formatDate(report.weekStart)}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(report.submittedAt)}
                  </span>
                </div>
                <p className="mt-2">{report.progress}</p>
                {report.risks && (
                  <p className="mt-1 text-muted-foreground">风险：{report.risks}</p>
                )}
                {report.nextPlan && (
                  <p className="mt-1 text-muted-foreground">
                    下周：{report.nextPlan}
                  </p>
                )}
                {report.feishuDocUrl && (
                  <a
                    href={report.feishuDocUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex text-primary hover:underline"
                  >
                    周报文档
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TaskSidePanel({ task }: { task: TaskDetailView }) {
  const latestSubmission = task.submissions[0] ?? null;
  return (
    <aside className="min-w-0 space-y-5 xl:sticky xl:top-24 xl:self-start">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>任务上下文</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ContextLink
            label="所属项目"
            value={task.projectName}
            href={projectStageHref(task.projectId, task.stageId)}
          />
          <ContextLink
            label="所属阶段"
            value={task.stageName ?? "无阶段"}
            href={projectStageHref(task.projectId, task.stageId)}
          />
          {latestSubmission ? (
            <div className="rounded-md border px-3 py-2">
              <p className="font-medium">最近材料</p>
              <p className="mt-1 text-muted-foreground">
                {latestSubmission.submitterName} ·{" "}
                {formatDateTime(latestSubmission.submittedAt)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  href={latestSubmission.feishuDocUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ size: "xs", variant: "outline" })}
                >
                  交付文档
                  <ArrowUpRight className="h-3 w-3" />
                </a>
                {latestSubmission.keyDataUrl && (
                  <a
                    href={latestSubmission.keyDataUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({ size: "xs", variant: "outline" })}
                  >
                    关键数据
                    <ArrowUpRight className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-dashed px-3 py-4 text-muted-foreground">
              暂无交付材料。
            </p>
          )}
        </CardContent>
      </Card>

      <TaskActivityPanel task={task} />
    </aside>
  );
}

function ContextLink({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 hover:border-primary/30"
    >
      <span>
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="font-medium">{value}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

function TaskActivityPanel({ task }: { task: TaskDetailView }) {
  const [filter, setFilter] = useState<ActivityFilter>("ALL");
  const logsKey = useMemo(
    () =>
      `${task.hasMoreActivityLogs}:${task.activityLogs
        .map((log) => log.id)
        .join("|")}`,
    [task.activityLogs, task.hasMoreActivityLogs],
  );
  const [historyState, setHistoryState] = useState<ActivityHistoryState>({
    sourceKey: logsKey,
    extraLogs: [],
    hasMore: task.hasMoreActivityLogs,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const effectiveHistoryState =
    historyState.sourceKey === logsKey
      ? historyState
      : {
          sourceKey: logsKey,
          extraLogs: historyState.extraLogs,
          hasMore: historyState.hasMore || task.hasMoreActivityLogs,
        };
  const activityLogs = mergeActivityLogs(
    task.activityLogs,
    effectiveHistoryState.extraLogs,
  );
  const hasMoreActivityLogs = effectiveHistoryState.hasMore;

  const submissionById = useMemo(
    () => new Map(task.submissions.map((submission) => [submission.id, submission])),
    [task.submissions],
  );
  const filteredLogs = activityLogs.filter((log) => {
    if (filter === "ALL") return true;
    return getActivityType(log.action) === filter;
  });

  async function handleLoadMore() {
    const cursorId = activityLogs.at(-1)?.id;
    setLoadingMore(true);
    try {
      const page = await loadMoreTaskActivityLogs(task.id, cursorId);
      const nextLogs = page.logs.map((log) => ({
        id: log.id,
        action: log.action,
        actorName: log.actorName,
        payload: log.payload,
        createdAt: log.createdAt,
      }));
      setHistoryState({
        sourceKey: logsKey,
        extraLogs: mergeActivityLogs(effectiveHistoryState.extraLogs, nextLogs),
        hasMore: page.hasMore,
      });
    } catch (err) {
      toast.error(getActionErrorMessage(err, "加载历史动态失败"));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card data-testid="task-activity-panel">
      <CardHeader className="pb-3">
        <CardTitle>任务动态</CardTitle>
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
            近 7 天暂无任务动态。
          </p>
        ) : (
          <div className="max-h-[calc(100vh-28rem)] min-h-64 space-y-3 overflow-y-auto pr-1">
            {filteredLogs.map((log) => (
              <TaskActivityItem
                key={log.id}
                task={task}
                log={log}
                submissionById={submissionById}
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
  );
}

function TaskActivityItem({
  task,
  log,
  submissionById,
}: {
  task: TaskDetailView;
  log: TaskActivityLogView;
  submissionById: Map<string, TaskSubmissionView>;
}) {
  const payload = parseActivityPayload(log.payload);
  const submissionId = getPayloadString(payload.submissionId);
  const submission = submissionId ? submissionById.get(submissionId) : null;
  const rejectComment = getRejectComment(payload, submission);

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{log.actorName}</p>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatDateTime(log.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-muted-foreground">{activityLabel(log.action)}</p>
      <p className="mt-2 font-medium">任务：{task.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        阶段：{task.stageName ?? "无阶段"}
      </p>
      <ActivityDetails log={log} payload={payload} comment={rejectComment} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={projectStageHref(task.projectId, task.stageId)}
          className={buttonVariants({ size: "xs", variant: "outline" })}
        >
          查看项目阶段
        </Link>
        {submission && (
          <>
            <a
              href={submission.feishuDocUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ size: "xs", variant: "outline" })}
            >
              打开交付材料
              <ArrowUpRight className="h-3 w-3" />
            </a>
            {submission.keyDataUrl && (
              <a
                href={submission.keyDataUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: "xs", variant: "outline" })}
              >
                打开关键数据
                <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ActivityDetails({
  log,
  payload,
  comment,
}: {
  log: TaskActivityLogView;
  payload: Record<string, unknown>;
  comment: string | null;
}) {
  if (log.action === "task.status_changed" || log.action === "task.restarted") {
    const from = getPayloadString(payload.from);
    const to = getPayloadString(payload.to);
    if (from && to && isTaskStatus(from) && isTaskStatus(to)) {
      const reason = getPayloadString(payload.reason);
      return (
        <div className="mt-2 space-y-1 rounded-md bg-muted/50 px-2 py-2 text-xs text-muted-foreground">
          <p>
            {taskStatusLabels[from]} {"->"} {taskStatusLabels[to]}
          </p>
          {reason && <p>原因：{reason}</p>}
        </div>
      );
    }
  }

  const changes = Array.isArray(payload.changes)
    ? payload.changes.filter((change): change is string => typeof change === "string")
    : [];
  if (changes.length > 0) {
    return (
      <ul className="mt-2 space-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {changes.map((change, index) => (
          <li key={`${change}-${index}`}>{change}</li>
        ))}
      </ul>
    );
  }

  if (comment) {
    return (
      <p className="mt-2 rounded-md bg-destructive/5 px-2 py-1 text-xs text-destructive">
        驳回理由：{comment}
      </p>
    );
  }

  const riskNote = getPayloadString(payload.riskNote);
  if (riskNote) {
    return (
      <p className="mt-2 rounded-md bg-destructive/5 px-2 py-1 text-xs text-destructive">
        风险：{riskNote}
      </p>
    );
  }

  const reason = getPayloadString(payload.reason);
  const reviewComment = getPayloadString(payload.reviewComment);
  if (reason || reviewComment) {
    return (
      <div className="mt-2 space-y-1 rounded-md bg-muted/50 px-2 py-2 text-xs text-muted-foreground">
        {reason && <p>原因：{reason}</p>}
        {reviewComment && <p>审核意见：{reviewComment}</p>}
      </div>
    );
  }

  const assignees = Array.isArray(payload.assignees)
    ? payload.assignees.filter((name): name is string => typeof name === "string")
    : [];
  if (assignees.length > 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        负责人：{assignees.join("、")}
      </p>
    );
  }

  return null;
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
    <Button type="button" disabled={loading} onClick={handleStart}>
      <Play className="h-4 w-4" />
      开始任务
    </Button>
  );
}

function ArchiveTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleArchive() {
    setLoading(true);
    try {
      await archiveTask(taskId);
      toast.success("已归档");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "归档失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant="outline" disabled={loading} onClick={handleArchive}>
      <Archive className="h-4 w-4" />
      归档任务
    </Button>
  );
}

function TaskStatusBadges({ task }: { task: TaskDetailView }) {
  return (
    <>
      <Badge variant={task.status === "PROJECT_CANCELED" ? "destructive" : "default"}>
        {taskStatusLabels[task.status]}
      </Badge>
      {task.isOverdue && <Badge variant="destructive">逾期</Badge>}
    </>
  );
}

function getActivityType(action: string): ActivityFilter {
  if (
    action === "task.status_changed" ||
    action === "task.updated" ||
    action === "task.archived" ||
    action === "task.deleted" ||
    action === "task.restarted" ||
    action === "task.project_canceled" ||
    action === "task.creation_approved"
  ) return "STATUS";
  if (action === "task.delivery_submitted") return "DELIVERY";
  if (
    action === "task.approved" ||
    action === "task.rejected" ||
    action === "task.creation_requested" ||
    action === "task.creation_rejected" ||
    action === "task.delete_requested" ||
    action === "task.delete_rejected"
  ) return "REVIEW";
  if (action === "task.weekly_report") return "WEEKLY";
  if (action === "task.risk_synced") return "RISK";
  return "STATUS";
}

function activityLabel(action: string): string {
  const labels: Record<string, string> = {
    "task.created": "创建了任务",
    "task.updated": "更新了任务信息",
    "task.status_changed": "更新了任务状态",
    "task.restarted": "重启了任务",
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
    "task.delete_requested": "申请删除任务",
    "task.delete_rejected": "驳回了删除申请",
    "task.deleted": "删除了任务",
    "task.reminded": "发送了任务催促提醒",
  };
  return labels[action] ?? action;
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

function getRejectComment(
  payload: Record<string, unknown>,
  submission: TaskSubmissionView | null | undefined,
): string | null {
  const payloadComment = getPayloadString(payload.comment);
  if (payloadComment) return payloadComment;
  const rejection = submission?.approvals.find(
    (approval) => approval.decision === "REJECTED" && approval.comment,
  );
  return rejection?.comment ?? null;
}

function isTaskStatus(value: string): value is TaskStatus {
  return value in taskStatusLabels;
}

function projectStageHref(projectId: string, stageId: string | null): string {
  return stageId
    ? routes.progress.projectStage(projectId, stageId)
    : routes.progress.project(projectId);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN");
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
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
