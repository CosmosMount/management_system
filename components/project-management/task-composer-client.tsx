"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import { TaskSelect } from "@/components/project-management/task-picker";
import { ProjectSelect } from "@/components/project-management/project-picker";
import { TaskComposerPlanEditor } from "@/components/project-management/task-composer-plan-editor";
import { TaskMemberRolePicker } from "@/components/project-management/task-member-role-picker";
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
import { Textarea } from "@/components/ui/textarea";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  TASK_COMPOSER_START_ID,
  type TaskComposerInspectorDraft,
  type TaskComposerMilestone,
  type TaskComposerMode,
  type TaskComposerSeed,
  type TaskComposerValidationIssue as ValidationIssue,
  type TaskPriorityValue,
} from "@/lib/project-management/composer-contract";
import { taskPriorityLabels } from "@/lib/project-management/labels";
import type {
  GlobalTimeMarkerDto,
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import type {
  TimeCanvasAnchorMoveRequest,
  TimeCanvasAnchorMoveResolution,
} from "@/components/project-management/time-canvas/types";
import {
  LOCAL_DRAFT_SCHEMA_VERSION,
  sanitizeRecoveredComposerState,
  type LocalTaskDraft,
} from "@/components/project-management/task-composer-local-draft";
import {
  NO_LEGAL_ANCHOR_MOVE_MESSAGE,
  applyAnchorMove,
  applyLiveInspectorUpdate,
  inspectorDraftForEntity,
  isLockedRevisionMilestone,
  isMilestoneTimeAvailable,
  isReadOnlyRevisionEntity,
  localMs,
  normalizeComposerSeed,
  reconcileComposerPlanState,
  renderAtMs,
  revisionAnchorTimes,
  resolveAnchorMoveCandidate,
  sortMilestones,
} from "@/components/project-management/task-composer-plan-state";
import {
  actionErrorMessage,
  composerSubmissionFingerprint,
  serverFieldValidationIssue,
  validateComposer,
  type TaskActionError,
} from "@/components/project-management/task-composer-validation";
import { useTaskComposerHistory } from "@/components/project-management/use-task-composer-history";
import { useTaskComposerDraft } from "@/components/project-management/use-task-composer-draft";
import { taskComposerLegacyDraftKeys } from "@/components/project-management/task-composer-legacy-draft-tombstone";
import { useTaskComposerNavigation } from "@/components/project-management/use-task-composer-navigation";
import { submitTaskComposer } from "@/components/project-management/task-composer-submit";
import { routes } from "@/lib/routes";

type PersonOption = PersonOptionDto;
type TaskOption = TaskOptionPage["items"][number];
const CREATE_TASK_COMPOSER_MODE: TaskComposerMode = { kind: "CREATE" };

export function TaskComposerClient({
  accountId,
  deploymentEnvironment,
  initialSeed,
  initialPeople,
  initialTasks,
  initialProjects = [],
  initialGlobalMarkers = [],
  mode = CREATE_TASK_COMPOSER_MODE,
}: {
  accountId: string;
  deploymentEnvironment: string;
  initialSeed: TaskComposerSeed;
  initialPeople: PersonOption[];
  initialTasks: TaskOption[];
  initialProjects?: Array<{ id: string; name: string; avatarPath: string | null }>;
  initialGlobalMarkers?: GlobalTimeMarkerDto[];
  mode?: TaskComposerMode;
}) {
  const router = useRouter();
  const normalizedInitialSeed = useMemo(
    () => normalizeComposerSeed(initialSeed),
    [initialSeed],
  );
  const {
    history,
    state,
    commit: commitHistory,
    commitLiveEdit,
    endLiveEdit,
    redo: redoHistory,
    replacePresent: replaceHistoryPresent,
    reset: resetHistory,
    undo: undoHistory,
  } = useTaskComposerHistory(normalizedInitialSeed);
  const [baselineFingerprint, setBaselineFingerprint] = useState(() =>
    composerSubmissionFingerprint(normalizedInitialSeed),
  );
  const currentFingerprint = useMemo(
    () => composerSubmissionFingerprint(state),
    [state],
  );
  const dirty = currentFingerprint !== baselineFingerprint;
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [storageBusy, setStorageBusy] = useState(false);
  const [cleanDraftCleanupError, setCleanDraftCleanupError] = useState(false);
  const [people, setPeople] = useState<PersonOption[]>(initialPeople);
  const [optionError, setOptionError] = useState("");
  const cleanDraftCleanupPromiseRef = useRef<Promise<boolean> | null>(null);
  const isEditingDraft = mode.kind === "EDIT_DRAFT";
  const isRevisionComposer =
    mode.kind === "CREATE_REVISION" || mode.kind === "RESUBMIT_REVISION";
  const isResubmittingRevision = mode.kind === "RESUBMIT_REVISION";
  const canManageMembers =
    mode.kind === "CREATE" ||
    (mode.kind === "EDIT_DRAFT" && mode.canManageMembers);
  const returnPath =
    mode.kind === "CREATE"
      ? routes.progress.tasks
      : isRevisionComposer
        ? routes.progress.taskRevisions(mode.taskId)
        : routes.progress.taskDetail(mode.taskId);
  const editContext = useMemo<LocalTaskDraft["editContext"]>(
    () =>
      mode.kind === "EDIT_DRAFT"
        ? {
            kind: "EDIT_DRAFT",
            taskId: mode.taskId,
            planVersionId: mode.planVersionId,
            baseLockVersion: mode.expectedLockVersion,
          }
        : mode.kind === "CREATE_REVISION"
          ? {
              kind: "CREATE_REVISION",
              taskId: mode.taskId,
              basePlanVersionId: mode.basePlanVersionId,
              baseLockVersion: mode.baseTaskLockVersion,
            }
          : mode.kind === "RESUBMIT_REVISION"
            ? {
                kind: "RESUBMIT_REVISION",
                taskId: mode.taskId,
                revisionNodeId: mode.revisionNodeId,
                targetPlanUpdatedAt: mode.expectedTargetPlanUpdatedAt,
              }
            : undefined,
    [mode],
  );
  const storageKey = useMemo(
    () =>
      mode.kind === "EDIT_DRAFT"
        ? `task-edit-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:${encodeURIComponent(mode.taskId)}:v1`
        : mode.kind === "CREATE_REVISION"
          ? `revision-create-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:${encodeURIComponent(mode.taskId)}:v1`
          : mode.kind === "RESUBMIT_REVISION"
            ? `revision-resubmit-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:${encodeURIComponent(mode.revisionNodeId)}:v1`
        : `task-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:v${LOCAL_DRAFT_SCHEMA_VERSION}`,
    [accountId, deploymentEnvironment, mode],
  );
  const retiredStorageKeys = useMemo(
    () => taskComposerLegacyDraftKeys({
      accountId,
      deploymentEnvironment,
      isCreateMode: mode.kind === "CREATE",
    }),
    [accountId, deploymentEnvironment, mode.kind],
  );
  const issues = useMemo(
    () => validateComposer(state),
    [state],
  );
  const inspectorDraft = useMemo(
    () => inspectorDraftForEntity(state, state.selectedEntityId),
    [state],
  );
  const inspectorIssues = useMemo(
    () =>
      inspectorDraft
        ? issues.filter((issue) => issue.entityId === inspectorDraft.entityId)
        : [],
    [inspectorDraft, issues],
  );

  const {
    cancelPendingAutoSave,
    cleanupCommittedDraft,
    discardLocalDraft,
    persistLocalDraftNow,
    recovery,
    savedAt,
    setRecovery,
    setSavedAt,
    setStorageReady,
    storageReady,
  } = useTaskComposerDraft({
    dirty,
    editContext,
    retiredStorageKeys,
    setError: setServerError,
    state,
    storageBusy,
    storageKey,
    submitting,
  });

  const {
    bypassBeforeUnloadRef,
    bypassPopStateRef,
    historyGuardRef,
    pendingNavigation,
    preserveDraftOnNavigationRef,
    replaceAfterCollapsingHistoryGuard,
    setPendingNavigation,
    setHistoryGuardActive,
    wasDirtyRef,
  } = useTaskComposerNavigation({
    cleanDraftCleanupError,
    currentFingerprint,
    dirty,
    router,
    setBaselineFingerprint,
    setStatusMessage,
    storageBusy,
    submitting,
  });

  const commit = useCallback(
    (mutator: (current: TaskComposerSeed) => TaskComposerSeed) => {
      commitHistory(mutator);
      setCleanDraftCleanupError(false);
      setServerError("");
      setStatusMessage("");
    },
    [commitHistory],
  );

  const replacePresent = useCallback(
    (mutator: (current: TaskComposerSeed) => TaskComposerSeed) => {
      replaceHistoryPresent(mutator);
      setCleanDraftCleanupError(false);
    },
    [replaceHistoryPresent],
  );

  const updateField = <K extends keyof TaskComposerSeed>(
    key: K,
    value: TaskComposerSeed[K],
  ) => {
    endLiveEdit();
    commit((current) => ({ ...current, [key]: value }));
  };

  const selectEntity = (entityId: string) => {
    if (entityId === state.selectedEntityId) return;
    endLiveEdit();
    replacePresent((current) => ({ ...current, selectedEntityId: entityId }));
  };

  const beginMilestone = (at: string, source?: TaskComposerMilestone) => {
    if (state.milestones.length >= 200) {
      setServerError("单个计划最多 200 个 Milestone。");
      return;
    }
    if (!isMilestoneTimeAvailable(state, at)) {
      setServerError("当前没有可用的分钟级 Milestone 位置，请先调整相邻节点或 Terminal。");
      return;
    }
    const milestone: TaskComposerMilestone = {
      id: `draft-node-${clientId()}`,
      goal: source?.goal ?? "",
      completionCriteria: source?.completionCriteria ?? "",
      expectedCompletedAt: at,
      reviewRequirements: source?.reviewRequirements ?? "",
      businessDescription: source?.businessDescription ?? "",
    };
    commit((current) => {
      const nextState: TaskComposerSeed = {
        ...current,
        milestones: sortMilestones([...current.milestones, milestone]),
        selectedEntityId: milestone.id,
        nodeMeta: {
          ...current.nodeMeta,
          [milestone.id]: {
            lifecycle: "TEMPORARY",
            lastValidAt: at,
          },
        },
      };
      return reconcileComposerPlanState(nextState);
    });
    // Adding a node is a structural history entry. The first field edit starts
    // a separate live-edit segment so undo can restore the blank temporary node
    // without removing it.
    endLiveEdit();
    window.setTimeout(() => document.getElementById(`goal-${milestone.id}`)?.focus(), 0);
  };

  const removeMilestones = (ids: string[]) => {
    const lockedIds = ids.filter((id) => isLockedRevisionMilestone(state, id));
    if (lockedIds.length > 0) {
      setServerError("已完成并承接到候选计划的 Milestone 不能删除。");
      return;
    }
    const existingIds = ids.filter((id) => state.milestones.some((item) => item.id === id));
    if (existingIds.length === 0) return;
    if (!window.confirm(`确认删除选中的 ${existingIds.length} 个 Milestone？`)) return;
    endLiveEdit();
    commit((current) => {
      const remaining = current.milestones.filter((item) => !existingIds.includes(item.id));
      const nextSelection = current.selectedEntityId && existingIds.includes(current.selectedEntityId)
        ? current.termination.id
        : current.selectedEntityId;
      const nodeMeta = { ...current.nodeMeta };
      existingIds.forEach((id) => delete nodeMeta[id]);
      return reconcileComposerPlanState({
        ...current,
        milestones: remaining,
        selectedEntityId: nextSelection,
        nodeMeta,
      });
    });
    setCleanDraftCleanupError(false);
  };

  const updateInspector = (next: TaskComposerInspectorDraft) => {
    if (isReadOnlyRevisionEntity(state, next.entityId)) {
      setServerError("该节点由当前计划承接，只能查看，不能修改。");
      return;
    }
    const mutate = (current: TaskComposerSeed) => applyLiveInspectorUpdate(current, next);
    commitLiveEdit(next.entityId, mutate);
    setCleanDraftCleanupError(false);
    setServerError("");
    setStatusMessage("");
  };

  const moveAnchor = (request: TimeCanvasAnchorMoveRequest) => {
    if (isReadOnlyRevisionEntity(state, request.anchorId)) {
      setServerError("该节点由当前计划承接，只能查看，不能移动。");
      return;
    }
    const result = applyAnchorMove(state, request);
    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    endLiveEdit();
    commit(() => reconcileComposerPlanState(result.state));
  };

  const constrainAnchorMove = (
    request: TimeCanvasAnchorMoveRequest,
  ): TimeCanvasAnchorMoveResolution => {
    const result = resolveAnchorMoveCandidate(state, request);
    const originalAt = renderAtMs(state, request.anchorId);
    const atMs = result.ok ? result.candidateAt : originalAt;
    const blockedMessage = result.ok
      ? result.candidateAt === originalAt && request.atMs !== originalAt
        ? NO_LEGAL_ANCHOR_MOVE_MESSAGE
        : undefined
      : result.message;
    return {
      atMs,
      deltaMs: atMs - originalAt,
      blockedMessage,
    };
  };

  const moveTerminal = (plannedAt: string) => {
    const at = localMs(plannedAt);
    const boundary = Math.max(
      renderAtMs(state, TASK_COMPOSER_START_ID),
      ...state.milestones.map((milestone) => renderAtMs(state, milestone.id)),
      ...revisionAnchorTimes(state),
    );
    if (!Number.isFinite(at) || at <= boundary) {
      setServerError("Terminal 必须严格晚于 Start 和全部 Milestone。");
      return;
    }
    endLiveEdit();
    commit((current) =>
      reconcileComposerPlanState({
        ...current,
        termination: { ...current.termination, plannedAt },
        selectedEntityId: current.termination.id,
      }),
    );
  };

  const undo = () => {
    undoHistory();
    setCleanDraftCleanupError(false);
  };

  const redo = () => {
    redoHistory();
    setCleanDraftCleanupError(false);
  };

  const focusIssue = (issue: ValidationIssue) => {
    if (issue.entityId) {
      selectEntity(issue.entityId);
    }
    window.setTimeout(() => document.getElementById(issue.key)?.focus(), 0);
  };

  const runValidation = () => {
    if (issues[0]) focusIssue(issues[0]);
    setStatusMessage(
      issues.length === 0
        ? isEditingDraft
          ? "内容校验通过，可以保存 Task。"
          : isResubmittingRevision
            ? "候选计划校验通过，可以修改并重新送审。"
            : isRevisionComposer
              ? "候选计划校验通过，可以创建并送审。"
              : "计划校验通过，可以创建 Task 草稿。"
        : `发现 ${issues.length} 个问题。`,
    );
    return issues.length === 0;
  };

  const applyActionError = (error: TaskActionError) => {
    setServerError(actionErrorMessage(error));
    const issue = serverFieldValidationIssue(error.fieldErrors, state);
    if (issue) focusIssue(issue);
  };

  const clearRevertedLocalDraft = useCallback(() => {
    if (cleanDraftCleanupPromiseRef.current) {
      return cleanDraftCleanupPromiseRef.current;
    }
    const cleanup = (async () => {
      setStorageBusy(true);
      setCleanDraftCleanupError(false);
      setServerError("");
      const discarded = await discardLocalDraft();
      if (discarded) {
        wasDirtyRef.current = false;
        setSavedAt(null);
      } else {
        setCleanDraftCleanupError(true);
      }
      return discarded;
    })().finally(() => {
      cleanDraftCleanupPromiseRef.current = null;
      setStorageBusy(false);
    });
    cleanDraftCleanupPromiseRef.current = cleanup;
    return cleanup;
  }, [discardLocalDraft, setSavedAt, wasDirtyRef]);

  useEffect(() => {
    if (dirty) {
      wasDirtyRef.current = true;
      return;
    }
    if (
      !wasDirtyRef.current ||
      preserveDraftOnNavigationRef.current ||
      cleanDraftCleanupError ||
      !storageReady ||
      recovery ||
      submitting ||
      storageBusy
    ) {
      return;
    }
    void clearRevertedLocalDraft();
  }, [
    cleanDraftCleanupError,
    clearRevertedLocalDraft,
    dirty,
    preserveDraftOnNavigationRef,
    recovery,
    storageBusy,
    storageReady,
    submitting,
    wasDirtyRef,
  ]);

  const submit = async () => {
    if (submitting || (isEditingDraft && !dirty) || !runValidation()) return;
    cancelPendingAutoSave();
    setSubmitting(true);
    setServerError("");
    setStatusMessage(
      isEditingDraft
        ? "正在保存 Task…"
        : isResubmittingRevision
          ? "正在修改并重新送审…"
          : isRevisionComposer
            ? "正在创建 Revision 并送审…"
            : "正在创建 Task 草稿…",
    );
    try {
      const result = await submitTaskComposer({
        canManageMembers,
        editContext,
        initialState: normalizedInitialSeed,
        mode,
        state,
      });
      if (!result.ok) {
        if (result.error.code === "INVALID_REVISION_CONTEXT") {
          setServerError(result.error.message);
          return;
        }
        if (result.conflictDraft) {
          const persisted = await persistLocalDraftNow();
          if (persisted) setServerError("");
          setRecovery({
            kind: "INCOMPATIBLE",
            raw: JSON.stringify(result.conflictDraft),
            reason:
              mode.kind === "EDIT_DRAFT"
                ? "Task 已在服务端更新，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。"
                : "Task 或 Revision 候选计划已在服务端变化，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。",
          });
          setStatusMessage("保存冲突，本地修改已保留；不会自动刷新或合并字段。");
          return;
        }
        applyActionError(result.error);
        setStatusMessage(
          mode.kind === "EDIT_DRAFT"
            ? "保存失败，本地修改已保留，可修正后重试。"
            : mode.kind === "RESUBMIT_REVISION"
              ? "重新送审失败，本地修改已保留，可修正后重试。"
              : "创建失败，本地草稿和幂等键已保留，可修正后重试。",
        );
        return;
      }
      try {
        await cleanupCommittedDraft();
      } catch {
        // The business mutation is already committed. Cleanup failure must not
        // turn it into a retry that could confuse the user.
      }
      setStatusMessage(
        isEditingDraft
          ? "Task 已保存，正在返回工作台…"
          : isResubmittingRevision
            ? "Revision 已修改并重新送审，正在返回工作台…"
            : isRevisionComposer
              ? "Revision 已创建并送审，正在返回工作台…"
              : "Task 草稿已创建，正在进入工作台…",
      );
      replaceAfterCollapsingHistoryGuard(result.destination);
    } catch {
      setServerError("网络或服务暂时不可用，请稍后重试。草稿不会被清除。");
      setStatusMessage(
        isEditingDraft
          ? "保存失败，本地修改已保留。"
          : isResubmittingRevision
            ? "重新送审失败，本地修改已保留。"
            : isRevisionComposer
              ? "创建失败，本地草稿和幂等键已保留。"
              : "创建失败，本地草稿和幂等键已保留。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const changeTeam = (team: string) => {
    endLiveEdit();
    commit((current) => ({ ...current, team }));
    setOptionError("");
  };

  return (
    <div
      className="min-w-0"
      data-testid="task-composer"
      data-composer-mode={mode.kind}
    >
      <div className="sticky top-14 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:top-14 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[110rem] flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={storageBusy || cleanDraftCleanupError}
              onClick={() => {
                if (dirty) {
                  setPendingNavigation(returnPath);
                } else if (
                  wasDirtyRef.current &&
                  !preserveDraftOnNavigationRef.current
                ) {
                  void clearRevertedLocalDraft().then((cleared) => {
                    if (!cleared) return;
                    if (historyGuardRef.current) {
                      replaceAfterCollapsingHistoryGuard(returnPath);
                    } else {
                      router.push(returnPath);
                    }
                  });
                } else if (historyGuardRef.current) {
                  replaceAfterCollapsingHistoryGuard(returnPath);
                } else {
                  router.push(returnPath);
                }
              }}
            >
              <ArrowLeft aria-hidden="true" />
              {mode.kind === "CREATE"
                ? "全部 Task"
                : "返回 Task 工作台"}
            </Button>
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {savedAt
                ? storageBusy && !dirty
                  ? "正在清理旧本地草稿…"
                  : `本地已保存 ${formatSavedAt(savedAt)}`
                : dirty
                  ? "等待本地保存"
                  : "尚未修改"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="撤销"
              disabled={history.past.length === 0 || submitting}
              onClick={undo}
            >
              <Undo2 aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="重做"
              disabled={history.future.length === 0 || submitting}
              onClick={redo}
            >
              <Redo2 aria-hidden="true" />
            </Button>
            <Button
              type="button"
              disabled={submitting || (isEditingDraft && !dirty)}
              onClick={submit}
            >
              <Save aria-hidden="true" />
              {submitting
                ? isEditingDraft
                  ? "正在保存…"
                  : isResubmittingRevision
                    ? "正在重新送审…"
                    : isRevisionComposer
                      ? "正在创建并送审…"
                  : "正在创建…"
                : isEditingDraft
                  ? "保存 Task"
                  : isResubmittingRevision
                    ? "修改并重新送审"
                    : isRevisionComposer
                      ? "创建并送审"
                  : "创建 Task 草稿"}
            </Button>
          </div>
        </div>
      </div>

      {recovery?.kind === "VALID" && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[110rem] flex-wrap items-center justify-between gap-3">
            <p>
              检测到 {formatSavedAt(recovery.draft.savedAt)} 保存的未完成草稿。当前页面不会覆盖它。
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const recoveredTask = sanitizeRecoveredComposerState({
                    recovered: recovery.draft.task,
                    authoritative: normalizedInitialSeed,
                    mode,
                    canManageMembers,
                  });
                  resetHistory(recoveredTask);
                  setRecovery(null);
                  setStorageReady(true);
                  setStatusMessage("已恢复本地草稿。");
                }}
              >
                恢复草稿
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={storageBusy}
                onClick={() => {
                  if (storageBusy) return;
                  setStorageBusy(true);
                  void discardLocalDraft()
                    .then((discarded) => {
                      if (!discarded) return;
                      if (mode.kind !== "CREATE") {
                        bypassBeforeUnloadRef.current = true;
                        window.location.reload();
                        return;
                      }
                      setRecovery(null);
                      setStorageReady(true);
                      setSavedAt(null);
                    })
                    .finally(() => setStorageBusy(false));
                }}
              >
                放弃旧草稿
              </Button>
            </div>
          </div>
        </div>
      )}

      {recovery?.kind === "INCOMPATIBLE" && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[110rem] flex-wrap items-center justify-between gap-3">
            <p>{recovery.reason}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => exportLocalDraft(recovery.raw)}
              >
                导出原始草稿
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={storageBusy}
                onClick={() => {
                  if (storageBusy) return;
                  setStorageBusy(true);
                  void discardLocalDraft()
                    .then((discarded) => {
                      if (!discarded) return;
                      if (mode.kind !== "CREATE") {
                        bypassBeforeUnloadRef.current = true;
                        window.location.reload();
                        return;
                      }
                      setRecovery(null);
                      setStorageReady(true);
                      setSavedAt(null);
                    })
                    .finally(() => setStorageBusy(false));
                }}
              >
                {mode.kind !== "CREATE" ? "放弃并加载最新版本" : "安全放弃"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {cleanDraftCleanupError && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-sm sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[110rem] flex-wrap items-center justify-between gap-3">
            <p role="alert">
              已回到服务端基线，但旧本地草稿尚未清除。为避免下次误恢复，请先重试清理。
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={storageBusy}
              onClick={() => void clearRevertedLocalDraft()}
            >
              重试清理本地草稿
            </Button>
          </div>
        </div>
      )}

      <div className="mx-auto flex w-full min-w-0 max-w-[110rem] flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <aside
          className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-5 [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0"
          aria-label="Task 基本信息"
        >
          <ComposerSection title="基本信息" issueCount={countIssues(issues, ["title", "team", "techGroup"])}>
            <Field label="Task 名称" required htmlFor="title">
              <Input
                id="title"
                value={state.title}
                maxLength={200}
                disabled={isRevisionComposer}
                aria-invalid={issues.some((issue) => issue.key === "title")}
                onChange={(event) => updateField("title", event.target.value)}
              />
            </Field>
            <Field label="描述" htmlFor="description">
              <Textarea
                id="description"
                rows={3}
                value={state.description}
                maxLength={8_000}
                disabled={isRevisionComposer}
                onChange={(event) => updateField("description", event.target.value)}
              />
            </Field>
            <Field label="优先级" htmlFor="priority">
              <select
                id="priority"
                className={selectClassName}
                value={state.priority}
                disabled={isRevisionComposer}
                onChange={(event) =>
                  updateField("priority", event.target.value as TaskPriorityValue)
                }
              >
                {(Object.keys(taskPriorityLabels) as TaskPriorityValue[]).map((priority) => (
                  <option key={priority} value={priority}>
                    {taskPriorityLabels[priority]}
                  </option>
                ))}
              </select>
            </Field>
          </ComposerSection>

          <ComposerSection title="组织与分类">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <Field label="车组" required htmlFor="team">
                <select
                  id="team"
                  className={selectClassName}
                  value={state.team}
                  disabled={isRevisionComposer}
                  onChange={(event) => changeTeam(event.target.value)}
                >
                  {TEAM_OPTIONS.map((team) => (
                    <option key={team} value={team}>
                      {team}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="技术组" required htmlFor="techGroup">
                <select
                  id="techGroup"
                  className={selectClassName}
                  value={state.techGroup}
                  disabled={isRevisionComposer}
                  onChange={(event) => updateField("techGroup", event.target.value)}
                >
                  {TECH_GROUP_OPTIONS.map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="关联 Task" htmlFor="related-task">
              <TaskSelect
                inputId="related-task"
                ariaLabel="关联 Task"
                value={state.relatedTaskId}
                onValueChange={(nextValue) => updateField("relatedTaskId", nextValue)}
                initialOptions={initialTasks}
                excludeIds={mode.kind === "CREATE" ? [] : [mode.taskId]}
                placeholder="按标题、描述或拼音首字母搜索"
                clearable
                disabled={isRevisionComposer}
              />
            </Field>
            <Field label="所属 Project" htmlFor="task-project">
              <ProjectSelect inputId="task-project" value={state.projectId ?? null} onValueChange={(projectId) => updateField("projectId", projectId)} initialOptions={initialProjects} disabled={isRevisionComposer} />
            </Field>
          </ComposerSection>

          <ComposerSection title="成员" issueCount={countIssues(issues, ["members"])}>
            <div className="space-y-2" id="members" tabIndex={-1}>
              <TaskMemberRolePicker
                members={state.members}
                people={people}
                scope={
                  mode.kind !== "CREATE"
                    ? { purpose: "TASK_MEMBERS", taskId: mode.taskId }
                    : {
                        purpose: "TASK_CREATE",
                        team: state.team,
                        techGroup: state.techGroup,
                      }
                }
                editable={canManageMembers}
                onChange={(members) => updateField("members", members)}
                onPersonResolved={(person) =>
                  setPeople((current) => mergeOptions(current, [person]))
                }
              />
            </div>
            {!canManageMembers ? (
              <p className="text-xs text-muted-foreground">
                {isRevisionComposer
                  ? "Revision 只调整下方计划节点；Task 基本信息、分类与成员保持只读。"
                  : "你可以编辑 Task 内容和计划，成员与角色为只读。"}
              </p>
            ) : null}
          </ComposerSection>
        </aside>

        <TaskComposerPlanEditor
          state={state}
          globalMarkers={initialGlobalMarkers}
          issues={issues}
          inspectorDraft={inspectorDraft}
          inspectorIssues={inspectorIssues}
          notice={
            serverError || optionError || statusMessage
              ? {
                  message: serverError || optionError || statusMessage,
                  error: Boolean(serverError || optionError),
                }
              : null
          }
          optionLoading={false}
          submitting={submitting}
          submitDisabled={isEditingDraft && !dirty}
          submitLabel={
            isEditingDraft
              ? "保存 Task"
              : isResubmittingRevision
                ? "修改并重新送审"
                : isRevisionComposer
                  ? "创建并送审"
                  : "创建草稿"
          }
          submittingLabel={
            isEditingDraft
              ? "正在保存…"
              : isResubmittingRevision
                ? "正在重新送审…"
                : isRevisionComposer
                  ? "正在创建并送审…"
                  : "正在创建…"
          }
          onSelect={selectEntity}
          onBeginMilestone={beginMilestone}
          onConstrainAnchorMove={constrainAnchorMove}
          onMoveAnchor={moveAnchor}
          onMoveTerminal={moveTerminal}
          onUpdateInspector={updateInspector}
          onDeleteMilestones={removeMilestones}
          onSubmit={submit}
        />
      </div>

      <Dialog
        open={Boolean(pendingNavigation)}
        onOpenChange={(open) => {
          if (!open && !storageBusy) setPendingNavigation(null);
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {isEditingDraft ? "离开 Task 编辑？" : "离开 Task Composer？"}
            </DialogTitle>
            <DialogDescription>
              当前修改尚未提交到服务端。你可以保留本地草稿后离开，或放弃草稿。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={storageBusy}
              onClick={() => setPendingNavigation(null)}
            >
              继续编辑
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={storageBusy}
              onClick={() => {
                const destination = pendingNavigation;
                if (!destination || storageBusy) return;
                setStorageBusy(true);
                void discardLocalDraft()
                  .then((discarded) => {
                    if (!discarded) return;
                    setBaselineFingerprint(currentFingerprint);
                    if (destination === "__HISTORY_BACK__") {
                      bypassPopStateRef.current = true;
                      historyGuardRef.current = false;
                      setHistoryGuardActive(false);
                      window.history.go(-2);
                    } else {
                      replaceAfterCollapsingHistoryGuard(destination);
                    }
                  })
                  .finally(() => setStorageBusy(false));
              }}
            >
              放弃并离开
            </Button>
            <Button
              type="button"
              disabled={storageBusy}
              onClick={() => {
                const destination = pendingNavigation;
                if (!destination || storageBusy) return;
                setStorageBusy(true);
                void persistLocalDraftNow()
                  .then((persisted) => {
                    if (!persisted) return;
                    preserveDraftOnNavigationRef.current = true;
                    setBaselineFingerprint(currentFingerprint);
                    if (destination === "__HISTORY_BACK__") {
                      bypassPopStateRef.current = true;
                      historyGuardRef.current = false;
                      setHistoryGuardActive(false);
                      window.history.go(-2);
                    } else {
                      replaceAfterCollapsingHistoryGuard(destination);
                    }
                  })
                  .finally(() => setStorageBusy(false));
              }}
            >
              保存本地草稿并离开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ComposerSection({
  title,
  issueCount = 0,
  children,
}: {
  title: string;
  issueCount?: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {issueCount > 0 && <Badge variant="destructive">{issueCount}</Badge>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  required = false,
  htmlFor,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}

const selectClassName =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

function formatSavedAt(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(parsed);
}

function exportLocalDraft(raw: string) {
  const blob = new Blob([raw], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `task-composer-unreadable-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function clientId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mergeOptions<T extends { id: string }>(current: T[], incoming: T[]) {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
}

function countIssues(issues: ValidationIssue[], keys: string[]) {
  return issues.filter((issue) => keys.includes(issue.key)).length;
}
