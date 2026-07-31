import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isSystemAdministrator } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

const listTagsSchema = z.object({
  includeArchived: z.boolean().optional().default(true),
  query: z.string().trim().max(100).optional(),
  cursor: z.string().uuid("分页游标格式不正确").optional(),
  limit: z.number().int().min(1).max(100).optional().default(100),
});

export async function listTags({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input?: unknown;
}) {
  const parsed = listTagsSchema.parse(input ?? {});
  const rows = await prisma.tag.findMany({
    where: {
      ...(parsed.includeArchived ? {} : { archivedAt: null }),
      ...(parsed.query
        ? { name: { contains: parsed.query, mode: "insensitive" as const } }
        : {}),
    },
    include: { _count: { select: { taskTags: true, segmentTags: true } } },
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
  });
  const tags = rows.slice(0, parsed.limit);
  return {
    items: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      description: tag.description,
      archivedAt: tag.archivedAt?.toISOString() ?? null,
      createdAt: tag.createdAt.toISOString(),
      updatedAt: tag.updatedAt.toISOString(),
      taskCount: tag._count.taskTags,
      segmentCount: tag._count.segmentTags,
      capabilities: {
        canUpdate:
          isSystemAdministrator(actor) ||
          tag.createdByAccountId === actor.accountId,
        canDelete:
          isSystemAdministrator(actor) ||
          tag.createdByAccountId === actor.accountId,
      },
    })),
    nextCursor: rows.length > parsed.limit ? tags.at(-1)?.id ?? null : null,
  };
}

export type TagListItem = Awaited<ReturnType<typeof listTags>>["items"][number];
