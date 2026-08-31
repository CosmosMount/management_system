import { prisma } from "@/lib/prisma";
import { notFoundError } from "@/lib/project-management/application/errors";
import {
  authorize,
  projectReadableWhere,
  taskReadableWhere,
  type AuthorizationProjectResource,
  type AuthorizationResource,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export type TargetType = "PROJECT" | "TASK";
export type TimestampCursor = { createdAt: Date; id: string };

type ReadableTarget =
  | {
      type: "PROJECT";
      id: string;
      status: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "COMPLETED";
      requesterAccountId: string;
      members: Array<{
        personId: string;
        role: "OWNER" | "PARTICIPANT";
        removedAt: Date | null;
      }>;
    }
  | {
      type: "TASK";
      id: string;
      status:
        | "DRAFT"
        | "ACTIVE"
        | "COMPLETED"
        | "FAILED"
        | "CANCELLED"
        | "TIMEOUT"
        | "ARCHIVED";
      priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      team: string;
      techGroup: string;
      members: Array<{
        personId: string;
        role: "OWNER" | "PARTICIPANT";
        removedAt: Date | null;
      }>;
    };

export async function loadReadableTarget(
  actor: ProjectManagementActor,
  targetType: TargetType,
  targetId: string,
): Promise<ReadableTarget> {
  if (targetType === "PROJECT") {
    const project = await prisma.project.findFirst({
      where: { AND: [{ id: targetId }, projectReadableWhere(actor)] },
      select: {
        id: true,
        status: true,
        requesterAccountId: true,
        members: {
          where: { removedAt: null },
          select: { personId: true, role: true, removedAt: true },
        },
      },
    });
    if (!project) throw notFoundError();
    const resource: AuthorizationProjectResource = { type: "project", ...project };
    if (!authorize({ actor, action: "project.view", resource }).allowed) throw notFoundError();
    return { type: "PROJECT", ...project };
  }
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: targetId }, taskReadableWhere(actor)] },
    select: {
      id: true,
      status: true,
      priority: true,
      team: true,
      techGroup: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  });
  if (!task) throw notFoundError();
  const resource: AuthorizationTaskResource = { type: "task", ...task };
  if (!authorize({ actor, action: "task.view", resource }).allowed) throw notFoundError();
  return { type: "TASK", ...task };
}

export function targetResource(target: ReadableTarget): AuthorizationResource {
  if (target.type === "PROJECT") {
    return {
      type: "project",
      id: target.id,
      status: target.status,
      requesterAccountId: target.requesterAccountId,
      members: target.members,
    };
  }
  return {
    type: "task",
    id: target.id,
    status: target.status,
    priority: target.priority,
    team: target.team,
    techGroup: target.techGroup,
    members: target.members,
  };
}

export function cursorWhere(cursor: TimestampCursor | null) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}

export function toTimestampCursor(
  cursor: { timestamp: Date; id: string } | null,
): TimestampCursor | null {
  return cursor ? { createdAt: cursor.timestamp, id: cursor.id } : null;
}
