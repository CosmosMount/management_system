import { prisma } from "@/lib/prisma";
import { logger, withScriptLogging } from "@/lib/logger";

const MAX_ATTEMPTS = 8;
const APPLY = process.env.APPLY_NOTIFICATION_OUTBOX_REPAIR === "true";
const FROZEN_NEXT_RUN_AT = new Date("9999-12-31T00:00:00.000Z");

type DuplicateGroup = {
  businessKey: string;
  keepId: string;
  freezeIds: string[];
};

async function main() {
  return withScriptLogging("repair-notification-outbox-duplicates", async () => {
  const legacyCompositeRows = await prisma.notificationOutbox.findMany({
    where: {
      botKind: "approval",
      status: { in: ["FAILED", "PROCESSING"] },
      attempts: { gt: 0 },
      recipients: { none: {} },
    },
    select: {
      id: true,
      eventKey: true,
      createdAt: true,
      attempts: true,
      lastError: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const legacyProjectEstablishmentRows = await prisma.notificationOutbox.findMany({
    where: {
      botKind: "approval",
      status: { in: ["FAILED", "PROCESSING"] },
      attempts: { gt: 0 },
      type: "project_establishment_requested",
    },
    select: {
      id: true,
      eventKey: true,
      createdAt: true,
      attempts: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const rows = await prisma.notificationOutbox.findMany({
    where: {
      botKind: "approval",
      status: { in: ["PENDING", "PROCESSING", "FAILED"] },
    },
    select: {
      id: true,
      eventKey: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const businessKey = approvalTodoBusinessKey(row.eventKey);
    if (!businessKey) continue;
    const group = groups.get(businessKey) ?? [];
    group.push(row);
    groups.set(businessKey, group);
  }

  const duplicateGroups: DuplicateGroup[] = [];
  for (const [businessKey, group] of groups) {
    if (group.length <= 1) continue;
    const [keep, ...duplicates] = group;
    if (!keep) continue;
    duplicateGroups.push({
      businessKey,
      keepId: keep.id,
      freezeIds: duplicates.map((item) => item.id),
    });
  }

  if (duplicateGroups.length === 0) {
    logger.info("notification.outbox.repair.duplicates.none", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
    });
  } else {
    logger.warn("notification.outbox.repair.duplicates.found", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
      duplicateGroupCount: duplicateGroups.length,
      freezeCount: duplicateGroups.reduce(
        (sum, group) => sum + group.freezeIds.length,
        0,
      ),
      groups: duplicateGroups,
    });
    for (const group of duplicateGroups) {
      logger.info("notification.outbox.repair.duplicate_group", {
        module: "script",
        action: "repairNotificationOutboxDuplicates",
        businessKey: group.businessKey,
        keepId: group.keepId,
        freezeIds: group.freezeIds,
      });
    }
  }

  if (legacyCompositeRows.length > 0) {
    logger.warn("notification.outbox.repair.legacy_composite.found", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
      count: legacyCompositeRows.length,
      rows: legacyCompositeRows.map((row) => ({
        id: row.id,
        eventKey: row.eventKey,
        createdAt: row.createdAt,
        attempts: row.attempts,
      })),
    });
    for (const row of legacyCompositeRows) {
      logger.info("notification.outbox.repair.legacy_composite.row", {
        module: "script",
        action: "repairNotificationOutboxDuplicates",
        entityType: "NotificationOutbox",
        entityId: row.id,
        eventKey: row.eventKey,
        attempts: row.attempts,
        createdAt: row.createdAt,
      });
    }
  } else {
    logger.info("notification.outbox.repair.legacy_composite.none", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
    });
  }

  const legacyProjectRows = legacyProjectEstablishmentRows.filter((row) =>
    isLegacyProjectEstablishmentRequestedEventKey(row.eventKey),
  );
  if (legacyProjectRows.length > 0) {
    logger.warn("notification.outbox.repair.legacy_project_establishment.found", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
      count: legacyProjectRows.length,
      rows: legacyProjectRows.map((row) => ({
        id: row.id,
        eventKey: row.eventKey,
        createdAt: row.createdAt,
        attempts: row.attempts,
      })),
    });
    for (const row of legacyProjectRows) {
      logger.info("notification.outbox.repair.legacy_project_establishment.row", {
        module: "script",
        action: "repairNotificationOutboxDuplicates",
        entityType: "NotificationOutbox",
        entityId: row.id,
        eventKey: row.eventKey,
        attempts: row.attempts,
        createdAt: row.createdAt,
      });
    }
  } else {
    logger.info("notification.outbox.repair.legacy_project_establishment.none", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
    });
  }

  if (!APPLY) {
    logger.info("notification.outbox.repair.dry_run", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
      duplicateGroupCount: duplicateGroups.length,
      legacyCompositeCount: legacyCompositeRows.length,
      legacyProjectEstablishmentCount: legacyProjectRows.length,
    });
    return;
  }

  const freezeIds = new Set<string>();
  for (const group of duplicateGroups) {
    for (const id of group.freezeIds) freezeIds.add(id);
  }
  for (const row of legacyCompositeRows) {
    freezeIds.add(row.id);
  }
  for (const row of legacyProjectRows) {
    freezeIds.add(row.id);
  }

  for (const group of duplicateGroups) {
    for (const id of group.freezeIds) freezeIds.add(id);
  }
  if (freezeIds.size > 0) {
    await prisma.notificationOutbox.updateMany({
      where: { id: { in: [...freezeIds] } },
      data: {
        status: "FAILED",
        attempts: MAX_ATTEMPTS,
        nextRunAt: FROZEN_NEXT_RUN_AT,
        lockedUntil: null,
        lastError:
          "历史重复或复合失败审批 outbox 已冻结；避免在缺少收件人级投递状态时重复发送给已成功收件人。",
      },
    });
  }

  logger.audit("notification.outbox.repair.applied", {
    module: "script",
    action: "repairNotificationOutboxDuplicates",
    freezeCount: freezeIds.size,
  });
  });
}

function approvalTodoBusinessKey(eventKey: string): string | null {
  const establishment = eventKey.match(
    /^(progress:project_establishment_requested:[^:]+):/,
  );
  if (establishment) return establishment[1] ?? null;

  const procurement = eventKey.match(/^(procurement:order:[^:]+:[A-Z_]+):/);
  if (procurement) return procurement[1] ?? null;

  return null;
}

function isLegacyProjectEstablishmentRequestedEventKey(eventKey: string): boolean {
  return /^progress:project_establishment_requested:[^:]+:\d{4}-\d{2}-\d{2}T/.test(
    eventKey,
  );
}

main()
  .catch((error) => {
    logger.error("notification.outbox.repair.failed", {
      module: "script",
      action: "repairNotificationOutboxDuplicates",
      error,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
