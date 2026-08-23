"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  activateTask,
  deleteTaskDraft,
  updateActiveTask,
} from "@/app/actions/project-management/tasks";
import {
  approveRevision,
  cancelRevision,
  rejectRevision,
} from "@/app/actions/project-management/revisions";
import {
  approveMilestoneReview,
  rejectMilestoneReview,
  requireMilestoneRevision,
  submitMilestoneForReview,
} from "@/app/actions/project-management/milestones";
import {
  approveTerminationReview,
  rejectTerminationReview,
  requireTerminationRevision,
  submitTerminationForReview,
} from "@/app/actions/project-management/terminations";
import {
  TaskPlanNodeNavigator,
  type TaskPlanNavigatorNode,
} from "@/components/project-management/task-plan-node-navigator";
import { TaskMemberRolePicker } from "@/components/project-management/task-member-role-picker";
import { TaskSelect } from "@/components/project-management/task-picker";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";

const TASK_DETAIL_START_ID = "task-detail-start";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import type {
  ProjectManagementActionFailure,
  ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  fieldErrorsFullyHandled,
  firstFieldErrorMessage,
} from "@/lib/project-management/field-errors";
import {
  formatDateTime,
  taskNodeStatusLabels,
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskLifecycleViews } from "@/lib/project-management/queries/task-lifecycle-queries";
import type {
  PlanVersionSummary,
  TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import type { TaskPendingApproval } from "@/lib/project-management/task-approval-gate";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ProjectSelect } from "@/components/project-management/project-picker";
import {
  CollaborationLeftSidebar,
  CollaborationRightSidebar,
  CreateRiskCard,
  type CollaborationInitialData,
} from "@/components/project-management/collaboration-panels";

type Notice = { kind: "success" | "error" | "info"; message: string } | null;
type ActiveTaskMemberRole = "OWNER" | "PARTICIPANT";
type RunAction = (
  action: () => Promise<ProjectManagementActionResult<unknown>>,
  successMessage: string,
  onSuccess?: (data: unknown) => void,
  onFailure?: (error: ProjectManagementActionFailure["error"]) => boolean | void,
) => Promise<void>;
type ApprovalGate = {
  pendingApproval: TaskPendingApproval | null;
  pendingApprovalConflict: boolean;
};

