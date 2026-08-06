"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  activateTask,
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
import { confirmTermination } from "@/app/actions/project-management/terminations";
import { searchTagOptions } from "@/app/actions/project-management/options";
import {
  TaskPlanNodeNavigator,
  type TaskPlanNavigatorNode,
} from "@/components/project-management/task-plan-node-navigator";
import { TaskMemberRolePicker } from "@/components/project-management/task-member-role-picker";
import { TaskSelect } from "@/components/project-management/task-picker";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { buildPlanPhaseBands } from "@/components/project-management/time-canvas/plan-phase-bands";
import type {
  TimeCanvasAnchor,
  TimeCanvasModel,
  TimeCanvasTone,
} from "@/components/project-management/time-canvas/types";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
  TagOptionPage,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import type { TaskPendingApproval } from "@/lib/project-management/task-approval-gate";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ProjectSelect } from "@/components/project-management/project-picker";

const TASK_DETAIL_START_ID = "task-detail-start";
const TASK_DETAIL_PLAN_ROW_ID = "task-detail-plan-row";
const TASK_DETAIL_DAY_MS = 24 * 60 * 60 * 1_000;
const TASK_DETAIL_PHASE_TONES: TimeCanvasTone[] = [
  "BLUE",
  "VIOLET",
  "AMBER",
  "EMERALD",
  "ROSE",
  "SLATE",
];
type Notice = { kind: "success" | "error" | "info"; message: string } | null;
type ActiveTaskMemberRole = "OWNER" | "PARTICIPANT";
type RunAction = (
  action: () => Promise<ProjectManagementActionResult<unknown>>,
  successMessage: string,
  onSuccess?: (data: unknown) => void,
  onFailure?: (error: ProjectManagementActionFailure["error"]) => void,
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
  tagOptions,
  projectOptions,
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  tagOptions: TagOptionPage["items"];
  projectOptions: Array<{ id: string; name: string; avatarPath: string | null }>;
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
  const initialNodeId =
    task.activeMilestoneNodeId ??
    (termination?.status === "ACTIVE" ? termination.nodeId : TASK_DETAIL_START_ID);
  const [requestedNodeId, setRequestedNodeId] = useState(initialNodeId);
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
        onFailure?.(result.error);
        setNotice({
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
      <section className="rounded-xl border border-border bg-card p-5">
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
              <OverviewItem label="Tags" value={workspace.tags.map((tag) => tag.name).join("、") || "未配置"} />
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
            {task.status === "ACTIVE" && workspace.permissions.canTerminate && termination && (
              <Button
                type="button"
                variant="destructive"
                disabled={approvalBlocked}
                title={approvalBlocked ? "当前 Task 已有待审批事项" : undefined}
                onClick={selectTerminal}
              >
                结束 Task
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
              : `Revision「${approvalGate.pendingApproval?.title || "未命名修订"}」正在等待审批。`}
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
        >
          {notice.message}
        </p>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
        <main className="min-w-0 space-y-4 xl:col-start-2 xl:row-start-1">
          <TaskDetailTimeline
            workspace={currentWorkspace}
            nodes={navigatorNodes}
            selectedId={selectedNodeId}
            onSelect={setRequestedNodeId}
          />

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
            />
          </section>
        </main>

        <aside className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1">
          <PlaceholderCard title="Task 风险" description="Task 风险功能暂未开放。" />
          <PlaceholderCard title="Task 评论" description="Task 评论功能暂未开放。" />
        </aside>

        <aside className="min-w-0 xl:col-start-3 xl:row-start-1">
          <PlaceholderCard title="最近动态" description="最近动态功能暂未开放。" />
        </aside>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>修改 Task 基本信息</DialogTitle>
            <DialogDescription>
              基本信息、Tags 与成员通过一次事务统一保存，并继续使用各自的权限和并发校验。
            </DialogDescription>
          </DialogHeader>
          <ActiveTaskEditor
            key={`${task.id}:${editSession}`}
            workspace={currentWorkspace}
            people={people}
            taskOptions={taskOptions}
              tagOptions={tagOptions}
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
    return (
      <TerminationDetail
        workspace={workspace}
        node={selectedNode}
        busy={busy}
        runAction={runAction}
        approvalBlocked={approvalBlocked}
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
  const reviewKey = useRef<string | null>(null);

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
            <label><input type="radio" checked={evidenceKind === "TEXT"} disabled={approvalBlocked} onChange={() => setEvidenceKind("TEXT")} /> 文本证据</label>
            <label><input type="radio" checked={evidenceKind === "LINK"} disabled={approvalBlocked} onChange={() => setEvidenceKind("LINK")} /> 链接证据</label>
          </div>
          <Field label={evidenceKind === "TEXT" ? "文本证据" : "证据链接"}>
            {evidenceKind === "TEXT" ? (
              <Textarea value={evidence} disabled={approvalBlocked} onChange={(event) => setEvidence(event.target.value)} />
            ) : (
              <Input type="url" value={evidence} disabled={approvalBlocked} onChange={(event) => setEvidence(event.target.value)} />
            )}
          </Field>
          {evidenceKind === "LINK" && (
            <Field label="链接说明"><Input value={evidenceNote} disabled={approvalBlocked} onChange={(event) => setEvidenceNote(event.target.value)} /></Field>
          )}
          <Button
            type="button"
            disabled={busy || approvalBlocked}
            title={approvalBlocked ? "当前 Task 已有待审批事项" : undefined}
            onClick={() => {
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
              <Field label="审批说明"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={busy} onClick={() => void runAction(() => approveMilestoneReview({ reviewId: pendingReview.id, comment }), "验收已通过。", () => onApprovalResolved(pendingReview.id))}>通过</Button>
                <Button type="button" variant="destructive" disabled={busy} onClick={() => void runAction(() => rejectMilestoneReview({ reviewId: pendingReview.id, comment }), "验收已驳回。", () => onApprovalResolved(pendingReview.id))}>驳回</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void runAction(() => requireMilestoneRevision({ reviewId: pendingReview.id, comment }), "已要求修订。", () => onApprovalResolved(pendingReview.id))}>要求修订</Button>
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
        <Field label="处理说明"><Textarea value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
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
            <Button type="button" disabled={busy} onClick={() => void runAction(() => approveRevision({ revisionNodeId: revision.id, comment }), "Revision 已批准并应用。", onResolved)}>批准</Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void runAction(() => rejectRevision({ revisionNodeId: revision.id, comment }), "Revision 已驳回。", onResolved)}>驳回</Button>
          </>
        )}
        {revision.capabilities.canCancel && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void runAction(() => cancelRevision({ revisionNodeId: revision.id, comment }), "Revision 已取消。", onResolved)}>取消 Revision</Button>
        )}
      </div>
    </section>
  );
}

