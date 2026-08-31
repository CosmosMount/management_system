import type { Prisma, RiskRecordStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validationError } from "@/lib/project-management/application/errors";
import { authorize } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  cursorWhere,
  loadReadableTarget,
  toTimestampCursor,
  type TargetType,
  type TimestampCursor,
} from "@/lib/project-management/queries/collaboration-query-support";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/lib/project-management/queries/keyset-cursor";
import { riskPageInputSchema } from "@/lib/project-management/validations/collaboration";

export type RiskItemDto = {
  id: string;
  content: string;
  status: RiskRecordStatus;
  createdByName: string;
  createdAt: string;
  resolvedByName: string | null;
  resolveNote: string | null;
  resolvedAt: string | null;
  target: { type: TargetType; id: string; name: string };
  canResolve: boolean;
};

export type RiskPageDto = {
  items: RiskItemDto[];
  totalCount: number;
  nextCursor: string | null;
};

export async function getRiskPage(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RiskPageDto> {
  const parsed = riskPageInputSchema.parse(input);
  await loadReadableTarget(actor, parsed.targetType, parsed.targetId);
  if (parsed.source === "TASKS" && parsed.targetType !== "PROJECT") {
    throw validationError("只有 Project 可以汇总所属 Task 风险");
  }
  const cursorScope = JSON.stringify({
    targetType: parsed.targetType,
    targetId: parsed.targetId,
    source: parsed.source,
    status: parsed.status,
  });
  const cursor = toTimestampCursor(
    decodeKeysetCursor(
      parsed.cursor ?? undefined,
      "RISK",
      cursorScope,
      "风险分页游标无效",
    ),
  );
  const baseWhere: Prisma.RiskRecordWhereInput = {
    status: parsed.status,
    ...(parsed.source === "TASKS"
      ? {
          task: {
            projectId: parsed.targetId,
            deletedAt: null,
          },
        }
      : parsed.targetType === "PROJECT"
        ? { projectId: parsed.targetId }
        : { taskId: parsed.targetId }),
  };
  await validateRiskCursor(baseWhere, cursor);
  const where: Prisma.RiskRecordWhereInput = {
    AND: [baseWhere, cursorWhere(cursor)],
  };
  const [rows, totalCount] = await Promise.all([
    prisma.riskRecord.findMany({
      where,
      include: {
        project: {
          select: {
            id: true,
            name: true,
            status: true,
            members: { where: { removedAt: null } },
          },
        },
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            team: true,
            techGroup: true,
            members: { where: { removedAt: null } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.limit + 1,
    }),
    prisma.riskRecord.count({ where: baseWhere }),
  ]);
  const items = rows.slice(0, parsed.limit).map((risk) => {
    const directTarget = risk.project
      ? {
          type: "PROJECT" as const,
          id: risk.project.id,
          name: risk.project.name,
          status: risk.project.status,
          members: risk.project.members,
        }
      : {
          type: "TASK" as const,
          id: risk.task!.id,
          name: risk.task!.title,
          title: risk.task!.title,
          status: risk.task!.status,
          priority: risk.task!.priority,
          team: risk.task!.team,
          techGroup: risk.task!.techGroup,
          members: risk.task!.members,
        };
    return {
      id: risk.id,
      content: risk.content,
      status: risk.status,
      createdByName: risk.createdByName,
      createdAt: risk.createdAt.toISOString(),
      resolvedByName: risk.resolvedByName,
      resolveNote: risk.resolveNote,
      resolvedAt: risk.resolvedAt?.toISOString() ?? null,
      target: {
        type: directTarget.type,
        id: directTarget.id,
        name: directTarget.name,
      },
      canResolve:
        risk.status === "ACTIVE" &&
        directTarget.status !== "DRAFT" &&
        !("status" in directTarget && directTarget.status === "PENDING_APPROVAL") &&
        authorize({
          actor,
          action:
            directTarget.type === "PROJECT"
              ? "project.risk.resolve"
              : "task.risk.resolve",
          resource:
            directTarget.type === "PROJECT"
              ? {
                  type: "project",
                  id: directTarget.id,
                  status: directTarget.status,
                  members: directTarget.members,
                }
              : {
                  type: "task",
                  id: directTarget.id,
                  status: directTarget.status,
                  priority: directTarget.priority,
                  team: directTarget.team,
                  techGroup: directTarget.techGroup,
                  members: directTarget.members,
                },
        }).allowed,
    };
  });
  return {
    items,
    totalCount,
    nextCursor:
      rows.length > parsed.limit && items.at(-1)
        ? encodeKeysetCursor("RISK", cursorScope, {
            timestamp: new Date(items.at(-1)!.createdAt),
            id: items.at(-1)!.id,
          })
        : null,
  };
}

async function validateRiskCursor(
  where: Prisma.RiskRecordWhereInput,
  cursor: TimestampCursor | null,
) {
  if (!cursor) return;
  const row = await prisma.riskRecord.findFirst({
    where: {
      AND: [where, { id: cursor.id, createdAt: cursor.createdAt }],
    },
    select: { id: true },
  });
  if (!row) throw validationError("风险分页游标无效");
}
