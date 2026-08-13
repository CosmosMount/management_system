import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  TASK_COMPOSER_START_ID,
  type TaskComposerInspectorDraft,
  type TaskComposerMode,
  type TaskComposerRevisionAnchor,
  type TaskComposerRevisionContext,
  type TaskComposerSeed,
  type TaskMemberRoleValue,
} from "@/lib/project-management/composer-contract";
import { isoToShanghaiDateTimeLocal } from "@/lib/project-management/date-time";
import { MAX_TASK_COMPOSER_DRAFT_CHARS } from "@/components/project-management/task-composer-draft-storage";
import {
  applyLiveInspectorUpdate,
  hasStrictRenderChronology,
  isMilestoneTimeAvailable,
  normalizeComposerSeed,
  reconcileComposerPlanState,
  renderAtMs,
  revisionAnchorAt,
  validLocalDateTime,
} from "@/components/project-management/task-composer-plan-state";

export const LOCAL_DRAFT_SCHEMA_VERSION = 4;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskMemberRoles: readonly TaskMemberRoleValue[] = ["OWNER", "PARTICIPANT"];

export type LocalTaskDraft = {
  schemaVersion: 4;
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

export type LocalDraftRecovery =
  | { kind: "VALID"; draft: LocalTaskDraft }
  | { kind: "INCOMPATIBLE"; raw: string; reason: string };

export function localDraftContextError(
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

export function parseLocalDraft(raw: string): LocalTaskDraft | null {
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
      (task.projectId !== undefined && task.projectId !== null &&
        (typeof task.projectId !== "string" ||
          !UUID_PATTERN.test(task.projectId))) ||
      (task.selectedEntityId !== null &&
        (typeof task.selectedEntityId !== "string" || task.selectedEntityId.length > 160)) ||
      typeof task.plannedStartAt !== "string" ||
      task.plannedStartAt.length > 32 ||
      !Array.isArray(task.members) ||
      task.members.length > 500 ||
      !task.members.every(isStoredMember) ||
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
    const normalizedInspectorDraft = parsed.inspectorDraft?.kind === "REVISION"
      ? {
          ...parsed.inspectorDraft,
          revision: {
            ...parsed.inspectorDraft.revision,
            description: parsed.inspectorDraft.revision.description ?? "",
          },
        }
      : parsed.inspectorDraft;
    const restoredTask = parsed.inspectorDirty && normalizedInspectorDraft
      ? mergeStoredInspectorDraft(normalizedTask, normalizedInspectorDraft)
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
    (value.description === undefined ||
      (typeof value.description === "string" && value.description.length <= 2_000)) &&
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
    (value.description === undefined ||
      (typeof value.description === "string" && value.description.length <= 2_000)) &&
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

export function sanitizeRecoveredComposerState({
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
    relatedTaskId: authoritative.relatedTaskId,
    projectId: authoritative.projectId ?? null,
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
      description: recoveredRevision.description,
      revisionAt: recoveredRevision.revisionAt,
    },
  });
}
