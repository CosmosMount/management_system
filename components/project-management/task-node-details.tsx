"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  approveMilestoneReview,
  rejectMilestoneReview,
  requireMilestoneRevision,
  submitMilestoneForReview,
} from "@/app/actions/project-management/milestones";
import { getMilestoneCompletionDetails } from "@/app/actions/project-management/plans";
import {
  approveRevision,
  cancelRevision,
  rejectRevision,
} from "@/app/actions/project-management/revisions";
import {
  approveTerminationReview,
  rejectTerminationReview,
  requireTerminationRevision,
  submitTerminationForReview,
} from "@/app/actions/project-management/terminations";
import { TASK_DETAIL_START_ID } from "@/components/project-management/task-detail-timeline";
import {
  Field,
  OverviewItem,
  selectClass,
} from "@/components/project-management/task-workbench-fields";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  revisionStatusLabel,
  taskNodeStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskLifecycleViews } from "@/lib/project-management/queries/task-lifecycle-queries";
import type {
  MilestoneCompletionDetails,
  TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type TaskWorkspaceNode = TaskWorkspace["currentPlan"]["nodes"][number];
export type RunAction = (
  action: () => Promise<ProjectManagementActionResult<unknown>>,
  successMessage: string,
  onSuccess?: (data: unknown) => void,
  onFailure?: (error: ProjectManagementActionFailure["error"]) => boolean | void,
) => Promise<void>;
export function SelectedNodeDetail({
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
  selectedNode: TaskWorkspaceNode | undefined;
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
  node: TaskWorkspaceNode;
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
  const completed = node.status === "COMPLETED";
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
        {completed && (
          <OverviewItem
            label="实际完成"
            value={milestone.completedAt ? formatDateTime(milestone.completedAt) : "未记录"}
          />
        )}
        <OverviewItem label="完成条件" value={milestone.completionCriteria} />
        <OverviewItem label="验收要求" value={milestone.reviewRequirements} />
        <OverviewItem label="业务说明" value={node.businessDescription || "无"} />
      </dl>

      {completed && (
        <MilestoneCompletionMaterials
          taskId={workspace.task.id}
          nodeId={node.nodeId}
        />
      )}

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
          <MilestoneEvidences
            evidences={pendingReview.evidences}
            title="本次提交材料"
            emptyMessage="未提交验收证据。"
            testId="milestone-pending-review-evidences"
          />
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

type MilestoneCompletionLoadState =
  | { status: "loading" }
  | { status: "success"; details: MilestoneCompletionDetails }
  | { status: "error"; message: string };

function MilestoneCompletionMaterials({
  taskId,
  nodeId,
}: {
  taskId: string;
  nodeId: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<MilestoneCompletionLoadState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    void getMilestoneCompletionDetails({ taskId, nodeId }).then(
      (result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: "success", details: result.data }
            : { status: "error", message: result.error.message },
        );
      },
      () => {
        if (cancelled) return;
        setState({
          status: "error",
          message: "网络或服务暂时不可用，请重试。",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, nodeId, taskId]);

  if (state.status === "success") {
    return (
      <MilestoneEvidences
        evidences={state.details.evidences}
        title="实际提交材料"
        emptyMessage="本次验收未提交材料。"
        testId="milestone-completion-evidences"
      />
    );
  }

  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      data-testid="milestone-completion-evidences"
    >
      <h3 className="font-medium">实际提交材料</h3>
      {state.status === "loading" ? (
        <p className="text-sm text-muted-foreground" role="status">
          正在加载实际提交材料…
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            {state.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((current) => current + 1);
            }}
          >
            重新加载材料
          </Button>
        </div>
      )}
    </section>
  );
}

function MilestoneEvidences({
  evidences,
  title,
  emptyMessage,
  testId,
}: {
  evidences: MilestoneCompletionDetails["evidences"];
  title: string;
  emptyMessage: string;
  testId: string;
}) {
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      data-testid={testId}
    >
      <h3 className="font-medium">{title}</h3>
      {evidences.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="space-y-3">
          {evidences.map((evidence, index) => (
            <li
              key={evidence.id}
              className="min-w-0 rounded-lg border border-border bg-muted/30 p-3 text-sm"
            >
              <p className="text-xs font-medium text-muted-foreground">
                {evidence.kind === "TEXT"
                  ? `文本材料 ${index + 1}`
                  : evidence.kind === "LINK"
                    ? `链接材料 ${index + 1}`
                    : `文件材料 ${index + 1}`}
              </p>
              {evidence.kind === "TEXT" ? (
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {evidence.note || "无"}
                </p>
              ) : evidence.kind === "LINK" ? (
                <div className="mt-1 min-w-0 space-y-1">
                  {evidence.externalUrl ? (
                    <a
                      href={evidence.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all text-primary hover:underline"
                    >
                      {evidence.externalUrl}
                    </a>
                  ) : (
                    <p className="text-muted-foreground">链接不可用</p>
                  )}
                  {evidence.note && (
                    <p className="whitespace-pre-wrap break-words">
                      {evidence.note}
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-1 space-y-1">
                  <p className="text-muted-foreground">文件材料当前不可查看</p>
                  {evidence.note && (
                    <p className="whitespace-pre-wrap break-words">
                      {evidence.note}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OpenRevisionPanel({
  taskId,
  revision,
  busy,
  approvalBlocked,
  approvalUnavailableReason,
  runAction,
  onResolved,
}: {
  taskId: string;
  revision: TaskLifecycleViews["revisions"][number];
  busy: boolean;
  approvalBlocked: boolean;
  approvalUnavailableReason: string | null;
  runAction: RunAction;
  onResolved: () => void;
}) {
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState("");
  const reviewRevision = (decision: "APPROVE" | "REJECT" | "CANCEL") => {
    if (decision === "APPROVE" && approvalUnavailableReason) return;
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
      {approvalUnavailableReason && (
        <p
          className="rounded-md border border-amber-400 bg-white/70 px-3 py-2 text-sm"
          role="alert"
          data-testid="revision-approval-plan-warning"
        >
          {approvalUnavailableReason} 批准已禁用；可改为驳回，或由有权限的人取消后重新提交。
        </p>
      )}
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
            <Button
              type="button"
              disabled={busy || Boolean(approvalUnavailableReason)}
              title={approvalUnavailableReason ?? undefined}
              onClick={() => reviewRevision("APPROVE")}
            >
              批准
            </Button>
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
  node: TaskWorkspaceNode;
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
  const completed = node.status === "COMPLETED";
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
        {completed && (
          <OverviewItem
            label="实际结束"
            value={termination.confirmedAt ? formatDateTime(termination.confirmedAt) : "未记录"}
          />
        )}
        <OverviewItem
          label="结束条件"
          value={termination.plannedOutcomeCriteria}
        />
        <OverviewItem
          label="业务说明"
          value={node.businessDescription || "无"}
        />
        {!completed && (
          <OverviewItem
            label="结束结果"
            value={
              termination.outcome
                ? terminationOutcomeLabel(termination.outcome)
                : "未确认"
            }
          />
        )}
      </dl>
      {completed && (
        <section
          className="space-y-3 border-t border-border pt-4"
          data-testid="termination-completion-materials"
        >
          <h3 className="font-medium">实际提交材料</h3>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <OverviewItem
              label="结束结果"
              value={
                termination.outcome
                  ? terminationOutcomeLabel(termination.outcome)
                  : "未确认"
              }
            />
            <OverviewItem label="原因" value={termination.reason || "无"} />
            <OverviewItem label="总结" value={termination.summary || "无"} />
          </dl>
        </section>
      )}
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

function recordString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
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
