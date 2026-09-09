import type { TaskStatus } from "@prisma/client";
import { resolveCurrentNodeDeadline } from "@/lib/project-management/current-node-deadline";
import { authorize } from "@/lib/project-management/authorization";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import { isTaskCreatableForSegment } from "@/lib/project-management/domain/task-segment-policy";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type {
  SegmentPermissionsDto,
  TimeCanvasNodeAnchorDto,
  TimeCanvasTaskAnchorDto,
  TimeSegmentDto,
} from "@/lib/project-management/types/time-canvas";
import type {
  AnchorTask,
  CanvasTask,
  FullSegment,
} from "@/lib/project-management/queries/time-canvas-records";

export function toTaskAnchorDto(
  actor: ProjectManagementActor,
  task: AnchorTask,
): TimeCanvasTaskAnchorDto {
  const resource = taskAuthorizationResource(task);
  const taskCanEdit =
    (task.status === "DRAFT" || task.status === "ACTIVE") &&
    authorize({ actor, action: "task.update_metadata", resource }).allowed;
  const canManageMembers =
    (task.status === "DRAFT" || task.status === "ACTIVE") &&
    authorize({ actor, action: "task.manage_members", resource }).allowed;
  const hasPendingApproval = task.nodes.length > 0;
  const updatedAt = task.updatedAt.toISOString();
  return {
    currentNodeDeadline: resolveCurrentNodeDeadline({
      taskStatus: task.status,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
      nodes: task.currentPlanVersion.nodes.map((entry) => entry.node),
    }),
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt.toISOString(),
    plannedStartAt: task.currentPlanVersion.plannedStartAt?.toISOString() ?? null,
    capabilities: {
      canView: true,
      canUpdateMetadata: taskCanEdit,
      canManageMembers,
      canActivate:
        task.status === "DRAFT" &&
        authorize({ actor, action: "task.activate", resource }).allowed,
      canArchive:
        isTerminalTaskStatus(task.status) &&
        authorize({ actor, action: "task.archive", resource }).allowed,
      canCreateRevision:
        task.status === "ACTIVE" &&
        !hasPendingApproval &&
        authorize({ actor, action: "revision.create", resource }).allowed,
    },
    nodes: task.currentPlanVersion.nodes.flatMap((entry) => {
      if (entry.node.deletedAt) return [];
      return [toNodeAnchorDto(actor, task, entry.sequence, entry.node)];
    }),
    updatedAt,
    versionToken: updatedAt,
  };
}

function toNodeAnchorDto(
  actor: ProjectManagementActor,
  task: AnchorTask,
  sequence: number,
  node: AnchorTask["currentPlanVersion"]["nodes"][number]["node"],
): TimeCanvasNodeAnchorDto {
  const resource = taskAuthorizationResource(task);
  const isDraftEditable =
    task.status === "DRAFT" &&
    task.currentPlanVersion.activatedAt === null &&
    authorize({ actor, action: "task.update_metadata", resource }).allowed;
  const isActivePlannedNode =
    task.status === "ACTIVE" &&
    node.status !== "REVISED" &&
    node.status !== "CANCELLED";
  const hasPendingApproval = task.nodes.length > 0;
  const updatedAt = node.updatedAt.toISOString();
  return {
    id: node.id,
    taskId: node.taskId,
    type: node.type,
    status: node.status,
    sequence,
    label: nodeLabel(node),
    plannedAt: nodePlannedAt(node)?.toISOString() ?? null,
    capabilities: {
      canView: true,
      canEditDraft: isDraftEditable,
      canCreateSegment:
        isTaskCreatableForSegment(task.status) &&
        (isDraftEditable || isActivePlannedNode) &&
        authorize({
          actor,
          action: "segment.manage_self",
          resource: {
            type: "segment",
            personId: actor.personId,
            task: resource,
          },
        }).allowed,
      canSubmitReview:
        node.type === "MILESTONE" &&
        node.status === "ACTIVE" &&
        !hasPendingApproval &&
        authorize({ actor, action: "milestone.submit_review", resource })
          .allowed,
      canReview:
        (node.type === "MILESTONE" &&
          node.status === "ACTIVE" &&
          authorize({ actor, action: "milestone.review", resource }).allowed) ||
        (node.type === "TERMINATION" &&
          Boolean(node.termination?.reviews.length) &&
          authorize({ actor, action: "termination.review", resource }).allowed),
      canSubmitTerminationReview:
        node.type === "TERMINATION" &&
        task.status === "ACTIVE" &&
        !hasPendingApproval &&
        authorize({ actor, action: "termination.submit_review", resource })
          .allowed,
    },
    updatedAt,
    versionToken: updatedAt,
  };
}

export function toFullSegmentDto(
  actor: ProjectManagementActor,
  segment: FullSegment,
): TimeSegmentDto {
  const updatedAt = segment.updatedAt.toISOString();
  return {
    kind: "SEGMENT",
    visibility: "FULL",
    id: segment.id,
    personId: segment.personId,
    type: "WORK",
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    taskId: segment.taskId,
    taskTitle: segment.task?.title ?? null,
    permissions: segmentPermissions(actor, segment),
    updatedAt,
    versionToken: updatedAt,
  };
}

export function segmentPermissions(
  actor: ProjectManagementActor,
  segment: Pick<FullSegment, "personId" | "task" | "deletedAt">,
): SegmentPermissionsDto {
  const canManage = authorize({
    actor,
    action:
      segment.personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskAuthorizationResource(segment.task) : null,
    },
  }).allowed;
  const editable = canManage && !segment.deletedAt;
  return {
    canViewDetails: true,
    canEdit: editable,
    canMove: editable,
    canResize: editable,
    canSoftDelete: editable,
  };
}

export function canCreateForPerson(
  actor: ProjectManagementActor,
  personId: string,
  task: CanvasTask | null,
): boolean {
  return authorize({
    actor,
    action:
      personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others",
    resource: {
      type: "segment",
      personId,
      task: task ? taskAuthorizationResource(task) : null,
    },
  }).allowed;
}

function nodeLabel(
  node: AnchorTask["currentPlanVersion"]["nodes"][number]["node"],
): string {
  if (node.milestone) return node.milestone.goal;
  if (node.revision) return node.revision.reason;
  if (node.termination) return node.termination.name;
  return node.businessDescription.trim() || node.type;
}

function nodePlannedAt(
  node: AnchorTask["currentPlanVersion"]["nodes"][number]["node"],
): Date | null {
  if (node.milestone) return node.milestone.expectedCompletedAt;
  if (node.termination) return node.termination.plannedAt;
  if (node.revision) return node.revision.revisionAt;
  return null;
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT"
  );
}
