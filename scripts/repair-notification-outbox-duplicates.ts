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
    return;
  }

  console.log(
    `[repair-notification-outbox] 发现 ${duplicateGroups.length} 组重复审批 outbox，` +
      `${duplicateGroups.reduce((sum, group) => sum + group.freezeIds.length, 0)} 条可冻结。`,
  );
  for (const group of duplicateGroups) {
    console.log(
      `- ${group.businessKey}: keep=${group.keepId}, freeze=${group.freezeIds.join(",")}`,
    );
  }

  if (!APPLY) {
    console.log(
      "[repair-notification-outbox] 当前为 dry-run；设置 APPLY_NOTIFICATION_OUTBOX_REPAIR=true 后才会写入数据库。",
    );
    return;
  }

  for (const group of duplicateGroups) {
    await prisma.notificationOutbox.updateMany({
      where: { id: { in: group.freezeIds } },
      data: {
        status: "FAILED",
        attempts: MAX_ATTEMPTS,
        nextRunAt: FROZEN_NEXT_RUN_AT,
        lockedUntil: null,
        lastError: "历史重复审批 outbox 已冻结；保留同业务待办的最新记录用于后续重试。",
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

main()
  .catch((error) => {
    console.error("[repair-notification-outbox] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