function TerminationDetail({
  workspace,
  node,
  busy,
  runAction,
  approvalBlocked,
}: {
  workspace: TaskWorkspace;
  node: PlanVersionSummary["nodes"][number];
  busy: boolean;
  runAction: RunAction;
  approvalBlocked: boolean;
}) {
  const termination = node.termination!;
  const [outcome, setOutcome] = useState<"SUCCESS" | "FAILED" | "CANCELLED" | "TIMEOUT">("SUCCESS");
  const [reason, setReason] = useState("");
  const [summary, setSummary] = useState("");
  const canTerminate =
    workspace.task.status === "ACTIVE" && workspace.permissions.canTerminate;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{termination.name}</h2>
        <Badge>{taskNodeStatusLabels[node.status]}</Badge>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <OverviewItem label="计划结束" value={formatDateTime(termination.plannedAt)} />
        <OverviewItem label="结束条件" value={termination.plannedOutcomeCriteria} />
        <OverviewItem label="业务说明" value={node.businessDescription || "无"} />
        <OverviewItem label="结束结果" value={termination.outcome ? terminationOutcomeLabel(termination.outcome) : "未确认"} />
      </dl>
      {canTerminate && (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="font-medium">结束 Task</h3>
          <p className="text-sm text-muted-foreground">成功完成要求全部前置 Milestone 已完成；其他结果必须填写原因。</p>
          <Field label="结束结果">
            <select className={selectClass} value={outcome} disabled={approvalBlocked} onChange={(event) => setOutcome(event.target.value as typeof outcome)}>
              <option value="SUCCESS">成功完成</option>
              <option value="FAILED">失败结束</option>
              <option value="CANCELLED">提前取消</option>
              <option value="TIMEOUT">超时结束</option>
            </select>
          </Field>
          <Field label="原因"><Textarea value={reason} disabled={approvalBlocked} onChange={(event) => setReason(event.target.value)} /></Field>
          <Field label="总结"><Textarea value={summary} disabled={approvalBlocked} onChange={(event) => setSummary(event.target.value)} /></Field>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || approvalBlocked}
            onClick={() => {
              if (!window.confirm(`确认以“${terminationOutcomeLabel(outcome)}”结束 Task？`)) return;
              void runAction(
                () => confirmTermination({
                  taskId: workspace.task.id,
                  terminationNodeId: node.nodeId,
                  outcome,
                  reason,
                  summary,
                  expectedLockVersion: workspace.task.lockVersion,
                }),
                "Task 已完成 Termination 确认。",
              );
            }}
          >
            确认结束 Task
          </Button>
        </div>
      )}
    </div>
  );
}

