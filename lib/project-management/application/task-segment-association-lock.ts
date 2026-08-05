import { Prisma } from "@prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Task is the serialization point for Task member changes and WorkSegment
 * task-association writes. Callers that need more than one Task must pass the
 * complete set before taking any WorkSegment row lock.
 */
export async function lockTaskSegmentAssociationsTx(
  tx: PrismaTx,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const orderedTaskIds = [...new Set(taskIds)].sort();
  if (orderedTaskIds.length === 0) return new Set();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Task"
    WHERE "id" IN (${Prisma.join(orderedTaskIds)})
    ORDER BY "id" ASC
    FOR UPDATE
  `;
  return new Set(rows.map((row) => row.id));
}
