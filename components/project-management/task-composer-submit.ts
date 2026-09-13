import {
  createTaskDraft,
  updateTaskDraft,
} from "@/app/actions/project-management/tasks";
import {
  createRevision,
  reviseRejectedRevision,
} from "@/app/actions/project-management/revisions";
import {
  LOCAL_DRAFT_SCHEMA_VERSION,
  type LocalTaskDraft,
} from "@/components/project-management/task-composer-local-draft";
import { sortMilestones } from "@/components/project-management/task-composer-plan-state";
import { memberSubmissionFingerprint } from "@/components/project-management/task-composer-validation";
import type {
  TaskComposerMode,
  TaskComposerSeed,
} from "@/lib/project-management/composer-contract";
import { shanghaiDateTimeLocalToIso } from "@/lib/project-management/date-time";
import { routes } from "@/lib/routes";

type SubmitSuccess = {
  ok: true;
  destination: string;
  taskId?: string;
  lockVersion?: number;
};
type SubmitFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
  };
  conflictDraft?: LocalTaskDraft;
};

export async function submitTaskComposer({
  canManageMembers,
  editContext,
  initialState,
  mode,
  state,
}: {
  canManageMembers: boolean;
  editContext: LocalTaskDraft["editContext"];
  initialState: TaskComposerSeed;
  mode: TaskComposerMode;
  state: TaskComposerSeed;
}): Promise<SubmitSuccess | SubmitFailure> {
  const commonPayload = {
    title: state.title,
    description: state.description,
    team: state.team,
    techGroup: state.techGroup,
    priority: state.priority,
    relatedTaskId: state.relatedTaskId,
    projectId: state.projectId ?? null,
    plannedStartAt: shanghaiDateTimeLocalToIso(state.plannedStartAt),
  };

  if (mode.kind === "CREATE") {
    const result = await createTaskDraft({
      ...commonPayload,
      members: state.members,
      milestones: milestonePayload(sortMilestones(state.milestones)),
      termination: terminationPayload(state),
      idempotencyKey: "task-composer:" + state.draftId,
    });
    return result.ok
      ? {
          ok: true,
          destination:
            routes.progress.taskDetail(result.data.taskId) + "?created=1",
        }
      : result;
  }

  if (mode.kind === "EDIT_DRAFT") {
    const existingNodeIds = new Set(mode.existingNodeIds);
    const nodeIdentity = (id: string) =>
      existingNodeIds.has(id) ? { nodeId: id } : { clientKey: id };
    const membersChanged =
      memberSubmissionFingerprint(state.members) !==
      memberSubmissionFingerprint(initialState.members);
    const result = await updateTaskDraft({
      ...commonPayload,
      taskId: mode.taskId,
      planVersionId: mode.planVersionId,
      expectedLockVersion: mode.expectedLockVersion,
      ...(canManageMembers && membersChanged ? { members: state.members } : {}),
      milestones: sortMilestones(state.milestones).map((milestone) => ({
        ...nodeIdentity(milestone.id),
        ...milestonePayload([milestone])[0]!,
      })),
      termination: {
        ...nodeIdentity(state.termination.id),
        ...terminationPayload(state),
      },
    });
    if (result.ok) {
      return {
        ok: true,
        destination: routes.progress.taskDetail(mode.taskId),
        taskId: result.data.taskId,
        lockVersion: result.data.lockVersion,
      };
    }
    return result.error.code === "STALE_TASK"
      ? { ...result, conflictDraft: draftEnvelope(state, editContext) }
      : result;
  }

  if (!state.revision) {
    return {
      ok: false,
      error: {
        code: "INVALID_REVISION_CONTEXT",
        message: "Revision 编辑上下文缺失，请刷新后重试。",
      },
    };
  }
  const lockedMilestoneIds = new Set(
    initialState.revision?.lockedMilestoneIds ?? [],
  );
  const revisionPayload = {
    revisionAt: shanghaiDateTimeLocalToIso(state.revision.revisionAt),
    reason: state.revision.reason,
    description: state.revision.description,
    replacementMilestones: milestonePayload(
      sortMilestones(state.milestones).filter(
        (milestone) => !lockedMilestoneIds.has(milestone.id),
      ),
    ),
    termination: terminationPayload(state),
  };
  const result =
    mode.kind === "CREATE_REVISION"
      ? await createRevision({
          ...revisionPayload,
          taskId: mode.taskId,
          basePlanVersionId: mode.basePlanVersionId,
          baseTaskLockVersion: mode.baseTaskLockVersion,
          idempotencyKey: "revision-composer:" + state.draftId,
        })
      : await reviseRejectedRevision({
          ...revisionPayload,
          revisionNodeId: mode.revisionNodeId,
          expectedTargetPlanUpdatedAt: mode.expectedTargetPlanUpdatedAt,
        });
  if (result.ok) {
    return {
      ok: true,
      destination: routes.progress.taskRevisions(mode.taskId),
    };
  }
  return ["STALE_TASK", "PLAN_VERSION_CONFLICT", "STATE_CONFLICT"].includes(
    result.error.code,
  )
    ? { ...result, conflictDraft: draftEnvelope(state, editContext) }
    : result;
}

function milestonePayload(milestones: TaskComposerSeed["milestones"]) {
  return milestones.map((milestone) => ({
    goal: milestone.goal,
    completionCriteria: milestone.completionCriteria,
    expectedCompletedAt: shanghaiDateTimeLocalToIso(
      milestone.expectedCompletedAt,
    ),
    reviewRequirements: milestone.reviewRequirements,
    businessDescription: milestone.businessDescription,
  }));
}

function terminationPayload(state: TaskComposerSeed) {
  return {
    name: state.termination.name,
    plannedAt: shanghaiDateTimeLocalToIso(state.termination.plannedAt),
    plannedOutcomeCriteria: state.termination.plannedOutcomeCriteria,
    businessDescription: state.termination.businessDescription,
  };
}

function draftEnvelope(
  state: TaskComposerSeed,
  editContext: LocalTaskDraft["editContext"],
): LocalTaskDraft {
  return {
    schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
    draftId: state.draftId,
    savedAt: new Date().toISOString(),
    task: state,
    inspectorDraft: null,
    inspectorDirty: false,
    ...(editContext ? { editContext } : {}),
  };
}