export function TaskWorkbench({
  workspace,
  lifecycle,
  people,
  taskOptions,
  projectOptions,
  collaboration,
  timeCanvasModel,
  timelineWindow,
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  projectOptions: Array<{ id: string; name: string; avatarPath: string | null }>;
  collaboration: CollaborationInitialData;
  timeCanvasModel: TimeCanvasModel;
  timelineWindow: {
    focusId: string | null;
    centerMs?: number;
    scale?: "WEEK" | "MONTH" | "QUARTER" | "YEAR";
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editSession, setEditSession] = useState(0);
  const [lockVersionState, setLockVersionState] = useState({
    server: workspace.task.lockVersion,
    current: workspace.task.lockVersion,
  });
  const lockVersion = lockVersionState.server === workspace.task.lockVersion
    ? lockVersionState.current
    : workspace.task.lockVersion;
  const serverApprovalGateKey = approvalGateKey(workspace);
  const [approvalGateState, setApprovalGateState] = useState({
    server: serverApprovalGateKey,
    current: {
      pendingApproval: workspace.pendingApproval,
      pendingApprovalConflict: workspace.pendingApprovalConflict,
    } satisfies ApprovalGate,
  });
  const approvalGate = approvalGateState.server === serverApprovalGateKey
    ? approvalGateState.current
    : {
        pendingApproval: workspace.pendingApproval,
        pendingApprovalConflict: workspace.pendingApprovalConflict,
      };
  const setApprovalGate = (next: ApprovalGate) => {
    setApprovalGateState({ server: serverApprovalGateKey, current: next });
  };
  const currentWorkspace: TaskWorkspace = {
    ...workspace,
    task: { ...workspace.task, lockVersion },
    ...approvalGate,
  };
  const task = currentWorkspace.task;
  const approvalBlocked =
    approvalGate.pendingApprovalConflict || approvalGate.pendingApproval !== null;
  const termination = currentWorkspace.currentPlan.nodes.find(
    (entry) => entry.termination,
  );
  const defaultNodeId = task.activeMilestoneNodeId ??
    (termination?.status === "ACTIVE" ? termination.nodeId : TASK_DETAIL_START_ID);
  const requestedInitialFocusId = timelineWindow.focusId;
  const initialNodeId = requestedInitialFocusId && (
    requestedInitialFocusId === TASK_DETAIL_START_ID ||
    workspace.currentPlan.nodes.some((node) => node.nodeId === requestedInitialFocusId)
  )
    ? requestedInitialFocusId
    : defaultNodeId;
  const [requestedNodeId, setRequestedNodeId] = useState(initialNodeId);
  const externalTimelineFocusRef = useRef(requestedInitialFocusId);
  useEffect(() => {
    if (externalTimelineFocusRef.current === requestedInitialFocusId) return;
    const timer = window.setTimeout(() => {
      externalTimelineFocusRef.current = requestedInitialFocusId;
      setRequestedNodeId(initialNodeId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialNodeId, requestedInitialFocusId]);
  const selectedNodeId =
    requestedNodeId === TASK_DETAIL_START_ID ||
    workspace.currentPlan.nodes.some((node) => node.nodeId === requestedNodeId)
      ? requestedNodeId
      : initialNodeId;
  const navigatorNodes = buildTaskNavigatorNodes(currentWorkspace);
  const selectedNode = currentWorkspace.currentPlan.nodes.find(
    (entry) => entry.nodeId === selectedNodeId,
  );
  const openRevision = lifecycle.revisions.find(
    (revision) =>
      revision.status === "PENDING_APPROVAL" || revision.status === "REJECTED",
  );
  const canEditActive =
    task.status === "ACTIVE" &&
    (workspace.permissions.canUpdateMetadata || workspace.permissions.canManageMembers);

  const runAction: RunAction = async (
    action,
    successMessage,
    onSuccess,
    onFailure,
  ) => {
    if (busy) return;
    setBusy(true);
    setNotice({ kind: "info", message: "正在保存…" });
    try {
      const result = await action();
      if (!result.ok) {
        const fieldErrorHandled = onFailure?.(result.error) === true;
        setNotice(fieldErrorHandled ? null : {
          kind: "error",
          message:
            result.error.code === "STALE_TASK"
              ? `${result.error.message}。正在刷新服务器最新状态。`
              : result.error.message,
        });
        if (result.error.code === "STALE_TASK") router.refresh();
        return;
      }
      const nextLockVersion = actionLockVersion(result.data);
      if (nextLockVersion !== null) {
        setLockVersionState({
          server: workspace.task.lockVersion,
          current: nextLockVersion,
        });
      }
      setNotice({ kind: "success", message: successMessage });
      onSuccess?.(result.data);
      router.refresh();
    } catch {
      setNotice({
        kind: "error",
        message: "网络或服务暂时不可用，未保存任何本地输入。",
      });
    } finally {
      setBusy(false);
    }
  };

  const selectTerminal = () => {
    if (!termination) return;
    setRequestedNodeId(termination.nodeId);
    window.setTimeout(
      () => document.getElementById("task-selected-node-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  };

  return (
    <div
      className="min-w-0 space-y-5"
      data-testid="task-workbench-v2"
      data-server-lock-version={workspace.task.lockVersion}
    >
      <section
        className="rounded-xl border border-border bg-card p-5"
        data-testid="task-overview"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={routes.progress.tasks} className="text-sm text-primary hover:underline">
                ← 全部 Task
              </Link>
              <Badge>{taskStatusLabels[task.status]}</Badge>
              <Badge variant="secondary">{taskPriorityLabels[task.priority]}</Badge>
              <Badge variant="outline">计划 v{workspace.currentPlan.versionNo}</Badge>
              {task.project && (
                <Link href={routes.progress.projectDetail(task.project.id)} className="text-sm font-medium text-primary hover:underline">
                  Project：{task.project.name}
                </Link>
              )}
            </div>
            <h1 className="mt-3 break-words text-2xl font-semibold">{task.title}</h1>
            {task.description && (
              <p className="mt-2 max-w-4xl whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {task.description}
              </p>
            )}
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <OverviewItem label="负责人" value={memberNames(workspace, "OWNER")} />
              <OverviewItem label="参与人员" value={memberNames(workspace, "PARTICIPANT")} />
              <OverviewItem label="车组/技术组" value={`${task.team} / ${task.techGroup}`} />
              <OverviewItem label="当前节点" value={currentNodeLabel(currentWorkspace)} />
              <OverviewItem label="计划开始" value={formatDateTime(workspace.currentPlan.plannedStartAt)} />
              <OverviewItem
                label="计划结束"
                value={formatDateTime(termination?.termination?.plannedAt ?? null)}
              />
              <OverviewItem
                label="关联 Task"
                value={
                  task.relatedTaskId
                    ? taskOptions.find((option) => option.id === task.relatedTaskId)?.title ?? "已关联"
                    : "未关联"
                }
              />
              <OverviewItem
                label="所属 Project"
                value={task.project ? task.project.name : "未设置"}
              />
            </dl>
            {workspace.currentPlan.chronologyCompatibilityIssues.length > 0 && (
              <p className="mt-3 text-sm text-amber-700">
                当前计划包含旧版时间顺序；可继续只读或结束 Task，新建 Draft/Revision 前必须调整为严格递增。
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {task.status === "DRAFT" && workspace.permissions.canUpdateMetadata && (
              <Link
                href={routes.progress.taskEdit(task.id)}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                编辑 Task
              </Link>
            )}
            {task.status === "DRAFT" && workspace.permissions.canActivate && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("确认激活 Task？激活后计划语义只能通过 Revision 修改。")) return;
                  void runAction(
                    () => activateTask({ taskId: task.id, expectedLockVersion: lockVersion }),
                    "Task 已激活。",
                  );
                }}
              >
                激活 Task
              </Button>
            )}
            {task.status === "DRAFT" && workspace.permissions.canDeleteDraft && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      "确定删除这个 Task 草稿？\n\n删除后将从 Task 和 Project 列表中移除，审计记录仍会保留。",
                    )
                  ) {
                    return;
                  }
                  void runAction(
                    () =>
                      deleteTaskDraft({
                        taskId: task.id,
                        expectedLockVersion: lockVersion,
                      }),
                    "Task 草稿已删除。",
                    () => router.replace(routes.progress.tasks),
                  );
                }}
              >
                删除草稿
              </Button>
            )}
            {canEditActive && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setNotice(null);
                  setEditSession((current) => current + 1);
                  setEditOpen(true);
                }}
              >
                修改 Task 基本信息
              </Button>
            )}
            {task.status === "ACTIVE" && workspace.permissions.canCreateRevision && (
              approvalBlocked || openRevision ? (
                <Button type="button" disabled title="当前 Task 已有待处理事项">
                  发起 Revision
                </Button>
              ) : (
                <Link href={routes.progress.taskRevisionNew(task.id)} className={cn(buttonVariants())}>
                  发起 Revision
                </Link>
              )
            )}
            {task.status === "ACTIVE" &&
              workspace.permissions.canSubmitTerminationReview && termination && (
              <Button
                type="button"
                variant="destructive"
                disabled={approvalBlocked}
                title={approvalBlocked ? "当前 Task 已有待审批事项" : undefined}
                onClick={selectTerminal}
              >
                申请结束 Task
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(window.location.href).then(
                  () => setNotice({ kind: "success", message: "Task 链接已复制。" }),
                  () => setNotice({ kind: "error", message: "浏览器拒绝复制，请手动复制地址栏链接。" }),
                )
              }
            >
              复制链接
            </Button>
          </div>
        </div>
      </section>

      {approvalBlocked && (
        <section
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="status"
          data-testid="task-approval-gate"
        >
          {approvalGate.pendingApprovalConflict
            ? "当前 Task 存在多条待审批记录，相关提交与结束操作已暂停，请联系管理员处理。"
            : approvalGate.pendingApproval?.kind === "MILESTONE_REVIEW"
              ? `Milestone「${approvalGate.pendingApproval.title}」正在等待审批。`
              : approvalGate.pendingApproval?.kind === "REVISION"
                ? `Revision「${approvalGate.pendingApproval.title || "未命名修订"}」正在等待审批。`
                : `Terminal「${approvalGate.pendingApproval?.title || "结束节点"}」的结束申请正在等待审批。`}
        </section>
      )}

      {notice && (
        <p
          className={cn(
            "break-words rounded-lg px-3 py-2 text-sm",
            notice.kind === "error" && "bg-destructive/10 text-destructive",
            notice.kind === "success" && "bg-emerald-50 text-emerald-800",
            notice.kind === "info" && "bg-muted text-muted-foreground",
          )}
          role={notice.kind === "error" ? "alert" : "status"}
          data-testid="task-global-notice"
        >
          {notice.message}
        </p>
      )}

      <TaskDetailTimeline
        workspace={currentWorkspace}
        nodes={navigatorNodes}
        selectedId={selectedNodeId}
        onSelect={(nodeId) => {
          const node = navigatorNodes.find((entry) => entry.id === nodeId);
          const atMs = node ? Date.parse(node.at) : Number.NaN;
          if (Number.isFinite(atMs) && (atMs < timeCanvasModel.range.startMs || atMs >= timeCanvasModel.range.endMs)) {
            const url = new URL(window.location.href);
            url.searchParams.set("center", new Date(atMs).toISOString());
            url.searchParams.set("focus", nodeId);
            router.push(`${url.pathname}?${url.searchParams.toString()}`);
            return;
          }
          setRequestedNodeId(nodeId);
        }}
        model={timeCanvasModel}
        people={people}
        taskOptions={taskOptions}
        timelineWindow={timelineWindow}
      />

      <div
        className="grid min-w-0 gap-5 xl:grid-cols-[300px_minmax(0,1fr)_300px]"
        data-testid="task-detail-lower-grid"
      >
        <main
          className="min-w-0 space-y-4 xl:col-start-2 xl:row-start-1"
          data-testid="task-detail-main-column"
        >
          {openRevision && (
            <OpenRevisionPanel
              taskId={task.id}
              revision={openRevision}
              busy={busy}
              approvalBlocked={approvalBlocked}
              runAction={runAction}
              onResolved={() => {
                const pending = approvalGate.pendingApproval;
                if (
                  !approvalGate.pendingApprovalConflict &&
                  pending?.kind === "REVISION" &&
                  pending.id === openRevision.id
                ) {
                  setApprovalGate({ pendingApproval: null, pendingApprovalConflict: false });
                }
              }}
            />
          )}

          <section
            id="task-selected-node-detail"
            className="scroll-mt-24 rounded-xl border border-border bg-card p-4 sm:p-5"
          >
            <SelectedNodeDetail
              workspace={currentWorkspace}
              lifecycle={lifecycle}
              selectedNode={selectedNode}
              selectedNodeId={selectedNodeId}
              busy={busy}
              runAction={runAction}
              approvalBlocked={approvalBlocked}
              onApprovalResolved={(reviewId) => {
                const pending = approvalGate.pendingApproval;
                if (
                  !approvalGate.pendingApprovalConflict &&
                  pending?.kind === "MILESTONE_REVIEW" &&
                  pending.id === reviewId
                ) {
                  setApprovalGate({ pendingApproval: null, pendingApprovalConflict: false });
                }
              }}
              onMilestoneSubmitted={(reviewId, title) =>
                setApprovalGate({
                  pendingApproval: {
                    kind: "MILESTONE_REVIEW",
                    id: reviewId,
                    title,
                    submittedAt: new Date().toISOString(),
                  },
                  pendingApprovalConflict: false,
                })
              }
              onTerminationReviewResolved={(reviewId) => {
                const pending = approvalGate.pendingApproval;
                if (
                  !approvalGate.pendingApprovalConflict &&
                  pending?.kind === "TERMINATION_REVIEW" &&
                  pending.id === reviewId
                ) {
                  setApprovalGate({
                    pendingApproval: null,
                    pendingApprovalConflict: false,
                  });
                }
              }}
              onTerminationSubmitted={(reviewId, title) =>
                setApprovalGate({
                  pendingApproval: {
                    kind: "TERMINATION_REVIEW",
                    id: reviewId,
                    title,
                    submittedAt: new Date().toISOString(),
                  },
                  pendingApprovalConflict: false,
                })
              }
            />
          </section>

          <CreateRiskCard
            targetType="TASK"
            targetId={task.id}
            canCreate={collaboration.capabilities.canCreateRisk}
          />
        </main>

        <aside
          className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1"
          data-testid="task-detail-left-column"
        >
          <CollaborationLeftSidebar data={collaboration} />
        </aside>

        <aside
          className="min-w-0 xl:col-start-3 xl:row-start-1"
          data-testid="task-detail-right-column"
        >
          <CollaborationRightSidebar data={collaboration} />
        </aside>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>修改 Task 基本信息</DialogTitle>
            <DialogDescription>
              基本信息与成员通过一次事务统一保存，并继续使用各自的权限和并发校验。
            </DialogDescription>
          </DialogHeader>
          <ActiveTaskEditor
            key={`${task.id}:${editSession}`}
            workspace={currentWorkspace}
            people={people}
            taskOptions={taskOptions}
            projectOptions={projectOptions}
            busy={busy}
            runAction={runAction}
            notice={notice}
            onSaved={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SelectedNodeDetail({
  workspace,
  lifecycle,
  selectedNode,
  selectedNodeId,
  busy,
  runAction,
  approvalBlocked,
  onApprovalResolved,
  onMilestoneSubmitted,
  onTerminationReviewResolved,
  onTerminationSubmitted,
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  selectedNode: PlanVersionSummary["nodes"][number] | undefined;
  selectedNodeId: string;
  busy: boolean;
  runAction: RunAction;
  approvalBlocked: boolean;
  onApprovalResolved: (reviewId: string) => void;
  onMilestoneSubmitted: (reviewId: string, title: string) => void;
  onTerminationReviewResolved: (reviewId: string) => void;
  onTerminationSubmitted: (reviewId: string, title: string) => void;
}) {
  if (selectedNodeId === TASK_DETAIL_START_ID || !selectedNode) {
    return (
      <div>
        <h2 className="text-lg font-semibold">Start</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          计划开始：{formatDateTime(workspace.currentPlan.plannedStartAt)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Current Plan v{workspace.currentPlan.versionNo} 的起点，只读展示。
        </p>
      </div>
    );
  }
  if (selectedNode.milestone) {
    return (
      <MilestoneDetail
        key={selectedNode.nodeId}
        workspace={workspace}
        lifecycle={lifecycle}
        node={selectedNode}
        busy={busy}
        runAction={runAction}
        approvalBlocked={approvalBlocked}
        onApprovalResolved={onApprovalResolved}
        onMilestoneSubmitted={onMilestoneSubmitted}
      />
    );
  }
  if (selectedNode.revision) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Revision</h2>
          <Badge>{revisionStatusLabel(selectedNode.revision.status)}</Badge>
          <Badge variant="outline">第 {selectedNode.revision.reviewRound} 轮</Badge>
        </div>
        <OverviewItem label="Revision 名称" value={selectedNode.revision.reason} />
        <OverviewItem
          label="Revision 详细内容"
          value={selectedNode.businessDescription || "无"}
        />
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <OverviewItem label="Revision 时间" value={formatDateTime(selectedNode.revision.revisionAt)} />
          <OverviewItem label="审批时间" value={formatDateTime(selectedNode.revision.reviewedAt)} />
          <OverviewItem label="生效时间" value={formatDateTime(selectedNode.revision.effectiveAt)} />
          <OverviewItem label="审批意见" value={selectedNode.revision.reviewComment || "无"} />
        </dl>
        <p className="text-xs text-muted-foreground">Revision 是时间标记，不形成阶段。</p>
      </div>
    );
  }
  if (selectedNode.termination) {
    const latestTerminationReview = lifecycle.terminationReviews.find(
      (review) => review.taskNodeId === selectedNode.nodeId,
    );
    return (
      <TerminationDetail
        key={`${selectedNode.nodeId}:${latestTerminationReview?.id ?? "none"}:${latestTerminationReview?.result ?? "none"}`}
        workspace={workspace}
        lifecycle={lifecycle}
        node={selectedNode}
        busy={busy}
        runAction={runAction}
        approvalBlocked={approvalBlocked}
        onReviewResolved={onTerminationReviewResolved}
        onSubmitted={onTerminationSubmitted}
      />
    );
  }
  return <p className="text-sm text-muted-foreground">该节点没有可展示的详情。</p>;
}

function MilestoneDetail({
  workspace,
  lifecycle,
  node,
  busy,
  runAction,
  approvalBlocked,
  onApprovalResolved,
  onMilestoneSubmitted,
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  node: PlanVersionSummary["nodes"][number];
  busy: boolean;
  runAction: RunAction;
  approvalBlocked: boolean;
  onApprovalResolved: (reviewId: string) => void;
  onMilestoneSubmitted: (reviewId: string, title: string) => void;
}) {
  const milestone = node.milestone!;
  const pendingReview = lifecycle.reviews.find(
    (review) =>
      review.taskNodeId === node.nodeId &&
      review.result === "PENDING" &&
      review.revokedAt === null,
  );
  const active = workspace.task.activeMilestoneNodeId === node.nodeId;
  const [evidenceKind, setEvidenceKind] = useState<"TEXT" | "LINK">("TEXT");
  const [evidence, setEvidence] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [comment, setComment] = useState("");
  const [evidenceError, setEvidenceError] = useState("");
  const [evidenceNoteError, setEvidenceNoteError] = useState("");
  const [commentError, setCommentError] = useState("");
  const reviewKey = useRef<string | null>(null);

  const submitDecision = (decision: "APPROVE" | "REJECT" | "REVISION") => {
    if (decision !== "APPROVE" && !comment.trim()) {
      setCommentError("驳回或要求修订时必须填写说明");
      requestAnimationFrame(() => document.getElementById(`milestone-review-comment-${pendingReview?.id ?? node.nodeId}`)?.focus());
      return;
    }
    if (!pendingReview) return;
    const action = decision === "APPROVE"
      ? () => approveMilestoneReview({ reviewId: pendingReview.id, comment })
      : decision === "REJECT"
        ? () => rejectMilestoneReview({ reviewId: pendingReview.id, comment })
        : () => requireMilestoneRevision({ reviewId: pendingReview.id, comment });
    void runAction(
      action,
      decision === "APPROVE" ? "验收已通过。" : decision === "REJECT" ? "验收已驳回。" : "已要求修订。",
      () => onApprovalResolved(pendingReview.id),
      (error) => {
        const message = firstFieldError(error, ["comment"]);
        if (!message) return false;
        setCommentError(message);
        requestAnimationFrame(() => document.getElementById(`milestone-review-comment-${pendingReview.id}`)?.focus());
        return fieldErrorsFullyHandled(error.fieldErrors, ["comment"]);
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{milestone.goal}</h2>
        <Badge>{taskNodeStatusLabels[node.status]}</Badge>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <OverviewItem label="计划完成" value={formatDateTime(milestone.expectedCompletedAt)} />
        <OverviewItem label="完成条件" value={milestone.completionCriteria} />
        <OverviewItem label="验收要求" value={milestone.reviewRequirements} />
        <OverviewItem label="业务说明" value={node.businessDescription || "无"} />
      </dl>

      {active && workspace.permissions.canSubmitMilestoneReview && !pendingReview && (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="font-medium">提交 Milestone 验收</h3>
          <div className="flex flex-wrap gap-4 text-sm">
            <label><input type="radio" checked={evidenceKind === "TEXT"} disabled={approvalBlocked} onChange={() => { setEvidenceKind("TEXT"); setEvidenceError(""); setEvidenceNoteError(""); }} /> 文本证据</label>
            <label><input type="radio" checked={evidenceKind === "LINK"} disabled={approvalBlocked} onChange={() => { setEvidenceKind("LINK"); setEvidenceError(""); setEvidenceNoteError(""); }} /> 链接证据</label>
          </div>
          <Field label={evidenceKind === "TEXT" ? "文本证据" : "证据链接"}>
            {evidenceKind === "TEXT" ? (
              <Textarea id={`milestone-evidence-${node.nodeId}`} value={evidence} disabled={approvalBlocked} maxLength={4_000} aria-invalid={Boolean(evidenceError)} aria-describedby={evidenceError ? `milestone-evidence-${node.nodeId}-error` : undefined} onChange={(event) => { setEvidence(event.target.value); setEvidenceError(""); }} />
            ) : (
              <Input id={`milestone-evidence-${node.nodeId}`} type="url" value={evidence} disabled={approvalBlocked} aria-invalid={Boolean(evidenceError)} aria-describedby={evidenceError ? `milestone-evidence-${node.nodeId}-error` : undefined} onChange={(event) => { setEvidence(event.target.value); setEvidenceError(""); }} />
            )}
            <FieldError id={`milestone-evidence-${node.nodeId}-error`} messages={evidenceError} className="mt-1.5" />
          </Field>
          {evidenceKind === "LINK" && (
            <Field label="链接说明"><Input id={`milestone-evidence-note-${node.nodeId}`} value={evidenceNote} disabled={approvalBlocked} maxLength={1_000} aria-invalid={Boolean(evidenceNoteError)} aria-describedby={evidenceNoteError ? `milestone-evidence-note-${node.nodeId}-error` : undefined} onChange={(event) => { setEvidenceNote(event.target.value); setEvidenceNoteError(""); }} /><FieldError id={`milestone-evidence-note-${node.nodeId}-error`} messages={evidenceNoteError} className="mt-1.5" /></Field>
          )}
          <Button
            type="button"
            disabled={busy || approvalBlocked}
            title={approvalBlocked ? "当前 Task 已有待审批事项" : undefined}
            onClick={() => {
              if (evidenceKind === "LINK" && evidence.trim()) {
                try {
                  new URL(evidence);
                } catch {
                  setEvidenceError("请输入有效链接");
                  requestAnimationFrame(() => document.getElementById(`milestone-evidence-${node.nodeId}`)?.focus());
                  return;
                }
              }
              reviewKey.current ??= `review-workbench:${globalThis.crypto.randomUUID()}`;
              void runAction(
                () => submitMilestoneForReview({
                  milestoneNodeId: node.nodeId,
                  idempotencyKey: reviewKey.current,
                  evidences: evidence
                    ? [evidenceKind === "TEXT"
                        ? { kind: "TEXT", note: evidence, sortOrder: 0 }
                        : { kind: "LINK", externalUrl: evidence, note: evidenceNote, sortOrder: 0 }]
                    : [],
                }),
                "Milestone 已提交验收。",
                (data) => {
                  reviewKey.current = null;
                  const reviewId = recordString(data, "reviewId");
                  if (reviewId) onMilestoneSubmitted(reviewId, milestone.goal);
                },
                (error) => {
                  if (error.code === "STATE_CONFLICT") reviewKey.current = null;
                  const evidenceMessage = firstFieldError(
                    error,
                    evidenceKind === "TEXT"
                      ? ["evidences.0.note", "evidences"]
                      : ["evidences.0.externalUrl", "evidences"],
                  );
                  const noteMessage = evidenceKind === "LINK"
                    ? firstFieldError(error, ["evidences.0.note"])
                    : undefined;
                  if (!evidenceMessage && !noteMessage) return false;
                  setEvidenceError(evidenceMessage ?? "");
                  setEvidenceNoteError(noteMessage ?? "");
                  requestAnimationFrame(() => document.getElementById(
                    evidenceMessage
                      ? `milestone-evidence-${node.nodeId}`
                      : `milestone-evidence-note-${node.nodeId}`,
                  )?.focus());
                  return fieldErrorsFullyHandled(error.fieldErrors, [
                    "evidences.0.note",
                    "evidences.0.externalUrl",
                    "evidences",
                  ]);
                },
              );
            }}
          >
            提交验收
          </Button>
        </div>
      )}

      {pendingReview && (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="font-medium">当前待审批验收</h3>
          <p className="text-sm text-muted-foreground">
            {pendingReview.submittedBy} 提交于 {formatDateTime(pendingReview.createdAt)}
          </p>
          {pendingReview.capabilities.canReview && (
            <>
              <Field label="审批说明"><Textarea id={`milestone-review-comment-${pendingReview.id}`} value={comment} maxLength={2_000} aria-invalid={Boolean(commentError)} aria-describedby={commentError ? `milestone-review-comment-${pendingReview.id}-error` : undefined} onChange={(event) => { setComment(event.target.value); if (event.target.value.trim()) setCommentError(""); }} /><FieldError id={`milestone-review-comment-${pendingReview.id}-error`} messages={commentError} className="mt-1.5" /></Field>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => submitDecision("APPROVE")}>通过</Button>
                <Button type="button" variant="destructive" disabled={busy} onClick={() => submitDecision("REJECT")}>驳回</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => submitDecision("REVISION")}>要求修订</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OpenRevisionPanel({
  taskId,
  revision,
  busy,
  approvalBlocked,
  runAction,
  onResolved,
}: {
  taskId: string;
  revision: TaskLifecycleViews["revisions"][number];
  busy: boolean;
  approvalBlocked: boolean;
  runAction: RunAction;
  onResolved: () => void;
}) {
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState("");
  const reviewRevision = (decision: "APPROVE" | "REJECT" | "CANCEL") => {
    if (decision === "REJECT" && !comment.trim()) {
      setCommentError("驳回修订时必须填写说明");
      requestAnimationFrame(() => document.getElementById(`revision-comment-${revision.id}`)?.focus());
      return;
    }
    const action = decision === "APPROVE"
      ? () => approveRevision({ revisionNodeId: revision.id, comment })
      : decision === "REJECT"
        ? () => rejectRevision({ revisionNodeId: revision.id, comment })
        : () => cancelRevision({ revisionNodeId: revision.id, comment });
    void runAction(
      action,
      decision === "APPROVE" ? "Revision 已批准并应用。" : decision === "REJECT" ? "Revision 已驳回。" : "Revision 已取消。",
      onResolved,
      (error) => {
        const message = firstFieldError(error, ["comment"]);
        if (!message) return false;
        setCommentError(message);
        requestAnimationFrame(() => document.getElementById(`revision-comment-${revision.id}`)?.focus());
        return fieldErrorsFullyHandled(error.fieldErrors, ["comment"]);
      },
    );
  };
  return (
    <section className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">当前 Revision 候选</h2>
        <Badge>{revisionStatusLabel(revision.status)}</Badge>
        <Badge variant="outline">第 {revision.reviewRound} 轮</Badge>
      </div>
      <OverviewItem label="Revision 名称" value={revision.reason} />
      <OverviewItem
        label="Revision 详细内容"
        value={revision.description || "无"}
      />
      <p className="text-xs">Revision 时间：{formatDateTime(revision.revisionAt)}</p>
      {(revision.capabilities.canReview || revision.capabilities.canCancel) && (
        <Field label="处理说明"><Textarea id={`revision-comment-${revision.id}`} value={comment} maxLength={2_000} aria-invalid={Boolean(commentError)} aria-describedby={commentError ? `revision-comment-${revision.id}-error` : undefined} onChange={(event) => { setComment(event.target.value); if (event.target.value.trim()) setCommentError(""); }} /><FieldError id={`revision-comment-${revision.id}-error`} messages={commentError} className="mt-1.5" /></Field>
      )}
      <div className="flex flex-wrap gap-2">
        {revision.capabilities.canEdit && (
          approvalBlocked ? (
            <Button type="button" variant="outline" disabled title="当前 Task 已有待审批事项">
              修改并重新送审
            </Button>
          ) : (
            <Link href={routes.progress.taskRevisionEdit(taskId, revision.id)} className={cn(buttonVariants({ variant: "outline" }))}>
              修改并重新送审
            </Link>
          )
        )}
        {revision.capabilities.canReview && (
          <>
            <Button type="button" disabled={busy} onClick={() => reviewRevision("APPROVE")}>批准</Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => reviewRevision("REJECT")}>驳回</Button>
          </>
        )}
        {revision.capabilities.canCancel && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => reviewRevision("CANCEL")}>取消 Revision</Button>
        )}
      </div>
    </section>
  );
}

function TerminationDetail({
  workspace,
  lifecycle,
  node,
  busy,
  runAction,
  approvalBlocked,
  onReviewResolved,
  onSubmitted,
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  node: PlanVersionSummary["nodes"][number];
  busy: boolean;
  runAction: RunAction;
  approvalBlocked: boolean;
  onReviewResolved: (reviewId: string) => void;
  onSubmitted: (reviewId: string, title: string) => void;
}) {
  const termination = node.termination!;
  const latestReview = lifecycle.terminationReviews.find(
    (review) => review.taskNodeId === node.nodeId,
  );
  const pendingReview =
    latestReview?.result === "PENDING" ? latestReview : null;
  const returnedReview =
    !termination.outcome &&
    (latestReview?.result === "REJECTED" ||
      latestReview?.result === "REVISION_REQUIRED")
      ? latestReview
      : null;
  const [outcome, setOutcome] = useState<
    "SUCCESS" | "FAILED" | "CANCELLED" | "TIMEOUT"
  >(returnedReview?.outcome ?? "SUCCESS");
  const [reason, setReason] = useState(returnedReview?.reason ?? "");
  const [summary, setSummary] = useState(returnedReview?.summary ?? "");
  const [comment, setComment] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [commentError, setCommentError] = useState("");
  const reviewKey = useRef<string | null>(null);
  const canSubmit =
    workspace.task.status === "ACTIVE" &&
    workspace.permissions.canSubmitTerminationReview &&
    !pendingReview;
  const reviewTermination = (decision: "APPROVE" | "REJECT" | "REVISION") => {
    if (decision !== "APPROVE" && !comment.trim()) {
      setCommentError("驳回或要求修订时必须填写说明");
      requestAnimationFrame(() => document.getElementById(`termination-review-comment-${pendingReview?.id ?? node.nodeId}`)?.focus());
      return;
    }
    if (!pendingReview) return;
    const action = decision === "APPROVE"
      ? () => approveTerminationReview({ reviewId: pendingReview.id, comment })
      : decision === "REJECT"
        ? () => rejectTerminationReview({ reviewId: pendingReview.id, comment })
        : () => requireTerminationRevision({ reviewId: pendingReview.id, comment });
    void runAction(
      action,
      decision === "APPROVE" ? "Task 结束申请已通过。" : decision === "REJECT" ? "Task 结束申请已驳回。" : "已要求修订 Task 结束申请。",
      () => onReviewResolved(pendingReview.id),
      (error) => {
        const message = firstFieldError(error, ["comment"]);
        if (!message) return false;
        setCommentError(message);
        requestAnimationFrame(() => document.getElementById(`termination-review-comment-${pendingReview.id}`)?.focus());
        return fieldErrorsFullyHandled(error.fieldErrors, ["comment"]);
      },
    );
  };
  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="min-w-0 break-words text-lg font-semibold">
          {termination.name}
        </h2>
        <Badge>{taskNodeStatusLabels[node.status]}</Badge>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <OverviewItem
          label="计划结束"
          value={formatDateTime(termination.plannedAt)}
        />
        <OverviewItem
          label="结束条件"
          value={termination.plannedOutcomeCriteria}
        />
        <OverviewItem
          label="业务说明"
          value={node.businessDescription || "无"}
        />
        <OverviewItem
          label="结束结果"
          value={
            termination.outcome
              ? terminationOutcomeLabel(termination.outcome)
              : "未确认"
          }
        />
      </dl>
      {returnedReview && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <h3 className="font-medium">
            上一轮结束申请
            {returnedReview.result === "REJECTED" ? "已驳回" : "需要修订"}
          </h3>
          <p className="whitespace-pre-wrap break-words">
            审批意见：{returnedReview.comment}
          </p>
          <p className="text-xs">
            已回填上一轮结束结果、原因和总结，可修改后重新提交。
          </p>
        </div>
      )}
      {canSubmit && (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="font-medium">提交 Task 结束申请</h3>
          <p className="text-sm text-muted-foreground">
            成功完成要求全部前置 Milestone
            已完成；其他结果必须填写原因。提交后由全局管理员审批。
          </p>
          <Field label="结束结果">
            <select
              className={selectClass}
              value={outcome}
              disabled={approvalBlocked}
              onChange={(event) => {
                const nextOutcome = event.target.value as typeof outcome;
                setOutcome(nextOutcome);
                if (nextOutcome === "SUCCESS") setReasonError("");
              }}
            >
              <option value="SUCCESS">成功完成</option>
              <option value="FAILED">失败结束</option>
              <option value="CANCELLED">提前取消</option>
              <option value="TIMEOUT">超时结束</option>
            </select>
          </Field>
          <Field label="原因">
            <Textarea
              id={`termination-reason-${node.nodeId}`}
              value={reason}
              maxLength={2000}
              disabled={approvalBlocked}
              aria-invalid={Boolean(reasonError)}
              aria-describedby={reasonError ? `termination-reason-${node.nodeId}-error` : undefined}
              onChange={(event) => { setReason(event.target.value); if (event.target.value.trim()) setReasonError(""); }}
            />
            <FieldError id={`termination-reason-${node.nodeId}-error`} messages={reasonError} className="mt-1.5" />
          </Field>
          <Field label="总结">
            <Textarea
              value={summary}
              maxLength={4000}
              disabled={approvalBlocked}
              onChange={(event) => setSummary(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || approvalBlocked}
            onClick={() => {
              if (outcome !== "SUCCESS" && !reason.trim()) {
                setReasonError("提前结束或超时时必须填写原因");
                requestAnimationFrame(() => document.getElementById(`termination-reason-${node.nodeId}`)?.focus());
                return;
              }
              reviewKey.current ??= `termination-workbench:${globalThis.crypto.randomUUID()}`;
              void runAction(
                () =>
                  submitTerminationForReview({
                    terminationNodeId: node.nodeId,
                    outcome,
                    reason,
                    summary,
                    idempotencyKey: reviewKey.current,
                  }),
                "Task 结束申请已提交审批。",
                (data) => {
                  reviewKey.current = null;
                  const reviewId = recordString(data, "reviewId");
                  if (reviewId) onSubmitted(reviewId, termination.name);
                },
                (error) => {
                  if (error.code === "STATE_CONFLICT") {
                    reviewKey.current = null;
                  }
                  const message = firstFieldError(error, ["reason"]);
                  if (!message) return false;
                  setReasonError(message);
                  requestAnimationFrame(() => document.getElementById(`termination-reason-${node.nodeId}`)?.focus());
                  return fieldErrorsFullyHandled(error.fieldErrors, ["reason"]);
                },
              );
            }}
          >
            提交结束审批
          </Button>
        </div>
      )}
      {pendingReview && (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="font-medium">当前待审批结束申请</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {pendingReview.submittedBy} 提交于{" "}
            {formatDateTime(pendingReview.createdAt)}
          </p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <OverviewItem
              label="拟定结束结果"
              value={terminationOutcomeLabel(pendingReview.outcome)}
            />
            <OverviewItem label="原因" value={pendingReview.reason || "无"} />
            <OverviewItem label="总结" value={pendingReview.summary || "无"} />
          </dl>
          {pendingReview.capabilities.canReview && (
            <>
              <Field label="审批说明">
                <Textarea
                  id={`termination-review-comment-${pendingReview.id}`}
                  value={comment}
                  maxLength={2000}
                  aria-invalid={Boolean(commentError)}
                  aria-describedby={commentError ? `termination-review-comment-${pendingReview.id}-error` : undefined}
                  onChange={(event) => { setComment(event.target.value); if (event.target.value.trim()) setCommentError(""); }}
                />
                <FieldError id={`termination-review-comment-${pendingReview.id}-error`} messages={commentError} className="mt-1.5" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => reviewTermination("APPROVE")}
                >
                  通过
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => reviewTermination("REJECT")}
                >
                  驳回
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => reviewTermination("REVISION")}
                >
                  要求修订
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveTaskEditor({
  workspace,
  people,
  taskOptions,
  projectOptions,
  busy,
  runAction,
  notice,
  onSaved,
}: {
  workspace: TaskWorkspace;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  projectOptions: Array<{ id: string; name: string; avatarPath: string | null }>;
  busy: boolean;
  runAction: RunAction;
  notice: Notice;
  onSaved: () => void;
}) {
  const editable = workspace.task.status === "ACTIVE" && workspace.permissions.canUpdateMetadata;
  const canManageMembers = workspace.task.status === "ACTIVE" && workspace.permissions.canManageMembers;
  const [baseLockVersion] = useState(workspace.task.lockVersion);
  const [stale, setStale] = useState(false);
  const [members, setMembers] = useState(
    workspace.members.flatMap(({ personId, role }) =>
      role === "OWNER" || role === "PARTICIPANT" ? [{ personId, role }] : [],
    ),
  );
  const [peopleOptions, setPeopleOptions] = useState(people);
  const [relatedTaskId, setRelatedTaskId] = useState(workspace.task.relatedTaskId);
  const [projectId, setProjectId] = useState(workspace.task.projectId);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const clearFieldError = (key: string) => {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const focusFirstFieldError = (errors: Record<string, string[]>) => {
    const keys = ["title", "description", "team", "techGroup", "priority", "relatedTaskId", "projectId", "members"];
    const first = keys.find((key) => errors[key]);
    if (!first) return;
    const id = first === "relatedTaskId" ? "active-task-related" : first === "projectId" ? "active-task-project" : first === "members" ? "active-task-members" : `active-task-${first}`;
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  };
  return (
    <form
      className="grid gap-5 lg:grid-cols-2"
      aria-label="修改 Task"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (stale) return;
        const form = new FormData(event.currentTarget);
        const nextErrors: Record<string, string[]> = {};
        if (editable && !String(form.get("title") ?? "").trim()) {
          nextErrors.title = ["请输入 Task 名称"];
        }
        if (canManageMembers && members.length === 0) {
          nextErrors.members = ["至少添加一名 Task 成员"];
        } else if (canManageMembers && members.every((member) => member.role !== "OWNER")) {
          nextErrors.members = ["至少需要一名负责人"];
        }
        if (Object.keys(nextErrors).length > 0) {
          setFieldErrors((current) => ({ ...current, ...nextErrors }));
          focusFirstFieldError(nextErrors);
          return;
        }
        void runAction(
          () => updateActiveTask({
            taskId: workspace.task.id,
            expectedLockVersion: baseLockVersion,
            metadata: editable
              ? {
                  title: String(form.get("title") ?? ""),
                  description: String(form.get("description") ?? ""),
                  team: String(form.get("team") ?? ""),
                  techGroup: String(form.get("techGroup") ?? ""),
                  priority: String(form.get("priority") ?? "MEDIUM"),
                  relatedTaskId,
                  projectId,
                }
              : undefined,
            members: canManageMembers ? members : undefined,
          }),
          "Task 修改已保存。",
          onSaved,
          (error) => {
            if (error.code === "STALE_TASK") setStale(true);
            const next = activeTaskFieldErrors(error.fieldErrors);
            if (Object.keys(next).length === 0) return false;
            setFieldErrors(next);
            focusFirstFieldError(next);
            return activeTaskFieldErrorsFullyHandled(error.fieldErrors);
          },
        );
      }}
    >
      {notice && (
        <p
          className={cn(
            "break-words rounded-lg px-3 py-2 text-sm lg:col-span-2",
            notice.kind === "error" && "bg-destructive/10 text-destructive",
            notice.kind === "success" && "bg-emerald-50 text-emerald-800",
            notice.kind === "info" && "bg-muted text-muted-foreground",
          )}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
          {stale && " 请关闭并重新打开编辑窗口，确认最新内容后再保存。"}
        </p>
      )}
      <section
        className="space-y-3 rounded-xl border border-border p-4"
        aria-label="Task 元数据"
      >
        <h3 className="font-semibold">基本信息</h3>
        <Field label="标题"><Input id="active-task-title" name="title" defaultValue={workspace.task.title} disabled={!editable} required maxLength={200} aria-invalid={Boolean(fieldErrors.title)} aria-describedby={fieldErrors.title ? "active-task-title-error" : undefined} onChange={() => clearFieldError("title")} /><FieldError id="active-task-title-error" messages={fieldErrors.title} /></Field>
        <Field label="描述"><Textarea id="active-task-description" name="description" defaultValue={workspace.task.description} disabled={!editable} maxLength={8_000} aria-invalid={Boolean(fieldErrors.description)} aria-describedby={fieldErrors.description ? "active-task-description-error" : undefined} onChange={() => clearFieldError("description")} /><FieldError id="active-task-description-error" messages={fieldErrors.description} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="车组"><select id="active-task-team" name="team" defaultValue={workspace.task.team} disabled={!editable} className={selectClass} aria-invalid={Boolean(fieldErrors.team)} aria-describedby={fieldErrors.team ? "active-task-team-error" : undefined} onChange={() => clearFieldError("team")}>{TEAM_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select><FieldError id="active-task-team-error" messages={fieldErrors.team} /></Field>
          <Field label="技术组"><select id="active-task-techGroup" name="techGroup" defaultValue={workspace.task.techGroup} disabled={!editable} className={selectClass} aria-invalid={Boolean(fieldErrors.techGroup)} aria-describedby={fieldErrors.techGroup ? "active-task-techGroup-error" : undefined} onChange={() => clearFieldError("techGroup")}>{TECH_GROUP_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select><FieldError id="active-task-techGroup-error" messages={fieldErrors.techGroup} /></Field>
          <Field label="优先级"><select id="active-task-priority" name="priority" defaultValue={workspace.task.priority} disabled={!editable} className={selectClass} aria-invalid={Boolean(fieldErrors.priority)} aria-describedby={fieldErrors.priority ? "active-task-priority-error" : undefined} onChange={() => clearFieldError("priority")}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><FieldError id="active-task-priority-error" messages={fieldErrors.priority} /></Field>
        </div>
        <Field label="关联 Task">
          <TaskSelect
            ariaLabel="关联 Task"
            inputId="active-task-related"
            value={relatedTaskId}
            onValueChange={(value) => { setRelatedTaskId(value); clearFieldError("relatedTaskId"); }}
            initialOptions={taskOptions}
            excludeIds={[workspace.task.id]}
            disabled={!editable}
            placeholder="按标题、描述或拼音首字母搜索"
            invalid={Boolean(fieldErrors.relatedTaskId)}
            ariaDescribedBy={fieldErrors.relatedTaskId ? "active-task-related-error" : undefined}
          />
          <FieldError id="active-task-related-error" messages={fieldErrors.relatedTaskId} />
        </Field>
        <Field label="所属 Project">
          <ProjectSelect inputId="active-task-project" value={projectId} onValueChange={(value) => { setProjectId(value); clearFieldError("projectId"); }} initialOptions={projectOptions} disabled={!editable} invalid={Boolean(fieldErrors.projectId)} ariaDescribedBy={fieldErrors.projectId ? "active-task-project-error" : undefined} />
          <FieldError id="active-task-project-error" messages={fieldErrors.projectId} />
        </Field>
      </section>

      <section id="active-task-members" tabIndex={-1} className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-semibold">成员与角色</h3>
        <TaskMemberRolePicker
          members={members}
          people={peopleOptions}
          scope={{ purpose: "TASK_MEMBERS", taskId: workspace.task.id }}
          editable={canManageMembers}
          error={fieldErrors.members}
          onChange={(value) => { setMembers(value); clearFieldError("members"); }}
          onPersonResolved={(person) =>
            setPeopleOptions((current) => mergeById(current, [person]))
          }
        />
      </section>

      <div className="flex justify-end border-t border-border pt-4 lg:col-span-2">
        <Button type="submit" disabled={busy || stale}>
          {busy ? "正在保存…" : "保存修改"}
        </Button>
      </div>
    </form>
  );
}

function buildTaskNavigatorNodes(workspace: TaskWorkspace): TaskPlanNavigatorNode[] {
  return [
    {
      id: TASK_DETAIL_START_ID,
      kind: "START",
      label: "Start",
      at: workspace.currentPlan.plannedStartAt ?? workspace.task.createdAt,
      status: workspace.task.status === "DRAFT" ? "草稿" : "已开始",
      completed: workspace.task.status !== "DRAFT",
    },
    ...workspace.currentPlan.nodes.map((node): TaskPlanNavigatorNode => ({
      id: node.nodeId,
      kind: node.milestone ? "MILESTONE" : node.revision ? "REVISION" : "TERMINAL",
      label: node.milestone?.goal ?? node.revision?.reason ?? node.termination?.name ?? "未命名节点",
      at: node.milestone?.expectedCompletedAt ?? node.revision?.revisionAt ?? node.termination?.plannedAt ?? workspace.task.updatedAt,
      status: node.revision ? revisionStatusLabel(node.revision.status) : taskNodeStatusLabels[node.status],
      completed: node.status === "COMPLETED" || node.revision?.status === "EFFECTIVE",
    })),
  ];
}

function TaskDetailTimeline({
  workspace,
  nodes,
  selectedId,
  onSelect,
  model,
  people,
  taskOptions,
  timelineWindow,
}: {
  workspace: TaskWorkspace;
  nodes: TaskPlanNavigatorNode[];
  selectedId: string;
  onSelect: (nodeId: string) => void;
  model: TimeCanvasModel;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  timelineWindow: {
    focusId: string | null;
    centerMs?: number;
    scale?: "WEEK" | "MONTH" | "QUARTER" | "YEAR";
  };
}) {
  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
      data-testid="task-timeline-layer"
    >
      <div>
        <h2 className="font-semibold">计划与人员投入</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Current Plan v{workspace.currentPlan.versionNo} · 按当前计划和投入自动确定范围
        </p>
      </div>
      <div className="mt-4 min-w-0">
        <ResourcePlannerCanvasClient
          initialModel={model}
          peopleOptions={people}
          peopleScope={{ purpose: "TASK_SEGMENT_CREATE", taskId: workspace.task.id }}
          taskOptions={taskOptions}
          defaultPersonId={workspace.members.find((member) => member.role === "OWNER")?.personId ?? workspace.members[0]?.personId ?? ""}
          defaultTaskId={workspace.task.id}
          defaultTaskTitle={workspace.task.title}
          allowIndependent={false}
          initialZoom={timelineWindow.scale}
          initialCenterMs={timelineWindow.centerMs}
          persistViewportInUrl
          adaptiveBlockQuery={{
            kind: "TASK",
            preferredCenterMs: timelineWindow.centerMs ?? Date.parse(model.generatedAt),
            taskId: workspace.task.id,
          }}
          mode="TASK_WORKBENCH"
          initialFocusId={
            selectedId === TASK_DETAIL_START_ID
              ? `plan-start:${workspace.task.id}`
              : selectedId
          }
        />
      </div>
      <div className="mt-4">
        <TaskPlanNodeNavigator
          nodes={nodes}
          selectedId={selectedId}
          onSelect={onSelect}
          label="Task 时间线"
        />
      </div>
    </section>
  );
}

function currentNodeLabel(workspace: TaskWorkspace) {
  const active = workspace.currentPlan.nodes.find(
    (node) => node.nodeId === workspace.task.activeMilestoneNodeId,
  );
  if (active?.milestone) return active.milestone.goal;
  const terminal = workspace.currentPlan.nodes.find(
    (node) => node.termination && node.status === "ACTIVE",
  );
  return terminal?.termination?.name ?? (workspace.task.status === "DRAFT" ? "草稿" : "无 Active 节点");
}

function memberNames(workspace: TaskWorkspace, role: ActiveTaskMemberRole) {
  return workspace.members
    .filter((member) => member.role === role)
    .map((member) => member.displayName)
    .join("、") || "未配置";
}

function OverviewItem({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}

function mergeById<T extends { id: string }>(...groups: T[][]) {
  const merged = new Map<string, T>();
  for (const group of groups) for (const item of group) merged.set(item.id, item);
  return [...merged.values()];
}

function approvalGateKey(
  workspace: Pick<TaskWorkspace, "pendingApproval" | "pendingApprovalConflict">,
) {
  if (workspace.pendingApprovalConflict) return "CONFLICT";
  return workspace.pendingApproval
    ? `${workspace.pendingApproval.kind}:${workspace.pendingApproval.id}`
    : "NONE";
}

function actionLockVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("lockVersion" in value)) return null;
  const candidate = value.lockVersion;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
}

function recordString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function revisionStatusLabel(status: string) {
  return ({ PENDING_APPROVAL: "待审批", REJECTED: "已驳回", CANCELLED: "已取消", EFFECTIVE: "已生效" } as Record<string, string>)[status] ?? status;
}

function terminationOutcomeLabel(outcome: string) {
  return ({ SUCCESS: "成功完成", FAILED: "失败结束", CANCELLED: "提前取消", TIMEOUT: "超时结束" } as Record<string, string>)[outcome] ?? outcome;
}

function firstFieldError(
  error: ProjectManagementActionFailure["error"],
  paths: string[],
) {
  for (const path of paths) {
    const message = firstFieldErrorMessage(error.fieldErrors, path);
    if (message) return message;
  }
  return undefined;
}

const ACTIVE_TASK_FIELD_ERROR_KEYS = new Set([
  "title",
  "description",
  "team",
  "techGroup",
  "priority",
  "relatedTaskId",
  "projectId",
  "members",
]);

function activeTaskFieldErrors(fieldErrors?: Record<string, string[]>) {
  const result: Record<string, string[]> = {};
  for (const [path, messages] of Object.entries(fieldErrors ?? {})) {
    const normalized = path.startsWith("metadata.") ? path.slice("metadata.".length) : path;
    const key = normalized.startsWith("members.") ? "members" : normalized;
    if (ACTIVE_TASK_FIELD_ERROR_KEYS.has(key)) {
      const visibleMessages = messages.filter(Boolean);
      if (visibleMessages.length > 0) {
        result[key] = [...(result[key] ?? []), ...visibleMessages];
      }
    }
  }
  return result;
}

function activeTaskFieldErrorsFullyHandled(fieldErrors?: Record<string, string[]>) {
  return fieldErrorsFullyHandled(
    fieldErrors,
    ACTIVE_TASK_FIELD_ERROR_KEYS,
    normalizeActiveTaskFieldErrorPath,
  );
}

function normalizeActiveTaskFieldErrorPath(path: string) {
  const normalized = path.startsWith("metadata.")
    ? path.slice("metadata.".length)
    : path;
  return normalized.startsWith("members.") ? "members" : normalized;
}

const selectClass = "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";
