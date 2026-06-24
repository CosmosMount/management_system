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
import { ArchivedTaskDeleteButton } from "@/components/admin-delete-actions";
import { TaskForm } from "@/components/progress/task-form";
import { loadMoreTaskActivityLogs } from "@/app/actions/progress/activityLogs";
import { BackLink } from "@/components/back-link";
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
import { updateTaskStatus, archiveTask } from "@/app/actions/progress/updateTask";
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
  stageId: string | null;
  stageName: string | null;
  team: string;
  techGroup: string;
  metrics: string;
  dueAt: string;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
  riskNote: string;
  submissions: TaskSubmissionView[];
  weeklyReports: TaskWeeklyReportView[];
  activityLogs: TaskActivityLogView[];
  hasMoreActivityLogs: boolean;
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
  isAssignee: boolean;
  canApprove: boolean;
  canManage: boolean;
  isSuperAdmin?: boolean;
};

type UserOption = { openId: string; name: string; avatar?: string | null };
type StageOption = { id: string; name: string };

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
  isAssignee,
  canApprove,
  canManage,
  isSuperAdmin = false,
}: Props) {
  const projectHref = projectStageHref(task.projectId, task.stageId);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const canEdit =
    canManage &&
    task.status !== "ARCHIVED" &&
    task.projectStatus !== "COMPLETED" &&
    task.projectStatus !== "CANCELED";

  return (
    <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink href={projectHref} label={`返回项目 ${task.projectName}`} />

      <TaskOverview
        task={task}
        isAssignee={isAssignee}
        canManage={canManage}
        canEdit={canEdit}
        isSuperAdmin={isSuperAdmin}
        onOpenEdit={() => setTaskDialogOpen(true)}
      />

      <div className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <TaskActionsPanel
            taskId={task.id}
            status={task.status}
            isAssignee={isAssignee}
            canApprove={canApprove}
            canManage={canManage}
            needsOfflineConfirmation={task.needsOfflineConfirmation}
            needsWeeklyReport={task.needsWeeklyReport}
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
            initialTask={{
              id: task.id,
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
  isSuperAdmin,
  onOpenEdit,
}: {
  task: TaskDetailView;
  isAssignee: boolean;
  canManage: boolean;
  canEdit: boolean;
  isSuperAdmin: boolean;
  onOpenEdit: () => void;
}) {
  const canStart = task.status === "TODO" && (isAssignee || canManage);
  const canArchive = task.status === "COMPLETED" && canManage;

  return (
    <Card>
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
            <OverviewItem label="指标" value={task.metrics || "未填写"} />
          </dl>
          {task.riskNote && (
            <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              最新风险：{task.riskNote}
            </p>
          )}
        </div>

        {(canEdit || canStart || canArchive || isSuperAdmin) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canEdit && (
              <Button type="button" variant="outline" onClick={onOpenEdit}>
                <Pencil className="h-4 w-4" />
                编辑任务
              </Button>
            )}
            {canStart && <StartTaskButton taskId={task.id} />}
            {canArchive && <ArchiveTaskButton taskId={task.id} />}
            <ArchivedTaskDeleteButton
              taskId={task.id}
              status={task.status}
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
      : { sourceKey: logsKey, extraLogs: [], hasMore: task.hasMoreActivityLogs };
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
    <Card>
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
  if (log.action === "task.status_changed") {
    const from = getPayloadString(payload.from);
    const to = getPayloadString(payload.to);
    if (from && to && isTaskStatus(from) && isTaskStatus(to)) {
      return (
        <p className="mt-2 text-xs text-muted-foreground">
          {taskStatusLabels[from]} {"->"} {taskStatusLabels[to]}
        </p>
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
      <Badge>{taskStatusLabels[task.status]}</Badge>
      {task.isOverdue && <Badge variant="destructive">逾期</Badge>}
    </>
  );
}

function getActivityType(action: string): ActivityFilter {
  if (
    action === "task.status_changed" ||
    action === "task.updated" ||
    action === "task.archived"
  ) return "STATUS";
  if (action === "task.delivery_submitted") return "DELIVERY";
  if (action === "task.approved" || action === "task.rejected") return "REVIEW";
  if (action === "task.weekly_report") return "WEEKLY";
  if (action === "task.risk_synced") return "RISK";
  return "STATUS";
}

function activityLabel(action: string): string {
  const labels: Record<string, string> = {
    "task.created": "创建了任务",
    "task.updated": "更新了任务信息",
    "task.status_changed": "更新了任务状态",
    "task.delivery_submitted": "提交了任务交付",
    "task.approved": "通过了任务验收",
    "task.rejected": "驳回了任务验收",
    "task.weekly_report": "提交了任务周报",
    "task.risk_synced": "同步了任务风险",
    "task.archived": "归档了任务",
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
