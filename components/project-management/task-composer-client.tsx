"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Flag,
  GripVertical,
  Plus,
  Redo2,
  Save,
  Trash2,
  Undo2,
} from "lucide-react";
import { createTaskDraft } from "@/app/actions/project-management/tasks";
import {
  listTagOptions,
  searchPeople,
  searchTaskOptions,
} from "@/app/actions/project-management/canvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type {
  PersonOptionDto,
  TagOptionPage,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const LOCAL_DRAFT_SCHEMA_VERSION = 2;
const MAX_HISTORY = 80;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_LOCAL_DRAFT_BYTES = 1_000_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskMemberRoles = ["OWNER", "PARTICIPANT"] as const;
type TaskMemberRoleValue = (typeof taskMemberRoles)[number];
type TaskPriorityValue = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type TaskComposerMilestone = {
  id: string;
  goal: string;
  completionCriteria: string;
  expectedCompletedAt: string;
  reviewRequirements: string;
  businessDescription: string;
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
    plannedAt: string;
    plannedOutcomeCriteria: string;
    businessDescription: string;
  };
  selectedEntityId: string | null;
};

type ComposerHistory = {
  past: TaskComposerSeed[];
  present: TaskComposerSeed;
  future: TaskComposerSeed[];
};

type ValidationIssue = {
  key: string;
  message: string;
  entityId?: string;
};

type LocalTaskDraft = {
  schemaVersion: 2;
  draftId: string;
  savedAt: string;
  task: TaskComposerSeed;
};

type LocalDraftRecovery =
  | { kind: "VALID"; draft: LocalTaskDraft }
  | { kind: "INCOMPATIBLE"; raw: string; reason: string };

type PersonOption = PersonOptionDto;
type TaskOption = TaskOptionPage["items"][number];
type TagOption = TagOptionPage["items"][number];

