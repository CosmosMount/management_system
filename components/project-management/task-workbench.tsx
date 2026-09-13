"use client";

import Link from "next/link";
import { TaskUrgeButton } from "@/components/project-management/task-urge-button";
import { ApprovalUrgeButton } from "@/components/project-management/approval-urge-button";
import { TaskDraftLeavePrompt } from "@/components/project-management/task-draft-leave-prompt";
import { NodeDeadline } from "@/components/project-management/node-deadline";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  activateTask,
  deleteTaskDraft,
  updateActiveTask,
} from "@/app/actions/project-management/tasks";
import {
  buildTaskNavigatorNodes,
  TASK_DETAIL_START_ID,
  TaskDetailTimeline,
} from "@/components/project-management/task-detail-timeline";
import {
  OpenRevisionPanel,
  type RunAction,
  SelectedNodeDetail,
} from "@/components/project-management/task-node-details";
import { TaskMemberRolePicker } from "@/components/project-management/task-member-role-picker";
import { TaskSelect } from "@/components/project-management/task-picker";
import {
  Field,
  OverviewItem,
  selectClass,
} from "@/components/project-management/task-workbench-fields";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";
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
import { fieldErrorsFullyHandled } from "@/lib/project-management/field-errors";
import {
  formatDateTime,
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskLifecycleViews } from "@/lib/project-management/queries/task-lifecycle-queries";
import type { TaskWorkspace } from "@/lib/project-management/queries/task-queries";
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
  const [requestedNodeFocus, setRequestedNodeFocus] = useState<{
    nodeId: string | null;
    revision: number;
    urlCenter: string | null;
  }>({ nodeId: null, revision: 0, urlCenter: null });
  const externalTimelineFocusRef = useRef(requestedInitialFocusId);
  useEffect(() => {
    if (externalTimelineFocusRef.current === requestedInitialFocusId) return;
    const timer = window.setTimeout(() => {
      externalTimelineFocusRef.current = requestedInitialFocusId;
      if (requestedInitialFocusId) setRequestedNodeId(initialNodeId);
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
  const pendingRevisionPlanIssue =
    openRevision?.status === "PENDING_APPROVAL"
      ? resolvePendingRevisionPlanIssue(currentWorkspace, openRevision.id)
      : null;
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
    setRequestedNodeFocus((current) => ({
      nodeId: termination.nodeId,
      revision: current.revision + 1,
      urlCenter: new URL(window.location.href).searchParams.get("center"),
    }));
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
      <TaskDraftLeavePrompt key={task.id} taskId={task.id} lockVersion={lockVersion} enabled={task.status === "DRAFT" && workspace.permissions.canActivate} />
      <section
        className="rounded-xl border border-border bg-card p-5"
        data-testid="task-overview"
      >
        <div className="grid min-w-0 gap-x-5 gap-y-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="contents">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={routes.progress.tasks} className="text-sm text-primary hover:underline">
                ← 全部任务
              </Link>
              <Badge>{taskStatusLabels[task.status]}</Badge>
              <Badge variant="secondary">{taskPriorityLabels[task.priority]}</Badge>
              <Badge variant="outline">计划 v{workspace.currentPlan.versionNo}</Badge>
              {task.project && (
                <Link href={routes.progress.projectDetail(task.project.id)} className="text-sm font-medium text-primary hover:underline">
                  项目：{task.project.name}
                </Link>
              )}
            </div>
            <h2 className="min-w-0 text-2xl font-semibold [overflow-wrap:anywhere] lg:col-span-2">{task.title}</h2>
            {task.description && <p className="min-w-0 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere] lg:col-span-2">{task.description}</p>}
            <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2 lg:col-span-2 lg:w-[70%] lg:grid-cols-4 [&_dd]:[overflow-wrap:anywhere]">
              <OverviewItem label="负责人" value={memberNames(workspace, "OWNER")} />
              <OverviewItem label="参与人员" value={memberNames(workspace, "PARTICIPANT")} />
              <OverviewItem label="车组/技术组" value={`${task.team} / ${task.techGroup}`} />
              <OverviewItem label="当前节点" value={<span className="space-y-1"><span>{currentNodeLabel(currentWorkspace)}</span><NodeDeadline target={currentWorkspace.task.currentNodeDeadline} showDate /></span>} />
              <OverviewItem label="计划开始" value={formatDateTime(workspace.currentPlan.plannedStartAt)} />
              <OverviewItem label="计划结束" value={formatDateTime(termination?.termination?.plannedAt ?? null)} />
              <OverviewItem
                label="关联任务"
                value={
                  task.relatedTaskId
                    ? taskOptions.find((option) => option.id === task.relatedTaskId)?.title ?? "已关联"
                    : "未关联"
                }
              />
              <OverviewItem
                label="所属项目"
                value={task.project ? task.project.name : "未设置"}
              />
            </dl>
            {workspace.currentPlan.chronologyCompatibilityIssues.length > 0 && (
              <p className="min-w-0 text-sm text-amber-700 lg:col-span-2">
                当前计划包含旧版时间顺序；可继续只读或结束任务，新建草稿/计划修订前必须调整为严格递增。
              </p>
            )}
          </div>

          <div className="flex min-w-0 flex-wrap gap-2 lg:col-start-2 lg:row-start-1 lg:justify-end" data-testid="task-overview-actions">
            {task.status === "DRAFT" && workspace.permissions.canUpdateMetadata && (
              <Link
                href={routes.progress.taskEdit(task.id)}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                编辑任务
              </Link>
            )}
            {task.status === "DRAFT" && workspace.permissions.canActivate && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("确认激活任务？激活后计划语义只能通过计划修订修改。")) return;
                  void runAction(
                    () => activateTask({ taskId: task.id, expectedLockVersion: lockVersion }),
                    "任务已激活。",
                  );
                }}
              >
                激活任务
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
                      "确定删除这个任务草稿？\n\n删除后将从任务和项目列表中移除，审计记录仍会保留。",
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
                    "任务草稿已删除。",
                    () => router.replace(routes.progress.tasks),
                  );
                }}
              >
                删除草稿
              </Button>
            )}
            {task.status === "ACTIVE" && (
              <TaskUrgeButton taskId={task.id} taskTitle={task.title} disabled={busy}
                onSubmitted={() => setNotice({ kind: "success", message: "催促已提交，飞书消息将由系统投递。" })} />
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
                修改任务基本信息
              </Button>
            )}
            {task.status === "ACTIVE" && workspace.permissions.canCreateRevision && (
              approvalBlocked || openRevision ? (
                <Button type="button" variant="outline" disabled title="当前任务已有待处理事项">
                  发起计划修订
                </Button>
              ) : (
                <Link href={routes.progress.taskRevisionNew(task.id)} className={cn(buttonVariants())}>
                  发起计划修订
                </Link>
              )
            )}
            {task.status === "ACTIVE" &&
              workspace.permissions.canSubmitTerminationReview && termination && (
              <Button
                type="button"
                variant="outline"
                className="border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
                disabled={approvalBlocked}
                title={approvalBlocked ? "当前任务已有待审批事项" : undefined}
                onClick={selectTerminal}
              >
                申请结束任务
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(window.location.href).then(
                  () => setNotice({ kind: "success", message: "任务链接已复制。" }),
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
          <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{approvalGate.pendingApprovalConflict
            ? "当前任务存在多条待审批记录，相关提交与结束操作已暂停，请联系管理员处理。"
            : approvalGate.pendingApproval?.kind === "MILESTONE_REVIEW"
              ? `里程碑「${approvalGate.pendingApproval.title}」正在等待审批。`
              : approvalGate.pendingApproval?.kind === "REVISION"
                ? `计划修订「${approvalGate.pendingApproval.title || "未命名修订"}」正在等待审批。`
                : `结束节点「${approvalGate.pendingApproval?.title || "结束节点"}」的结束申请正在等待审批。`}</span>
          {!approvalGate.pendingApprovalConflict && approvalGate.pendingApproval && (
            <ApprovalUrgeButton kind={approvalGate.pendingApproval.kind} approvalId={approvalGate.pendingApproval.id} disabled={busy} />
          )}
          </div>
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

      <div data-testid="task-plan-view">
        <TaskDetailTimeline
        key={currentWorkspace.task.id}
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
          setRequestedNodeFocus((current) => ({
            nodeId,
            revision: current.revision + 1,
            urlCenter: new URL(window.location.href).searchParams.get("center"),
          }));
        }}
        model={timeCanvasModel}
        people={people}
        taskOptions={taskOptions}
        timelineWindow={timelineWindow}
        focusRequest={requestedNodeFocus}
        pendingRevisionPlanIssue={pendingRevisionPlanIssue}
      />
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[300px_minmax(0,1fr)_300px]" data-testid="task-detail-lower-grid">
        <div className="min-w-0 space-y-4 xl:col-start-2 xl:row-start-1" data-testid="task-detail-main-column">
          <div className="min-w-0 space-y-4" data-testid="task-execution-view">
          {openRevision && (
            <OpenRevisionPanel
              taskId={task.id}
              revision={openRevision}
              busy={busy}
              approvalBlocked={approvalBlocked}
              approvalUnavailableReason={pendingRevisionPlanIssue}
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

          </div>
          <CreateRiskCard targetType="TASK" targetId={task.id} canCreate={collaboration.capabilities.canCreateRisk} />
        </div>
        <aside className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1" data-testid="task-detail-left-column">
          <div data-testid="task-collaboration-view">
            <CollaborationLeftSidebar data={collaboration} />
          </div>
        </aside>
        <aside className="min-w-0 xl:col-start-3 xl:row-start-1" data-testid="task-detail-right-column">
          <div data-testid="task-activity-view">
            <CollaborationRightSidebar data={collaboration} />
          </div>
        </aside>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>修改任务基本信息</DialogTitle>
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
      aria-label="修改任务"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (stale) return;
        const form = new FormData(event.currentTarget);
        const nextErrors: Record<string, string[]> = {};
        if (editable && !String(form.get("title") ?? "").trim()) {
          nextErrors.title = ["请输入任务名称"];
        }
        if (canManageMembers && members.length === 0) {
          nextErrors.members = ["至少添加一名任务成员"];
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
          "任务修改已保存。",
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
        aria-label="任务元数据"
      >
        <h3 className="font-semibold">基本信息</h3>
        <Field label="标题"><Input id="active-task-title" name="title" defaultValue={workspace.task.title} disabled={!editable} required maxLength={200} aria-invalid={Boolean(fieldErrors.title)} aria-describedby={fieldErrors.title ? "active-task-title-error" : undefined} onChange={() => clearFieldError("title")} /><FieldError id="active-task-title-error" messages={fieldErrors.title} /></Field>
        <Field label="描述"><Textarea id="active-task-description" name="description" defaultValue={workspace.task.description} disabled={!editable} maxLength={8_000} aria-invalid={Boolean(fieldErrors.description)} aria-describedby={fieldErrors.description ? "active-task-description-error" : undefined} onChange={() => clearFieldError("description")} /><FieldError id="active-task-description-error" messages={fieldErrors.description} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="车组"><select id="active-task-team" name="team" defaultValue={workspace.task.team} disabled={!editable} className={selectClass} aria-invalid={Boolean(fieldErrors.team)} aria-describedby={fieldErrors.team ? "active-task-team-error" : undefined} onChange={() => clearFieldError("team")}>{TEAM_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select><FieldError id="active-task-team-error" messages={fieldErrors.team} /></Field>
          <Field label="技术组"><select id="active-task-techGroup" name="techGroup" defaultValue={workspace.task.techGroup} disabled={!editable} className={selectClass} aria-invalid={Boolean(fieldErrors.techGroup)} aria-describedby={fieldErrors.techGroup ? "active-task-techGroup-error" : undefined} onChange={() => clearFieldError("techGroup")}>{TECH_GROUP_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select><FieldError id="active-task-techGroup-error" messages={fieldErrors.techGroup} /></Field>
          <Field label="优先级"><select id="active-task-priority" name="priority" defaultValue={workspace.task.priority} disabled={!editable} className={selectClass} aria-invalid={Boolean(fieldErrors.priority)} aria-describedby={fieldErrors.priority ? "active-task-priority-error" : undefined} onChange={() => clearFieldError("priority")}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><FieldError id="active-task-priority-error" messages={fieldErrors.priority} /></Field>
        </div>
        <Field label="关联任务">
          <TaskSelect
            ariaLabel="关联任务"
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
        <Field label="所属项目">
          <ProjectSelect inputId="active-task-project" value={projectId} onValueChange={(value) => { setProjectId(value); clearFieldError("projectId"); }} initialOptions={projectOptions} disabled={!editable} invalid={Boolean(fieldErrors.projectId)} ariaDescribedBy={fieldErrors.projectId ? "active-task-project-error" : undefined} />
          <FieldError id="active-task-project-error" messages={fieldErrors.projectId} />
        </Field>
      </section>

      <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-semibold">成员与角色</h3>
        <TaskMemberRolePicker
          members={members}
          people={peopleOptions}
          focusTargetId="active-task-members"
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

function resolvePendingRevisionPlanIssue(
  workspace: TaskWorkspace,
  revisionNodeId: string,
) {
  if (
    workspace.pendingApprovalConflict ||
    workspace.pendingApproval?.kind !== "REVISION" ||
    workspace.pendingApproval.id !== revisionNodeId ||
    workspace.pendingRevisionPlanComparison?.revisionNodeId !== revisionNodeId
  ) {
    return "待审批计划修订与当前审批状态不一致，无法安全展示修改后计划。";
  }
  return workspace.pendingRevisionPlanComparison.status === "UNAVAILABLE"
    ? workspace.pendingRevisionPlanComparison.message
    : null;
}

function actionLockVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("lockVersion" in value)) return null;
  const candidate = value.lockVersion;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
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
