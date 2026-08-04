"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  activateTask,
  replaceTaskMembers,
  replaceTaskTags,
  updateTaskMetadata,
} from "@/app/actions/project-management/tasks";
import {
  approveRevision,
  cancelRevision,
  createRevisionDraft,
  rejectRevision,
  submitRevision,
  updateRevisionDraft,
} from "@/app/actions/project-management/revisions";
import {
  approveMilestoneReview,
  rejectMilestoneReview,
  requireMilestoneRevision,
  submitMilestoneForReview,
} from "@/app/actions/project-management/milestones";
import { confirmTermination } from "@/app/actions/project-management/terminations";
import {
  searchTagOptions,
} from "@/app/actions/project-management/options";
import {
  comparePlanVersions,
  getPlanVersion,
  getTaskLifecycleViews,
} from "@/app/actions/project-management/plans";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { TaskSelect } from "@/components/project-management/task-picker";
import { UserSelect } from "@/components/project-management/user-picker";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import {
  formatDateTime,
  taskMemberRoleLabels,
  taskNodeStatusLabels,
  taskNodeTypeLabels,
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskLifecycleViews } from "@/lib/project-management/queries/task-lifecycle-queries";
import type {
  PlanVersionDiff,
  PlanVersionSummary,
  TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";
import type {
  PersonOptionDto,
  TagOptionPage,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type TabId = "plan" | "overview" | "revisions" | "reviews" | "audit";
type Notice = { kind: "success" | "error" | "info"; message: string } | null;
type PlanVersionListItem = {
  id: string;
  versionNo: number;
  status: string;
  baseVersionId: string | null;
  revisionNodeId: string | null;
  reason: string;
  plannedStartAt: string | null;
  activatedAt: string | null;
  createdAt: string;
};
type RunAction = (
  action: () => Promise<ProjectManagementActionResult<unknown>>,
  successMessage: string,
  onSuccess?: () => void,
) => Promise<void>;
type RevisionDraftMilestone = {
  uiKey: string;
  goal: string;
  completionCriteria: string;
  expectedCompletedAt: string;
  reviewRequirements: string;
  businessDescription: string;
};
type ActiveTaskMemberRole = "OWNER" | "PARTICIPANT";
const activeTaskMemberRoles: ActiveTaskMemberRole[] = ["OWNER", "PARTICIPANT"];

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "plan", label: "计划与资源" },
  { id: "overview", label: "概览" },
  { id: "revisions", label: "修订与历史" },
  { id: "reviews", label: "验收" },
  { id: "audit", label: "审计" },
];

