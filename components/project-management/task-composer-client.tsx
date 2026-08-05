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
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  createTaskDraft,
  updateTaskDraft,
} from "@/app/actions/project-management/tasks";
import {
  createRevision,
  reviseRejectedRevision,
} from "@/app/actions/project-management/revisions";
import {
  listTagOptions,
} from "@/app/actions/project-management/canvas";
import { TaskSelect } from "@/components/project-management/task-picker";
import { TaskComposerPlanEditor } from "@/components/project-management/task-composer-plan-editor";
import { UserSelect } from "@/components/project-management/user-picker";
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
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import {
  taskMemberRoleLabels,
  taskPriorityLabels,
} from "@/lib/project-management/labels";
import type {
  PersonOptionDto,
  TagOptionPage,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import type {
  TimeCanvasAnchorMoveRequest,
  TimeCanvasAnchorMoveResolution,
} from "@/components/project-management/time-canvas/types";
import {
  MAX_TASK_COMPOSER_DRAFT_CHARS,
  canUseIndexedDraftStorage,
  parseIndexedDraftPointer,
  persistTaskComposerDraft,
  readIndexedDraft,
  removeTaskComposerDraft,
  withTaskComposerDraftLock,
} from "@/components/project-management/task-composer-draft-storage";
import { routes } from "@/lib/routes";

const LOCAL_DRAFT_SCHEMA_VERSION = 3;
const MAX_HISTORY = 80;
const DAY_MS = 24 * 60 * 60 * 1_000;
const NO_LEGAL_ANCHOR_MOVE_MESSAGE =
  "当前吸附粒度没有合法位置，节点已保留在原处；请放大画布或使用 Inspector 精调。";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskMemberRoles = ["OWNER", "PARTICIPANT"] as const;
type TaskMemberRoleValue = (typeof taskMemberRoles)[number];
type LegacyTaskMemberRoleValue = "LEAD" | "MEMBER" | "REVIEWER" | "VIEWER";
type TaskPriorityValue = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export const TASK_COMPOSER_START_ID = "task-composer-start";

export type TaskComposerMilestone = {
  id: string;
  goal: string;
  completionCriteria: string;
  expectedCompletedAt: string;
  reviewRequirements: string;
  businessDescription: string;
};

export type TaskComposerNodeMeta = {
  lifecycle: "TEMPORARY" | "ESTABLISHED";
  lastValidAt: string;
};

export type TaskComposerRevisionAnchor = {
  id: string;
  reason: string;
  revisionAt: string;
  status: string;
};

export type TaskComposerRevisionContext = {
  markerId: string;
  reason: string;
  revisionAt: string;
  reviewRound: number;
  lockedMilestoneIds: string[];
  carriedAnchors: TaskComposerRevisionAnchor[];
};

export type TaskComposerSeed = {
  draftId: string;
  title: string;
  description: string;
  team: string;
  techGroup: string;
  priority: TaskPriorityValue;
  tagIds: string[];
  relatedTaskId: string | null;
  members: Array<{ personId: string; role: TaskMemberRoleValue }>;
  plannedStartAt: string;
  milestones: TaskComposerMilestone[];
  termination: {
    id: string;
    name: string;
    plannedAt: string;
    plannedOutcomeCriteria: string;
    businessDescription: string;
  };
  selectedEntityId: string | null;
  revision?: TaskComposerRevisionContext;
  /** Composer-only presentation state. It is never included in the server payload. */
  nodeMeta?: Record<string, TaskComposerNodeMeta>;
};

export type TaskComposerInspectorDraft =
  | {
      kind: "START";
      entityId: typeof TASK_COMPOSER_START_ID;
      plannedStartAt: string;
      returnEntityId: string | null;
    }
  | {
      kind: "MILESTONE";
      entityId: string;
      milestone: TaskComposerMilestone;
      isNew: boolean;
      returnEntityId: string | null;
    }
  | {
      kind: "TERMINATION";
      entityId: string;
      termination: TaskComposerSeed["termination"];
      returnEntityId: string | null;
    }
  | {
      kind: "REVISION";
      entityId: string;
      revision: TaskComposerRevisionAnchor;
      isCurrent: boolean;
      returnEntityId: string | null;
    };

type ComposerHistory = {
  past: TaskComposerSeed[];
  present: TaskComposerSeed;
  future: TaskComposerSeed[];
};

export type ValidationIssue = {
  key: string;
  message: string;
  entityId?: string;
};

type LocalTaskDraft = {
  schemaVersion: 3;
  draftId: string;
  savedAt: string;
  task: TaskComposerSeed;
  inspectorDraft: TaskComposerInspectorDraft | null;
  inspectorDirty: boolean;
  editContext?:
    | {
        kind: "EDIT_DRAFT";
        taskId: string;
        planVersionId: string;
        baseLockVersion: number;
      }
    | {
        kind: "CREATE_REVISION";
        taskId: string;
        basePlanVersionId: string;
        baseLockVersion: number;
      }
    | {
        kind: "RESUBMIT_REVISION";
        taskId: string;
        revisionNodeId: string;
        targetPlanUpdatedAt: string;
      };
};

type LocalDraftRecovery =
  | { kind: "VALID"; draft: LocalTaskDraft }
  | { kind: "INCOMPATIBLE"; raw: string; reason: string };

type PersonOption = PersonOptionDto;
type TaskOption = TaskOptionPage["items"][number];
type TagOption = TagOptionPage["items"][number];
type TaskActionError = {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export type TaskComposerMode =
  | { kind: "CREATE" }
  | {
      kind: "EDIT_DRAFT";
      taskId: string;
      planVersionId: string;
      expectedLockVersion: number;
      existingNodeIds: string[];
      canManageMembers: boolean;
      preservedLegacyMembers?: Array<{
        personId: string;
        role: LegacyTaskMemberRoleValue;
      }>;
    }
  | {
      kind: "CREATE_REVISION";
      taskId: string;
      basePlanVersionId: string;
      baseVersionNo: number;
      baseTaskLockVersion: number;
    }
  | {
      kind: "RESUBMIT_REVISION";
      taskId: string;
      revisionNodeId: string;
      basePlanVersionId: string;
      baseVersionNo: number;
      baseTaskLockVersion: number;
      targetVersionNo: number;
      expectedTargetPlanUpdatedAt: string;
    };

const CREATE_TASK_COMPOSER_MODE: TaskComposerMode = { kind: "CREATE" };

export function TaskComposerClient({
  accountId,
  deploymentEnvironment,
  initialSeed,
  initialPeople,
  initialTasks,
  initialTags,
  actorPersonId,
  mode = CREATE_TASK_COMPOSER_MODE,
}: {
  accountId: string;
  deploymentEnvironment: string;
  initialSeed: TaskComposerSeed;
  initialPeople: PersonOption[];
  initialTasks: TaskOption[];
  initialTags: TagOption[];
  actorPersonId: string;
  mode?: TaskComposerMode;
}) {
  const router = useRouter();
  const normalizedInitialSeed = useMemo(
    () => normalizeComposerSeed(initialSeed),
    [initialSeed],
  );
  const [history, setHistory] = useState<ComposerHistory>({
    past: [],
    present: normalizedInitialSeed,
    future: [],
  });
  const state = history.present;
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
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<LocalDraftRecovery | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [cleanDraftCleanupError, setCleanDraftCleanupError] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const [historyGuardActive, setHistoryGuardActive] = useState(false);
  const [people, setPeople] = useState<PersonOption[]>(initialPeople);
  const [tags, setTags] = useState<TagOption[]>(initialTags);
  const [tagQuery, setTagQuery] = useState("");
  const [optionError, setOptionError] = useState("");
  const [optionLoading, setOptionLoading] = useState(false);
  const [memberPersonId, setMemberPersonId] = useState(
    () => {
      const ownerId = initialSeed.members.find(
        (member) => member.role === "OWNER",
      )?.personId;
      return (
        initialPeople.find(
          (person) => person.id === ownerId && person.status === "ACTIVE",
        )?.id ??
        initialPeople.find((person) => person.status === "ACTIVE")?.id ??
        ""
      );
    },
  );
  const [memberRole, setMemberRole] =
    useState<TaskMemberRoleValue>("PARTICIPANT");
  const historyGuardRef = useRef(false);
  const bypassPopStateRef = useRef(false);
  const bypassBeforeUnloadRef = useRef(false);
  const wasDirtyRef = useRef(false);
  const preserveDraftOnNavigationRef = useRef(false);
  const cleanDraftCleanupPromiseRef = useRef<Promise<boolean> | null>(null);
  const draftWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const autoSaveTimerRef = useRef<number | null>(null);
  const liveEditEntityRef = useRef<string | null>(null);
  const isEditingDraft = mode.kind === "EDIT_DRAFT";
  const isRevisionComposer =
    mode.kind === "CREATE_REVISION" || mode.kind === "RESUBMIT_REVISION";
  const isResubmittingRevision = mode.kind === "RESUBMIT_REVISION";
  const preservedLegacyMembers =
    mode.kind === "EDIT_DRAFT" ? (mode.preservedLegacyMembers ?? []) : [];
  const canManageMembers =
    mode.kind === "CREATE" ||
    (mode.kind === "EDIT_DRAFT" &&
      mode.canManageMembers &&
      preservedLegacyMembers.length === 0);
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
  const legacyStorageKeyV1 = useMemo(
    () =>
      mode.kind === "CREATE"
        ? `task-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:v1`
        : null,
    [accountId, deploymentEnvironment, mode.kind],
  );
  const legacyStorageKeyV2 = useMemo(
    () =>
      mode.kind === "CREATE"
        ? `task-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:v2`
        : null,
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

  const queueDraftWrite = useCallback(
    (draft: LocalTaskDraft) => {
      const raw = JSON.stringify(draft);
      const write = draftWriteChainRef.current
        .catch(() => undefined)
        .then(() =>
          persistTaskComposerDraft({
            storageKey,
            raw,
            draftId: draft.draftId,
            savedAt: draft.savedAt,
          }),
        );
      draftWriteChainRef.current = write.catch(() => undefined);
      return write;
    },
    [storageKey],
  );
  const cancelPendingAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current === null) return;
    window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = null;
  }, []);

  const replaceAfterCollapsingHistoryGuard = useCallback(
    (destination: string) => {
      setPendingNavigation(null);
      setBaselineFingerprint(currentFingerprint);
      if (!historyGuardRef.current) {
        setHistoryGuardActive(false);
        router.replace(destination);
        return;
      }

      const finishNavigation = () => {
        historyGuardRef.current = false;
        setHistoryGuardActive(false);
        bypassBeforeUnloadRef.current = true;
        window.location.replace(destination);
      };
      window.addEventListener("popstate", finishNavigation, { once: true });
      bypassPopStateRef.current = true;
      window.history.back();
    },
    [currentFingerprint, router],
  );

  const commit = useCallback(
    (mutator: (current: TaskComposerSeed) => TaskComposerSeed) => {
      setHistory((current) => ({
        past: [...current.past.slice(-(MAX_HISTORY - 1)), current.present],
        present: mutator(current.present),
        future: [],
      }));
      setCleanDraftCleanupError(false);
      setServerError("");
      setStatusMessage("");
    },
    [],
  );

  const replacePresent = useCallback(
    (mutator: (current: TaskComposerSeed) => TaskComposerSeed) => {
      setHistory((current) => ({
        ...current,
        present: mutator(current.present),
      }));
      setCleanDraftCleanupError(false);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let preservedRaw: string | null = null;
        let unavailableReason = "";
        try {
          await withTaskComposerDraftLock(storageKey, async () => {
            const currentRaw = window.localStorage.getItem(storageKey);
            const legacyRawV2 = currentRaw || !legacyStorageKeyV2
              ? null
              : window.localStorage.getItem(legacyStorageKeyV2);
            const legacyRawV1 = currentRaw || legacyRawV2 || !legacyStorageKeyV1
              ? null
              : window.localStorage.getItem(legacyStorageKeyV1);
            preservedRaw = currentRaw ?? legacyRawV2 ?? legacyRawV1;

            let parsed: LocalTaskDraft | null = null;
            if (currentRaw) {
              const pointer = parseIndexedDraftPointer(currentRaw);
              if (pointer) {
                const indexedRaw = await readIndexedDraft(storageKey);
                preservedRaw = indexedRaw ?? currentRaw;
                parsed = indexedRaw ? parseLocalDraft(indexedRaw) : null;
                if (
                  parsed &&
                  (parsed.draftId !== pointer.draftId ||
                    parsed.savedAt !== pointer.savedAt ||
                    indexedRaw?.length !== pointer.serializedChars)
                ) {
                  parsed = null;
                }
                if (!indexedRaw) {
                  unavailableReason = "本地草稿索引存在，但大草稿内容缺失或不可读取。";
                }
              } else {
                parsed = parseLocalDraft(currentRaw);
              }
            } else if (legacyRawV2) {
              parsed = migrateLegacyLocalDraft(legacyRawV2, actorPersonId, 2);
            } else if (legacyRawV1) {
              parsed = migrateLegacyLocalDraft(legacyRawV1, actorPersonId, 1);
            } else if (canUseIndexedDraftStorage()) {
              const indexedRaw = await readIndexedDraft(storageKey);
              if (indexedRaw) {
                preservedRaw = indexedRaw;
                parsed = parseLocalDraft(indexedRaw);
              }
            }

            if (cancelled) return;
            const contextError = parsed
              ? localDraftContextError(parsed, editContext)
              : null;
            if (parsed && !contextError) {
              setRecovery({ kind: "VALID", draft: parsed });
              setSavedAt(parsed.savedAt);
            } else if (preservedRaw) {
              setRecovery({
                kind: "INCOMPATIBLE",
                raw: preservedRaw,
                reason:
                  unavailableReason ||
                  contextError ||
                  "草稿版本、结构或字段不兼容，未自动覆盖或删除原始内容。",
              });
            } else {
              setStorageReady(true);
            }
          });
        } catch {
          if (cancelled) return;
          if (preservedRaw) {
            setRecovery({
              kind: "INCOMPATIBLE",
              raw: preservedRaw,
              reason: "浏览器无法读取本地大草稿；原始索引仍保留，未自动覆盖或删除。",
            });
          } else {
            setStorageReady(true);
            setServerError("浏览器本地草稿不可用；你仍可创建 Task，但刷新后内容可能丢失。");
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [actorPersonId, editContext, legacyStorageKeyV1, legacyStorageKeyV2, storageKey]);

  useEffect(() => {
    if (!storageReady || recovery || !dirty || submitting || storageBusy) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      const saved = new Date().toISOString();
      const envelope: LocalTaskDraft = {
        schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
        draftId: state.draftId,
        savedAt: saved,
        task: state,
        inspectorDraft: null,
        inspectorDirty: false,
        ...(editContext ? { editContext } : {}),
      };
      void queueDraftWrite(envelope)
        .then(() => {
          if (!cancelled) setSavedAt(saved);
        })
        .catch(() => {
          if (!cancelled) {
            setServerError("本地草稿保存失败，请不要刷新页面并尽快复制重要内容。");
          }
        });
    }, 700);
    autoSaveTimerRef.current = timer;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (autoSaveTimerRef.current === timer) {
        autoSaveTimerRef.current = null;
      }
    };
  }, [dirty, editContext, queueDraftWrite, recovery, state, storageBusy, storageReady, submitting]);

  useEffect(() => {
    if ((!dirty && !historyGuardActive) || submitting) return;
    if (dirty && !historyGuardRef.current) {
      const currentHistoryState = window.history.state as {
        taskComposerGuard?: boolean;
      } | null;
      if (currentHistoryState?.taskComposerGuard !== true) {
        window.history.pushState(
          { ...(currentHistoryState ?? {}), taskComposerGuard: true },
          "",
          window.location.href,
        );
      }
      historyGuardRef.current = true;
      setHistoryGuardActive(true);
    }
    const shouldBlockUnload =
      dirty ||
      storageBusy ||
      cleanDraftCleanupError ||
      (wasDirtyRef.current && !preserveDraftOnNavigationRef.current);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (bypassBeforeUnloadRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const interceptLinks = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.href === window.location.href) return;
      event.preventDefault();
      if (
        storageBusy ||
        cleanDraftCleanupError ||
        (!dirty &&
          wasDirtyRef.current &&
          !preserveDraftOnNavigationRef.current)
      ) {
        setStatusMessage("请先等待或重试清理旧本地草稿。");
        return;
      }
      const destination = `${url.pathname}${url.search}${url.hash}`;
      if (dirty) {
        setPendingNavigation(destination);
      } else {
        replaceAfterCollapsingHistoryGuard(destination);
      }
    };
    const interceptHistory = () => {
      if (bypassPopStateRef.current) {
        bypassPopStateRef.current = false;
        return;
      }
      if (
        storageBusy ||
        cleanDraftCleanupError ||
        (!dirty &&
          wasDirtyRef.current &&
          !preserveDraftOnNavigationRef.current)
      ) {
        window.history.pushState(
          { ...(window.history.state ?? {}), taskComposerGuard: true },
          "",
          window.location.href,
        );
        historyGuardRef.current = true;
        setStatusMessage("请先等待或重试清理旧本地草稿。");
        return;
      }
      if (!dirty) {
        historyGuardRef.current = false;
        setHistoryGuardActive(false);
        bypassPopStateRef.current = true;
        window.history.back();
        return;
      }
      window.history.pushState(
        { ...(window.history.state ?? {}), taskComposerGuard: true },
        "",
        window.location.href,
      );
      historyGuardRef.current = true;
      setPendingNavigation("__HISTORY_BACK__");
    };
    if (shouldBlockUnload) window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", interceptHistory);
    document.addEventListener("click", interceptLinks, true);
    return () => {
      if (shouldBlockUnload) window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", interceptHistory);
      document.removeEventListener("click", interceptLinks, true);
    };
  }, [
    cleanDraftCleanupError,
    dirty,
    historyGuardActive,
    replaceAfterCollapsingHistoryGuard,
    storageBusy,
    submitting,
  ]);

  const updateField = <K extends keyof TaskComposerSeed>(
    key: K,
    value: TaskComposerSeed[K],
  ) => {
    liveEditEntityRef.current = null;
    commit((current) => ({ ...current, [key]: value }));
  };

  const selectEntity = (entityId: string) => {
    if (entityId === state.selectedEntityId) return;
    liveEditEntityRef.current = null;
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
    liveEditEntityRef.current = null;
    window.setTimeout(() => document.getElementById(`goal-${milestone.id}`)?.focus(), 0);
  };

  const duplicateMilestone = (source: TaskComposerMilestone) => {
    if (isLockedRevisionMilestone(state, source.id)) {
      setServerError("已承接的 Milestone 为只读，不能复制或修改。");
      return;
    }
    const savedSource =
      state.milestones.find((milestone) => milestone.id === source.id) ?? source;
    const duplicateAt = suggestDuplicateAt(state, savedSource.id);
    if (!duplicateAt) {
      setServerError("原节点之后没有合法的分钟级位置，请先移动相邻节点或 Terminal 后再复制。");
      return;
    }
    beginMilestone(duplicateAt, savedSource);
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
    liveEditEntityRef.current = null;
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
    if (liveEditEntityRef.current === next.entityId) {
      replacePresent(mutate);
    } else {
      liveEditEntityRef.current = next.entityId;
      commit(mutate);
    }
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
    liveEditEntityRef.current = null;
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
    liveEditEntityRef.current = null;
    commit((current) =>
      reconcileComposerPlanState({
        ...current,
        termination: { ...current.termination, plannedAt },
        selectedEntityId: current.termination.id,
      }),
    );
  };

  const undo = () => {
    liveEditEntityRef.current = null;
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future].slice(0, MAX_HISTORY),
      };
    });
    setCleanDraftCleanupError(false);
  };

  const redo = () => {
    liveEditEntityRef.current = null;
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, current.present].slice(-MAX_HISTORY),
        present: next,
        future: current.future.slice(1),
      };
    });
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

  const persistLocalDraftNow = async () => {
    cancelPendingAutoSave();
    const saved = new Date().toISOString();
    try {
      await queueDraftWrite({
        schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
        draftId: state.draftId,
        savedAt: saved,
        task: state,
        inspectorDraft: null,
        inspectorDirty: false,
        ...(editContext ? { editContext } : {}),
      });
      setSavedAt(saved);
      return true;
    } catch {
      setServerError("本地草稿保存失败，页面仍停留在 Composer，请不要刷新。");
      return false;
    }
  };

  const discardLocalDraft = useCallback(async () => {
    cancelPendingAutoSave();
    try {
      await draftWriteChainRef.current.catch(() => undefined);
      await removeTaskComposerDraft(storageKey, [
        ...[legacyStorageKeyV1, legacyStorageKeyV2].filter(
          (key): key is string => Boolean(key),
        ),
      ]);
      return true;
    } catch {
      setServerError("浏览器拒绝删除本地草稿；为避免旧草稿再次出现，当前不会离开页面。");
      return false;
    }
  }, [cancelPendingAutoSave, legacyStorageKeyV1, legacyStorageKeyV2, storageKey]);

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
  }, [discardLocalDraft]);

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
    recovery,
    storageBusy,
    storageReady,
    submitting,
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
      const commonPayload = {
        title: state.title,
        description: state.description,
        team: state.team,
        techGroup: state.techGroup,
        priority: state.priority,
        tagIds: state.tagIds,
        relatedTaskId: state.relatedTaskId,
        plannedStartAt: shanghaiDateTimeLocalToIso(state.plannedStartAt),
      };
      let destination: string;
      if (mode.kind === "CREATE") {
        const result = await createTaskDraft({
          ...commonPayload,
          members: state.members,
          milestones: sortMilestones(state.milestones).map((milestone) => ({
            goal: milestone.goal,
            completionCriteria: milestone.completionCriteria,
            expectedCompletedAt: shanghaiDateTimeLocalToIso(
              milestone.expectedCompletedAt,
            ),
            reviewRequirements: milestone.reviewRequirements,
            businessDescription: milestone.businessDescription,
          })),
          termination: {
            name: state.termination.name,
            plannedAt: shanghaiDateTimeLocalToIso(state.termination.plannedAt),
            plannedOutcomeCriteria: state.termination.plannedOutcomeCriteria,
            businessDescription: state.termination.businessDescription,
          },
          idempotencyKey: `task-composer:${state.draftId}`,
        });
        if (!result.ok) {
          applyActionError(result.error);
          setStatusMessage(
            "创建失败，本地草稿和幂等键已保留，可修正后重试。",
          );
          return;
        }
        destination = `${routes.progress.taskDetail(result.data.taskId)}?created=1`;
      } else if (mode.kind === "EDIT_DRAFT") {
        const existingNodeIds = new Set(mode.existingNodeIds);
        const membersChanged =
          memberSubmissionFingerprint(state.members) !==
          memberSubmissionFingerprint(normalizedInitialSeed.members);
        const nodeIdentity = (id: string) =>
          existingNodeIds.has(id) ? { nodeId: id } : { clientKey: id };
        const result = await updateTaskDraft({
          ...commonPayload,
          taskId: mode.taskId,
          planVersionId: mode.planVersionId,
          expectedLockVersion: mode.expectedLockVersion,
          ...(canManageMembers && membersChanged
            ? { members: state.members }
            : {}),
          milestones: sortMilestones(state.milestones).map((milestone) => ({
            ...nodeIdentity(milestone.id),
            goal: milestone.goal,
            completionCriteria: milestone.completionCriteria,
            expectedCompletedAt: shanghaiDateTimeLocalToIso(
              milestone.expectedCompletedAt,
            ),
            reviewRequirements: milestone.reviewRequirements,
            businessDescription: milestone.businessDescription,
          })),
          termination: {
            ...nodeIdentity(state.termination.id),
            name: state.termination.name,
            plannedAt: shanghaiDateTimeLocalToIso(state.termination.plannedAt),
            plannedOutcomeCriteria: state.termination.plannedOutcomeCriteria,
            businessDescription: state.termination.businessDescription,
          },
        });
        if (!result.ok) {
          if (result.error.code === "STALE_TASK") {
            const exportedDraft: LocalTaskDraft = {
              schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
              draftId: state.draftId,
              savedAt: new Date().toISOString(),
              task: state,
              inspectorDraft: null,
              inspectorDirty: false,
              ...(editContext ? { editContext } : {}),
            };
            const persisted = await persistLocalDraftNow();
            if (persisted) setServerError("");
            setRecovery({
              kind: "INCOMPATIBLE",
              raw: JSON.stringify(exportedDraft),
              reason:
                "Task 已在服务端更新，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。",
            });
            setStatusMessage(
              "保存冲突，本地修改已保留；不会自动刷新或合并字段。",
            );
            return;
          }
          applyActionError(result.error);
          setStatusMessage("保存失败，本地修改已保留，可修正后重试。");
          return;
        }
        destination = routes.progress.taskDetail(mode.taskId);
      } else {
        if (!state.revision) {
          setServerError("Revision 编辑上下文缺失，请刷新后重试。");
          return;
        }
        const lockedMilestoneIds = new Set(
          normalizedInitialSeed.revision?.lockedMilestoneIds ?? [],
        );
        const replacementMilestones = sortMilestones(state.milestones)
          .filter((milestone) => !lockedMilestoneIds.has(milestone.id))
          .map((milestone) => ({
            goal: milestone.goal,
            completionCriteria: milestone.completionCriteria,
            expectedCompletedAt: shanghaiDateTimeLocalToIso(
              milestone.expectedCompletedAt,
            ),
            reviewRequirements: milestone.reviewRequirements,
            businessDescription: milestone.businessDescription,
          }));
        const revisionPayload = {
          revisionAt: shanghaiDateTimeLocalToIso(state.revision.revisionAt),
          reason: state.revision.reason,
          replacementMilestones,
          termination: {
            name: state.termination.name,
            plannedAt: shanghaiDateTimeLocalToIso(state.termination.plannedAt),
            plannedOutcomeCriteria: state.termination.plannedOutcomeCriteria,
            businessDescription: state.termination.businessDescription,
          },
        };
        const result = mode.kind === "CREATE_REVISION"
          ? await createRevision({
              ...revisionPayload,
              taskId: mode.taskId,
              basePlanVersionId: mode.basePlanVersionId,
              baseTaskLockVersion: mode.baseTaskLockVersion,
              idempotencyKey: `revision-composer:${state.draftId}`,
            })
          : await reviseRejectedRevision({
              ...revisionPayload,
              revisionNodeId: mode.revisionNodeId,
              expectedTargetPlanUpdatedAt: mode.expectedTargetPlanUpdatedAt,
            });
        if (!result.ok) {
          if (
            result.error.code === "STALE_TASK" ||
            result.error.code === "PLAN_VERSION_CONFLICT" ||
            result.error.code === "STATE_CONFLICT"
          ) {
            const exportedDraft: LocalTaskDraft = {
              schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
              draftId: state.draftId,
              savedAt: new Date().toISOString(),
              task: state,
              inspectorDraft: null,
              inspectorDirty: false,
              ...(editContext ? { editContext } : {}),
            };
            await persistLocalDraftNow();
            setRecovery({
              kind: "INCOMPATIBLE",
              raw: JSON.stringify(exportedDraft),
              reason:
                "Task 或 Revision 候选计划已在服务端变化，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。",
            });
            setStatusMessage("保存冲突，本地修改已保留；不会自动刷新或合并字段。");
            return;
          }
          applyActionError(result.error);
          setStatusMessage(
            mode.kind === "CREATE_REVISION"
              ? "创建失败，本地草稿和幂等键已保留，可修正后重试。"
              : "重新送审失败，本地修改已保留，可修正后重试。",
          );
          return;
        }
        destination = routes.progress.taskRevisions(mode.taskId);
      }
      try {
        await draftWriteChainRef.current.catch(() => undefined);
        await removeTaskComposerDraft(storageKey, [
          ...[legacyStorageKeyV1, legacyStorageKeyV2].filter(
            (key): key is string => Boolean(key),
          ),
        ]);
      } catch {
        // The Task is already committed. Storage cleanup failure must not turn a
        // successful business mutation into a retry that could confuse the user.
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
      replaceAfterCollapsingHistoryGuard(destination);
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

  const loadTags = async () => {
    setOptionLoading(true);
    setOptionError("");
    try {
      const result = await listTagOptions({ query: tagQuery || undefined, limit: 50 });
      if (!result.ok) {
        setOptionError(result.error.message);
        return;
      }
      setTags((current) => mergeOptions(current, result.data.items));
    } catch {
      setOptionError("Tag 搜索暂时不可用，请稍后重试。");
    } finally {
      setOptionLoading(false);
    }
  };

  const addMember = () => {
    if (!memberPersonId) {
      setOptionError("请先选择人员。");
      return;
    }
    const existing = state.members.find(
      (member) => member.personId === memberPersonId,
    );
    const selectedPerson = people.find((person) => person.id === memberPersonId);
    if (!selectedPerson || selectedPerson.status !== "ACTIVE") {
      setOptionError("该人员已停用或不可用，不能新增角色。");
      return;
    }
    if (
      existing?.role === "OWNER" &&
      memberRole !== "OWNER" &&
      state.members.filter((member) => member.role === "OWNER").length === 1
    ) {
      setOptionError("至少保留一名负责人。");
      return;
    }
    updateField(
      "members",
      existing
        ? state.members.map((member) =>
            member.personId === memberPersonId
              ? { ...member, role: memberRole }
              : member,
          )
        : [
            ...state.members,
            { personId: memberPersonId, role: memberRole },
          ],
    );
    setOptionError("");
  };

  const changeTeam = (team: string) => {
    liveEditEntityRef.current = null;
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
            <Button type="button" variant="outline" onClick={runValidation}>
              校验{issues.length > 0 ? ` (${issues.length})` : ""}
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
                  setHistory({ past: [], present: recoveredTask, future: [] });
                  liveEditEntityRef.current = null;
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

      <div className="mx-auto grid w-full min-w-0 max-w-[110rem] gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[19rem_minmax(0,1fr)_22rem] lg:px-8">
        <aside
          className="min-w-0 space-y-4"
          aria-label={isRevisionComposer ? "Revision 信息" : "Task 基本信息"}
        >
          {isRevisionComposer && state.revision ? (
            <>
              <ComposerSection title="Revision 信息" issueCount={countIssues(issues, ["revision-reason"])}>
                <Field label="Task" htmlFor="revision-task-title">
                  <Input id="revision-task-title" value={state.title} readOnly />
                </Field>
                <Field label="修订原因" required htmlFor="revision-reason">
                  <Textarea
                    id="revision-reason"
                    rows={6}
                    value={state.revision.reason}
                    maxLength={2_000}
                    aria-invalid={issues.some((issue) => issue.key === "revision-reason")}
                    onChange={(event) => {
                      const mutator = (current: TaskComposerSeed) => current.revision
                        ? {
                            ...current,
                            revision: {
                              ...current.revision,
                              reason: event.target.value,
                            },
                          }
                        : current;
                      if (liveEditEntityRef.current === state.revision?.markerId) {
                        replacePresent(mutator);
                      } else {
                        liveEditEntityRef.current = state.revision?.markerId ?? null;
                        commit(mutator);
                      }
                    }}
                  />
                </Field>
              </ComposerSection>
              <ComposerSection title="只读基线">
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">计划版本</dt>
                    <dd>v{mode.baseVersionNo}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Task 锁版本</dt>
                    <dd>{mode.baseTaskLockVersion}</dd>
                  </div>
                  {mode.kind === "RESUBMIT_REVISION" && (
                    <>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">候选版本</dt>
                        <dd>v{mode.targetVersionNo}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">重新送审轮次</dt>
                        <dd>第 {state.revision.reviewRound + 1} 轮</dd>
                      </div>
                    </>
                  )}
                </dl>
                <p className="text-xs leading-5 text-muted-foreground">
                  Start、已完成 Milestone 与已生效 Revision 由当前计划承接并保持只读；Revision 标记不切割计划阶段。
                </p>
              </ComposerSection>
            </>
          ) : (
            <>
          <ComposerSection title="基本信息" issueCount={countIssues(issues, ["title", "team", "techGroup"])}>
            <Field label="Task 名称" required htmlFor="title">
              <Input
                id="title"
                value={state.title}
                maxLength={200}
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
                onChange={(event) => updateField("description", event.target.value)}
              />
            </Field>
            <Field label="优先级" htmlFor="priority">
              <select
                id="priority"
                className={selectClassName}
                value={state.priority}
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
            <Field label="Tags" htmlFor="tag-search">
              <div className="flex gap-2">
                <Input
                  id="tag-search"
                  value={tagQuery}
                  placeholder="搜索 Tag"
                  onChange={(event) => setTagQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void loadTags();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={() => void loadTags()}>
                  搜索
                </Button>
              </div>
              <div className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto">
                {tags.map((tag) => (
                  <label
                    key={tag.id}
                    className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={state.tagIds.includes(tag.id)}
                      onChange={(event) =>
                        updateField(
                          "tagIds",
                          event.target.checked
                            ? [...state.tagIds, tag.id]
                            : state.tagIds.filter((id) => id !== tag.id),
                        )
                      }
                    />
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                      aria-hidden="true"
                    />
                    {tag.name}
                    {tag.isArchived && (
                      <span className="text-muted-foreground">（已归档）</span>
                    )}
                  </label>
                ))}
                {tags.length === 0 && <EmptyInline>没有可选 Tag</EmptyInline>}
              </div>
            </Field>
            <Field label="关联 Task" htmlFor="related-task">
              <TaskSelect
                inputId="related-task"
                ariaLabel="关联 Task"
                value={state.relatedTaskId}
                onValueChange={(nextValue) => updateField("relatedTaskId", nextValue)}
                initialOptions={initialTasks}
                excludeIds={mode.kind === "EDIT_DRAFT" ? [mode.taskId] : []}
                placeholder="按标题、描述或拼音首字母搜索"
                clearable
              />
            </Field>
          </ComposerSection>

          <ComposerSection title="成员" issueCount={countIssues(issues, ["members"])}>
            <div className="space-y-2" id="members" tabIndex={-1}>
              {state.members.map((member, index) => {
                const person = people.find((item) => item.id === member.personId);
                return (
                  <div
                    key={`${member.personId}:${member.role}`}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-border p-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {person?.displayName ?? "已选择成员"}
                    </span>
                    <Badge variant={member.role === "OWNER" ? "default" : "secondary"}>
                      {taskMemberRoleLabels[member.role]}
                    </Badge>
                    {canManageMembers && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={
                          member.role === "OWNER" &&
                          state.members.filter((item) => item.role === "OWNER")
                            .length === 1
                        }
                        aria-label={`移除 ${person?.displayName ?? "成员"} ${taskMemberRoleLabels[member.role]}`}
                        onClick={() =>
                          updateField(
                            "members",
                            state.members.filter((_, memberIndex) => memberIndex !== index),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                );
              })}
              {preservedLegacyMembers.map((member) => {
                const person = people.find((item) => item.id === member.personId);
                return (
                  <div
                    key={`legacy:${member.personId}:${member.role}`}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-border p-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {person?.displayName ?? "历史成员"}
                    </span>
                    <Badge variant="outline">
                      {taskMemberRoleLabels[member.role]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">只读</span>
                  </div>
                );
              })}
              {state.members.length === 0 && preservedLegacyMembers.length === 0 && (
                <EmptyInline>尚未添加成员</EmptyInline>
              )}
            </div>
            {preservedLegacyMembers.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                此 Task 含历史成员角色。历史成员会保留；在管理员清理历史数据前，成员区保持只读，其他内容仍可保存。
              </p>
            ) : !canManageMembers ? (
              <p className="text-xs text-muted-foreground">
                你可以编辑 Task 内容和计划，成员与角色为只读。
              </p>
            ) : null}
            {canManageMembers && (
              <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3">
                <UserSelect
                  ariaLabel="成员人员"
                  scope={
                    mode.kind === "EDIT_DRAFT"
                      ? { purpose: "TASK_MEMBERS", taskId: mode.taskId }
                      : {
                          purpose: "TASK_CREATE",
                          team: state.team,
                          techGroup: state.techGroup,
                        }
                  }
                  value={memberPersonId || null}
                  onValueChange={(nextValue) => setMemberPersonId(nextValue ?? "")}
                  onOptionChange={(option) => {
                    if (option) setPeople((current) => mergeOptions(current, [option]));
                  }}
                  initialOptions={initialPeople}
                  placeholder="按姓名或拼音首字母搜索"
                />
                <div className="flex gap-2">
                  <select
                    aria-label="成员角色"
                    className={selectClassName}
                    value={memberRole}
                    onChange={(event) =>
                      setMemberRole(event.target.value as TaskMemberRoleValue)
                    }
                  >
                    {taskMemberRoles.map((role) => (
                      <option key={role} value={role}>
                        {taskMemberRoleLabels[role]}
                      </option>
                    ))}
                  </select>
                  <Button type="button" variant="outline" onClick={addMember}>
                    <Plus aria-hidden="true" />
                    添加
                  </Button>
                </div>
              </div>
            )}
          </ComposerSection>

            </>
          )}

        </aside>

        <TaskComposerPlanEditor
          state={state}
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
          optionLoading={optionLoading}
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
          onDuplicateMilestone={duplicateMilestone}
          onDeleteMilestones={removeMilestones}
          onFocusIssue={focusIssue}
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
  htmlFor: string;
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

function EmptyInline({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

const selectClassName =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

function inspectorDraftForEntity(
  state: TaskComposerSeed,
  entityId: string | null,
): TaskComposerInspectorDraft | null {
  if (entityId === TASK_COMPOSER_START_ID) {
    return {
      kind: "START",
      entityId: TASK_COMPOSER_START_ID,
      plannedStartAt: state.plannedStartAt,
      returnEntityId: entityId,
    };
  }
  if (entityId === state.termination.id) {
    return {
      kind: "TERMINATION",
      entityId: state.termination.id,
      termination: { ...state.termination },
      returnEntityId: entityId,
    };
  }
  if (state.revision && entityId === state.revision.markerId) {
    return {
      kind: "REVISION",
      entityId: state.revision.markerId,
      revision: {
        id: state.revision.markerId,
        reason: state.revision.reason,
        revisionAt: state.revision.revisionAt,
        status: "当前候选",
      },
      isCurrent: true,
      returnEntityId: state.revision.markerId,
    };
  }
  const carriedRevision = state.revision?.carriedAnchors.find(
    (anchor) => anchor.id === entityId,
  );
  if (carriedRevision) {
    return {
      kind: "REVISION",
      entityId: carriedRevision.id,
      revision: { ...carriedRevision },
      isCurrent: false,
      returnEntityId: carriedRevision.id,
    };
  }
  const milestone = state.milestones.find((item) => item.id === entityId);
  if (!milestone) return null;
  return {
    kind: "MILESTONE",
    entityId: milestone.id,
    milestone: { ...milestone },
    isNew: nodeMetaFor(state, milestone.id).lifecycle === "TEMPORARY",
    returnEntityId: entityId,
  };
}

function applyLiveInspectorUpdate(
  state: TaskComposerSeed,
  draft: TaskComposerInspectorDraft,
): TaskComposerSeed {
  let nextState: TaskComposerSeed;
  if (draft.kind === "START") {
    nextState = { ...state, plannedStartAt: draft.plannedStartAt };
  } else if (draft.kind === "TERMINATION") {
    nextState = { ...state, termination: { ...draft.termination } };
  } else if (draft.kind === "MILESTONE") {
    nextState = {
      ...state,
      milestones: state.milestones.map((milestone) =>
        milestone.id === draft.entityId ? { ...draft.milestone } : milestone,
      ),
    };
  } else if (state.revision && draft.isCurrent) {
    const nextNodeMeta = isRevisionTimeLegal(state, draft.revision.revisionAt)
      ? updateLastValidAt(state, draft.entityId, draft.revision.revisionAt)
      : state.nodeMeta;
    nextState = {
      ...state,
      revision: {
        ...state.revision,
        reason: draft.revision.reason,
        revisionAt: draft.revision.revisionAt,
      },
      nodeMeta: nextNodeMeta,
    };
  } else {
    return state;
  }

  nextState = reconcileComposerPlanState(nextState);

  return {
    ...nextState,
    milestones: sortMilestonesByRenderTime(nextState),
    selectedEntityId: draft.entityId,
  };
}

function validateInspector(
  draft: TaskComposerInspectorDraft,
  state: TaskComposerSeed,
): ValidationIssue[] {
  if (draft.kind === "REVISION") {
    if (!draft.isCurrent) return [];
    const issues: ValidationIssue[] = [];
    if (!draft.revision.reason.trim()) {
      issues.push({
        key: "revision-reason",
        entityId: draft.entityId,
        message: "请输入修订原因。",
      });
    }
    if (!validLocalDateTime(draft.revision.revisionAt)) {
      issues.push({
        key: "revisionAt",
        entityId: draft.entityId,
        message: "请选择有效的 Revision 时间。",
      });
    }
    return issues;
  }
  if (draft.kind === "START") {
    if (!validLocalDateTime(draft.plannedStartAt)) {
      return [{ key: "plannedStartAt", entityId: draft.entityId, message: "请选择有效的计划开始时间。" }];
    }
    return isNodeTimeStrictlyLegal(state, draft.entityId, draft.plannedStartAt)
      ? []
      : [{ key: "plannedStartAt", entityId: draft.entityId, message: "Start 必须严格早于下一个节点。" }];
  }

  if (draft.kind === "TERMINATION") {
    const issues: ValidationIssue[] = [];
    const name = draft.termination.name.trim();
    if (!name) {
      issues.push({ key: "termination-name", entityId: draft.entityId, message: "请输入 Terminal 名称。" });
    } else if (name.length > 200) {
      issues.push({ key: "termination-name", entityId: draft.entityId, message: "Terminal 名称不能超过 200 个字符。" });
    }
    if (!validLocalDateTime(draft.termination.plannedAt)) {
      issues.push({ key: "termination-plannedAt", entityId: draft.entityId, message: "请选择有效的计划结束时间。" });
    } else if (
      !isNodeTimeStrictlyLegal(
        state,
        draft.entityId,
        draft.termination.plannedAt,
      )
    ) {
      issues.push({ key: "termination-plannedAt", entityId: draft.entityId, message: "Terminal 必须严格晚于前一个节点。" });
    }
    if (!draft.termination.plannedOutcomeCriteria.trim()) {
      issues.push({ key: "termination-outcome", entityId: draft.entityId, message: "请输入结束条件。" });
    }
    return issues;
  }

  const issues: ValidationIssue[] = [];
  const milestone = draft.milestone;
  if (!milestone.goal.trim()) {
    issues.push({ key: `goal-${draft.entityId}`, entityId: draft.entityId, message: "请输入 Milestone 目标。" });
  }
  if (!validLocalDateTime(milestone.expectedCompletedAt)) {
    issues.push({ key: `expected-${draft.entityId}`, entityId: draft.entityId, message: "请选择有效的 Milestone 完成时间。" });
  } else {
    const at = localMs(milestone.expectedCompletedAt);
    const occupied = state.milestones.some(
      (item) => item.id !== draft.entityId && comparisonAtMs(state, item.id) === at,
    );
    if (
      !validLocalDateTime(state.plannedStartAt) ||
      !validLocalDateTime(state.termination.plannedAt) ||
      at <= localMs(state.plannedStartAt) ||
      at >= localMs(state.termination.plannedAt)
    ) {
      issues.push({ key: `expected-${draft.entityId}`, entityId: draft.entityId, message: "Milestone 必须严格位于 Start 与 Terminal 之间。" });
    } else if (occupied) {
      issues.push({ key: `expected-${draft.entityId}`, entityId: draft.entityId, message: "Milestone 不能与其他节点处于同一时刻。" });
    }
  }
  if (!milestone.completionCriteria.trim()) {
    issues.push({ key: `criteria-${draft.entityId}`, entityId: draft.entityId, message: "请输入完成条件。" });
  }
  if (!milestone.reviewRequirements.trim()) {
    issues.push({ key: `review-${draft.entityId}`, entityId: draft.entityId, message: "请输入验收要求。" });
  }
  return issues;
}

function nodeMetaFor(
  state: TaskComposerSeed,
  entityId: string,
): TaskComposerNodeMeta {
  const stored = state.nodeMeta?.[entityId];
  if (stored && validLocalDateTime(stored.lastValidAt)) return stored;
  const revisionAt = revisionAnchorAt(state, entityId);
  const currentAt = revisionAt ?? (entityId === TASK_COMPOSER_START_ID
    ? state.plannedStartAt
    : entityId === state.termination.id
      ? state.termination.plannedAt
      : state.milestones.find((milestone) => milestone.id === entityId)
          ?.expectedCompletedAt ?? state.plannedStartAt);
  return {
    lifecycle: "ESTABLISHED",
    lastValidAt: validLocalDateTime(currentAt) ? currentAt : state.plannedStartAt,
  };
}

function renderAtLocal(state: TaskComposerSeed, entityId: string) {
  return nodeMetaFor(state, entityId).lastValidAt;
}

function renderAtMs(state: TaskComposerSeed, entityId: string) {
  return localMs(renderAtLocal(state, entityId));
}

function updateLastValidAt(
  state: TaskComposerSeed,
  entityId: string,
  lastValidAt: string,
) {
  return {
    ...state.nodeMeta,
    [entityId]: {
      ...nodeMetaFor(state, entityId),
      lastValidAt,
    },
  };
}

function isNodeTimeStrictlyLegal(
  state: TaskComposerSeed,
  entityId: string,
  candidate: string,
) {
  if (!validLocalDateTime(candidate)) return false;
  const at = localMs(candidate);
  if (entityId === TASK_COMPOSER_START_ID) {
    return at < Math.min(
      comparisonAtMs(state, state.termination.id),
      ...state.milestones.map((milestone) => comparisonAtMs(state, milestone.id)),
    );
  }
  if (entityId === state.termination.id) {
    return at > Math.max(
      comparisonAtMs(state, TASK_COMPOSER_START_ID),
      ...state.milestones.map((milestone) => comparisonAtMs(state, milestone.id)),
    );
  }
  if (!state.milestones.some((milestone) => milestone.id === entityId)) return false;
  if (
    !validLocalDateTime(state.plannedStartAt) ||
    !validLocalDateTime(state.termination.plannedAt)
  ) {
    return false;
  }
  return (
    at > localMs(state.plannedStartAt) &&
    at < localMs(state.termination.plannedAt) &&
    !state.milestones.some(
      (milestone) =>
        milestone.id !== entityId && comparisonAtMs(state, milestone.id) === at,
    )
  );
}

function nodeInputAtLocal(state: TaskComposerSeed, entityId: string) {
  const revisionAt = revisionAnchorAt(state, entityId);
  if (revisionAt) return revisionAt;
  if (entityId === TASK_COMPOSER_START_ID) return state.plannedStartAt;
  if (entityId === state.termination.id) return state.termination.plannedAt;
  return state.milestones.find((milestone) => milestone.id === entityId)
    ?.expectedCompletedAt ?? "";
}

function comparisonAtMs(state: TaskComposerSeed, entityId: string) {
  const inputAt = nodeInputAtLocal(state, entityId);
  return validLocalDateTime(inputAt) ? localMs(inputAt) : renderAtMs(state, entityId);
}

function isMilestoneTimeAvailable(
  state: TaskComposerSeed,
  candidate: string,
) {
  if (!validLocalDateTime(candidate)) return false;
  const at = localMs(candidate);
  return (
    at > renderAtMs(state, TASK_COMPOSER_START_ID) &&
    at < renderAtMs(state, state.termination.id) &&
    !state.milestones.some((milestone) => renderAtMs(state, milestone.id) === at)
  );
}

function sortMilestonesByRenderTime(state: TaskComposerSeed) {
  return [...state.milestones].sort(
    (left, right) =>
      renderAtMs(state, left.id) - renderAtMs(state, right.id) ||
      left.id.localeCompare(right.id),
  );
}

function reconcileStrictlyLegalTimes(state: TaskComposerSeed) {
  if (
    !validLocalDateTime(state.plannedStartAt) ||
    !validLocalDateTime(state.termination.plannedAt) ||
    state.milestones.some(
      (milestone) => !validLocalDateTime(milestone.expectedCompletedAt),
    )
  ) {
    return state;
  }
  const milestones = sortMilestones(state.milestones);
  const times = [
    state.plannedStartAt,
    ...milestones.map((milestone) => milestone.expectedCompletedAt),
    state.termination.plannedAt,
  ];
  if (times.some((at, index) => index > 0 && localMs(at) <= localMs(times[index - 1]!))) {
    return state;
  }
  const nodeMeta = { ...state.nodeMeta };
  nodeMeta[TASK_COMPOSER_START_ID] = {
    ...nodeMetaFor(state, TASK_COMPOSER_START_ID),
    lastValidAt: state.plannedStartAt,
  };
  milestones.forEach((milestone) => {
    nodeMeta[milestone.id] = {
      ...nodeMetaFor(state, milestone.id),
      lastValidAt: milestone.expectedCompletedAt,
    };
  });
  nodeMeta[state.termination.id] = {
    ...nodeMetaFor(state, state.termination.id),
    lastValidAt: state.termination.plannedAt,
  };
  return { ...state, milestones, nodeMeta };
}

function reconcileComposerPlanState(state: TaskComposerSeed) {
  let nextState = state;
  const entityIds = [
    TASK_COMPOSER_START_ID,
    ...state.milestones.map((milestone) => milestone.id),
    state.termination.id,
  ];
  for (const entityId of entityIds) {
    const inputAt = nodeInputAtLocal(nextState, entityId);
    if (!isNodeTimeStrictlyLegal(nextState, entityId, inputAt)) continue;
    nextState = {
      ...nextState,
      nodeMeta: updateLastValidAt(nextState, entityId, inputAt),
    };
  }
  nextState = reconcileStrictlyLegalTimes(nextState);
  for (const milestone of nextState.milestones) {
    nextState = promoteTemporaryMilestone(nextState, milestone.id);
  }
  return {
    ...nextState,
    milestones: sortMilestonesByRenderTime(nextState),
  };
}

function suggestDuplicateAt(state: TaskComposerSeed, sourceId: string) {
  const sorted = sortMilestonesByRenderTime(state);
  const sourceIndex = sorted.findIndex((milestone) => milestone.id === sourceId);
  if (sourceIndex < 0) return null;
  const sourceAt = renderAtMs(state, sourceId);
  const upperExclusive = sorted[sourceIndex + 1]
    ? renderAtMs(state, sorted[sourceIndex + 1]!.id)
    : renderAtMs(state, state.termination.id);
  const occupied = new Set(
    state.milestones.map((milestone) => renderAtMs(state, milestone.id)),
  );
  const preferredAt = sourceAt + DAY_MS;
  if (preferredAt < upperExclusive && !occupied.has(preferredAt)) {
    return isoToShanghaiDateTimeLocal(new Date(preferredAt));
  }
  const minuteMs = 60_000;
  for (let offset = 1; offset <= occupied.size + 1; offset += 1) {
    const candidateAt = sourceAt + offset * minuteMs;
    if (candidateAt >= upperExclusive) return null;
    if (!occupied.has(candidateAt)) {
      return isoToShanghaiDateTimeLocal(new Date(candidateAt));
    }
  }
  return null;
}

function promoteTemporaryMilestone(
  state: TaskComposerSeed,
  entityId: string,
): TaskComposerSeed {
  const draft = inspectorDraftForEntity(state, entityId);
  if (
    draft?.kind !== "MILESTONE" ||
    nodeMetaFor(state, entityId).lifecycle !== "TEMPORARY" ||
    validateInspector(draft, state).length > 0
  ) {
    return state;
  }
  return {
    ...state,
    nodeMeta: {
      ...state.nodeMeta,
      [entityId]: {
        ...nodeMetaFor(state, entityId),
        lifecycle: "ESTABLISHED" as const,
      },
    },
  };
}

function applyAnchorMove(
  state: TaskComposerSeed,
  request: TimeCanvasAnchorMoveRequest,
): { ok: true; state: TaskComposerSeed } | { ok: false; message: string } {
  const resolved = resolveAnchorMoveCandidate(state, request);
  if (!resolved.ok) return resolved;
  const { candidateAt, originalAt } = resolved;
  if (candidateAt === originalAt && request.atMs !== originalAt) {
    return {
      ok: false,
      message: NO_LEGAL_ANCHOR_MOVE_MESSAGE,
    };
  }
  const localValue = isoToShanghaiDateTimeLocal(new Date(candidateAt));
  if (state.revision && request.anchorId === state.revision.markerId) {
    return {
      ok: true,
      state: {
        ...state,
        revision: { ...state.revision, revisionAt: localValue },
        selectedEntityId: request.anchorId,
        nodeMeta: updateLastValidAt(state, request.anchorId, localValue),
      },
    };
  }
  if (request.anchorId === TASK_COMPOSER_START_ID) {
    return {
      ok: true,
      state: {
        ...state,
        plannedStartAt: localValue,
        selectedEntityId: request.anchorId,
        nodeMeta: updateLastValidAt(state, request.anchorId, localValue),
      },
    };
  }
  if (request.anchorId === state.termination.id) {
    return {
      ok: true,
      state: {
        ...state,
        termination: { ...state.termination, plannedAt: localValue },
        selectedEntityId: request.anchorId,
        nodeMeta: updateLastValidAt(state, request.anchorId, localValue),
      },
    };
  }
  const nextState: TaskComposerSeed = {
    ...state,
    milestones: state.milestones.map((milestone) =>
      milestone.id === request.anchorId
        ? { ...milestone, expectedCompletedAt: localValue }
        : milestone,
    ),
    selectedEntityId: request.anchorId,
    nodeMeta: updateLastValidAt(state, request.anchorId, localValue),
  };
  const promoted = promoteTemporaryMilestone(nextState, request.anchorId);
  return {
    ok: true,
    state: { ...promoted, milestones: sortMilestonesByRenderTime(promoted) },
  };
}

function resolveAnchorMoveCandidate(
  state: TaskComposerSeed,
  request: TimeCanvasAnchorMoveRequest,
):
  | { ok: true; originalAt: number; candidateAt: number }
  | { ok: false; message: string } {
  const originalAt = renderAtMs(state, request.anchorId);
  if (!Number.isFinite(originalAt) || !Number.isFinite(request.atMs) || request.snapMs <= 0) {
    return { ok: false, message: "节点时间无效，请使用 Inspector 重新设置。" };
  }

  if (isReadOnlyRevisionEntity(state, request.anchorId)) {
    return { ok: false, message: "该节点由当前计划承接，只能查看，不能移动。" };
  }
  if (state.revision && request.anchorId === state.revision.markerId) {
    const lowerInclusive = Math.max(
      renderAtMs(state, TASK_COMPOSER_START_ID),
      ...state.revision.lockedMilestoneIds.map((id) => renderAtMs(state, id)),
      ...state.revision.carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
    );
    const upperInclusive = renderAtMs(state, state.termination.id);
    if (upperInclusive < lowerInclusive) {
      return { ok: false, message: "当前计划范围内没有合法的 Revision 时间。" };
    }
    return {
      ok: true,
      originalAt,
      candidateAt: Math.max(lowerInclusive, Math.min(request.atMs, upperInclusive)),
    };
  }

  let lowerExclusive = Number.NEGATIVE_INFINITY;
  let upperExclusive = Number.POSITIVE_INFINITY;
  let occupied = new Set<number>();
  if (request.anchorId === TASK_COMPOSER_START_ID) {
    upperExclusive = Math.min(
      renderAtMs(state, state.termination.id),
      ...state.milestones.map((milestone) => renderAtMs(state, milestone.id)),
    );
  } else if (request.anchorId === state.termination.id) {
    lowerExclusive = Math.max(
      renderAtMs(state, TASK_COMPOSER_START_ID),
      ...state.milestones.map((milestone) => renderAtMs(state, milestone.id)),
    );
  } else {
    const milestone = state.milestones.find((item) => item.id === request.anchorId);
    if (!milestone) return { ok: false, message: "未找到要移动的 Milestone。" };
    lowerExclusive = renderAtMs(state, TASK_COMPOSER_START_ID);
    upperExclusive = renderAtMs(state, state.termination.id);
    occupied = new Set(
      state.milestones
        .filter((item) => item.id !== request.anchorId)
        .map((item) => renderAtMs(state, item.id)),
    );
  }

  const candidateAt = nearestLegalMove({
    originalAt,
    targetAt: request.atMs,
    snapMs: request.snapMs,
    lowerExclusive,
    upperExclusive,
    occupied,
  });
  if (candidateAt === null) {
    return {
      ok: false,
      message: NO_LEGAL_ANCHOR_MOVE_MESSAGE,
    };
  }
  return { ok: true, originalAt, candidateAt };
}

function nearestLegalMove(input: {
  originalAt: number;
  targetAt: number;
  snapMs: number;
  lowerExclusive: number;
  upperExclusive: number;
  occupied: ReadonlySet<number>;
}) {
  const minimumStep = Number.isFinite(input.lowerExclusive)
    ? Math.floor((input.lowerExclusive - input.originalAt) / input.snapMs) + 1
    : Number.NEGATIVE_INFINITY;
  const maximumStep = Number.isFinite(input.upperExclusive)
    ? Math.ceil((input.upperExclusive - input.originalAt) / input.snapMs) - 1
    : Number.POSITIVE_INFINITY;
  const targetStep = Math.round((input.targetAt - input.originalAt) / input.snapMs);
  const boundedStep = Math.max(minimumStep, Math.min(targetStep, maximumStep));
  const maximumSearch = input.occupied.size + 2;
  const preferForward = targetStep >= 0;
  for (let distance = 0; distance <= maximumSearch; distance += 1) {
    const steps = distance === 0
      ? [boundedStep]
      : preferForward
        ? [boundedStep + distance, boundedStep - distance]
        : [boundedStep - distance, boundedStep + distance];
    for (const step of steps) {
      if (step < minimumStep || step > maximumStep) continue;
      const at = input.originalAt + step * input.snapMs;
      if (!input.occupied.has(at)) return at;
    }
  }
  return null;
}

function validateComposer(
  state: TaskComposerSeed,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const startValid = validLocalDateTime(state.plannedStartAt);
  const terminationValid = validLocalDateTime(state.termination.plannedAt);
  const startAt = startValid ? localMs(state.plannedStartAt) : Number.NaN;
  const terminationAt = terminationValid
    ? localMs(state.termination.plannedAt)
    : Number.NaN;
  const milestoneTimeCounts = new Map<number, number>();
  for (const milestone of state.milestones) {
    if (!validLocalDateTime(milestone.expectedCompletedAt)) continue;
    const at = localMs(milestone.expectedCompletedAt);
    milestoneTimeCounts.set(at, (milestoneTimeCounts.get(at) ?? 0) + 1);
  }
  const hasMilestoneAtOrBeforeStart =
    startValid &&
    [...milestoneTimeCounts.keys()].some((milestoneAt) => milestoneAt <= startAt);
  const hasMilestoneAtOrAfterTermination =
    terminationValid &&
    [...milestoneTimeCounts.keys()].some(
      (milestoneAt) => milestoneAt >= terminationAt,
    );
  if (!state.title.trim()) issues.push({ key: "title", message: "请输入 Task 名称。" });
  if (!state.revision) {
    if (!TEAM_OPTIONS.includes(state.team as (typeof TEAM_OPTIONS)[number])) {
      issues.push({ key: "team", message: "请选择有效车组。" });
    }
    if (!TECH_GROUP_OPTIONS.includes(state.techGroup as (typeof TECH_GROUP_OPTIONS)[number])) {
      issues.push({ key: "techGroup", message: "请选择有效技术组。" });
    }
  }
  if (!startValid) {
    issues.push({
      key: "plannedStartAt",
      entityId: TASK_COMPOSER_START_ID,
      message: "请选择有效的计划开始时间。",
    });
  } else if (
    hasMilestoneAtOrBeforeStart ||
    (terminationValid && terminationAt <= startAt)
  ) {
    issues.push({
      key: "plannedStartAt",
      entityId: TASK_COMPOSER_START_ID,
      message: "Start 必须严格早于全部 Milestone 和 Terminal。",
    });
  }
  if (!state.revision && new Set(state.tagIds).size !== state.tagIds.length) {
    issues.push({ key: "tag-search", message: "不能重复选择同一个 Tag。" });
  }
  if (!state.revision && state.members.length === 0) {
    issues.push({ key: "members", message: "至少添加一名 Task 成员。" });
  }
  const memberPersonIds = state.members.map((member) => member.personId);
  if (!state.revision && new Set(memberPersonIds).size !== memberPersonIds.length) {
    issues.push({ key: "members", message: "同一成员只能有一个角色。" });
  }
  if (!state.revision && state.members.every((member) => member.role !== "OWNER")) {
    issues.push({ key: "members", message: "至少需要一名负责人。" });
  }
  if (state.milestones.length > 200) {
    issues.push({ key: "plannedStartAt", entityId: TASK_COMPOSER_START_ID, message: "计划最多包含 200 个 Milestone。" });
  }
  for (const milestone of sortMilestones(state.milestones)) {
    if (nodeMetaFor(state, milestone.id).lifecycle === "TEMPORARY") {
      issues.push({
        key: `goal-${milestone.id}`,
        entityId: milestone.id,
        message: `请完成或删除临时 Milestone「${milestone.goal || "未命名"}」。`,
      });
    }
    if (!milestone.goal.trim()) {
      issues.push({
        key: `goal-${milestone.id}`,
        entityId: milestone.id,
        message: "请填写 Milestone 目标。",
      });
    }
    if (!milestone.completionCriteria.trim()) {
      issues.push({
        key: `criteria-${milestone.id}`,
        entityId: milestone.id,
        message: `请填写「${milestone.goal || "未命名 Milestone"}」的完成条件。`,
      });
    }
    if (!milestone.reviewRequirements.trim()) {
      issues.push({
        key: `review-${milestone.id}`,
        entityId: milestone.id,
        message: `请填写「${milestone.goal || "未命名 Milestone"}」的验收要求。`,
      });
    }
    const at = localMs(milestone.expectedCompletedAt);
    if (!validLocalDateTime(milestone.expectedCompletedAt)) {
      issues.push({
        key: `expected-${milestone.id}`,
        entityId: milestone.id,
        message: "请选择有效的 Milestone 完成时间。",
      });
    } else if (
      (startValid && at <= startAt) ||
      (terminationValid && at >= terminationAt)
    ) {
      issues.push({
        key: `expected-${milestone.id}`,
        entityId: milestone.id,
        message: "Milestone 必须严格位于 Start 与 Terminal 之间。",
      });
    } else if ((milestoneTimeCounts.get(at) ?? 0) > 1) {
      issues.push({
        key: `expected-${milestone.id}`,
        entityId: milestone.id,
        message: "Milestone 不能与其他节点处于同一时刻。",
      });
    }
  }
  if (!terminationValid) {
    issues.push({
      key: "termination-plannedAt",
      entityId: state.termination.id,
      message: "请选择有效的计划结束时间。",
    });
  } else if (
    hasMilestoneAtOrAfterTermination ||
    (startValid && terminationAt <= startAt)
  ) {
    issues.push({
      key: "termination-plannedAt",
      entityId: state.termination.id,
      message: "Terminal 必须严格晚于 Start 和最后一个 Milestone。",
    });
  }
  if (!state.termination.name.trim()) {
    issues.push({
      key: "termination-name",
      entityId: state.termination.id,
      message: "请输入 Terminal 名称。",
    });
  } else if (state.termination.name.trim().length > 200) {
    issues.push({
      key: "termination-name",
      entityId: state.termination.id,
      message: "Terminal 名称不能超过 200 个字符。",
    });
  }
  if (!state.termination.plannedOutcomeCriteria.trim()) {
    issues.push({
      key: "termination-outcome",
      entityId: state.termination.id,
      message: "请输入结束条件。",
    });
  }
  if (state.revision) {
    const revisionAtValid = validLocalDateTime(state.revision.revisionAt);
    if (!state.revision.reason.trim()) {
      issues.push({
        key: "revision-reason",
        entityId: state.revision.markerId,
        message: "请输入修订原因。",
      });
    } else if (state.revision.reason.trim().length > 2_000) {
      issues.push({
        key: "revision-reason",
        entityId: state.revision.markerId,
        message: "修订原因不能超过 2000 个字符。",
      });
    }
    if (!revisionAtValid) {
      issues.push({
        key: "revisionAt",
        entityId: state.revision.markerId,
        message: "请选择有效的 Revision 时间。",
      });
    } else if (startValid && terminationValid) {
      const revisionAt = localMs(state.revision.revisionAt);
      const lowerBoundary = Math.max(
        startAt,
        ...state.revision.lockedMilestoneIds.map((id) => comparisonAtMs(state, id)),
        ...state.revision.carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
      );
      if (revisionAt < lowerBoundary) {
        issues.push({
          key: "revisionAt",
          entityId: state.revision.markerId,
          message: "Revision 时间不能早于最后一个已完成 Milestone 或已生效 Revision。",
        });
      } else if (revisionAt > terminationAt) {
        issues.push({
          key: "revisionAt",
          entityId: state.revision.markerId,
          message: "Revision 时间不能晚于 Terminal。",
        });
      }
    }
  }
  return issues;
}

function actionErrorMessage(error: TaskActionError) {
  const detail = Object.values(error.fieldErrors ?? {})
    .flatMap((messages) => messages)
    .find(Boolean);
  return detail && detail !== error.message
    ? `${error.message}：${detail}`
    : error.message;
}

function serverFieldValidationIssue(
  fieldErrors: Record<string, string[]> | undefined,
  state: TaskComposerSeed,
): ValidationIssue | null {
  const entry = Object.entries(fieldErrors ?? {}).find(
    ([, messages]) => messages.length > 0,
  );
  if (!entry) return null;
  const [path, messages] = entry;
  const message = messages[0] ?? "输入内容不符合要求。";
  const directKeys: Record<string, string> = {
    title: "title",
    team: "team",
    techGroup: "techGroup",
    relatedTaskId: "related-task",
    tagIds: "tag-search",
    members: "members",
    plannedStartAt: "plannedStartAt",
    revisionAt: "revisionAt",
    reason: "revision-reason",
    "termination.name": "termination-name",
    "termination.plannedAt": "termination-plannedAt",
    "termination.plannedOutcomeCriteria": "termination-outcome",
  };
  const directKey = directKeys[path];
  if (directKey) {
    return {
      key: directKey,
      message,
      ...(path === "plannedStartAt"
        ? { entityId: TASK_COMPOSER_START_ID }
        : path === "revisionAt" || path === "reason"
          ? { entityId: state.revision?.markerId }
        : path.startsWith("termination.")
          ? { entityId: state.termination.id }
          : {}),
    };
  }
  const milestoneMatch = /^(?:milestones|replacementMilestones)\.(\d+)\.(.+)$/.exec(path);
  if (!milestoneMatch) return null;
  const submittedMilestones = sortMilestones(state.milestones).filter(
    (milestone) => !isLockedRevisionMilestone(state, milestone.id),
  );
  const milestone = submittedMilestones[Number(milestoneMatch[1])];
  if (!milestone) return null;
  const milestoneKeys: Record<string, string> = {
    goal: `goal-${milestone.id}`,
    completionCriteria: `criteria-${milestone.id}`,
    expectedCompletedAt: `expected-${milestone.id}`,
    reviewRequirements: `review-${milestone.id}`,
    businessDescription: `business-${milestone.id}`,
  };
  return {
    key: milestoneKeys[milestoneMatch[2] ?? ""] ?? `goal-${milestone.id}`,
    entityId: milestone.id,
    message,
  };
}

function localDraftContextError(
  draft: LocalTaskDraft,
  expected: LocalTaskDraft["editContext"],
) {
  const actual: unknown = draft.editContext;
  if (!expected) {
    return actual === undefined
      ? null
      : "检测到其他编辑场景的本地草稿，未自动覆盖当前新建内容。";
  }
  if (!isRecord(actual) || actual.kind !== expected.kind) {
    return "本地草稿缺少当前编辑场景的版本信息，不能安全恢复。";
  }
  if (expected.kind === "EDIT_DRAFT") {
    if (
      actual.taskId !== expected.taskId ||
      actual.planVersionId !== expected.planVersionId
    ) {
      return "本地编辑草稿不属于当前 Task 或计划版本，不能安全恢复。";
    }
    if (actual.baseLockVersion !== expected.baseLockVersion) {
      return "Task 已在服务端更新，旧本地草稿不能直接覆盖最新版本。";
    }
  } else if (expected.kind === "CREATE_REVISION") {
    if (
      actual.taskId !== expected.taskId ||
      actual.basePlanVersionId !== expected.basePlanVersionId ||
      actual.baseLockVersion !== expected.baseLockVersion
    ) {
      return "Task 基线已变化，旧 Revision 草稿不能直接覆盖最新版本。";
    }
  } else if (
    actual.taskId !== expected.taskId ||
    actual.revisionNodeId !== expected.revisionNodeId ||
    actual.targetPlanUpdatedAt !== expected.targetPlanUpdatedAt
  ) {
    return "Revision 候选计划已变化，旧本地草稿不能直接覆盖最新版本。";
  }
  return null;
}

function parseLocalDraft(raw: string): LocalTaskDraft | null {
  if (raw.length > MAX_TASK_COMPOSER_DRAFT_CHARS) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    if (
      envelope.schemaVersion !== LOCAL_DRAFT_SCHEMA_VERSION ||
      typeof envelope.draftId !== "string" ||
      !UUID_PATTERN.test(envelope.draftId) ||
      typeof envelope.savedAt !== "string" ||
      Number.isNaN(new Date(envelope.savedAt).getTime()) ||
      typeof envelope.inspectorDirty !== "boolean" ||
      (envelope.inspectorDraft !== null &&
        !isStoredInspectorDraft(envelope.inspectorDraft)) ||
      !envelope.task ||
      typeof envelope.task !== "object" ||
      Array.isArray(envelope.task)
    ) {
      return null;
    }
    const task = envelope.task as Record<string, unknown>;
    if (
      typeof task.draftId !== "string" ||
      task.draftId !== envelope.draftId ||
      typeof task.title !== "string" ||
      task.title.length > 200 ||
      typeof task.description !== "string" ||
      task.description.length > 8_000 ||
      typeof task.team !== "string" ||
      !TEAM_OPTIONS.includes(task.team as (typeof TEAM_OPTIONS)[number]) ||
      typeof task.techGroup !== "string" ||
      !TECH_GROUP_OPTIONS.includes(
        task.techGroup as (typeof TECH_GROUP_OPTIONS)[number],
      ) ||
      !["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(String(task.priority)) ||
      (task.relatedTaskId !== null &&
        (typeof task.relatedTaskId !== "string" ||
          !UUID_PATTERN.test(task.relatedTaskId))) ||
      (task.selectedEntityId !== null &&
        (typeof task.selectedEntityId !== "string" || task.selectedEntityId.length > 160)) ||
      typeof task.plannedStartAt !== "string" ||
      task.plannedStartAt.length > 32 ||
      !Array.isArray(task.members) ||
      task.members.length > 500 ||
      !task.members.every(isStoredMember) ||
      !Array.isArray(task.tagIds) ||
      task.tagIds.length > 50 ||
      !task.tagIds.every((tagId) => typeof tagId === "string") ||
      !task.tagIds.every((tagId) => UUID_PATTERN.test(tagId as string)) ||
      !Array.isArray(task.milestones) ||
      task.milestones.length > 200 ||
      !task.milestones.every(isStoredMilestone) ||
      !task.termination ||
      !isStoredTermination(task.termination) ||
      (task.nodeMeta !== undefined && !isStoredNodeMetaMap(task.nodeMeta)) ||
      (task.revision !== undefined && !isStoredRevisionContext(task.revision))
    ) {
      return null;
    }
    const nodeIds = [
      TASK_COMPOSER_START_ID,
      ...task.milestones.map((milestone) => (milestone as Record<string, unknown>).id),
      (task.termination as Record<string, unknown>).id,
      ...(isRecord(task.revision)
        ? [
            task.revision.markerId,
            ...(Array.isArray(task.revision.carriedAnchors)
              ? task.revision.carriedAnchors.flatMap((anchor) =>
                  isRecord(anchor) && typeof anchor.id === "string" ? [anchor.id] : [],
                )
              : []),
          ]
        : []),
    ];
    const inspectorEntityId = isRecord(envelope.inspectorDraft)
      ? envelope.inspectorDraft.entityId
      : null;
    if (
      new Set(nodeIds).size !== nodeIds.length ||
      (task.selectedEntityId !== null &&
        !nodeIds.includes(task.selectedEntityId) &&
        task.selectedEntityId !== inspectorEntityId)
    ) {
      return null;
    }
    const parsed = value as LocalTaskDraft;
    const taskSeed = parsed.task;
    const storedInspector = parsed.inspectorDirty ? parsed.inspectorDraft : null;
    if (
      storedInspector &&
      ((storedInspector.returnEntityId !== null &&
        !nodeIds.includes(storedInspector.returnEntityId)) ||
        (storedInspector.kind === "TERMINATION" &&
          storedInspector.entityId !== taskSeed.termination.id) ||
        (storedInspector.kind === "REVISION" &&
          !revisionAnchorAt(taskSeed, storedInspector.entityId)) ||
        (storedInspector.kind === "MILESTONE" &&
          (storedInspector.isNew
            ? nodeIds.includes(storedInspector.entityId)
            : !taskSeed.milestones.some(
                (milestone) => milestone.id === storedInspector.entityId,
              ))))
    ) {
      return null;
    }
    const storedMeta = taskSeed.nodeMeta;
    const rawNodeTimes = [
      [TASK_COMPOSER_START_ID, taskSeed.plannedStartAt],
      ...taskSeed.milestones.map((milestone) => [milestone.id, milestone.expectedCompletedAt]),
      [taskSeed.termination.id, taskSeed.termination.plannedAt],
      ...(taskSeed.revision
        ? [
            [taskSeed.revision.markerId, taskSeed.revision.revisionAt] as const,
            ...taskSeed.revision.carriedAnchors.map(
              (anchor) => [anchor.id, anchor.revisionAt] as const,
            ),
          ]
        : []),
    ] as const;
    if (
      rawNodeTimes.some(
        ([entityId, at]) =>
          !validLocalDateTime(at) &&
          !validLocalDateTime(storedMeta?.[entityId]?.lastValidAt ?? ""),
      )
    ) {
      return null;
    }
    const normalizedTask = normalizeComposerSeed(taskSeed);
    const restoredTask = parsed.inspectorDirty && parsed.inspectorDraft
      ? mergeStoredInspectorDraft(normalizedTask, parsed.inspectorDraft)
      : normalizedTask;
    if (!restoredTask || !hasStrictRenderChronology(restoredTask)) {
      return null;
    }
    return {
      ...parsed,
      task: restoredTask,
      inspectorDraft: null,
      inspectorDirty: false,
    };
  } catch {
    return null;
  }
}

function migrateLegacyLocalDraft(
  raw: string,
  creatorPersonId: string,
  schemaVersion: 1 | 2,
): LocalTaskDraft | null {
  if (raw.length > MAX_TASK_COMPOSER_DRAFT_CHARS) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schemaVersion !== schemaVersion || !isRecord(value.task)) {
      return null;
    }
    const normalized = normalizeLegacyMembers(value.task.members, creatorPersonId);
    const {
      revisionApprovalMode: _revisionApprovalMode,
      allowSelfReview: _allowSelfReview,
      nodeMeta: _nodeMeta,
      ...task
    } = value.task;
    void _revisionApprovalMode;
    void _allowSelfReview;
    void _nodeMeta;
    const migrated = {
      ...value,
      schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
      inspectorDraft: null,
      inspectorDirty: false,
      task: {
        ...task,
        members: [...normalized].map(([personId, role]) => ({
          personId,
          role,
        })),
        termination: isRecord(task.termination)
          ? { ...task.termination, name: "Terminal" }
          : task.termination,
      },
    };
    return parseLocalDraft(JSON.stringify(migrated));
  } catch {
    return null;
  }
}

function mergeStoredInspectorDraft(
  state: TaskComposerSeed,
  draft: TaskComposerInspectorDraft,
): TaskComposerSeed | null {
  if (draft.kind !== "MILESTONE" || !draft.isNew) {
    if (
      draft.kind === "MILESTONE" &&
      !state.milestones.some((milestone) => milestone.id === draft.entityId)
    ) {
      return null;
    }
    return applyLiveInspectorUpdate(state, draft);
  }
  if (
    state.milestones.length >= 200 ||
    state.milestones.some((milestone) => milestone.id === draft.entityId)
  ) {
    return null;
  }
  const lastValidAt = isMilestoneTimeAvailable(
    state,
    draft.milestone.expectedCompletedAt,
  )
    ? draft.milestone.expectedCompletedAt
    : firstAvailableMilestoneAt(state);
  if (!lastValidAt) return null;
  const restored: TaskComposerSeed = {
    ...state,
    milestones: [...state.milestones, { ...draft.milestone }],
    selectedEntityId: draft.entityId,
    nodeMeta: {
      ...state.nodeMeta,
      [draft.entityId]: {
        lifecycle: "TEMPORARY",
        lastValidAt,
      },
    },
  };
  return reconcileComposerPlanState(restored);
}

function firstAvailableMilestoneAt(state: TaskComposerSeed) {
  const startAt = renderAtMs(state, TASK_COMPOSER_START_ID);
  const terminalAt = renderAtMs(state, state.termination.id);
  const occupied = new Set(
    state.milestones.map((milestone) => renderAtMs(state, milestone.id)),
  );
  for (let offset = 1; offset <= occupied.size + 1; offset += 1) {
    const candidateAt = startAt + offset * 60_000;
    if (candidateAt >= terminalAt) return null;
    if (!occupied.has(candidateAt)) {
      return isoToShanghaiDateTimeLocal(new Date(candidateAt));
    }
  }
  return null;
}

function normalizeLegacyMembers(value: unknown, creatorPersonId: string) {
  const legacyMembers = Array.isArray(value) ? value : [];
  const normalized = new Map<string, TaskMemberRoleValue>();
  for (const member of legacyMembers) {
    if (
      !isRecord(member) ||
      typeof member.personId !== "string" ||
      !UUID_PATTERN.test(member.personId)
    ) {
      continue;
    }
    const role =
      member.role === "OWNER"
        ? "OWNER"
        : member.role === "LEAD" ||
            member.role === "MEMBER" ||
            member.role === "PARTICIPANT"
          ? "PARTICIPANT"
          : null;
    if (!role || normalized.get(member.personId) === "OWNER") continue;
    normalized.set(member.personId, role);
  }
  normalized.set(creatorPersonId, "OWNER");
  return normalized;
}

function isStoredMember(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    typeof value.personId === "string" &&
    UUID_PATTERN.test(value.personId) &&
    taskMemberRoles.includes(value.role as TaskMemberRoleValue)
  );
}

function isStoredMilestone(value: unknown) {
  if (!isRecord(value)) return false;
  const stringFields = [
    "id",
    "goal",
    "completionCriteria",
    "expectedCompletedAt",
    "reviewRequirements",
    "businessDescription",
  ].every((key) => typeof value[key] === "string");
  return (
    stringFields &&
    typeof value.id === "string" &&
    (value.id.startsWith("draft-node-") || UUID_PATTERN.test(value.id)) &&
    value.id.length <= 160 &&
    typeof value.goal === "string" &&
    value.goal.length <= 2_000 &&
    typeof value.completionCriteria === "string" &&
    value.completionCriteria.length <= 2_000 &&
    typeof value.reviewRequirements === "string" &&
    value.reviewRequirements.length <= 2_000 &&
    typeof value.businessDescription === "string" &&
    value.businessDescription.length <= 2_000 &&
    typeof value.expectedCompletedAt === "string" &&
    value.expectedCompletedAt.length <= 32
  );
}

function isStoredTermination(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    ["id", "name", "plannedAt", "plannedOutcomeCriteria", "businessDescription"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.id === "string" &&
    (value.id.startsWith("draft-termination-") || UUID_PATTERN.test(value.id)) &&
    value.id.length <= 160 &&
    typeof value.name === "string" &&
    value.name.length <= 200 &&
    typeof value.plannedAt === "string" &&
    value.plannedAt.length <= 32 &&
    typeof value.plannedOutcomeCriteria === "string" &&
    value.plannedOutcomeCriteria.length <= 2_000 &&
    typeof value.businessDescription === "string" &&
    value.businessDescription.length <= 2_000
  );
}

function isStoredNodeMetaMap(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length > 405) return false;
  return Object.entries(value).every(
    ([entityId, meta]) =>
      entityId.length <= 160 &&
      isRecord(meta) &&
      (meta.lifecycle === "TEMPORARY" || meta.lifecycle === "ESTABLISHED") &&
      typeof meta.lastValidAt === "string" &&
      validLocalDateTime(meta.lastValidAt),
  );
}

function isStoredRevisionContext(value: unknown): value is TaskComposerRevisionContext {
  if (!isRecord(value)) return false;
  return (
    typeof value.markerId === "string" &&
    value.markerId.length <= 160 &&
    typeof value.reason === "string" &&
    value.reason.length <= 2_000 &&
    typeof value.revisionAt === "string" &&
    value.revisionAt.length <= 32 &&
    Number.isInteger(value.reviewRound) &&
    Number(value.reviewRound) >= 1 &&
    Array.isArray(value.lockedMilestoneIds) &&
    value.lockedMilestoneIds.length <= 200 &&
    value.lockedMilestoneIds.every(
      (id) => typeof id === "string" && id.length <= 160,
    ) &&
    Array.isArray(value.carriedAnchors) &&
    value.carriedAnchors.length <= 200 &&
    value.carriedAnchors.every(isStoredRevisionAnchor)
  );
}

function isStoredRevisionAnchor(value: unknown): value is TaskComposerRevisionAnchor {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length <= 160 &&
    typeof value.reason === "string" &&
    value.reason.length <= 2_000 &&
    typeof value.revisionAt === "string" &&
    value.revisionAt.length <= 32 &&
    typeof value.status === "string" &&
    value.status.length <= 80
  );
}

function isStoredInspectorDraft(value: unknown): value is TaskComposerInspectorDraft {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  const validReturnEntityId =
    value.returnEntityId === null ||
    (typeof value.returnEntityId === "string" && value.returnEntityId.length <= 160);
  if (!validReturnEntityId || typeof value.entityId !== "string" || value.entityId.length > 160) {
    return false;
  }
  if (value.kind === "START") {
    return (
      value.entityId === TASK_COMPOSER_START_ID &&
      typeof value.plannedStartAt === "string" &&
      value.plannedStartAt.length <= 32
    );
  }
  if (value.kind === "MILESTONE") {
    const milestone = value.milestone;
    if (!isRecord(milestone)) return false;
    return (
      typeof value.isNew === "boolean" &&
      value.entityId.startsWith("draft-node-") &&
      milestone.id === value.entityId &&
      [
        "id",
        "goal",
        "completionCriteria",
        "expectedCompletedAt",
        "reviewRequirements",
        "businessDescription",
      ].every((key) => typeof milestone[key] === "string") &&
      String(milestone.goal).length <= 2_000 &&
      String(milestone.completionCriteria).length <= 2_000 &&
      String(milestone.reviewRequirements).length <= 2_000 &&
      String(milestone.businessDescription).length <= 2_000 &&
      String(milestone.expectedCompletedAt).length <= 32
    );
  }
  if (value.kind === "TERMINATION") {
    const termination = value.termination;
    if (!isRecord(termination)) return false;
    return (
      termination.id === value.entityId &&
      ["id", "name", "plannedAt", "plannedOutcomeCriteria", "businessDescription"].every(
        (key) => typeof termination[key] === "string",
      ) &&
      String(termination.name).length <= 200 &&
      String(termination.plannedAt).length <= 32 &&
      String(termination.plannedOutcomeCriteria).length <= 2_000 &&
      String(termination.businessDescription).length <= 2_000
    );
  }
  if (value.kind === "REVISION") {
    return (
      isStoredRevisionAnchor(value.revision) &&
      typeof value.isCurrent === "boolean" &&
      value.revision.id === value.entityId
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validLocalDateTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const iso = shanghaiDateTimeLocalToIso(value);
  return iso !== value && isoToShanghaiDateTimeLocal(iso) === value;
}

function localMs(value: string) {
  return new Date(shanghaiDateTimeLocalToIso(value)).getTime();
}

function sortMilestones(milestones: TaskComposerMilestone[]) {
  return milestones
    .map((milestone, index) => ({ milestone, index }))
    .sort((left, right) => {
      const delta = localMs(left.milestone.expectedCompletedAt) - localMs(right.milestone.expectedCompletedAt);
      return Number.isFinite(delta) && delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.milestone);
}

function composerSubmissionFingerprint(state: TaskComposerSeed) {
  return JSON.stringify({
    title: state.title,
    description: state.description,
    team: state.team,
    techGroup: state.techGroup,
    priority: state.priority,
    tagIds: [...state.tagIds].sort(),
    relatedTaskId: state.relatedTaskId,
    members: [...state.members].sort(
      (left, right) =>
        left.personId.localeCompare(right.personId) ||
        left.role.localeCompare(right.role),
    ),
    plannedStartAt: state.plannedStartAt,
    milestones: sortMilestones(state.milestones),
    termination: state.termination,
    revision: state.revision
      ? {
          reason: state.revision.reason,
          revisionAt: state.revision.revisionAt,
        }
      : null,
  });
}

function memberSubmissionFingerprint(
  members: TaskComposerSeed["members"],
) {
  return JSON.stringify(
    [...members].sort(
      (left, right) =>
        left.personId.localeCompare(right.personId) ||
        left.role.localeCompare(right.role),
    ),
  );
}

function normalizeComposerSeed(seed: TaskComposerSeed): TaskComposerSeed {
  const fallbackAt = [
    seed.plannedStartAt,
    ...seed.milestones.map((milestone) => milestone.expectedCompletedAt),
    seed.termination.plannedAt,
  ].find(validLocalDateTime) ?? "2000-01-01T00:00";
  const normalizedMeta: Record<string, TaskComposerNodeMeta> = {};
  const normalizeMeta = (
    entityId: string,
    currentAt: string,
    lifecycle: TaskComposerNodeMeta["lifecycle"],
  ) => {
    const stored = seed.nodeMeta?.[entityId];
    normalizedMeta[entityId] = {
      lifecycle: stored?.lifecycle ?? lifecycle,
      lastValidAt: validLocalDateTime(stored?.lastValidAt ?? "")
        ? stored!.lastValidAt
        : validLocalDateTime(currentAt)
          ? currentAt
          : fallbackAt,
    };
  };
  normalizeMeta(TASK_COMPOSER_START_ID, seed.plannedStartAt, "ESTABLISHED");
  seed.milestones.forEach((milestone) =>
    normalizeMeta(milestone.id, milestone.expectedCompletedAt, "ESTABLISHED"),
  );
  normalizeMeta(seed.termination.id, seed.termination.plannedAt, "ESTABLISHED");
  if (seed.revision) {
    normalizeMeta(
      seed.revision.markerId,
      seed.revision.revisionAt,
      "ESTABLISHED",
    );
    seed.revision.carriedAnchors.forEach((anchor) =>
      normalizeMeta(anchor.id, anchor.revisionAt, "ESTABLISHED"),
    );
  }
  normalizedMeta[TASK_COMPOSER_START_ID]!.lifecycle = "ESTABLISHED";
  normalizedMeta[seed.termination.id]!.lifecycle = "ESTABLISHED";
  const normalized: TaskComposerSeed = {
    ...seed,
    nodeMeta: normalizedMeta,
  };
  const reconciled = reconcileComposerPlanState(normalized);
  return seed.nodeMeta === undefined && !hasStrictRenderChronology(reconciled)
    ? createFallbackRenderChronology(reconciled)
    : reconciled;
}

function hasStrictRenderChronology(state: TaskComposerSeed) {
  const renderTimes = [
    renderAtMs(state, TASK_COMPOSER_START_ID),
    ...sortMilestonesByRenderTime(state).map((milestone) =>
      renderAtMs(state, milestone.id),
    ),
    renderAtMs(state, state.termination.id),
  ];
  return renderTimes.every(
    (at, index) =>
      Number.isFinite(at) &&
      (index === 0 || at > renderTimes[index - 1]!),
  );
}

function createFallbackRenderChronology(state: TaskComposerSeed) {
  const milestones = sortMilestonesByRenderTime(state);
  const startAt = validLocalDateTime(state.plannedStartAt)
    ? localMs(state.plannedStartAt)
    : localMs("2000-01-01T00:00");
  const minuteMs = 60_000;
  const nodeMeta: Record<string, TaskComposerNodeMeta> = {
    [TASK_COMPOSER_START_ID]: {
      lifecycle: "ESTABLISHED",
      lastValidAt: isoToShanghaiDateTimeLocal(new Date(startAt)),
    },
  };
  milestones.forEach((milestone, index) => {
    nodeMeta[milestone.id] = {
      lifecycle: "ESTABLISHED",
      lastValidAt: isoToShanghaiDateTimeLocal(
        new Date(startAt + (index + 1) * minuteMs),
      ),
    };
  });
  nodeMeta[state.termination.id] = {
    lifecycle: "ESTABLISHED",
    lastValidAt: isoToShanghaiDateTimeLocal(
      new Date(startAt + (milestones.length + 1) * minuteMs),
    ),
  };
  return { ...state, milestones, nodeMeta };
}

function revisionAnchorAt(state: TaskComposerSeed, entityId: string) {
  if (!state.revision) return null;
  if (state.revision.markerId === entityId) return state.revision.revisionAt;
  return state.revision.carriedAnchors.find((anchor) => anchor.id === entityId)
    ?.revisionAt ?? null;
}

function revisionAnchorTimes(state: TaskComposerSeed) {
  if (!state.revision) return [];
  return [
    localMs(state.revision.revisionAt),
    ...state.revision.carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
  ].filter(Number.isFinite);
}

function isLockedRevisionMilestone(state: TaskComposerSeed, entityId: string) {
  return state.revision?.lockedMilestoneIds.includes(entityId) ?? false;
}

function isReadOnlyRevisionEntity(state: TaskComposerSeed, entityId: string) {
  if (!state.revision) return false;
  return (
    entityId === TASK_COMPOSER_START_ID ||
    state.revision.lockedMilestoneIds.includes(entityId) ||
    state.revision.carriedAnchors.some((anchor) => anchor.id === entityId)
  );
}

function isRevisionTimeLegal(state: TaskComposerSeed, candidate: string) {
  if (
    !state.revision ||
    !validLocalDateTime(candidate) ||
    !validLocalDateTime(state.plannedStartAt) ||
    !validLocalDateTime(state.termination.plannedAt)
  ) {
    return false;
  }
  const lowerBoundary = Math.max(
    localMs(state.plannedStartAt),
    ...state.revision.lockedMilestoneIds.map((id) => comparisonAtMs(state, id)),
    ...state.revision.carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
  );
  const candidateAt = localMs(candidate);
  return (
    candidateAt >= lowerBoundary &&
    candidateAt <= localMs(state.termination.plannedAt)
  );
}

function sanitizeRecoveredComposerState({
  recovered,
  authoritative,
  mode,
  canManageMembers,
}: {
  recovered: TaskComposerSeed;
  authoritative: TaskComposerSeed;
  mode: TaskComposerMode;
  canManageMembers: boolean;
}) {
  if (mode.kind === "EDIT_DRAFT" && !canManageMembers) {
    return { ...recovered, members: authoritative.members };
  }
  if (mode.kind !== "CREATE_REVISION" && mode.kind !== "RESUBMIT_REVISION") {
    return recovered;
  }
  const authoritativeRevision = authoritative.revision;
  const recoveredRevision = recovered.revision;
  if (!authoritativeRevision || !recoveredRevision) return authoritative;
  const lockedById = new Map(
    authoritative.milestones
      .filter((milestone) =>
        authoritativeRevision.lockedMilestoneIds.includes(milestone.id),
      )
      .map((milestone) => [milestone.id, milestone]),
  );
  const editable = recovered.milestones.filter(
    (milestone) => !lockedById.has(milestone.id),
  );
  return normalizeComposerSeed({
    ...recovered,
    title: authoritative.title,
    description: authoritative.description,
    team: authoritative.team,
    techGroup: authoritative.techGroup,
    priority: authoritative.priority,
    tagIds: authoritative.tagIds,
    relatedTaskId: authoritative.relatedTaskId,
    members: authoritative.members,
    plannedStartAt: authoritative.plannedStartAt,
    milestones: [...lockedById.values(), ...editable],
    selectedEntityId:
      recovered.selectedEntityId === recoveredRevision.markerId
        ? authoritativeRevision.markerId
        : recovered.selectedEntityId,
    revision: {
      ...authoritativeRevision,
      reason: recoveredRevision.reason,
      revisionAt: recoveredRevision.revisionAt,
    },
  });
}

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