function ActiveTaskEditor({
  workspace,
  people,
  taskOptions,
  tagOptions,
  projectOptions,
  busy,
  runAction,
  notice,
  onSaved,
}: {
  workspace: TaskWorkspace;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  tagOptions: TagOptionPage["items"];
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
  const [selectedTags, setSelectedTags] = useState(workspace.tags.map((tag) => tag.id));
  const [tagChoices, setTagChoices] = useState(tagOptions);
  const [tagQuery, setTagQuery] = useState("");
  const [optionLoading, setOptionLoading] = useState(false);
  const [optionError, setOptionError] = useState("");
  const availableTags = mergeById(workspace.tags, tagChoices);

  const loadTags = async () => {
    setOptionLoading(true);
    setOptionError("");
    try {
      const result = await searchTagOptions({ query: tagQuery, includeArchived: false, limit: 50 });
      if (!result.ok) {
        setOptionError(result.error.message);
        return;
      }
      setTagChoices(mergeById(tagChoices, result.data.items));
    } catch {
      setOptionError("Tag 搜索失败，请稍后重试。");
    } finally {
      setOptionLoading(false);
    }
  };

  return (
    <form
      className="grid gap-5 lg:grid-cols-2"
      aria-label="修改 Task"
      onSubmit={(event) => {
        event.preventDefault();
        if (stale) return;
        const form = new FormData(event.currentTarget);
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
            tagIds: editable ? selectedTags : undefined,
            members: canManageMembers ? members : undefined,
          }),
          "Task 修改已保存。",
          onSaved,
          (error) => {
            if (error.code === "STALE_TASK") setStale(true);
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
        <Field label="标题"><Input name="title" defaultValue={workspace.task.title} disabled={!editable} required maxLength={200} /></Field>
        <Field label="描述"><Textarea name="description" defaultValue={workspace.task.description} disabled={!editable} maxLength={8_000} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="车组"><select name="team" defaultValue={workspace.task.team} disabled={!editable} className={selectClass}>{TEAM_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="技术组"><select name="techGroup" defaultValue={workspace.task.techGroup} disabled={!editable} className={selectClass}>{TECH_GROUP_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="优先级"><select name="priority" defaultValue={workspace.task.priority} disabled={!editable} className={selectClass}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        </div>
        <Field label="关联 Task">
          <TaskSelect
            ariaLabel="关联 Task"
            value={relatedTaskId}
            onValueChange={setRelatedTaskId}
            initialOptions={taskOptions}
            excludeIds={[workspace.task.id]}
            disabled={!editable}
            placeholder="按标题、描述或拼音首字母搜索"
          />
        </Field>
        <Field label="所属 Project">
          <ProjectSelect value={projectId} onValueChange={setProjectId} initialOptions={projectOptions} disabled={!editable} />
        </Field>
        <div className="space-y-2">
          <span className="text-sm font-medium">Tags</span>
          {editable && <div className="flex gap-2"><Input aria-label="搜索 Tag" value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} /><Button type="button" variant="outline" disabled={optionLoading} onClick={() => void loadTags()}>搜索</Button></div>}
          <div className="flex flex-wrap gap-2">
            {availableTags.map((tag) => <label key={tag.id} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-sm"><input type="checkbox" checked={selectedTags.includes(tag.id)} disabled={!editable} onChange={(event) => setSelectedTags(event.target.checked ? [...selectedTags, tag.id] : selectedTags.filter((id) => id !== tag.id))} />{tag.name}</label>)}
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-semibold">成员与角色</h3>
        <TaskMemberRolePicker
          members={members}
          people={peopleOptions}
          scope={{ purpose: "TASK_MEMBERS", taskId: workspace.task.id }}
          editable={canManageMembers}
          onChange={setMembers}
          onPersonResolved={(person) =>
            setPeopleOptions((current) => mergeById(current, [person]))
          }
        />
        {optionError && <p className="text-sm text-destructive" role="alert">{optionError}</p>}
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
}: {
  workspace: TaskWorkspace;
  nodes: TaskPlanNavigatorNode[];
  selectedId: string;
  onSelect: (nodeId: string) => void;
}) {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const model = buildTaskDetailCanvasModel(workspace);
  const selectedAnchorAt = model.anchors.find(
    (item) => item.id === selectedId,
  )?.atMs;
  useEffect(() => {
    if (selectedAnchorAt === undefined) return;
    const scroller = canvasContainerRef.current?.querySelector<HTMLElement>(
      "[data-testid='time-canvas-scroll']",
    );
    if (!scroller) return;
    const timelineRow = scroller.querySelector<HTMLElement>(
      "[data-testid^='timeline-row-']",
    );
    const rowHeaderWidth =
      timelineRow?.firstElementChild instanceof HTMLElement
        ? timelineRow.firstElementChild.offsetWidth
        : 0;
    const duration = model.range.endMs - model.range.startMs;
    if (duration <= 0) return;
    const ratio = Math.max(
      0,
      Math.min(1, (selectedAnchorAt - model.range.startMs) / duration),
    );
    const timelineWidth = Math.max(0, scroller.scrollWidth - rowHeaderWidth);
    const targetX = rowHeaderWidth + ratio * timelineWidth;
    const maximumLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    scroller.scrollTo({
      left: Math.max(0, Math.min(maximumLeft, targetX - scroller.clientWidth / 2)),
      behavior: "smooth",
    });
  }, [model.range.endMs, model.range.startMs, selectedAnchorAt]);

  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div>
        <h2 className="font-semibold">计划时间轴</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Current Plan v{workspace.currentPlan.versionNo} · Asia/Shanghai
        </p>
      </div>
      <div
        ref={canvasContainerRef}
        className="mt-4 hidden min-w-0 overflow-hidden rounded-lg border border-border lg:block"
      >
        <TimeCanvas
          mode="TASK_WORKBENCH"
          model={model}
          initialZoom="DAY"
          display={{ showActual: false, showBusy: false, showInspector: false }}
          selection={{ kind: "ANCHOR", id: selectedId }}
          interaction={{
            onAnchorSelectionChange: (anchorId) => {
              if (anchorId) onSelect(anchorId);
            },
          }}
          emptyMessage="当前计划没有可展示的时间节点"
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

function buildTaskDetailCanvasModel(workspace: TaskWorkspace): TimeCanvasModel {
  const startAt = workspace.currentPlan.plannedStartAt ?? workspace.task.createdAt;
  const anchors: TimeCanvasAnchor[] = [
    {
      id: TASK_DETAIL_START_ID,
      rowId: TASK_DETAIL_PLAN_ROW_ID,
      taskId: workspace.task.id,
      kind: "PLAN_START",
      status: workspace.task.status === "DRAFT" ? "草稿" : "已开始",
      label: "Start",
      atMs: new Date(startAt).getTime(),
      sequence: 0,
      editable: false,
      versionToken: startAt,
      tone: "BLUE",
    },
    ...workspace.currentPlan.nodes.map((entry, index): TimeCanvasAnchor => {
      const at = entry.milestone?.expectedCompletedAt ??
        entry.revision?.revisionAt ??
        entry.termination?.plannedAt ??
        workspace.task.updatedAt;
      return {
        id: entry.nodeId,
        rowId: TASK_DETAIL_PLAN_ROW_ID,
        taskId: workspace.task.id,
        kind: entry.milestone
          ? "MILESTONE"
          : entry.revision
            ? "REVISION"
            : "TERMINATION",
        status: entry.revision
          ? revisionStatusLabel(entry.revision.status)
          : taskNodeStatusLabels[entry.status],
        label: entry.milestone?.goal ??
          entry.revision?.reason ??
          entry.termination?.name ??
          "未命名节点",
        atMs: new Date(at).getTime(),
        sequence: entry.sequence,
        editable: false,
        versionToken: at,
        tone: entry.revision
          ? "SLATE"
          : TASK_DETAIL_PHASE_TONES[index % TASK_DETAIL_PHASE_TONES.length],
      };
    }),
  ];
  const validTimes = anchors.map((anchor) => anchor.atMs).filter(Number.isFinite);
  const minimum = Math.min(...validTimes);
  const maximum = Math.max(...validTimes);
  const duration = Math.max(TASK_DETAIL_DAY_MS, maximum - minimum);
  const padding = Math.max(TASK_DETAIL_DAY_MS, duration * 0.08);
  return {
    timezone: "Asia/Shanghai",
    range: { startMs: minimum - padding, endMs: maximum + padding + 1 },
    rows: [
      {
        id: TASK_DETAIL_PLAN_ROW_ID,
        sourceId: workspace.task.id,
        kind: "PLAN",
        label: workspace.task.title,
        sublabel: `${workspace.currentPlan.nodes.filter((node) => node.milestone).length} 个 Milestone`,
        editable: false,
        height: 132,
        capacity: null,
      },
    ],
    anchors,
    phaseBands: buildPlanPhaseBands(anchors, TASK_DETAIL_PLAN_ROW_ID).map(
      (band) => ({ ...band, id: `task-detail-${band.id}` }),
    ),
    segments: [],
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
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

function PlaceholderCard({ title, description }: { title: string; description: string }) {
  return <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">{title}</h2><div className="mt-3 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{description}</div></section>;
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

const selectClass = "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