export function TaskComposerClient({
  accountId,
  deploymentEnvironment,
  initialSeed,
  initialPeople,
  initialTasks,
  initialTags,
  actorPersonId,
}: {
  accountId: string;
  deploymentEnvironment: string;
  initialSeed: TaskComposerSeed;
  initialPeople: PersonOption[];
  initialTasks: TaskOption[];
  initialTags: TagOption[];
  actorPersonId: string;
}) {
  const router = useRouter();
  const [history, setHistory] = useState<ComposerHistory>({
    past: [],
    present: initialSeed,
    future: [],
  });
  const state = history.present;
  const [dirty, setDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<LocalDraftRecovery | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const [people, setPeople] = useState<PersonOption[]>(initialPeople);
  const [tasks, setTasks] = useState<TaskOption[]>(initialTasks);
  const [tags, setTags] = useState<TagOption[]>(initialTags);
  const [personQuery, setPersonQuery] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const [optionError, setOptionError] = useState("");
  const [optionLoading, setOptionLoading] = useState(false);
  const [memberPersonId, setMemberPersonId] = useState(
    initialSeed.members.find((member) => member.role === "OWNER")?.personId ??
      initialPeople[0]?.id ??
      "",
  );
  const [memberRole, setMemberRole] =
    useState<TaskMemberRoleValue>("PARTICIPANT");
  const [lastValidationIssues, setLastValidationIssues] = useState<
    ValidationIssue[]
  >([]);
  const dragRef = useRef<{
    id: string;
    startX: number;
    originalAt: string;
  } | null>(null);
  const historyGuardRef = useRef(false);
  const bypassPopStateRef = useRef(false);
  const storageKey = useMemo(
    () =>
      `task-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:v${LOCAL_DRAFT_SCHEMA_VERSION}`,
    [accountId, deploymentEnvironment],
  );
  const legacyStorageKey = useMemo(
    () =>
      `task-draft:${encodeURIComponent(deploymentEnvironment)}:${encodeURIComponent(accountId)}:v1`,
    [accountId, deploymentEnvironment],
  );
  const issues = useMemo(
    () => validateComposer(state),
    [state],
  );
  const selectedMilestone = state.milestones.find(
    (milestone) => milestone.id === state.selectedEntityId,
  );
  const selectedTermination = state.selectedEntityId === state.termination.id;

  const commit = useCallback(
    (mutator: (current: TaskComposerSeed) => TaskComposerSeed) => {
      setHistory((current) => ({
        past: [...current.past.slice(-(MAX_HISTORY - 1)), current.present],
        present: mutator(current.present),
        future: [],
      }));
      setDirty(true);
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
      setDirty(true);
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const currentRaw = window.localStorage.getItem(storageKey);
        const legacyRaw = currentRaw
          ? null
          : window.localStorage.getItem(legacyStorageKey);
        const raw = currentRaw ?? legacyRaw;
        const parsed = currentRaw
          ? parseLocalDraft(currentRaw)
          : legacyRaw
            ? migrateLegacyLocalDraft(legacyRaw, actorPersonId)
            : null;
        if (parsed) {
          setRecovery({ kind: "VALID", draft: parsed });
          setSavedAt(parsed.savedAt);
        } else if (raw) {
          setRecovery({
            kind: "INCOMPATIBLE",
            raw,
            reason: "草稿版本、结构或字段不兼容，未自动覆盖或删除原始内容。",
          });
        } else {
          setStorageReady(true);
        }
      } catch {
        setStorageReady(true);
        setServerError("浏览器本地草稿不可用；你仍可创建 Task，但刷新后内容可能丢失。");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [actorPersonId, legacyStorageKey, storageKey]);

  useEffect(() => {
    if (!storageReady || recovery || !dirty || submitting) return;
    const timer = window.setTimeout(() => {
      const saved = new Date().toISOString();
      const envelope: LocalTaskDraft = {
        schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
        draftId: state.draftId,
        savedAt: saved,
        task: state,
      };
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(envelope));
        setSavedAt(saved);
      } catch {
        setServerError("本地草稿保存失败，请不要刷新页面并尽快复制重要内容。");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, recovery, state, storageKey, storageReady, submitting]);

  useEffect(() => {
    if (!dirty || submitting) return;
    if (!historyGuardRef.current) {
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
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
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
      setPendingNavigation(`${url.pathname}${url.search}${url.hash}`);
    };
    const interceptHistory = () => {
      if (bypassPopStateRef.current) {
        bypassPopStateRef.current = false;
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
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", interceptHistory);
    document.addEventListener("click", interceptLinks, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", interceptHistory);
      document.removeEventListener("click", interceptLinks, true);
    };
  }, [dirty, submitting]);

  const updateField = <K extends keyof TaskComposerSeed>(
    key: K,
    value: TaskComposerSeed[K],
  ) => commit((current) => ({ ...current, [key]: value }));

  const updateMilestone = (
    id: string,
    patch: Partial<TaskComposerMilestone>,
    sortByDate = false,
  ) =>
    commit((current) => ({
      ...current,
      milestones: sortByDate
        ? sortMilestones(
            current.milestones.map((milestone) =>
              milestone.id === id ? { ...milestone, ...patch } : milestone,
            ),
          )
        : current.milestones.map((milestone) =>
            milestone.id === id ? { ...milestone, ...patch } : milestone,
          ),
    }));

  const addMilestone = (at?: string) => {
    if (state.milestones.length >= 200) {
      setServerError("单个计划最多 200 个 Milestone。");
      return;
    }
    const previousAt = state.milestones.at(-1)?.expectedCompletedAt ?? state.plannedStartAt;
    const milestone: TaskComposerMilestone = {
      id: `draft-node-${clientId()}`,
      goal: "",
      completionCriteria: "",
      expectedCompletedAt: at ?? addDaysLocal(previousAt, 7),
      reviewRequirements: "",
      businessDescription: "",
    };
    commit((current) => ({
      ...current,
      milestones: sortMilestones([...current.milestones, milestone]),
      selectedEntityId: milestone.id,
    }));
    window.setTimeout(() => document.getElementById(`goal-${milestone.id}`)?.focus(), 0);
  };

  const duplicateMilestone = (source: TaskComposerMilestone) => {
    if (state.milestones.length >= 200) {
      setServerError("单个计划最多 200 个 Milestone。");
      return;
    }
    const copy: TaskComposerMilestone = {
      ...source,
      id: `draft-node-${clientId()}`,
      goal: source.goal ? `${source.goal}（副本）` : "",
      expectedCompletedAt: addDaysLocal(source.expectedCompletedAt, 1),
    };
    commit((current) => ({
      ...current,
      milestones: sortMilestones([...current.milestones, copy]),
      selectedEntityId: copy.id,
    }));
  };

  const removeMilestone = (id: string) => {
    if (state.milestones.length <= 1) {
      setServerError("计划至少保留一个 Milestone。");
      return;
    }
    const target = state.milestones.find((item) => item.id === id);
    if (
      target &&
      (target.goal || target.completionCriteria || target.reviewRequirements) &&
      !window.confirm("此 Milestone 已填写内容，确认删除？")
    ) {
      return;
    }
    commit((current) => {
      const remaining = current.milestones.filter((item) => item.id !== id);
      return {
        ...current,
        milestones: remaining,
        selectedEntityId: remaining[0]?.id ?? current.termination.id,
      };
    });
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future].slice(0, MAX_HISTORY),
      };
    });
    setDirty(true);
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, current.present].slice(-MAX_HISTORY),
        present: next,
        future: current.future.slice(1),
      };
    });
    setDirty(true);
  };

  const focusIssue = (issue: ValidationIssue) => {
    if (issue.entityId) {
      commit((current) => ({ ...current, selectedEntityId: issue.entityId ?? null }));
    }
    window.setTimeout(() => document.getElementById(issue.key)?.focus(), 0);
  };

  const runValidation = () => {
    setLastValidationIssues(issues);
    if (issues[0]) focusIssue(issues[0]);
    setStatusMessage(
      issues.length === 0 ? "计划校验通过，可以创建 Task 草稿。" : `发现 ${issues.length} 个问题。`,
    );
    return issues.length === 0;
  };

  const persistLocalDraftNow = () => {
    const saved = new Date().toISOString();
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
          draftId: state.draftId,
          savedAt: saved,
          task: state,
        } satisfies LocalTaskDraft),
      );
      setSavedAt(saved);
      return true;
    } catch {
      setServerError("本地草稿保存失败，页面仍停留在 Composer，请不要刷新。");
      return false;
    }
  };

  const discardLocalDraft = () => {
    try {
      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem(legacyStorageKey);
      return true;
    } catch {
      setServerError("浏览器拒绝删除本地草稿；为避免旧草稿再次出现，当前不会离开页面。");
      return false;
    }
  };

  const replaceAfterCollapsingHistoryGuard = (destination: string) => {
    setPendingNavigation(null);
    setDirty(false);
    if (!historyGuardRef.current) {
      router.replace(destination);
      return;
    }

    const finishNavigation = () => {
      historyGuardRef.current = false;
      window.location.replace(destination);
    };
    window.addEventListener("popstate", finishNavigation, { once: true });
    bypassPopStateRef.current = true;
    window.history.back();
  };

  const submit = async () => {
    if (submitting || !runValidation()) return;
    setSubmitting(true);
    setServerError("");
    setStatusMessage("正在创建 Task 草稿…");
    try {
      const result = await createTaskDraft({
        title: state.title,
        description: state.description,
        team: state.team,
        techGroup: state.techGroup,
        priority: state.priority,
        tagIds: state.tagIds,
        relatedTaskId: state.relatedTaskId,
        members: state.members,
        plannedStartAt: shanghaiDateTimeLocalToIso(state.plannedStartAt),
        milestones: state.milestones.map((milestone) => ({
          goal: milestone.goal,
          completionCriteria: milestone.completionCriteria,
          expectedCompletedAt: shanghaiDateTimeLocalToIso(
            milestone.expectedCompletedAt,
          ),
          reviewRequirements: milestone.reviewRequirements,
          businessDescription: milestone.businessDescription,
        })),
        termination: {
          plannedAt: shanghaiDateTimeLocalToIso(state.termination.plannedAt),
          plannedOutcomeCriteria: state.termination.plannedOutcomeCriteria,
          businessDescription: state.termination.businessDescription,
        },
        idempotencyKey: `task-composer:${state.draftId}`,
      });
      if (!result.ok) {
        setServerError(result.error.message);
        setStatusMessage("创建失败，本地草稿和幂等键已保留，可修正后重试。");
        return;
      }
      try {
        window.localStorage.removeItem(storageKey);
        window.localStorage.removeItem(legacyStorageKey);
      } catch {
        // The Task is already committed. Storage cleanup failure must not turn a
        // successful business mutation into a retry that could confuse the user.
      }
      setStatusMessage("Task 草稿已创建，正在进入工作台…");
      replaceAfterCollapsingHistoryGuard(
        `${routes.progress.taskDetail(result.data.taskId)}?created=1`,
      );
    } catch {
      setServerError("网络或服务暂时不可用，请稍后重试。草稿不会被清除。");
      setStatusMessage("创建失败，本地草稿和幂等键已保留。");
    } finally {
      setSubmitting(false);
    }
  };

  const loadPeople = async () => {
    setOptionLoading(true);
    setOptionError("");
    try {
      const result = await searchPeople({
        purpose: "TASK_CREATE",
        team: state.team,
        techGroup: state.techGroup,
        query: personQuery || undefined,
        limit: 50,
      });
      if (!result.ok) {
        setOptionError(result.error.message);
        return;
      }
      setPeople((current) => mergeOptions(current, result.data.items));
      if (!memberPersonId && result.data.items[0]) {
        setMemberPersonId(result.data.items[0].id);
      }
    } catch {
      setOptionError("人员搜索暂时不可用，请稍后重试。");
    } finally {
      setOptionLoading(false);
    }
  };

  const loadTasks = async () => {
    setOptionLoading(true);
    setOptionError("");
    try {
      const result = await searchTaskOptions({ query: taskQuery || undefined, limit: 50 });
      if (!result.ok) {
        setOptionError(result.error.message);
        return;
      }
      setTasks((current) => mergeOptions(current, result.data.items));
    } catch {
      setOptionError("Task 搜索暂时不可用，请稍后重试。");
    } finally {
      setOptionLoading(false);
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
    commit((current) => ({ ...current, team }));
    setOptionError("");
  };

  const moveSameTime = (id: string, direction: -1 | 1) => {
    const index = state.milestones.findIndex((item) => item.id === id);
    const targetIndex = index + direction;
    const target = state.milestones[targetIndex];
    const source = state.milestones[index];
    if (!source || !target || source.expectedCompletedAt !== target.expectedCompletedAt) {
      return;
    }
    commit((current) => {
      const milestones = [...current.milestones];
      [milestones[index], milestones[targetIndex]] = [milestones[targetIndex]!, milestones[index]!];
      return { ...current, milestones };
    });
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    milestone: TaskComposerMilestone,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setHistory((current) => ({
      past: [...current.past.slice(-(MAX_HISTORY - 1)), current.present],
      present: current.present,
      future: [],
    }));
    dragRef.current = {
      id: milestone.id,
      startX: event.clientX,
      originalAt: milestone.expectedCompletedAt,
    };
  };

  const dragMilestone = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.currentTarget.dataset.nodeId) return;
    const days = Math.round((event.clientX - drag.startX) / 48);
    replacePresent((current) => ({
      ...current,
      milestones: current.milestones.map((milestone) =>
        milestone.id === drag.id
          ? { ...milestone, expectedCompletedAt: addDaysLocal(drag.originalAt, days) }
          : milestone,
      ),
      selectedEntityId: drag.id,
    }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    replacePresent((current) => ({
      ...current,
      milestones: sortMilestones(current.milestones),
    }));
  };

  return (
    <div className="min-w-0" data-testid="task-composer">
      <div className="sticky top-14 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:top-14 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[110rem] flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                dirty
                  ? setPendingNavigation(routes.progress.tasks)
                  : router.push(routes.progress.tasks)
              }
            >
              <ArrowLeft aria-hidden="true" />
              全部 Task
            </Button>
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {savedAt
                ? `本地已保存 ${formatSavedAt(savedAt)}`
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
            <Button type="button" disabled={submitting} onClick={submit}>
              <Save aria-hidden="true" />
              {submitting ? "正在创建…" : "创建 Task 草稿"}
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
                  setHistory({ past: [], present: recovery.draft.task, future: [] });
                  setRecovery(null);
                  setStorageReady(true);
                  setDirty(true);
                  setStatusMessage("已恢复本地草稿。");
                }}
              >
                恢复草稿
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!discardLocalDraft()) return;
                  setRecovery(null);
                  setStorageReady(true);
                  setSavedAt(null);
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
                onClick={() => {
                  if (!discardLocalDraft()) return;
                  setRecovery(null);
                  setStorageReady(true);
                  setSavedAt(null);
                }}
              >
                安全放弃
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto grid w-full min-w-0 max-w-[110rem] gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[19rem_minmax(0,1fr)_22rem] lg:px-8">
        <aside className="min-w-0 space-y-4" aria-label="Task 基本信息">
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
                  </label>
                ))}
                {tags.length === 0 && <EmptyInline>没有可选 Tag</EmptyInline>}
              </div>
            </Field>
            <Field label="关联 Task" htmlFor="related-task">
              <div className="mb-2 flex gap-2">
                <Input
                  value={taskQuery}
                  placeholder="按名称搜索可见 Task"
                  aria-label="搜索关联 Task"
                  onChange={(event) => setTaskQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void loadTasks();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={() => void loadTasks()}>
                  搜索
                </Button>
              </div>
              <select
                id="related-task"
                className={selectClassName}
                value={state.relatedTaskId ?? ""}
                onChange={(event) => updateField("relatedTaskId", event.target.value || null)}
              >
                <option value="">不关联</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title} · {taskStatusLabels[task.status]}
                  </option>
                ))}
              </select>
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
                  </div>
                );
              })}
              {state.members.length === 0 && <EmptyInline>尚未添加成员</EmptyInline>}
            </div>
            <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3">
              <div className="flex gap-2">
                <Input
                  value={personQuery}
                  placeholder="搜索人员"
                  aria-label="搜索 Task 成员"
                  onChange={(event) => setPersonQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void loadPeople();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={() => void loadPeople()}>
                  搜索
                </Button>
              </div>
              <select
                aria-label="成员人员"
                className={selectClassName}
                value={memberPersonId}
                onChange={(event) => setMemberPersonId(event.target.value)}
              >
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                    {person.accountAvailability !== "ACTIVE" ? "（账号不可用）" : ""}
                  </option>
                ))}
              </select>
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
          </ComposerSection>

        </aside>

        <main className="min-w-0 space-y-4">
          <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold">计划时间轴</h2>
                  <Badge variant="secondary" data-testid="task-composer-milestone-count">
                    {state.milestones.length}/200
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  固定 Asia/Shanghai；创建页只编排节点，不创建人员投入。
                </p>
              </div>
              <Button type="button" variant="outline" onClick={() => addMilestone()}>
                <Plus aria-hidden="true" />
                Milestone
              </Button>
            </div>
            <Field label="计划开始时间" required htmlFor="plannedStartAt" className="mt-4 max-w-sm">
              <Input
                id="plannedStartAt"
                type="datetime-local"
                value={state.plannedStartAt}
                aria-invalid={issues.some((issue) => issue.key === "plannedStartAt")}
                onChange={(event) => updateField("plannedStartAt", event.target.value)}
              />
            </Field>

            <PlanRail
              state={state}
              issues={issues}
              onAdd={addMilestone}
              onSelect={(id) => updateField("selectedEntityId", id)}
              onStartDrag={startDrag}
              onDrag={dragMilestone}
              onEndDrag={endDrag}
            />

            <div className="mt-4 space-y-2 lg:hidden" aria-label="移动端纵向计划节点">
              {state.milestones.map((milestone, index) => (
                <button
                  key={milestone.id}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-start gap-3 rounded-lg border p-3 text-left",
                    state.selectedEntityId === milestone.id
                      ? "border-primary bg-primary/5"
                      : "border-border",
                  )}
                  onClick={() => updateField("selectedEntityId", milestone.id)}
                >
                  <Badge variant="secondary">M{index + 1}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium">
                      {milestone.goal || "未命名 Milestone"}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {formatLocalDateTime(milestone.expectedCompletedAt)}
                    </span>
                  </span>
                  {issues.some((issue) => issue.entityId === milestone.id) && (
                    <AlertTriangle className="size-4 text-destructive" aria-label="存在校验问题" />
                  )}
                </button>
              ))}
              <button
                type="button"
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-left",
                  selectedTermination ? "border-primary bg-primary/5" : "border-border",
                )}
                onClick={() => updateField("selectedEntityId", state.termination.id)}
              >
                <Flag className="size-4 text-primary" aria-hidden="true" />
                <span>
                  <span className="block font-medium">Termination</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {formatLocalDateTime(state.termination.plannedAt)}
                  </span>
                </span>
              </button>
            </div>
          </section>

          {(serverError || optionError || statusMessage) && (
            <div
              className={cn(
                "rounded-lg border p-3 text-sm leading-6",
                serverError || optionError
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "border-border bg-muted/40",
              )}
              role={serverError || optionError ? "alert" : "status"}
              aria-live="polite"
            >
              {serverError || optionError || statusMessage}
              {optionLoading && " 正在加载…"}
            </div>
          )}
        </main>

        <aside className="min-w-0" aria-label="计划节点检查器">
          <div className="space-y-4 rounded-xl border border-border bg-card p-4 lg:sticky lg:top-36">
            {selectedMilestone ? (
              <MilestoneInspector
                milestone={selectedMilestone}
                index={state.milestones.findIndex((item) => item.id === selectedMilestone.id)}
                milestones={state.milestones}
                issues={issues}
                onUpdate={updateMilestone}
                onDuplicate={() => duplicateMilestone(selectedMilestone)}
                onDelete={() => removeMilestone(selectedMilestone.id)}
                onMoveSameTime={(direction) => moveSameTime(selectedMilestone.id, direction)}
              />
            ) : selectedTermination ? (
              <TerminationInspector
                state={state}
                issues={issues}
                onUpdate={(patch) =>
                  commit((current) => ({
                    ...current,
                    termination: { ...current.termination, ...patch },
                  }))
                }
              />
            ) : (
              <PlanOverview state={state} issues={issues} onFocusIssue={focusIssue} />
            )}

            <div className="border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">问题列表</h3>
                <Badge variant={issues.length > 0 ? "destructive" : "secondary"}>
                  {issues.length}
                </Badge>
              </div>
              {issues.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                  当前本地校验通过
                </p>
              ) : (
                <ol className="max-h-64 space-y-2 overflow-y-auto text-sm">
                  {issues.map((issue, index) => (
                    <li key={`${issue.key}:${issue.entityId ?? "root"}:${index}`}>
                      <button
                        type="button"
                        className="w-full rounded-md px-2 py-1 text-left text-destructive hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => focusIssue(issue)}
                      >
                        {issue.message}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              {lastValidationIssues.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  最近一次校验：{lastValidationIssues.length} 个问题
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>

      <div className="sticky bottom-0 z-20 flex gap-2 border-t border-border bg-background/95 p-3 backdrop-blur lg:hidden">
        <Button type="button" variant="outline" className="flex-1" onClick={() => addMilestone()}>
          <Plus aria-hidden="true" />
          Milestone
        </Button>
        <Button type="button" className="flex-1" disabled={submitting} onClick={submit}>
          {submitting ? "正在创建…" : "创建草稿"}
        </Button>
      </div>

      {pendingNavigation && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-composer-title"
        >
          <div className="w-full max-w-md rounded-xl bg-background p-5 shadow-xl">
            <h2 id="leave-composer-title" className="text-lg font-semibold">
              离开 Task Composer？
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              当前修改尚未提交到服务端。你可以保留本地草稿后离开，或放弃草稿。
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setPendingNavigation(null)}>
                继续编辑
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (!discardLocalDraft()) return;
                  setDirty(false);
                  if (pendingNavigation === "__HISTORY_BACK__") {
                    bypassPopStateRef.current = true;
                    historyGuardRef.current = false;
                    window.history.go(-2);
                  } else {
                    replaceAfterCollapsingHistoryGuard(pendingNavigation);
                  }
                }}
              >
                放弃并离开
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!persistLocalDraftNow()) return;
                  setDirty(false);
                  if (pendingNavigation === "__HISTORY_BACK__") {
                    bypassPopStateRef.current = true;
                    historyGuardRef.current = false;
                    window.history.go(-2);
                  } else {
                    replaceAfterCollapsingHistoryGuard(pendingNavigation);
                  }
                }}
              >
                保存本地草稿并离开
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanRail({
  state,
  issues,
  onAdd,
  onSelect,
  onStartDrag,
  onDrag,
  onEndDrag,
}: {
  state: TaskComposerSeed;
  issues: ValidationIssue[];
  onAdd: (at?: string) => void;
  onSelect: (id: string) => void;
  onStartDrag: (
    event: ReactPointerEvent<HTMLButtonElement>,
    milestone: TaskComposerMilestone,
  ) => void;
  onDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onEndDrag: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const range = composerRange(state);
  const width = Math.max(760, Math.ceil((range.endMs - range.startMs) / DAY_MS) * 48);
  const xFor = (value: string) => {
    const ms = localMs(value);
    const ratio = Number.isFinite(ms)
      ? (ms - range.startMs) / Math.max(1, range.endMs - range.startMs)
      : 0;
    return 48 + Math.max(0, Math.min(1, ratio)) * (width - 96);
  };
  const addAtPointer = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const at = range.startMs + ratio * (range.endMs - range.startMs);
    onAdd(isoToShanghaiDateTimeLocal(new Date(Math.round(at / DAY_MS) * DAY_MS)));
  };
  return (
    <div className="mt-5 hidden lg:block">
      <p className="mb-2 text-xs text-muted-foreground">
        单击空白处创建；拖动节点按天吸附；聚焦轨道后按 M 在中点创建。
      </p>
      <div className="max-w-full overflow-x-auto rounded-lg border border-border" data-testid="task-composer-plan-scroll">
        <div
          className="relative h-48 cursor-crosshair bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[size:48px_100%]"
          style={{ width }}
          tabIndex={0}
          role="application"
          aria-label="Task 计划时间轴"
          onClick={(event) => {
            // A browser double-click emits detail=1 then detail=2. The first click creates
            // exactly one node and the second is ignored, so both entry paths are equivalent.
            if (event.detail === 1) addAtPointer(event);
          }}
          onKeyDown={(event) => {
            if (event.key.toLowerCase() === "m") {
              event.preventDefault();
              onAdd(
                isoToShanghaiDateTimeLocal(
                  new Date((range.startMs + range.endMs) / 2),
                ),
              );
            }
          }}
        >
          <div className="absolute inset-x-8 top-24 h-px bg-border" aria-hidden="true" />
          <div
            className="absolute top-6 -translate-x-1/2 text-center text-xs"
            style={{ left: xFor(state.plannedStartAt) }}
          >
            <span className="block h-16 border-l-2 border-primary" aria-hidden="true" />
            <span className="mt-1 block whitespace-nowrap font-medium">计划开始</span>
          </div>
          {state.milestones.map((milestone, index) => {
            const hasIssue = issues.some((issue) => issue.entityId === milestone.id);
            return (
              <button
                key={milestone.id}
                type="button"
                data-node-id={milestone.id}
                aria-label={`Milestone ${index + 1}：${milestone.goal || "未命名"}，${formatLocalDateTime(milestone.expectedCompletedAt)}`}
                aria-pressed={state.selectedEntityId === milestone.id}
                className={cn(
                  "absolute top-[4.7rem] z-10 flex max-w-40 touch-none select-none flex-col items-center rounded-lg px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  state.selectedEntityId === milestone.id && "bg-primary/10",
                )}
                style={{ left: xFor(milestone.expectedCompletedAt), transform: "translateX(-50%)" }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(milestone.id);
                }}
                onPointerDown={(event) => onStartDrag(event, milestone)}
                onPointerMove={onDrag}
                onPointerUp={onEndDrag}
                onPointerCancel={onEndDrag}
              >
                <span
                  className={cn(
                    "grid size-7 rotate-45 place-items-center border-2 bg-background",
                    hasIssue ? "border-destructive" : "border-primary",
                  )}
                  aria-hidden="true"
                >
                  <span className="-rotate-45 text-[10px] font-bold">{index + 1}</span>
                </span>
                <span className="mt-2 max-w-36 truncate font-medium">
                  {milestone.goal || "未命名"}
                </span>
                <span className="whitespace-nowrap text-muted-foreground">
                  {datePart(milestone.expectedCompletedAt)}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className={cn(
              "absolute top-[4.6rem] z-10 flex -translate-x-1/2 flex-col items-center rounded-lg px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              state.selectedEntityId === state.termination.id && "bg-primary/10",
            )}
            style={{ left: xFor(state.termination.plannedAt) }}
            aria-label={`Termination：${formatLocalDateTime(state.termination.plannedAt)}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(state.termination.id);
            }}
          >
            <Flag className="size-7 text-primary" aria-hidden="true" />
            <span className="mt-2 font-medium">结束</span>
            <span className="whitespace-nowrap text-muted-foreground">
              {datePart(state.termination.plannedAt)}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function MilestoneInspector({
  milestone,
  index,
  milestones,
  issues,
  onUpdate,
  onDuplicate,
  onDelete,
  onMoveSameTime,
}: {
  milestone: TaskComposerMilestone;
  index: number;
  milestones: TaskComposerMilestone[];
  issues: ValidationIssue[];
  onUpdate: (
    id: string,
    patch: Partial<TaskComposerMilestone>,
    sortByDate?: boolean,
  ) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveSameTime: (direction: -1 | 1) => void;
}) {
  const previous = milestones[index - 1];
  const next = milestones[index + 1];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">草稿节点</p>
          <h2 className="font-semibold">Milestone #{index + 1}</h2>
        </div>
        <GripVertical className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <Field label="目标" required htmlFor={`goal-${milestone.id}`}>
        <Input
          id={`goal-${milestone.id}`}
          value={milestone.goal}
          aria-invalid={hasIssue(issues, `goal-${milestone.id}`)}
          onChange={(event) => onUpdate(milestone.id, { goal: event.target.value })}
        />
      </Field>
      <Field label="预期完成时间" required htmlFor={`expected-${milestone.id}`}>
        <Input
          id={`expected-${milestone.id}`}
          type="datetime-local"
          value={milestone.expectedCompletedAt}
          aria-invalid={hasIssue(issues, `expected-${milestone.id}`)}
          onChange={(event) =>
            onUpdate(milestone.id, { expectedCompletedAt: event.target.value }, true)
          }
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              onUpdate(
                milestone.id,
                { expectedCompletedAt: addDaysLocal(milestone.expectedCompletedAt, -1) },
                true,
              )
            }
          >
            前移一天
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              onUpdate(
                milestone.id,
                { expectedCompletedAt: addDaysLocal(milestone.expectedCompletedAt, 1) },
                true,
              )
            }
          >
            后移一天
          </Button>
        </div>
      </Field>
      <Field label="完成条件" required htmlFor={`criteria-${milestone.id}`}>
        <Textarea
          id={`criteria-${milestone.id}`}
          value={milestone.completionCriteria}
          aria-invalid={hasIssue(issues, `criteria-${milestone.id}`)}
          onChange={(event) =>
            onUpdate(milestone.id, { completionCriteria: event.target.value })
          }
        />
      </Field>
      <Field label="验收要求" required htmlFor={`review-${milestone.id}`}>
        <Textarea
          id={`review-${milestone.id}`}
          value={milestone.reviewRequirements}
          aria-invalid={hasIssue(issues, `review-${milestone.id}`)}
          onChange={(event) =>
            onUpdate(milestone.id, { reviewRequirements: event.target.value })
          }
        />
      </Field>
      <Field label="业务说明" htmlFor={`business-${milestone.id}`}>
        <Textarea
          id={`business-${milestone.id}`}
          value={milestone.businessDescription}
          onChange={(event) =>
            onUpdate(milestone.id, { businessDescription: event.target.value })
          }
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDuplicate}>
          <Copy aria-hidden="true" />
          复制
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            !previous || previous.expectedCompletedAt !== milestone.expectedCompletedAt
          }
          onClick={() => onMoveSameTime(-1)}
        >
          同时间前移
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            !next || next.expectedCompletedAt !== milestone.expectedCompletedAt
          }
          onClick={() => onMoveSameTime(1)}
        >
          同时间后移
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 aria-hidden="true" />
          删除
        </Button>
      </div>
    </div>
  );
}

function TerminationInspector({
  state,
  issues,
  onUpdate,
}: {
  state: TaskComposerSeed;
  issues: ValidationIssue[];
  onUpdate: (patch: Partial<TaskComposerSeed["termination"]>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-muted-foreground">固定终点，不可删除</p>
        <h2 className="font-semibold">Termination</h2>
      </div>
      <Field label="计划结束时间" required htmlFor="termination-plannedAt">
        <Input
          id="termination-plannedAt"
          type="datetime-local"
          value={state.termination.plannedAt}
          aria-invalid={hasIssue(issues, "termination-plannedAt")}
          onChange={(event) => onUpdate({ plannedAt: event.target.value })}
        />
      </Field>
      <Field label="Task 整体预期结果" required htmlFor="termination-outcome">
        <Textarea
          id="termination-outcome"
          value={state.termination.plannedOutcomeCriteria}
          aria-invalid={hasIssue(issues, "termination-outcome")}
          onChange={(event) => onUpdate({ plannedOutcomeCriteria: event.target.value })}
        />
      </Field>
      <Field label="业务说明" htmlFor="termination-business">
        <Textarea
          id="termination-business"
          value={state.termination.businessDescription}
          onChange={(event) => onUpdate({ businessDescription: event.target.value })}
        />
      </Field>
    </div>
  );
}

function PlanOverview({
  state,
  issues,
  onFocusIssue,
}: {
  state: TaskComposerSeed;
  issues: ValidationIssue[];
  onFocusIssue: (issue: ValidationIssue) => void;
}) {
  const start = localMs(state.plannedStartAt);
  const end = localMs(state.termination.plannedAt);
  return (
    <div>
      <h2 className="font-semibold">计划概览</h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-muted/50 p-3">
          <dt className="text-muted-foreground">Milestone</dt>
          <dd className="mt-1 text-lg font-semibold">{state.milestones.length}</dd>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <dt className="text-muted-foreground">计划跨度</dt>
          <dd className="mt-1 text-lg font-semibold">
            {Number.isFinite(start) && Number.isFinite(end) && end >= start
              ? `${Math.ceil((end - start) / DAY_MS)} 天`
              : "—"}
          </dd>
        </div>
      </dl>
      {issues[0] && (
        <Button
          type="button"
          variant="outline"
          className="mt-4 w-full"
          onClick={() => onFocusIssue(issues[0]!)}
        >
          定位第一个问题
        </Button>
      )}
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

function validateComposer(
  state: TaskComposerSeed,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!state.title.trim()) issues.push({ key: "title", message: "请输入 Task 名称。" });
  if (!TEAM_OPTIONS.includes(state.team as (typeof TEAM_OPTIONS)[number])) {
    issues.push({ key: "team", message: "请选择有效车组。" });
  }
  if (!TECH_GROUP_OPTIONS.includes(state.techGroup as (typeof TECH_GROUP_OPTIONS)[number])) {
    issues.push({ key: "techGroup", message: "请选择有效技术组。" });
  }
  if (!validLocalDateTime(state.plannedStartAt)) {
    issues.push({ key: "plannedStartAt", message: "请选择有效的计划开始时间。" });
  }
  if (new Set(state.tagIds).size !== state.tagIds.length) {
    issues.push({ key: "tag-search", message: "不能重复选择同一个 Tag。" });
  }
  if (state.members.length === 0) {
    issues.push({ key: "members", message: "至少添加一名 Task 成员。" });
  }
  const memberPersonIds = state.members.map((member) => member.personId);
  if (new Set(memberPersonIds).size !== memberPersonIds.length) {
    issues.push({ key: "members", message: "同一成员只能有一个角色。" });
  }
  if (state.members.every((member) => member.role !== "OWNER")) {
    issues.push({ key: "members", message: "至少需要一名负责人。" });
  }
  if (state.milestones.length < 1 || state.milestones.length > 200) {
    issues.push({ key: "plannedStartAt", message: "计划必须包含 1–200 个 Milestone。" });
  }
  let chronologyBoundary = localMs(state.plannedStartAt);
  for (const milestone of state.milestones) {
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
    } else if (Number.isFinite(chronologyBoundary) && at < chronologyBoundary) {
      issues.push({
        key: `expected-${milestone.id}`,
        entityId: milestone.id,
        message: "Milestone 必须按 sequence 非递减，且不得早于计划开始时间。",
      });
    }
    chronologyBoundary = at;
  }
  if (!validLocalDateTime(state.termination.plannedAt)) {
    issues.push({
      key: "termination-plannedAt",
      entityId: state.termination.id,
      message: "请选择有效的计划结束时间。",
    });
  } else if (
    Number.isFinite(chronologyBoundary) &&
    localMs(state.termination.plannedAt) < chronologyBoundary
  ) {
    issues.push({
      key: "termination-plannedAt",
      entityId: state.termination.id,
      message: "Termination 不得早于最后一个 Milestone。",
    });
  }
  if (!state.termination.plannedOutcomeCriteria.trim()) {
    issues.push({
      key: "termination-outcome",
      entityId: state.termination.id,
      message: "请填写 Task 整体预期结果。",
    });
  }
  return issues;
}

function parseLocalDraft(raw: string): LocalTaskDraft | null {
  if (raw.length > MAX_LOCAL_DRAFT_BYTES) return null;
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
      !validLocalDateTime(task.plannedStartAt) ||
      !Array.isArray(task.members) ||
      task.members.length > 500 ||
      !task.members.every(isStoredMember) ||
      !Array.isArray(task.tagIds) ||
      task.tagIds.length > 50 ||
      !task.tagIds.every((tagId) => typeof tagId === "string") ||
      !task.tagIds.every((tagId) => UUID_PATTERN.test(tagId as string)) ||
      !Array.isArray(task.milestones) ||
      task.milestones.length < 1 ||
      task.milestones.length > 200 ||
      !task.milestones.every(isStoredMilestone) ||
      !task.termination ||
      !isStoredTermination(task.termination)
    ) {
      return null;
    }
    const nodeIds = [
      ...task.milestones.map((milestone) => (milestone as Record<string, unknown>).id),
      (task.termination as Record<string, unknown>).id,
    ];
    if (
      new Set(nodeIds).size !== nodeIds.length ||
      (task.selectedEntityId !== null && !nodeIds.includes(task.selectedEntityId))
    ) {
      return null;
    }
    return value as LocalTaskDraft;
  } catch {
    return null;
  }
}

function migrateLegacyLocalDraft(
  raw: string,
  creatorPersonId: string,
): LocalTaskDraft | null {
  if (raw.length > MAX_LOCAL_DRAFT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.task)) {
      return null;
    }
    const legacyMembers = Array.isArray(value.task.members)
      ? value.task.members
      : [];
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
    const { revisionApprovalMode: _revisionApprovalMode, allowSelfReview: _allowSelfReview, ...task } =
      value.task;
    void _revisionApprovalMode;
    void _allowSelfReview;
    const migrated = {
      ...value,
      schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
      task: {
        ...task,
        members: [...normalized].map(([personId, role]) => ({
          personId,
          role,
        })),
      },
    };
    return parseLocalDraft(JSON.stringify(migrated));
  } catch {
    return null;
  }
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
    value.id.startsWith("draft-node-") &&
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
    validLocalDateTime(value.expectedCompletedAt)
  );
}

function isStoredTermination(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    ["id", "plannedAt", "plannedOutcomeCriteria", "businessDescription"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.id === "string" &&
    value.id.startsWith("draft-termination-") &&
    value.id.length <= 160 &&
    typeof value.plannedAt === "string" &&
    validLocalDateTime(value.plannedAt) &&
    typeof value.plannedOutcomeCriteria === "string" &&
    value.plannedOutcomeCriteria.length <= 2_000 &&
    typeof value.businessDescription === "string" &&
    value.businessDescription.length <= 2_000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function composerRange(state: TaskComposerSeed) {
  const values = [
    localMs(state.plannedStartAt),
    ...state.milestones.map((milestone) => localMs(milestone.expectedCompletedAt)),
    localMs(state.termination.plannedAt),
  ].filter(Number.isFinite);
  const fallback = Date.now();
  const startMs = Math.min(...(values.length > 0 ? values : [fallback]));
  const endCandidate = Math.max(...(values.length > 0 ? values : [fallback + 14 * DAY_MS]));
  return { startMs, endMs: Math.max(startMs + DAY_MS, endCandidate) };
}

function validLocalDateTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const iso = shanghaiDateTimeLocalToIso(value);
  return iso !== value && isoToShanghaiDateTimeLocal(iso) === value;
}

function localMs(value: string) {
  return new Date(shanghaiDateTimeLocalToIso(value)).getTime();
}

function addDaysLocal(value: string, days: number) {
  const parsed = localMs(value);
  if (!Number.isFinite(parsed)) return value;
  return isoToShanghaiDateTimeLocal(new Date(parsed + days * DAY_MS));
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

function datePart(value: string) {
  return value.slice(0, 10) || "未设置";
}

function formatLocalDateTime(value: string) {
  return validLocalDateTime(value) ? value.replace("T", " ") : "未设置";
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

function hasIssue(issues: ValidationIssue[], key: string) {
  return issues.some((issue) => issue.key === key);
}
