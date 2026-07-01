import { prisma } from "@/lib/prisma";

const MAX_ATTEMPTS = 8;
const APPLY = process.env.APPLY_NOTIFICATION_OUTBOX_REPAIR === "true";
const FROZEN_NEXT_RUN_AT = new Date("9999-12-31T00:00:00.000Z");

type DuplicateGroup = {
  businessKey: string;
  keepId: string;
  freezeIds: string[];
};

async function main() {
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
    console.log("[repair-notification-outbox] 没有发现待冻结的重复审批 outbox");
  } else {
    console.log(
      `[repair-notification-outbox] 发现 ${duplicateGroups.length} 组重复审批 outbox，` +
        `${duplicateGroups.reduce((sum, group) => sum + group.freezeIds.length, 0)} 条可冻结。`,
    );
    for (const group of duplicateGroups) {
      console.log(
        `- ${group.businessKey}: keep=${group.keepId}, freeze=${group.freezeIds.join(",")}`,
      );
    }
  }

  if (legacyCompositeRows.length > 0) {
    console.log(
      `[repair-notification-outbox] 发现 ${legacyCompositeRows.length} 条历史复合失败审批 outbox，` +
        "这些记录没有 recipient 子行，自动重试可能重复发送给已成功收件人。",
    );
    for (const row of legacyCompositeRows) {
      console.log(
        `- legacy-composite id=${row.id} attempts=${row.attempts} created=${row.createdAt.toISOString()} key=${row.eventKey}`,
      );
    }
  } else {
    console.log("[repair-notification-outbox] 没有发现历史复合失败审批 outbox");
  }

  const legacyProjectRows = legacyProjectEstablishmentRows.filter((row) =>
    isLegacyProjectEstablishmentRequestedEventKey(row.eventKey),
  );
  if (legacyProjectRows.length > 0) {
    console.log(
      `[repair-notification-outbox] 发现 ${legacyProjectRows.length} 条旧幂等 key 的立项审批 outbox，` +
        "这些记录使用 submittedAt 时间戳，重试可能造成重复通知。",
    );
    for (const row of legacyProjectRows) {
      console.log(
        `- legacy-project-establishment id=${row.id} attempts=${row.attempts} created=${row.createdAt.toISOString()} key=${row.eventKey}`,
      );
    }
  } else {
    console.log("[repair-notification-outbox] 没有发现旧幂等 key 的立项审批 outbox");
  }

  if (!APPLY) {
    console.log(
      "[repair-notification-outbox] 当前为 dry-run；设置 APPLY_NOTIFICATION_OUTBOX_REPAIR=true 后才会写入数据库。",
    );
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

  console.log("[repair-notification-outbox] 已冻结历史重复审批 outbox。");
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
    console.error("[repair-notification-outbox] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
