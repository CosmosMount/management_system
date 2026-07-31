import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

export type ConflictMutationRange = {
  personId: string;
  startAt: Date;
  endAt: Date;
};

type PrismaTx = Prisma.TransactionClient;

export async function prepareConflictMutationTx(
  tx: PrismaTx,
  ranges: ConflictMutationRange[],
): Promise<ConflictMutationRange[]> {
  const normalized = normalizeConflictMutationRanges(ranges);
  await lockConflictPersonsTx(
    tx,
    normalized.map((range) => range.personId),
  );
  await lockConflictsForRangesTx(tx, normalized);
  return normalized;
}

export function normalizeConflictMutationRanges(
  ranges: ConflictMutationRange[],
): ConflictMutationRange[] {
  const byPerson = new Map<string, ConflictMutationRange[]>();
  for (const range of ranges) {
    if (range.endAt <= range.startAt) continue;
    const personRanges = byPerson.get(range.personId) ?? [];
    personRanges.push(range);
    byPerson.set(range.personId, personRanges);
  }
  const normalized: ConflictMutationRange[] = [];
  for (const personId of [...byPerson.keys()].sort()) {
    const sorted = [...(byPerson.get(personId) ?? [])].sort(
      (left, right) =>
        left.startAt.getTime() - right.startAt.getTime() ||
        left.endAt.getTime() - right.endAt.getTime(),
    );
    for (const range of sorted) {
      const latest = normalized.at(-1);
      if (
        latest?.personId === personId &&
        range.startAt <= latest.endAt
      ) {
        if (range.endAt > latest.endAt) latest.endAt = range.endAt;
      } else {
        normalized.push({ ...range });
      }
    }
  }
  return normalized;
}

export async function lockConflictPersonsTx(
  tx: PrismaTx,
  personIds: string[],
) {
  for (const personId of [...new Set(personIds)].sort()) {
    await lockConflictPersonTx(tx, personId);
  }
}

export async function lockConflictPersonTx(tx: PrismaTx, personId: string) {
  const digest = createHash("sha256")
    .update(`pm:resource-conflict:person:${personId}`)
    .digest();
  const namespaceKey = digest.readInt32BE(0);
  const personKey = digest.readInt32BE(4);
  await tx.$queryRaw<Array<{ locked: string }>>`
    SELECT pg_advisory_xact_lock(${namespaceKey}, ${personKey})::text AS "locked"
  `;
}

export async function lockConflictsForRangesTx(
  tx: PrismaTx,
  ranges: ConflictMutationRange[],
  requiredConflictIds: string[] = [],
) {
  if (ranges.length === 0 && requiredConflictIds.length === 0) return;
  const clauses: Prisma.ResourceConflictWhereInput[] = ranges.map((range) => ({
    personId: range.personId,
    startAt: { lt: range.endAt },
    endAt: { gt: range.startAt },
  }));
  const rows = await tx.resourceConflict.findMany({
    where: {
      OR: [
        ...clauses,
        ...(requiredConflictIds.length > 0
          ? [{ id: { in: [...new Set(requiredConflictIds)] } }]
          : []),
      ],
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return;
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "ResourceConflict"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id" ASC
    FOR UPDATE
  `;
}
