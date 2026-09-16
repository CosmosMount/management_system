import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

type AggregationRecipientInput = {
  outboxId: string;
  channel: string;
  botKind: string;
  category: string;
  recipientOpenIds: string[];
  windowSeconds: number;
  createdAt?: Date;
};

export async function attachAggregatedNotificationRecipientsTx(
  tx: Prisma.TransactionClient,
  input: AggregationRecipientInput,
) {
  const now = input.createdAt ?? new Date();
  const recipients = [
    ...new Set(input.recipientOpenIds.map((value) => value.trim()).filter(Boolean)),
  ]
    .map((recipientOpenId) => {
      const groupingKey = [
        input.channel,
        input.botKind,
        recipientOpenId,
        input.category,
      ].join("\u0000");
      return {
        recipientOpenId,
        openKey: createHash("sha256").update(groupingKey).digest("hex"),
      };
    })
    .sort((left, right) => left.openKey.localeCompare(right.openKey));
  if (recipients.length === 0) return;

  const openKeys = recipients.map(({ openKey }) => openKey);
  // Acquire every key in a deterministic order before reading batches. This
  // preserves cross-request serialization while avoiding per-recipient ORM
  // round trips inside the caller's business transaction.
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended("openKey", 0))::text AS "locked"
    FROM unnest(ARRAY[${Prisma.join(openKeys)}]::text[]) AS keys("openKey")
    ORDER BY "openKey"
  `);

  const existingBatches = await tx.notificationDeliveryBatch.findMany({
    where: { openKey: { in: openKeys } },
    select: {
      id: true,
      openKey: true,
      status: true,
      windowEndsAt: true,
      _count: { select: { recipients: true } },
    },
  });
  const emptyBatchIds = existingBatches
    .filter((batch) => batch._count.recipients === 0)
    .map((batch) => batch.id);
  if (emptyBatchIds.length > 0) {
    await tx.notificationDeliveryBatch.deleteMany({
      where: { id: { in: emptyBatchIds } },
    });
  }
  const sealedBatchIds = existingBatches
    .filter(
      (batch) =>
        batch._count.recipients > 0 &&
        (batch.status !== "PENDING" || batch.windowEndsAt <= now),
    )
    .map((batch) => batch.id);
  if (sealedBatchIds.length > 0) {
    await tx.notificationDeliveryBatch.updateMany({
      where: { id: { in: sealedBatchIds }, openKey: { in: openKeys } },
      data: { openKey: null },
    });
  }

  const reusableBatchByKey = new Map(
    existingBatches
      .filter(
        (batch) =>
          batch.openKey !== null &&
          batch._count.recipients > 0 &&
          batch.status === "PENDING" &&
          batch.windowEndsAt > now,
      )
      .map((batch) => [batch.openKey!, batch]),
  );
  const defaultWindowEndsAt = new Date(
    now.getTime() + input.windowSeconds * 1000,
  );
  const recipientRows = recipients.map(({ recipientOpenId, openKey }) => {
    const existingBatch = reusableBatchByKey.get(openKey);
    return {
      recipientOpenId,
      deliveryBatchId: existingBatch?.id ?? randomUUID(),
      openKey,
      windowEndsAt: existingBatch?.windowEndsAt ?? defaultWindowEndsAt,
      needsBatch: !existingBatch,
    };
  });
  const newBatches = recipientRows.filter((row) => row.needsBatch);
  if (newBatches.length > 0) {
    await tx.notificationDeliveryBatch.createMany({
      data: newBatches.map((row) => ({
        id: row.deliveryBatchId,
        openKey: row.openKey,
        channel: input.channel,
        botKind: input.botKind,
        category: input.category,
        recipientOpenId: row.recipientOpenId,
        nextRunAt: row.windowEndsAt,
        windowStartedAt: now,
        windowEndsAt: row.windowEndsAt,
      })),
    });
  }
  await tx.notificationOutboxRecipient.createMany({
    data: recipientRows.map((row) => ({
      outboxId: input.outboxId,
      deliveryBatchId: row.deliveryBatchId,
      openId: row.recipientOpenId,
      nextRunAt: row.windowEndsAt,
    })),
  });
  const earliestWindowEndsAt = recipientRows.reduce(
    (earliest, row) =>
      row.windowEndsAt < earliest ? row.windowEndsAt : earliest,
    recipientRows[0]!.windowEndsAt,
  );
  await tx.notificationOutbox.update({
    where: { id: input.outboxId },
    data: { nextRunAt: earliestWindowEndsAt },
  });
}
