import type { Prisma } from "@prisma/client";
import {
  assertAuthorized,
  authorize,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  associationInvalidError,
  notFoundError,
  staleTaskError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { acquireProjectCrossAggregateLockTx } from "@/lib/project-management/application/project-service";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import {
  taskMutationInclude,
  type TaskForMutation,
} from "@/lib/project-management/application/task-mutation-records";
import { lockTaskSegmentAssociationsTx } from "@/lib/project-management/application/task-segment-association-lock";
import type { UpdateTaskDraftInput } from "@/lib/project-management/validations/task-mutations";

type PrismaTx = Prisma.TransactionClient;

export async function loadLockedTaskTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  taskId: string,
): Promise<{
  refreshedActor: ProjectManagementActor;
  task: TaskForMutation;
}> {
  await acquireProjectCrossAggregateLockTx(tx);
  const lockedTaskIds = await lockTaskSegmentAssociationsTx(tx, [taskId]);
  if (!lockedTaskIds.has(taskId)) throw notFoundError();

  const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
  const task = await tx.task.findUnique({
    where: { id: taskId },
    include: taskMutationInclude,
  });
  if (!task || task.deletedAt) throw notFoundError();
  const visible = authorize({
    actor: refreshedActor,
    action: "task.view",
    resource: taskAuthorizationResource(task),
  });
  if (!visible.allowed) throw notFoundError();
  return { refreshedActor, task };
}

export function assertAuthorizedTaskAction(
  actor: ProjectManagementActor,
  task: TaskForMutation,
  action: "task.update_metadata" | "task.manage_members",
) {
  assertAuthorized({ actor, action, resource: taskAuthorizationResource(task) });
}

export function assertAuthorizedTargetScope(
  actor: ProjectManagementActor,
  task: TaskForMutation,
  input: Pick<UpdateTaskDraftInput, "team" | "techGroup">,
) {
  assertAuthorized({
    actor,
    action: "task.update_metadata",
    resource: {
      ...taskAuthorizationResource(task),
      team: input.team,
      techGroup: input.techGroup,
    },
  });
}

export function assertTaskStatus(
  task: TaskForMutation,
  requiredStatus: "DRAFT" | "ACTIVE",
) {
  if (task.status !== requiredStatus) {
    throw stateConflictError(
      requiredStatus === "DRAFT"
        ? "只有草稿 Task 可以执行此操作"
        : "只有执行中的 Task 可以执行此操作",
    );
  }
}

export function assertExpectedLockVersion(
  task: TaskForMutation,
  expectedLockVersion: number,
) {
  if (task.lockVersion !== expectedLockVersion) {
    throw staleTaskError(task);
  }
}

export async function assertRelatedTaskVisibleTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  taskId: string,
  relatedTaskId: string | null,
  currentRelatedTaskId: string | null,
) {
  if (!relatedTaskId) return;
  if (relatedTaskId === taskId) {
    throw associationInvalidError("Task 不能关联自身", {
      relatedTaskId: ["Task 不能关联自身"],
    });
  }
  if (relatedTaskId === currentRelatedTaskId) return;
  const relatedTask = await tx.task.findFirst({
    where: {
      AND: [{ id: relatedTaskId }, taskReadableWhere(actor)],
    },
    select: { id: true },
  });
  if (!relatedTask) throw notFoundError();
}