export function TaskWorkbench({
  workspace,
  lifecycle: initialLifecycle,
  planVersions,
  canvasModel,
  canvasError,
  people,
  taskOptions,
  tagOptions,
  initialTab = "plan",
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  planVersions: PlanVersionListItem[];
  canvasModel: TimeCanvasModel | null;
  canvasError: string | null;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  tagOptions: TagOptionPage["items"];
  initialTab?: TabId;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [lifecycleState, setLifecycleState] = useState({
    base: initialLifecycle,
    value: initialLifecycle,
  });
  const lifecycle = lifecycleState.base === initialLifecycle
    ? lifecycleState.value
    : initialLifecycle;
  const setLifecycle = (value: TaskLifecycleViews) => {
    setLifecycleState({ base: initialLifecycle, value });
  };
  const [lockVersionState, setLockVersionState] = useState({
    server: workspace.task.lockVersion,
    current: workspace.task.lockVersion,
  });
  const lockVersion = lockVersionState.server === workspace.task.lockVersion
    ? lockVersionState.current
    : workspace.task.lockVersion;
  const currentWorkspace = lockVersion === workspace.task.lockVersion
    ? workspace
    : { ...workspace, task: { ...workspace.task, lockVersion } };
  const task = currentWorkspace.task;
  const activeMilestone = currentWorkspace.currentPlan.nodes.find(
    (entry) => entry.nodeId === task.activeMilestoneNodeId,
  );
  const termination = workspace.currentPlan.nodes.find((entry) => entry.termination);
  const segmentCount = canvasModel?.segments.filter((entry) => entry.type !== "BUSY").length ?? 0;
  const actualCount = canvasModel?.segments.filter((entry) => entry.type === "ACTUAL").length ?? 0;
  const needsReviewCount = canvasModel?.segments.filter(
    (entry) => entry.associationNeedsReview,
  ).length ?? 0;
  const selectTab = (nextTab: TabId) => {
    setTab(nextTab);
    const url = new URL(window.location.href);
    if (nextTab === "plan") url.searchParams.delete("tab");
    else url.searchParams.set("tab", nextTab);
    window.history.replaceState(window.history.state, "", url);
  };

  const runAction: RunAction = async (action, successMessage, onSuccess) => {
    if (busy) return;
    setBusy(true);
    setNotice({ kind: "info", message: "正在保存…" });
    try {
      const result = await action();
      if (!result.ok) {
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
      onSuccess?.();
      router.refresh();
    } catch {
      setNotice({ kind: "error", message: "网络或服务暂时不可用，未保存任何本地输入。" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="min-w-0 space-y-4"
      data-testid="task-workbench-v1"
      data-server-lock-version={workspace.task.lockVersion}
    >
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={routes.progress.tasks} className="text-sm text-primary hover:underline">
                ← 全部 Task
              </Link>
              <Badge>{taskStatusLabels[task.status]}</Badge>
              <Badge variant="secondary">{taskPriorityLabels[task.priority]}</Badge>
              <Badge variant="outline">计划 v{workspace.currentPlan.versionNo}</Badge>
              {workspace.tags.slice(0, 3).map((tag) => (
                <Badge key={tag.id} variant="outline">{tag.name}</Badge>
              ))}
            </div>
            <p className="mt-3 break-words text-xl font-semibold">{task.title}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {activeMilestone?.milestone
                ? `当前：${activeMilestone.milestone.goal} · ${formatDateTime(activeMilestone.milestone.expectedCompletedAt)} 截止`
                : termination?.termination && termination.status === "ACTIVE"
                  ? `当前：${termination.termination.name} · ${formatDateTime(termination.termination.plannedAt)}`
                : task.status === "DRAFT"
                  ? "草稿计划尚未激活"
                  : "当前没有 Active Milestone"}
            </p>
            {workspace.currentPlan.chronologyCompatibilityIssues.length > 0 && (
              <p className="mt-2 text-sm text-amber-700">
                当前计划包含旧版时间顺序；可继续只读或结束 Task，新建 Draft/Revision 前必须调整为严格递增。
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
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
                    () => activateTask({ taskId: task.id, expectedLockVersion: task.lockVersion }),
                    "Task 已激活。",
                  );
                }}
              >
                激活 Task
              </Button>
            )}
            {task.status === "ACTIVE" && workspace.permissions.canCreateRevision && (
              <Button type="button" onClick={() => selectTab("revisions")}>发起 Revision</Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(window.location.href).then(
                () => setNotice({ kind: "success", message: "工作台链接已复制。" }),
                () => setNotice({ kind: "error", message: "浏览器拒绝复制，请手动复制地址栏链接。" }),
              )}
            >
              复制链接
            </Button>
          </div>
        </div>
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="参与人" value={workspace.members.length} />
          <Metric label="当前窗口投入" value={segmentCount} />
          <Metric label="当前窗口 Actual" value={actualCount} />
          <Metric label="当前窗口关联复核" value={needsReviewCount} alert={needsReviewCount > 0} />
          <Metric label="锁版本" value={task.lockVersion} />
        </div>
      </section>

      <div className="overflow-x-auto rounded-xl border border-border bg-card px-2" aria-label="Task 工作台标签">
        <div className="flex min-w-max gap-1" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={cn(
                "border-b-2 px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === entry.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => selectTab(entry.id)}
            >
              {entry.label}
              {entry.id === "reviews" && lifecycle.reviews.some((item) => item.capabilities.canReview) && " · 待办"}
            </button>
          ))}
        </div>
      </div>

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

      <div role="tabpanel" className="min-w-0">
        {tab === "plan" && (
          <PlanAndResourcesPanel
            workspace={currentWorkspace}
            canvasModel={canvasModel}
            canvasError={canvasError}
            people={people}
            taskOptions={taskOptions}
          />
        )}
        {tab === "overview" && (
          <OverviewPanel
            key={`overview:${workspace.task.lockVersion}`}
            workspace={currentWorkspace}
            people={people}
            taskOptions={taskOptions}
            tagOptions={tagOptions}
            busy={busy}
            runAction={runAction}
          />
        )}
        {tab === "revisions" && (
          <RevisionsPanel
            key={`revisions:${task.lockVersion}:${lifecycle.revisions.length}`}
            workspace={currentWorkspace}
            lifecycle={lifecycle}
            setLifecycle={setLifecycle}
            planVersions={planVersions}
            busy={busy}
            runAction={runAction}
          />
        )}
        {tab === "reviews" && (
          <ReviewsPanel
            key={`reviews:${task.lockVersion}:${lifecycle.reviews.length}`}
            workspace={currentWorkspace}
            lifecycle={lifecycle}
            setLifecycle={setLifecycle}
            terminationNodeId={termination?.nodeId ?? null}
            busy={busy}
            runAction={runAction}
          />
        )}
        {tab === "audit" && (
          <AuditPanel
            taskId={task.id}
            lifecycle={lifecycle}
            setLifecycle={setLifecycle}
          />
        )}
      </div>
    </div>
  );
}

function PlanAndResourcesPanel({
  workspace,
  canvasModel,
  canvasError,
  people,
  taskOptions,
}: {
  workspace: TaskWorkspace;
  canvasModel: TimeCanvasModel | null;
  canvasError: string | null;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
}) {
  const creatableSegmentPersonIds = new Set(
    canvasModel?.rows.flatMap((row) =>
      row.kind === "PERSON" && row.editable ? [row.sourceId] : [],
    ) ?? [],
  );
  const segmentPeople = people.filter(
    (person) =>
      person.status === "ACTIVE" &&
      creatableSegmentPersonIds.has(person.id),
  );
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">当前计划</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              v{workspace.currentPlan.versionNo} · {workspace.currentPlan.nodes.length} 个节点 · 计划开始 {formatDateTime(workspace.currentPlan.plannedStartAt)}
            </p>
          </div>
          {workspace.task.status !== "DRAFT" && (
            <Badge variant="outline">Current Plan 只读，计划语义修改必须走 Revision</Badge>
          )}
        </div>
        {workspace.task.status === "DRAFT" && workspace.permissions.canUpdateMetadata && (
          <p className="mt-3 text-sm text-muted-foreground">
            如需调整 Task 内容或计划，请使用右上角“编辑 Task”。
          </p>
        )}
      </section>

      <ReadOnlyPlan plan={workspace.currentPlan} />

      <section className="min-w-0 space-y-3">
        <div>
          <h2 className="font-semibold">人员投入</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            当前 Task 的 Planned/Actual 与参与人的其他 Busy 占用使用同一安全 DTO。
          </p>
        </div>
        {canvasModel ? (
          <>
            {canvasModel.nextCursor && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" role="status">
                当前工作台显示前 50 行；其余人员请前往
                <Link className="mx-1 underline" href={`${routes.progress.resources}?tasks=${workspace.task.id}`}>资源计划</Link>
                继续分页查看。
              </div>
            )}
            <ResourcePlannerCanvasClient
              initialModel={canvasModel}
              peopleOptions={segmentPeople}
              peopleScope={{
                purpose: "TASK_SEGMENT_CREATE",
                taskId: workspace.task.id,
              }}
              taskOptions={taskOptions}
              defaultPersonId={segmentPeople[0]?.id ?? ""}
              defaultTaskId={workspace.task.id}
              allowIndependent={false}
              initialZoom="DAY"
              mode="TASK_WORKBENCH"
            />
          </>
        ) : (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive" role="alert">
            时间画布加载失败：{canvasError ?? "未知错误"}。计划和生命周期操作仍可使用；请刷新或缩小时间范围后重试。
          </div>
        )}
      </section>
    </div>
  );
}

