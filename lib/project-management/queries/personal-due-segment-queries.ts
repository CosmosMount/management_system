import { prisma } from "@/lib/prisma";
import { isSystemAdministrator } from "@/lib/project-management/authorization";
import { validationError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { listPersonalDueSegmentsInputSchema } from "@/lib/project-management/validations/segments";
import { fullSegmentSelect } from "@/lib/project-management/queries/time-canvas-records";
import { toFullSegmentDto } from "@/lib/project-management/queries/time-canvas-dto";
import {
  decodePersonalDueCursor,
  encodePersonalDueCursor,
} from "@/lib/project-management/queries/time-canvas-cursor";

export async function getPersonalDueSegments({
  actor,
  input,
  now = new Date(),
}: {
  actor: ProjectManagementActor;
  input?: unknown;
  now?: Date;
}) {
  const parsed = listPersonalDueSegmentsInputSchema.parse(input ?? {});
  const cursor = parsed.cursor
    ? decodePersonalDueCursor(parsed.cursor, actor.personId)
    : null;
  if (parsed.cursor && !cursor) {
    throw validationError("分页游标无效或已不再匹配当前到期队列", {
      cursor: ["分页游标无效或已不再匹配当前到期队列"],
    });
  }
  if (cursor) {
    const anchor = await prisma.workSegment.findFirst({
      where: { id: cursor.id, personId: actor.personId },
      select: { id: true },
    });
    if (!anchor) {
      throw validationError("分页游标无效或已不再匹配当前到期队列", {
        cursor: ["分页游标无效或已不再匹配当前到期队列"],
      });
    }
  }
  const rows = await prisma.workSegment.findMany({
    where: {
      AND: [
        {
          personId: actor.personId,
          type: "PLANNED",
          status: "PENDING_CONFIRMATION",
          endAt: { lte: now },
          deletedAt: null,
        },
        isSystemAdministrator(actor)
          ? {}
          : {
              OR: [
                { taskId: null },
                {
                  task: {
                    members: {
                      some: {
                        personId: actor.personId,
                        role: { in: ["OWNER", "PARTICIPANT"] },
                        removedAt: null,
                      },
                    },
                  },
                },
              ],
            },
        cursor
          ? {
              OR: [
                { endAt: { gt: new Date(cursor.endAt) } },
                {
                  endAt: new Date(cursor.endAt),
                  id: { gt: cursor.id },
                },
              ],
            }
          : {},
      ],
    },
    select: fullSegmentSelect,
    orderBy: [{ endAt: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
  });
  const page = rows.slice(0, parsed.limit);
  return {
    items: page.map((row) => ({
      ...toFullSegmentDto(actor, row),
      taskTitle: row.task?.title ?? null,
    })),
    nextCursor: rows.length > parsed.limit
      ? encodePersonalDueCursor(page.at(-1), actor.personId)
      : null,
    generatedAt: now.toISOString(),
  };
}
