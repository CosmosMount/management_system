import {
  Prisma,
  type WorkSegmentChangeAction,
} from "@prisma/client";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

type PrismaTx = Prisma.TransactionClient;

export async function recordSegmentChangeTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    segmentId: string;
    action: WorkSegmentChangeAction;
    before: Prisma.InputJsonValue | null;
    after: Prisma.InputJsonValue | null;
    reason: string;
  },
) {
  await tx.workSegmentChange.create({
    data: {
      segmentId: input.segmentId,
      action: input.action,
      before: input.before ?? Prisma.JsonNull,
      after: input.after ?? Prisma.JsonNull,
      reason: input.reason,
      actorAccountId: input.actor.accountId,
    },
  });
  await createDomainAuditEventTx(tx, {
    actorAccountId: input.actor.accountId,
    actorPersonId: input.actor.personId,
    action: `pm.segment.${input.action.toLowerCase()}`,
    entityType: "WorkSegment",
    entityId: input.segmentId,
    taskId: extractTaskId(input.after) ?? extractTaskId(input.before),
    before: input.before,
    after: input.after,
    reason: input.reason,
  });
}

function extractTaskId(value: Prisma.InputJsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const taskId = (value as Record<string, unknown>).taskId;
  return typeof taskId === "string" ? taskId : null;
}
