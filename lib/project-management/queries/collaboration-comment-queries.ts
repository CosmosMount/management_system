import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validationError } from "@/lib/project-management/application/errors";
import { isSystemAdministrator } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  cursorWhere,
  loadReadableTarget,
  toTimestampCursor,
  type TimestampCursor,
} from "@/lib/project-management/queries/collaboration-query-support";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/lib/project-management/queries/keyset-cursor";
import { commentPageInputSchema } from "@/lib/project-management/validations/collaboration";

export type CommentItemDto = {
  id: string;
  authorName: string;
  authorInactive: boolean;
  content: string;
  createdAt: string;
  canDelete: boolean;
};

export type CommentPageDto = {
  items: CommentItemDto[];
  totalCount: number;
  nextCursor: string | null;
};

export async function getCommentPage(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<CommentPageDto> {
  const parsed = commentPageInputSchema.parse(input);
  await loadReadableTarget(actor, parsed.targetType, parsed.targetId);
  const cursorScope = JSON.stringify({
    targetType: parsed.targetType,
    targetId: parsed.targetId,
  });
  const cursor = toTimestampCursor(
    decodeKeysetCursor(
      parsed.cursor ?? undefined,
      "COMMENT",
      cursorScope,
      "评论分页游标无效",
    ),
  );
  const baseWhere: Prisma.CommentWhereInput = {
    deletedAt: null,
    ...(parsed.targetType === "PROJECT"
      ? { projectId: parsed.targetId }
      : { taskId: parsed.targetId }),
  };
  await validateCommentCursor(baseWhere, cursor);
  const [rows, totalCount] = await Promise.all([
    prisma.comment.findMany({
      where: { AND: [baseWhere, cursorWhere(cursor)] },
      include: { authorPerson: { select: { status: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.limit + 1,
    }),
    prisma.comment.count({ where: baseWhere }),
  ]);
  const items = rows.slice(0, parsed.limit).map((comment) => ({
    id: comment.id,
    authorName: comment.authorName,
    authorInactive: comment.authorPerson?.status === "INACTIVE",
    content: comment.content,
    createdAt: comment.createdAt.toISOString(),
    canDelete: isSystemAdministrator(actor),
  }));
  return {
    items,
    totalCount,
    nextCursor:
      rows.length > parsed.limit && items.at(-1)
        ? encodeKeysetCursor("COMMENT", cursorScope, {
            timestamp: new Date(items.at(-1)!.createdAt),
            id: items.at(-1)!.id,
          })
        : null,
  };
}

async function validateCommentCursor(
  where: Prisma.CommentWhereInput,
  cursor: TimestampCursor | null,
) {
  if (!cursor) return;
  const row = await prisma.comment.findFirst({
    where: {
      AND: [where, { id: cursor.id, createdAt: cursor.createdAt }],
    },
    select: { id: true },
  });
  if (!row) throw validationError("评论分页游标无效");
}
