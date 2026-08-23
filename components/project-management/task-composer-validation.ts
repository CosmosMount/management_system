import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  TASK_COMPOSER_START_ID,
  type TaskComposerSeed,
  type TaskComposerValidationIssue as ValidationIssue,
} from "@/lib/project-management/composer-contract";
import {
  comparisonAtMs,
  isLockedRevisionMilestone,
  localMs,
  nodeMetaFor,
  sortMilestones,
  validLocalDateTime,
} from "@/components/project-management/task-composer-plan-state";

export type TaskActionError = {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export function validateComposer(
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
        message: "请输入 Revision 名称。",
      });
    } else if (state.revision.reason.trim().length > 2_000) {
      issues.push({
        key: "revision-reason",
        entityId: state.revision.markerId,
        message: "Revision 名称不能超过 2000 个字符。",
      });
    }
    if (!state.revision.description.trim()) {
      issues.push({
        key: "revision-description",
        entityId: state.revision.markerId,
        message: "请输入 Revision 详细内容。",
      });
    } else if (state.revision.description.trim().length > 2_000) {
      issues.push({
        key: "revision-description",
        entityId: state.revision.markerId,
        message: "Revision 详细内容不能超过 2000 个字符。",
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

export function actionErrorMessage(error: TaskActionError) {
  const detail = Object.values(error.fieldErrors ?? {})
    .flatMap((messages) => messages)
    .find(Boolean);
  return detail && detail !== error.message
    ? `${error.message}：${detail}`
    : error.message;
}

export function serverFieldValidationIssues(
  fieldErrors: Record<string, string[]> | undefined,
  state: TaskComposerSeed,
): ValidationIssue[] {
  return Object.entries(fieldErrors ?? {})
    .flatMap(([path, messages]) =>
      messages
        .filter(Boolean)
        .map((message) => serverFieldValidationIssue(path, message, state)),
    )
    .filter((issue): issue is ValidationIssue => issue !== null);
}

export function serverFieldValidationIssuesFullyMapped(
  fieldErrors: Record<string, string[]> | undefined,
  mappedIssues: readonly ValidationIssue[],
) {
  const fieldMessageCount = Object.values(fieldErrors ?? {})
    .flatMap((messages) => messages)
    .filter(Boolean).length;
  return mappedIssues.length > 0 && mappedIssues.length === fieldMessageCount;
}

function serverFieldValidationIssue(
  path: string,
  message: string,
  state: TaskComposerSeed,
): ValidationIssue | null {
  const directKeys: Record<string, string> = {
    title: "title",
    priority: "priority",
    team: "team",
    techGroup: "techGroup",
    relatedTaskId: "related-task",
    projectId: "task-project",
    members: "members",
    plannedStartAt: "plannedStartAt",
    revisionAt: "revisionAt",
    reason: "revision-reason",
    description: state.revision ? "revision-description" : "description",
    "termination.name": "termination-name",
    "termination.plannedAt": "termination-plannedAt",
    "termination.plannedOutcomeCriteria": "termination-outcome",
    "termination.businessDescription": "termination-business",
  };
  const directKey = directKeys[path];
  if (directKey) {
    return {
      key: directKey,
      message,
      ...(path === "plannedStartAt"
        ? { entityId: TASK_COMPOSER_START_ID }
        : path === "revisionAt" || path === "reason" || (path === "description" && state.revision)
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
  const key = milestoneKeys[milestoneMatch[2] ?? ""];
  if (!key) return null;
  return {
    key,
    entityId: milestone.id,
    message,
  };
}


export function composerSubmissionFingerprint(state: TaskComposerSeed) {
  return JSON.stringify({
    title: state.title,
    description: state.description,
    team: state.team,
    techGroup: state.techGroup,
    priority: state.priority,
    relatedTaskId: state.relatedTaskId,
    projectId: state.projectId ?? null,
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
          description: state.revision.description,
          revisionAt: state.revision.revisionAt,
        }
      : null,
  });
}

export function memberSubmissionFingerprint(
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