function ReadOnlyPlan({ plan }: { plan: PlanVersionSummary }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <ol className="space-y-3">
        {plan.nodes.map((entry) => (
          <li key={entry.planVersionNodeId} className="rounded-lg border border-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">#{entry.sequence}</Badge>
              <Badge variant="secondary">{taskNodeTypeLabels[entry.type]}</Badge>
              <Badge variant={entry.status === "ACTIVE" ? "default" : "outline"}>{taskNodeStatusLabels[entry.status]}</Badge>
              {entry.isCarryForward && <Badge variant="outline">Completed 前缀锁定</Badge>}
            </div>
            <h3 className="mt-2 break-words font-medium">
              {entry.milestone?.goal ?? entry.revision?.reason ?? entry.termination?.name}
            </h3>
            {entry.milestone && <p className="mt-1 text-sm text-muted-foreground">截止 {formatDateTime(entry.milestone.expectedCompletedAt)} · {entry.milestone.completionCriteria}</p>}
            {entry.termination && <p className="mt-1 text-sm text-muted-foreground">计划结束 {formatDateTime(entry.termination.plannedAt)}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function OverviewPanel({
  workspace,
  people,
  taskOptions,
  tagOptions,
  busy,
  runAction,
}: {
  workspace: TaskWorkspace;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  tagOptions: TagOptionPage["items"];
  busy: boolean;
  runAction: RunAction;
}) {
  const editable = workspace.task.status === "ACTIVE" && workspace.permissions.canUpdateMetadata;
  const canManageMembers = workspace.task.status === "ACTIVE" && workspace.permissions.canManageMembers;
  const [members, setMembers] = useState(
    workspace.members.flatMap(({ personId, role }) =>
      role === "OWNER" || role === "PARTICIPANT"
        ? [{ personId, role }]
        : [],
    ),
  );
  const [memberPersonId, setMemberPersonId] = useState(people[0]?.id ?? "");
  const [memberRole, setMemberRole] = useState<ActiveTaskMemberRole>("PARTICIPANT");
  const [peopleOptions, setPeopleOptions] = useState(people);
  const [relatedTaskId, setRelatedTaskId] = useState(workspace.task.relatedTaskId);
  const [selectedTags, setSelectedTags] = useState(workspace.tags.map((tag) => tag.id));
  const [tagChoices, setTagChoices] = useState(tagOptions);
  const [tagQuery, setTagQuery] = useState("");
  const [optionLoading, setOptionLoading] = useState(false);
  const [optionError, setOptionError] = useState("");
  const availableTags = [
    ...workspace.tags,
    ...tagChoices.filter((tag) => !workspace.tags.some((current) => current.id === tag.id)),
  ];

  const loadTags = async () => {
    setOptionLoading(true);
    setOptionError("");
    try {
      const result = await searchTagOptions({ query: tagQuery, includeArchived: false, limit: 50 });
      if (!result.ok) return setOptionError(result.error.message);
      setTagChoices(mergeById(tagChoices, result.data.items));
    } catch {
      setOptionError("Tag 搜索失败，请稍后重试。");
    } finally {
      setOptionLoading(false);
    }
  };
  const addMember = () => {
    if (!memberPersonId) {
      setOptionError("请先选择人员。");
      return;
    }
    const selectedPerson = peopleOptions.find(
      (person) => person.id === memberPersonId,
    );
    if (!selectedPerson || selectedPerson.status !== "ACTIVE") {
      setOptionError("该人员已停用或不可用，不能新增角色。");
      return;
    }
    const existing = members.find((entry) => entry.personId === memberPersonId);
    if (
      existing?.role === "OWNER" &&
      memberRole === "PARTICIPANT" &&
      members.filter((entry) => entry.role === "OWNER").length === 1
    ) {
      setOptionError("至少保留一名负责人。");
      return;
    }
    setOptionError("");
    setMembers(
      existing
        ? members.map((entry) =>
            entry.personId === memberPersonId
              ? { ...entry, role: memberRole }
              : entry,
          )
        : [...members, { personId: memberPersonId, role: memberRole }],
    );
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <form
        className="space-y-3 rounded-xl border border-border bg-card p-4"
        aria-label="Task 元数据"
        onSubmit={(event) => {
          event.preventDefault();
          if (!editable) return;
          const form = new FormData(event.currentTarget);
          const input = {
            taskId: workspace.task.id,
            expectedLockVersion: workspace.task.lockVersion,
            title: String(form.get("title") ?? ""),
            description: String(form.get("description") ?? ""),
            team: String(form.get("team") ?? ""),
            techGroup: String(form.get("techGroup") ?? ""),
            priority: String(form.get("priority") ?? "MEDIUM"),
            relatedTaskId: String(form.get("relatedTaskId") ?? "") || null,
          };
          void runAction(
            () => updateTaskMetadata(input),
            "Task 元数据已保存。",
          );
        }}
      >
        <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Task 概览</h2>{!editable && <Badge variant="outline">只读</Badge>}</div>
        <Field label="标题"><Input name="title" defaultValue={workspace.task.title} disabled={!editable} required maxLength={200} /></Field>
        <Field label="描述"><Textarea name="description" defaultValue={workspace.task.description} disabled={!editable} maxLength={8_000} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="车组"><select name="team" defaultValue={workspace.task.team} disabled={!editable} className={selectClass}>{TEAM_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="技术组"><select name="techGroup" defaultValue={workspace.task.techGroup} disabled={!editable} className={selectClass}>{TECH_GROUP_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="优先级"><select name="priority" defaultValue={workspace.task.priority} disabled={!editable} className={selectClass}>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        </div>
        <Field label="关联 Task" htmlFor="overview-related-task">
          <TaskSelect
            inputId="overview-related-task"
            ariaLabel="关联 Task"
            name="relatedTaskId"
            value={relatedTaskId}
            onValueChange={setRelatedTaskId}
            initialOptions={taskOptions}
            excludeIds={[workspace.task.id]}
            disabled={!editable}
            placeholder="按标题、描述或拼音首字母搜索"
          />
        </Field>
        <div className="space-y-2">
          <span className="text-sm font-medium">Tags</span>
          {editable && <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Input aria-label="搜索 Tag" value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} placeholder="按名称搜索首屏外 Tag" /><Button type="button" variant="outline" disabled={optionLoading} onClick={() => void loadTags()}>搜索 Tag</Button></div>}
          <div className="flex flex-wrap gap-2">
            {availableTags.map((tag) => <label key={tag.id} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-sm"><input type="checkbox" checked={selectedTags.includes(tag.id)} disabled={!editable} onChange={(event) => setSelectedTags(event.target.checked ? [...selectedTags, tag.id] : selectedTags.filter((id) => id !== tag.id))} />{tag.name}{tag.isArchived && <span className="text-muted-foreground">（已归档，可移除）</span>}</label>)}
            {availableTags.length === 0 && <span className="text-sm text-muted-foreground">暂无可用 Tag</span>}
          </div>
        </div>
        {editable && <div className="flex gap-2"><Button type="submit" disabled={busy}>保存元数据</Button>{workspace.task.status === "ACTIVE" && <Button type="button" variant="outline" disabled={busy} onClick={() => void runAction(() => replaceTaskTags({ taskId: workspace.task.id, expectedLockVersion: workspace.task.lockVersion, tagIds: selectedTags }), "Task Tags 已保存。")}>单独保存 Tags</Button>}</div>}
        <div className="grid gap-1 border-t border-border pt-3 text-xs text-muted-foreground"><span>创建：{formatDateTime(workspace.task.createdAt)}</span><span>更新：{formatDateTime(workspace.task.updatedAt)}</span><span>开始：{formatDateTime(workspace.task.startedAt)}</span><span>结束：{formatDateTime(workspace.task.endedAt)}</span></div>
      </form>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">成员与角色</h2>{!canManageMembers && <Badge variant="outline">只读</Badge>}</div>
        <div className="space-y-2">
          {members.map((member, index) => {
            const person = peopleOptions.find((item) => item.id === member.personId) ?? workspace.members.find((item) => item.personId === member.personId);
            const lastOwner = member.role === "OWNER" && members.filter((item) => item.role === "OWNER").length === 1;
            return <div key={`${member.personId}:${member.role}`} className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm"><span className="min-w-0 flex-1 truncate">{person?.displayName ?? "成员"}</span><Badge variant="secondary">{taskMemberRoleLabels[member.role]}</Badge>{canManageMembers && <Button type="button" size="sm" variant="ghost" disabled={lastOwner} title={lastOwner ? "至少保留一名负责人" : undefined} onClick={() => setMembers(members.filter((_, itemIndex) => itemIndex !== index))}>移除</Button>}</div>;
          })}
        </div>
        {canManageMembers && (
          <>
            <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
              <UserSelect
                ariaLabel="新增成员人员"
                scope={{ purpose: "TASK_MEMBERS", taskId: workspace.task.id }}
                value={memberPersonId || null}
                onValueChange={(nextValue) => setMemberPersonId(nextValue ?? "")}
                onOptionChange={(option) => {
                  if (option) {
                    setPeopleOptions((current) => mergeById(current, [option]));
                  }
                }}
                initialOptions={peopleOptions}
                placeholder="按姓名或拼音首字母搜索"
              />
              <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as ActiveTaskMemberRole)} className={selectClass} aria-label="新增成员角色">{activeTaskMemberRoles.map((value) => <option key={value} value={value}>{taskMemberRoleLabels[value]}</option>)}</select>
              <Button type="button" variant="outline" onClick={addMember}>添加</Button>
            </div>
            <Button type="button" disabled={busy} onClick={() => void runAction(() => replaceTaskMembers({ taskId: workspace.task.id, expectedLockVersion: workspace.task.lockVersion, members }), "Task 成员已保存。")}>保存成员</Button>
          </>
        )}
        {optionError && <p className="text-sm text-destructive" role="alert">{optionError}</p>}
        <div className="border-t border-border pt-3 text-sm text-muted-foreground">
          <p>可修改元数据：{workspace.permissions.canUpdateMetadata ? "是" : "否"}</p><p>可创建 Revision：{workspace.permissions.canCreateRevision ? "是" : "否"}</p><p>可处理验收：{workspace.permissions.canReviewMilestone ? "是" : "否"}</p><p>可确认结束：{workspace.permissions.canTerminate ? "是" : "否"}</p>
        </div>
      </section>
    </div>
  );
}

function RevisionsPanel({
  workspace,
  lifecycle,
  setLifecycle,
  planVersions,
  busy,
  runAction,
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  setLifecycle: (value: TaskLifecycleViews) => void;
  planVersions: PlanVersionListItem[];
  busy: boolean;
  runAction: RunAction;
}) {
  const revisions = lifecycle.revisions;
  const selectableNodes = workspace.currentPlan.nodes.filter(
    (entry) => (entry.milestone || entry.termination) && entry.status !== "COMPLETED",
  );
  const [revisedFromNodeId, setRevisedFromNodeId] = useState(
    workspace.task.activeMilestoneNodeId ?? selectableNodes[0]?.nodeId ?? "",
  );
  const selectedIndex = workspace.currentPlan.nodes.findIndex((entry) => entry.nodeId === revisedFromNodeId);
  const defaultReplacement = workspace.currentPlan.nodes.slice(Math.max(0, selectedIndex)).flatMap((entry) => entry.milestone ? [{
    uiKey: entry.nodeId,
    goal: entry.milestone.goal,
    completionCriteria: entry.milestone.completionCriteria,
    expectedCompletedAt: isoToShanghaiDateTimeLocal(entry.milestone.expectedCompletedAt),
    reviewRequirements: entry.milestone.reviewRequirements,
    businessDescription: entry.businessDescription,
  }] : []);
  const [replacement, setReplacement] = useState<RevisionDraftMilestone[]>(defaultReplacement);
  const termination = workspace.currentPlan.nodes.find((entry) => entry.termination);
  const [reason, setReason] = useState("");
  const [plannedStartAt, setPlannedStartAt] = useState(isoToShanghaiDateTimeLocal(workspace.currentPlan.plannedStartAt ?? workspace.task.createdAt));
  const [terminationDraft, setTerminationDraft] = useState({
    name: termination?.termination?.name ?? "Terminal",
    plannedAt: isoToShanghaiDateTimeLocal(
      termination?.termination?.plannedAt ??
        addDaysIso(workspace.currentPlan.plannedStartAt ?? workspace.task.createdAt, 1),
    ),
    plannedOutcomeCriteria: termination?.termination?.plannedOutcomeCriteria ?? "",
    businessDescription: termination?.businessDescription ?? "",
  });
  const idempotencyKey = useRef<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [diff, setDiff] = useState<PlanVersionDiff | null>(null);
  const [diffError, setDiffError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editingRevisionId, setEditingRevisionId] = useState<string | null>(null);
  const [editingTargetUpdatedAt, setEditingTargetUpdatedAt] = useState("");

  const resetReplacement = (nodeId: string) => {
    setRevisedFromNodeId(nodeId);
    const index = workspace.currentPlan.nodes.findIndex((entry) => entry.nodeId === nodeId);
    setReplacement(workspace.currentPlan.nodes.slice(Math.max(0, index)).flatMap((entry) => entry.milestone ? [{
      uiKey: entry.nodeId,
      goal: entry.milestone.goal,
      completionCriteria: entry.milestone.completionCriteria,
      expectedCompletedAt: isoToShanghaiDateTimeLocal(entry.milestone.expectedCompletedAt),
      reviewRequirements: entry.milestone.reviewRequirements,
      businessDescription: entry.businessDescription,
    }] : []));
  };

  const beginEditRevision = async (
    revision: TaskLifecycleViews["revisions"][number],
  ) => {
    if (!revision.targetPlanVersionId || !revision.revisedFromNodeId) return;
    setLoadingMore(true);
    setLoadError("");
    try {
      const result = await getPlanVersion(revision.targetPlanVersionId);
      if (!result.ok) return setLoadError(result.error.message);
      const revisionIndex = result.data.nodes.findIndex(
        (entry) => entry.nodeId === revision.taskNodeId,
      );
      if (revisionIndex < 0) return setLoadError("候选计划结构不完整，无法编辑。");
      const editableNodes = result.data.nodes.slice(revisionIndex + 1);
      const nextTermination = editableNodes.find((entry) => entry.termination);
      if (!nextTermination?.termination) {
        return setLoadError("候选计划缺少 Termination，无法编辑。");
      }
      setEditingRevisionId(revision.id);
      setEditingTargetUpdatedAt(result.data.updatedAt);
      setRevisedFromNodeId(revision.revisedFromNodeId);
      setReason(revision.reason);
      setPlannedStartAt(
        isoToShanghaiDateTimeLocal(
          result.data.plannedStartAt ?? workspace.task.createdAt,
        ),
      );
      setReplacement(editableNodes.flatMap((entry) => entry.milestone ? [{
        uiKey: entry.nodeId,
        goal: entry.milestone.goal,
        completionCriteria: entry.milestone.completionCriteria,
        expectedCompletedAt: isoToShanghaiDateTimeLocal(entry.milestone.expectedCompletedAt),
        reviewRequirements: entry.milestone.reviewRequirements,
        businessDescription: entry.businessDescription,
      }] : []));
      setTerminationDraft({
        name: nextTermination.termination.name,
        plannedAt: isoToShanghaiDateTimeLocal(nextTermination.termination.plannedAt),
        plannedOutcomeCriteria: nextTermination.termination.plannedOutcomeCriteria,
        businessDescription: nextTermination.businessDescription,
      });
    } catch {
      setLoadError("候选计划加载失败，请稍后重试。");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-4">
      {workspace.task.status === "ACTIVE" &&
        (workspace.permissions.canCreateRevision || Boolean(editingRevisionId)) && (
        <section className="space-y-3 rounded-xl border border-primary/20 bg-card p-4">
          <div><h2 className="font-semibold">Revision 候选计划{editingRevisionId ? "（编辑已有）" : ""}</h2><p className="mt-1 text-sm text-muted-foreground">Completed 前缀由服务端锁定；Draft 或被驳回的候选计划可整包编辑后再提交。</p></div>
          <Field label="修订起点"><select className={selectClass} value={revisedFromNodeId} disabled={Boolean(editingRevisionId)} onChange={(event) => resetReplacement(event.target.value)}>{selectableNodes.map((entry) => <option key={entry.nodeId} value={entry.nodeId}>{entry.milestone?.goal ?? entry.termination?.name ?? "Terminal"}</option>)}</select></Field>
          <Field label="修订原因"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2_000} /></Field>
          <Field label="计划开始"><Input type="datetime-local" value={plannedStartAt} onChange={(event) => setPlannedStartAt(event.target.value)} /></Field>
          <div className="space-y-3">
            {replacement.map((milestone, index) => <div key={milestone.uiKey} className="grid gap-2 rounded-lg border border-border p-3 md:grid-cols-2"><div className="md:col-span-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">替换 Milestone #{index + 1}</h3><div className="flex gap-1"><Button type="button" size="sm" variant="outline" aria-label={`前移替换 Milestone #${index + 1}`} disabled={index === 0} onClick={() => setReplacement((current) => moveItem(current, index, index - 1))}>前移</Button><Button type="button" size="sm" variant="outline" aria-label={`后移替换 Milestone #${index + 1}`} disabled={index === replacement.length - 1} onClick={() => setReplacement((current) => moveItem(current, index, index + 1))}>后移</Button><Button type="button" size="sm" variant="destructive" aria-label={`删除替换 Milestone #${index + 1}`} onClick={() => setReplacement((current) => current.filter((_, itemIndex) => itemIndex !== index))}>删除</Button></div></div><Field label="目标"><Input aria-label={`替换 Milestone #${index + 1} 目标`} value={milestone.goal} onChange={(event) => setReplacement((current) => patchItem(current, index, { goal: event.target.value }))} /></Field><Field label="预期完成"><Input aria-label={`替换 Milestone #${index + 1} 预期完成`} type="datetime-local" value={milestone.expectedCompletedAt} onChange={(event) => setReplacement((current) => patchItem(current, index, { expectedCompletedAt: event.target.value }))} /></Field><Field label="完成条件"><Textarea aria-label={`替换 Milestone #${index + 1} 完成条件`} value={milestone.completionCriteria} onChange={(event) => setReplacement((current) => patchItem(current, index, { completionCriteria: event.target.value }))} /></Field><Field label="验收要求"><Textarea aria-label={`替换 Milestone #${index + 1} 验收要求`} value={milestone.reviewRequirements} onChange={(event) => setReplacement((current) => patchItem(current, index, { reviewRequirements: event.target.value }))} /></Field><Field label="业务说明" className="md:col-span-2"><Textarea aria-label={`替换 Milestone #${index + 1} 业务说明`} value={milestone.businessDescription} onChange={(event) => setReplacement((current) => patchItem(current, index, { businessDescription: event.target.value }))} /></Field></div>)}
          </div>
          <Button type="button" variant="outline" onClick={() => setReplacement((current) => [...current, { uiKey: newClientKey("revision-milestone"), goal: "", completionCriteria: "", expectedCompletedAt: current.at(-1)?.expectedCompletedAt ?? plannedStartAt, reviewRequirements: "", businessDescription: "" }])}>添加替换 Milestone</Button>
          <div className="grid gap-2 rounded-lg border border-border p-3 md:grid-cols-2"><h3 className="font-medium md:col-span-2">候选 Termination</h3><Field label="名称"><Input aria-label="候选 Termination 名称" value={terminationDraft.name} onChange={(event) => setTerminationDraft((current) => ({ ...current, name: event.target.value }))} /></Field><Field label="计划结束"><Input aria-label="候选 Termination 计划结束" type="datetime-local" value={terminationDraft.plannedAt} onChange={(event) => setTerminationDraft((current) => ({ ...current, plannedAt: event.target.value }))} /></Field><Field label="预期结果"><Input aria-label="候选 Termination 预期结果" value={terminationDraft.plannedOutcomeCriteria} onChange={(event) => setTerminationDraft((current) => ({ ...current, plannedOutcomeCriteria: event.target.value }))} /></Field><Field label="业务说明" className="md:col-span-2"><Textarea aria-label="候选 Termination 业务说明" value={terminationDraft.businessDescription} onChange={(event) => setTerminationDraft((current) => ({ ...current, businessDescription: event.target.value }))} /></Field></div>
          <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !revisedFromNodeId} onClick={() => { const replacementMilestones = replacement.map((entry) => ({ goal: entry.goal, completionCriteria: entry.completionCriteria, expectedCompletedAt: shanghaiDateTimeLocalToIso(entry.expectedCompletedAt), reviewRequirements: entry.reviewRequirements, businessDescription: entry.businessDescription })); const termination = { ...terminationDraft, plannedAt: shanghaiDateTimeLocalToIso(terminationDraft.plannedAt) }; if (editingRevisionId) { void runAction(() => updateRevisionDraft({ revisionNodeId: editingRevisionId, expectedTargetPlanUpdatedAt: editingTargetUpdatedAt, reason, plannedStartAt: shanghaiDateTimeLocalToIso(plannedStartAt), replacementMilestones, termination }), "Revision Draft 已更新。", () => { setEditingRevisionId(null); setEditingTargetUpdatedAt(""); setReason(""); }); return; } idempotencyKey.current ??= `revision-workbench:${globalThis.crypto.randomUUID()}`; void runAction(() => createRevisionDraft({ taskId: workspace.task.id, basePlanVersionId: workspace.currentPlan.id, baseTaskLockVersion: workspace.task.lockVersion, revisedFromNodeId, reason, plannedStartAt: shanghaiDateTimeLocalToIso(plannedStartAt), replacementMilestones, termination, idempotencyKey: idempotencyKey.current }), "Revision Draft 已创建。", () => { idempotencyKey.current = null; setReason(""); }); }}>{editingRevisionId ? "更新 Revision Draft" : "保存 Revision Draft"}</Button>{editingRevisionId && <Button type="button" variant="outline" onClick={() => { setEditingRevisionId(null); setEditingTargetUpdatedAt(""); resetReplacement(workspace.task.activeMilestoneNodeId ?? selectableNodes[0]?.nodeId ?? ""); setReason(""); }}>取消编辑</Button>}</div>
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Revision 历史</h2>
        {revisions.length === 0 && <p className="text-sm text-muted-foreground">暂无 Revision。</p>}
        {revisions.map((revision) => <article key={revision.id} className="space-y-2 rounded-lg border border-border p-3"><div className="flex flex-wrap items-center gap-2"><Badge>{revisionStatusLabel(revision.status)}</Badge>{revision.targetVersionNo && <Badge variant="outline">候选 v{revision.targetVersionNo}</Badge>}<span className="text-sm text-muted-foreground">基线锁 {revision.baseTaskLockVersion}</span></div><h3 className="font-medium">{revision.reason}</h3><p className="text-sm text-muted-foreground">提交 {formatDateTime(revision.submittedAt)} · 审批 {formatDateTime(revision.reviewedAt)} · 生效 {formatDateTime(revision.effectiveAt)}</p>{revision.reviewComment && <p className="text-sm">审批说明：{revision.reviewComment}</p>}<Field label="处理说明"><Input value={comments[revision.id] ?? ""} onChange={(event) => setComments({ ...comments, [revision.id]: event.target.value })} /></Field><div className="flex flex-wrap gap-2">{revision.capabilities.canEdit && <Button type="button" size="sm" variant="outline" disabled={busy || loadingMore} onClick={() => void beginEditRevision(revision)}>编辑候选计划</Button>}{revision.capabilities.canSubmit && <Button type="button" size="sm" disabled={busy} onClick={() => void runAction(() => submitRevision({ revisionNodeId: revision.id, comment: comments[revision.id] ?? "" }), "Revision 已提交。")}>提交审批</Button>}{revision.capabilities.canReview && <><Button type="button" size="sm" disabled={busy} onClick={() => void runAction(() => approveRevision({ revisionNodeId: revision.id, comment: comments[revision.id] ?? "" }), "Revision 已批准并应用。")}>批准</Button><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void runAction(() => rejectRevision({ revisionNodeId: revision.id, comment: comments[revision.id] ?? "" }), "Revision 已驳回。")}>驳回</Button></>}{revision.capabilities.canCancel && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void runAction(() => cancelRevision({ revisionNodeId: revision.id, comment: comments[revision.id] ?? "" }), "Revision 已取消。")}>取消</Button>}{revision.targetPlanVersionId && <Button type="button" size="sm" variant="outline" onClick={() => void comparePlanVersions({ fromPlanVersionId: revision.basePlanVersionId, toPlanVersionId: revision.targetPlanVersionId! }).then((result) => { if (result.ok) { setDiff(result.data); setDiffError(""); } else setDiffError(result.error.message); }).catch(() => setDiffError("版本比较请求失败。"))}>查看三层 Diff</Button>}</div></article>)}
        {loadError && <p className="text-sm text-destructive" role="alert">{loadError}</p>}
        {lifecycle.nextRevisionCursor && <Button type="button" variant="outline" disabled={loadingMore} onClick={() => { setLoadingMore(true); setLoadError(""); void getTaskLifecycleViews({ taskId: workspace.task.id, revisionCursor: lifecycle.nextRevisionCursor, revisionLimit: 50, reviewLimit: 1, auditLimit: 1 }).then((result) => { if (!result.ok) { setLoadError(result.error.message); return; } setLifecycle({ ...lifecycle, revisions: [...lifecycle.revisions, ...result.data.revisions], nextRevisionCursor: result.data.nextRevisionCursor }); }).catch(() => setLoadError("Revision 历史加载失败，请稍后重试。")).finally(() => setLoadingMore(false)); }}>加载更多 Revision</Button>}
      </section>

      {(diff || diffError) && <section className="space-y-2 rounded-xl border border-border bg-card p-4" aria-label="Revision 三层 Diff"><h2 className="font-semibold">结构 / 字段 / 资源 Diff</h2>{diffError && <p className="text-sm text-destructive" role="alert">{diffError}</p>}{diff && <><p className="text-sm">结构：新增 {diff.added.length}、删除 {diff.removed.length}、移动 {diff.moved.length}</p><p className="text-sm">字段：{diff.changed.length} 个节点变化{diff.planChanges.plannedStartAt ? "，计划开始有变化" : ""}</p><p className="text-sm">资源：影响 {diff.resourceImpact.affectedPlannedSegmentCount} 条 Planned，其中 {diff.resourceImpact.associationNeedsReviewCount} 条需关联复核</p></>}</section>}

      <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">计划版本</h2><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{planVersions.map((plan) => <div key={plan.id} className="rounded-lg border border-border p-3 text-sm"><div className="flex gap-2"><Badge variant={plan.id === workspace.currentPlan.id ? "default" : "outline"}>v{plan.versionNo}</Badge><span>{plan.status}</span></div><p className="mt-2 text-muted-foreground">{plan.reason || "初始计划"}</p><p className="mt-1 text-xs text-muted-foreground">{formatDateTime(plan.createdAt)}</p></div>)}</div></section>
    </div>
  );
}

function ReviewsPanel({
  workspace,
  lifecycle,
  setLifecycle,
  terminationNodeId,
  busy,
  runAction,
}: {
  workspace: TaskWorkspace;
  lifecycle: TaskLifecycleViews;
  setLifecycle: (value: TaskLifecycleViews) => void;
  terminationNodeId: string | null;
  busy: boolean;
  runAction: RunAction;
}) {
  const activeMilestone = workspace.currentPlan.nodes.find((entry) => entry.nodeId === workspace.task.activeMilestoneNodeId && entry.milestone);
  const [evidenceKind, setEvidenceKind] = useState<"TEXT" | "LINK">("TEXT");
  const [evidence, setEvidence] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [comments, setComments] = useState<Record<string, string>>({});
  const reviewKey = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<"SUCCESS" | "FAILED" | "CANCELLED" | "TIMEOUT">("SUCCESS");
  const [terminationReason, setTerminationReason] = useState("");
  const [terminationSummary, setTerminationSummary] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");

  return (
    <div className="space-y-4">
      {activeMilestone?.milestone && <section className="space-y-3 rounded-xl border border-border bg-card p-4"><div><h2 className="font-semibold">当前 Milestone 验收</h2><h3 className="mt-2 font-medium">{activeMilestone.milestone.goal}</h3><p className="mt-1 text-sm text-muted-foreground">完成条件：{activeMilestone.milestone.completionCriteria}</p><p className="mt-1 text-sm text-muted-foreground">验收要求：{activeMilestone.milestone.reviewRequirements}</p></div>{workspace.permissions.canSubmitMilestoneReview && <><div className="flex gap-3 text-sm"><label><input type="radio" checked={evidenceKind === "TEXT"} onChange={() => setEvidenceKind("TEXT")} /> 文本证据</label><label><input type="radio" checked={evidenceKind === "LINK"} onChange={() => setEvidenceKind("LINK")} /> 链接证据</label><span className="text-muted-foreground">FILE 暂未启用</span></div><Field label={evidenceKind === "TEXT" ? "文本证据" : "证据链接"}>{evidenceKind === "TEXT" ? <Textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} /> : <Input type="url" value={evidence} onChange={(event) => setEvidence(event.target.value)} />}</Field>{evidenceKind === "LINK" && <Field label="链接说明"><Input value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} /></Field>}<Button type="button" disabled={busy} onClick={() => { reviewKey.current ??= `review-workbench:${globalThis.crypto.randomUUID()}`; void runAction(() => submitMilestoneForReview({ milestoneNodeId: activeMilestone.nodeId, idempotencyKey: reviewKey.current, evidences: evidence ? [evidenceKind === "TEXT" ? { kind: "TEXT", note: evidence, sortOrder: 0 } : { kind: "LINK", externalUrl: evidence, note: evidenceNote, sortOrder: 0 }] : [] }), "Milestone 已提交验收。", () => { reviewKey.current = null; setEvidence(""); setEvidenceNote(""); }); }}>提交验收</Button></>}</section>}

      <section className="space-y-3 rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">验收历史</h2>{lifecycle.reviews.length === 0 && <p className="text-sm text-muted-foreground">暂无验收记录。</p>}{lifecycle.reviews.map((review) => <article key={review.id} className="space-y-2 rounded-lg border border-border p-3"><div className="flex flex-wrap gap-2"><Badge>{reviewResultLabel(review.result)}</Badge><span className="text-sm">{review.milestoneGoal}</span>{review.revokedAt && <Badge variant="outline">已撤销</Badge>}</div><p className="text-sm text-muted-foreground">{review.submittedBy} 提交于 {formatDateTime(review.createdAt)}{review.reviewer ? ` · 审批人 ${review.reviewer}` : ""}</p>{review.comment && <p className="text-sm">审批说明：{review.comment}</p>}<ul className="space-y-1 text-sm">{review.evidences.map((item) => <li key={item.id}>{item.kind === "LINK" && item.externalUrl ? <a href={item.externalUrl} target="_blank" rel="noreferrer" className="text-primary underline">{item.note || item.externalUrl}</a> : <span>{item.kind}：{item.note || "文件证据未启用"}</span>}</li>)}</ul>{review.capabilities.canReview && <><Field label="审批说明"><Textarea value={comments[review.id] ?? ""} onChange={(event) => setComments({ ...comments, [review.id]: event.target.value })} /></Field><div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={busy} onClick={() => void runAction(() => approveMilestoneReview({ reviewId: review.id, comment: comments[review.id] ?? "" }), "验收已通过。")}>通过</Button><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void runAction(() => rejectMilestoneReview({ reviewId: review.id, comment: comments[review.id] ?? "" }), "验收已驳回。")}>驳回</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void runAction(() => requireMilestoneRevision({ reviewId: review.id, comment: comments[review.id] ?? "" }), "已要求修订。")}>要求修订</Button></div></>}</article>)}{loadError && <p className="text-sm text-destructive" role="alert">{loadError}</p>}{lifecycle.nextReviewCursor && <Button type="button" variant="outline" disabled={loadingMore} onClick={() => { setLoadingMore(true); setLoadError(""); void getTaskLifecycleViews({ taskId: workspace.task.id, reviewCursor: lifecycle.nextReviewCursor, reviewLimit: 50, revisionLimit: 1, auditLimit: 1 }).then((result) => { if (!result.ok) { setLoadError(result.error.message); return; } setLifecycle({ ...lifecycle, reviews: [...lifecycle.reviews, ...result.data.reviews], nextReviewCursor: result.data.nextReviewCursor }); }).catch(() => setLoadError("验收历史加载失败，请稍后重试。")).finally(() => setLoadingMore(false)); }}>加载更多验收记录</Button>}</section>

      {workspace.task.status === "ACTIVE" && workspace.permissions.canTerminate && terminationNodeId && <section className="space-y-3 rounded-xl border border-destructive/20 bg-card p-4"><div><h2 className="font-semibold">Termination 确认</h2><p className="mt-1 text-sm text-muted-foreground">成功结束要求全部前置 Milestone 已完成；其余结果必须填写原因。操作会写审计并进入终态。</p></div><Field label="结束结果"><select className={selectClass} value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)}><option value="SUCCESS">成功完成</option><option value="FAILED">失败结束</option><option value="CANCELLED">提前取消</option><option value="TIMEOUT">超时结束</option></select></Field><Field label="原因"><Textarea value={terminationReason} onChange={(event) => setTerminationReason(event.target.value)} /></Field><Field label="总结"><Textarea value={terminationSummary} onChange={(event) => setTerminationSummary(event.target.value)} /></Field><Button type="button" variant="destructive" disabled={busy} onClick={() => { if (!window.confirm(`确认以“${terminationOutcomeLabel(outcome)}”结束 Task？`)) return; void runAction(() => confirmTermination({ taskId: workspace.task.id, terminationNodeId, outcome, reason: terminationReason, summary: terminationSummary, expectedLockVersion: workspace.task.lockVersion }), "Task 已完成 Termination 确认。"); }}>确认结束 Task</Button></section>}
    </div>
  );
}

function AuditPanel({
  taskId,
  lifecycle,
  setLifecycle,
}: {
  taskId: string;
  lifecycle: TaskLifecycleViews;
  setLifecycle: (value: TaskLifecycleViews) => void;
}) {
  const [eventType, setEventType] = useState("");
  const [auditActor, setAuditActor] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async (append: boolean) => {
    setLoading(true);
    setError("");
    try {
      const result = await getTaskLifecycleViews({
        taskId,
        auditCursor: append ? lifecycle.nextAuditCursor ?? undefined : undefined,
        auditLimit: 50,
        auditEventTypes: eventType ? [eventType] : [],
        auditActor: auditActor || undefined,
        reviewLimit: 1,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setLifecycle({
        ...lifecycle,
        audits: append ? [...lifecycle.audits, ...result.data.audits] : result.data.audits,
        nextAuditCursor: result.data.nextAuditCursor,
      });
    } catch {
      setError("审计记录加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div><h2 className="font-semibold">Task 审计</h2><p className="mt-1 text-sm text-muted-foreground">按游标分页；before/after 已在服务端递归脱敏和截断。</p></div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <select className={selectClass} value={eventType} onChange={(event) => setEventType(event.target.value)} aria-label="审计事件类型"><option value="">全部事件</option>{lifecycle.auditFilterOptions.eventTypes.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select className={selectClass} value={auditActor} onChange={(event) => setAuditActor(event.target.value)} aria-label="审计操作者"><option value="">全部操作者</option>{lifecycle.auditFilterOptions.actors.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <Button type="button" variant="outline" disabled={loading} onClick={() => void load(false)}>应用筛选</Button>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <ol className="space-y-3">
        {lifecycle.audits.map((audit) => <li key={audit.id} className="rounded-lg border border-border p-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{audit.action}</Badge><span className="text-sm">{audit.actor}</span><span className="text-xs text-muted-foreground">{formatDateTime(audit.createdAt)}</span></div><p className="mt-2 text-sm">{audit.reason || "无补充原因"}</p><details className="mt-2 text-xs"><summary className="cursor-pointer text-primary">展开脱敏前后值</summary><div className="mt-2 grid min-w-0 gap-2 lg:grid-cols-2"><AuditJson label="Before" value={audit.before} /><AuditJson label="After" value={audit.after} /></div></details></li>)}
      </ol>
      {lifecycle.audits.length === 0 && <p className="text-sm text-muted-foreground">没有符合筛选条件的审计事件。</p>}
      {lifecycle.nextAuditCursor && <Button type="button" variant="outline" disabled={loading} onClick={() => void load(true)}>加载更多</Button>}
    </section>
  );
}

function AuditJson({ label, value }: { label: string; value: unknown }) {
  return <div className="min-w-0 rounded bg-muted p-2"><p className="font-medium">{label}</p><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre></div>;
}

function Metric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return <div className={cn("rounded-lg bg-muted/60 px-3 py-2", alert && "bg-amber-100 text-amber-950")}><span className="block text-xs text-muted-foreground">{label}</span><strong>{value}</strong></div>;
}

function Field({ label, htmlFor, className, children }: { label: string; htmlFor?: string; className?: string; children: React.ReactNode }) {
  if (htmlFor) {
    return <div className={cn("grid gap-1 text-sm", className)}><label htmlFor={htmlFor} className="font-medium">{label}</label>{children}</div>;
  }
  return <label className={cn("grid gap-1 text-sm", className)}><span className="font-medium">{label}</span>{children}</label>;
}

function moveItem<T>(items: T[], from: number, to: number) {
  const result = [...items];
  const [item] = result.splice(from, 1);
  if (item !== undefined) result.splice(to, 0, item);
  return result;
}

function patchItem<T extends object>(items: T[], index: number, patch: Partial<T>) {
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function newClientKey(prefix: string) {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function addDaysIso(value: string, days: number) {
  return new Date(new Date(value).getTime() + days * 86_400_000).toISOString();
}

function actionLockVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("lockVersion" in value)) return null;
  const candidate = value.lockVersion;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0
    ? candidate
    : null;
}

function revisionStatusLabel(status: string) {
  return ({ DRAFT: "草稿", PENDING_APPROVAL: "待审批", APPROVED: "已批准", REJECTED: "已驳回", CANCELLED: "已取消", EFFECTIVE: "已生效" } as Record<string, string>)[status] ?? status;
}

function reviewResultLabel(result: string) {
  return ({ PENDING: "待处理", APPROVED: "已通过", REJECTED: "已驳回", REVISION_REQUIRED: "要求修订" } as Record<string, string>)[result] ?? result;
}

function terminationOutcomeLabel(outcome: string) {
  return ({ SUCCESS: "成功完成", FAILED: "失败结束", CANCELLED: "提前取消", TIMEOUT: "超时结束" } as Record<string, string>)[outcome] ?? outcome;
}

const selectClass = "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
