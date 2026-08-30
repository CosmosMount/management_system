import {
  TASK_COMPOSER_START_ID,
  type TaskComposerInspectorDraft,
  type TaskComposerMilestone,
  type TaskComposerNodeMeta,
  type TaskComposerSeed,
  type TaskComposerValidationIssue as ValidationIssue,
} from "@/lib/project-management/composer-contract";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import type { TimeCanvasAnchorMoveRequest } from "@/components/project-management/time-canvas/types";

export const NO_LEGAL_ANCHOR_MOVE_MESSAGE =
  "当前吸附粒度没有合法位置，节点已保留在原处；请放大画布或使用 Inspector 精调。";

export function inspectorDraftForEntity(
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
        description: state.revision.description,
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
export function applyLiveInspectorUpdate(
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
        description: draft.revision.description,
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

export function validateInspector(
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
        message: "请输入 Revision 名称。",
      });
    }
    if (!draft.revision.description.trim()) {
      issues.push({
        key: "revision-description",
        entityId: draft.entityId,
        message: "请输入 Revision 详细内容。",
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

export function nodeMetaFor(
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

export function renderAtLocal(state: TaskComposerSeed, entityId: string) {
  return nodeMetaFor(state, entityId).lastValidAt;
}

export function renderAtMs(state: TaskComposerSeed, entityId: string) {
  return localMs(renderAtLocal(state, entityId));
}

export function updateLastValidAt(
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

export function isNodeTimeStrictlyLegal(
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
export function nodeInputAtLocal(state: TaskComposerSeed, entityId: string) {
  const revisionAt = revisionAnchorAt(state, entityId);
  if (revisionAt) return revisionAt;
  if (entityId === TASK_COMPOSER_START_ID) return state.plannedStartAt;
  if (entityId === state.termination.id) return state.termination.plannedAt;
  return state.milestones.find((milestone) => milestone.id === entityId)
    ?.expectedCompletedAt ?? "";
}

export function comparisonAtMs(state: TaskComposerSeed, entityId: string) {
  const inputAt = nodeInputAtLocal(state, entityId);
  return validLocalDateTime(inputAt) ? localMs(inputAt) : renderAtMs(state, entityId);
}

export function isMilestoneTimeAvailable(
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

export function sortMilestonesByRenderTime(state: TaskComposerSeed) {
  return [...state.milestones].sort(
    (left, right) =>
      renderAtMs(state, left.id) - renderAtMs(state, right.id) ||
      left.id.localeCompare(right.id),
  );
}

export function reconcileStrictlyLegalTimes(state: TaskComposerSeed) {
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

export function reconcileComposerPlanState(state: TaskComposerSeed) {
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

export function promoteTemporaryMilestone(
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

export function applyAnchorMove(
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

export type ComposerPlanTimeMutationResult =
  | {
      ok: true;
      state: TaskComposerSeed;
      movedEntityIds: string[];
      deltaMs: number;
    }
  | { ok: false; message: string };

export function editableComposerEntityIds(state: TaskComposerSeed) {
  return [
    TASK_COMPOSER_START_ID,
    ...state.milestones.map((milestone) => milestone.id),
    ...(state.revision ? [state.revision.markerId] : []),
    state.termination.id,
  ].filter((entityId) => !isReadOnlyRevisionEntity(state, entityId));
}

export function composerBatchDelayEntityIds(
  state: TaskComposerSeed,
  entityId: string,
) {
  const selectedAt = renderAtMs(state, entityId);
  if (
    !Number.isFinite(selectedAt) ||
    !editableComposerEntityIds(state).includes(entityId)
  ) {
    return [];
  }
  return editableComposerEntityIds(state)
    .filter((candidateId) => renderAtMs(state, candidateId) >= selectedAt)
    .sort(
      (left, right) =>
        renderAtMs(state, left) - renderAtMs(state, right) ||
        left.localeCompare(right),
    );
}

export function resolveAnchorGroupMoveCandidate(
  state: TaskComposerSeed,
  request: TimeCanvasAnchorMoveRequest,
  selectedEntityIds: readonly string[],
):
  | {
      ok: true;
      originalAt: number;
      candidateAt: number;
      movedEntityIds: string[];
      deltaMs: number;
    }
  | { ok: false; message: string } {
  const editableIds = new Set(editableComposerEntityIds(state));
  const selectedIds = new Set(selectedEntityIds);
  const movedEntityIds = selectedIds.has(request.anchorId)
    ? [...selectedIds].filter((entityId) => editableIds.has(entityId))
    : [request.anchorId];
  if (!movedEntityIds.includes(request.anchorId)) {
    movedEntityIds.push(request.anchorId);
  }
  if (movedEntityIds.length <= 1) {
    const resolved = resolveAnchorMoveCandidate(state, request);
    return resolved.ok
      ? {
          ...resolved,
          movedEntityIds: [request.anchorId],
          deltaMs: resolved.candidateAt - resolved.originalAt,
        }
      : resolved;
  }
  if (movedEntityIds.some((entityId) => !editableIds.has(entityId))) {
    return { ok: false, message: "选中节点中包含只读节点，无法整体移动。" };
  }

  const originalAt = renderAtMs(state, request.anchorId);
  const deltaMs = request.atMs - originalAt;
  if (
    !Number.isFinite(originalAt) ||
    !Number.isFinite(deltaMs) ||
    !Number.isFinite(request.snapMs) ||
    request.snapMs <= 0
  ) {
    return { ok: false, message: "节点时间无效，请使用 Inspector 重新设置。" };
  }
  const shifted = applyEntityTimeDelta(state, movedEntityIds, deltaMs);
  if (!shifted.ok || !hasLegalRenderedPlanTimes(shifted.state)) {
    return {
      ok: false,
      message: "整组选中节点在此位置不合法，所有节点均已保留在原处。",
    };
  }
  return {
    ok: true,
    originalAt,
    candidateAt: originalAt + deltaMs,
    movedEntityIds,
    deltaMs,
  };
}

export function applyAnchorGroupMove(
  state: TaskComposerSeed,
  request: TimeCanvasAnchorMoveRequest,
  selectedEntityIds: readonly string[],
): ComposerPlanTimeMutationResult {
  const resolved = resolveAnchorGroupMoveCandidate(
    state,
    request,
    selectedEntityIds,
  );
  if (!resolved.ok) return resolved;
  if (resolved.movedEntityIds.length === 1) {
    const moved = applyAnchorMove(state, {
      ...request,
      atMs: resolved.candidateAt,
      deltaMs: resolved.deltaMs,
    });
    return moved.ok
      ? {
          ok: true,
          state: moved.state,
          movedEntityIds: resolved.movedEntityIds,
          deltaMs: resolved.deltaMs,
        }
      : moved;
  }
  const shifted = applyEntityTimeDelta(
    state,
    resolved.movedEntityIds,
    resolved.deltaMs,
  );
  if (!shifted.ok) return shifted;
  return {
    ok: true,
    state: reconcileComposerPlanState({
      ...shifted.state,
      selectedEntityId: request.anchorId,
    }),
    movedEntityIds: resolved.movedEntityIds,
    deltaMs: resolved.deltaMs,
  };
}

export function applyComposerBatchDelay(
  state: TaskComposerSeed,
  entityId: string,
  targetAt: string,
): ComposerPlanTimeMutationResult {
  const movedEntityIds = composerBatchDelayEntityIds(state, entityId);
  if (movedEntityIds.length === 0) {
    return { ok: false, message: "该节点为只读节点，不能批量推迟。" };
  }
  if (!validLocalDateTime(targetAt)) {
    return { ok: false, message: "请选择有效的新节点时间。" };
  }
  const originalAt = renderAtMs(state, entityId);
  const deltaMs = localMs(targetAt) - originalAt;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return { ok: false, message: "新的节点时间必须晚于当前时间。" };
  }
  const shifted = applyEntityTimeDelta(state, movedEntityIds, deltaMs);
  if (!shifted.ok || !hasLegalRenderedPlanTimes(shifted.state)) {
    return {
      ok: false,
      message: "推迟后节点时间超出合法范围，计划未发生任何变化。",
    };
  }
  return {
    ok: true,
    state: reconcileComposerPlanState({
      ...shifted.state,
      selectedEntityId: entityId,
    }),
    movedEntityIds,
    deltaMs,
  };
}

function applyEntityTimeDelta(
  state: TaskComposerSeed,
  entityIds: readonly string[],
  deltaMs: number,
): { ok: true; state: TaskComposerSeed } | { ok: false; message: string } {
  const updates = new Map<string, string>();
  for (const entityId of entityIds) {
    const nextAt = renderAtMs(state, entityId) + deltaMs;
    const localValue = isoToShanghaiDateTimeLocal(new Date(nextAt));
    if (!Number.isFinite(nextAt) || !validLocalDateTime(localValue)) {
      return { ok: false, message: "移动后的节点时间无效，计划未发生任何变化。" };
    }
    updates.set(entityId, localValue);
  }

  let nextState = state;
  for (const [entityId, localValue] of updates) {
    if (entityId === TASK_COMPOSER_START_ID) {
      nextState = { ...nextState, plannedStartAt: localValue };
    } else if (entityId === nextState.termination.id) {
      nextState = {
        ...nextState,
        termination: { ...nextState.termination, plannedAt: localValue },
      };
    } else if (entityId === nextState.revision?.markerId) {
      nextState = {
        ...nextState,
        revision: { ...nextState.revision, revisionAt: localValue },
      };
    } else {
      nextState = {
        ...nextState,
        milestones: nextState.milestones.map((milestone) =>
          milestone.id === entityId
            ? { ...milestone, expectedCompletedAt: localValue }
            : milestone,
        ),
      };
    }
    nextState = {
      ...nextState,
      nodeMeta: updateLastValidAt(nextState, entityId, localValue),
    };
  }
  return { ok: true, state: nextState };
}

function hasLegalRenderedPlanTimes(state: TaskComposerSeed) {
  const startAt = renderAtMs(state, TASK_COMPOSER_START_ID);
  const terminalAt = renderAtMs(state, state.termination.id);
  const milestoneTimes = state.milestones.map((milestone) =>
    renderAtMs(state, milestone.id),
  );
  if (
    !Number.isFinite(startAt) ||
    !Number.isFinite(terminalAt) ||
    startAt >= terminalAt ||
    milestoneTimes.some(
      (atMs) =>
        !Number.isFinite(atMs) || atMs <= startAt || atMs >= terminalAt,
    ) ||
    new Set(milestoneTimes).size !== milestoneTimes.length
  ) {
    return false;
  }
  if (!state.revision) return true;
  const lockedMilestoneBoundary = Math.max(
    startAt,
    ...state.revision.lockedMilestoneIds.map((id) => renderAtMs(state, id)),
  );
  if (
    !Number.isFinite(lockedMilestoneBoundary) ||
    state.milestones.some(
      (milestone) =>
        !state.revision!.lockedMilestoneIds.includes(milestone.id) &&
        renderAtMs(state, milestone.id) <= lockedMilestoneBoundary,
    )
  ) {
    return false;
  }
  const revisionAt = renderAtMs(state, state.revision.markerId);
  const lowerBoundary = Math.max(
    startAt,
    ...state.revision.lockedMilestoneIds.map((id) => renderAtMs(state, id)),
    ...state.revision.carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
  );
  return (
    Number.isFinite(revisionAt) &&
    revisionAt >= lowerBoundary &&
    revisionAt <= terminalAt
  );
}

export function resolveAnchorMoveCandidate(
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
    lowerExclusive = Math.max(
      renderAtMs(state, TASK_COMPOSER_START_ID),
      ...(state.revision?.lockedMilestoneIds.map((id) =>
        renderAtMs(state, id),
      ) ?? []),
    );
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

export function nearestLegalMove(input: {
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


export function validLocalDateTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const iso = shanghaiDateTimeLocalToIso(value);
  return iso !== value && isoToShanghaiDateTimeLocal(iso) === value;
}

export function localMs(value: string) {
  return new Date(shanghaiDateTimeLocalToIso(value)).getTime();
}

export function sortMilestones(milestones: TaskComposerMilestone[]) {
  return milestones
    .map((milestone, index) => ({ milestone, index }))
    .sort((left, right) => {
      const delta = localMs(left.milestone.expectedCompletedAt) - localMs(right.milestone.expectedCompletedAt);
      return Number.isFinite(delta) && delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.milestone);
}


export function normalizeComposerSeed(seed: TaskComposerSeed): TaskComposerSeed {
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
    projectId: seed.projectId ?? null,
    revision: seed.revision
      ? {
          ...seed.revision,
          description: seed.revision.description ?? "",
          carriedAnchors: seed.revision.carriedAnchors.map((anchor) => ({
            ...anchor,
            description: anchor.description ?? "",
          })),
        }
      : undefined,
    nodeMeta: normalizedMeta,
  };
  const reconciled = reconcileComposerPlanState(normalized);
  return seed.nodeMeta === undefined && !hasStrictRenderChronology(reconciled)
    ? createFallbackRenderChronology(reconciled)
    : reconciled;
}

export function hasStrictRenderChronology(state: TaskComposerSeed) {
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

export function createFallbackRenderChronology(state: TaskComposerSeed) {
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

export function revisionAnchorAt(state: TaskComposerSeed, entityId: string) {
  if (!state.revision) return null;
  if (state.revision.markerId === entityId) return state.revision.revisionAt;
  return state.revision.carriedAnchors.find((anchor) => anchor.id === entityId)
    ?.revisionAt ?? null;
}

export function revisionAnchorTimes(state: TaskComposerSeed) {
  if (!state.revision) return [];
  return [
    localMs(state.revision.revisionAt),
    ...state.revision.carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
  ].filter(Number.isFinite);
}

export function isLockedRevisionMilestone(state: TaskComposerSeed, entityId: string) {
  return state.revision?.lockedMilestoneIds.includes(entityId) ?? false;
}

export function isReadOnlyRevisionEntity(state: TaskComposerSeed, entityId: string) {
  if (!state.revision) return false;
  return (
    entityId === TASK_COMPOSER_START_ID ||
    state.revision.lockedMilestoneIds.includes(entityId) ||
    state.revision.carriedAnchors.some((anchor) => anchor.id === entityId)
  );
}

export function isRevisionTimeLegal(state: TaskComposerSeed, candidate: string) {
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
