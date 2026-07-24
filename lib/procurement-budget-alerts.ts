import { getOpenIdsByRole } from "@/lib/permissions";
import {
  crossedAlertThresholds,
  getBudgetGroupForOrder,
  listBudgetPoolViews,
} from "@/lib/procurement-budget";
import {
  drainNotificationOutboxSoon,
  enqueueBudgetThresholdNotification,
} from "@/lib/notification-outbox";
import { prisma } from "@/lib/prisma";
import { currentBudgetPeriod } from "@/lib/import-procurement-budget";
import type { NotificationContext } from "@/lib/app-origin";

export async function checkBudgetAlertsForGroup(
  team: string,
  techGroup: string,
  period: string,
  context?: NotificationContext,
): Promise<number> {
  const group = await getBudgetGroupForOrder(team, techGroup, period);
  if (!group) return 0;

  const thresholds = crossedAlertThresholds(
    group.usagePercent,
    group.lastAlertThreshold,
  );
  if (thresholds.length === 0) return 0;

  const recipientOpenIds = await resolveBudgetAlertRecipients(team, techGroup);
  if (recipientOpenIds.length === 0) return 0;

  let queued = 0;
  for (const threshold of thresholds) {
    const result = await enqueueBudgetThresholdNotification(
      `procurement:budget:${team}:${techGroup}:${threshold}:${period}`,
      {
        description: group.description,
        team: group.team,
        techGroup: group.techGroup,
        period: group.period,
        budgetAmount: group.budgetAmount,
        usedAmount: group.usedAmount,
        usagePercent: group.usagePercent,
        threshold,
        recipientOpenIds,
      },
      context,
    );
    if (result.created) queued++;
  }

  if (queued > 0) {
    await prisma.procurementBudgetPool.updateMany({
      where: {
        id: { in: group.poolIds },
      },
      data: { lastAlertThreshold: Math.max(...thresholds) },
    });
    drainNotificationOutboxSoon();
  }

  return queued;
}

export async function checkBudgetAlertsForPool(
  poolId: string,
  context?: NotificationContext,
): Promise<number> {
  const pool = await prisma.procurementBudgetPool.findUnique({
    where: { id: poolId },
    select: { team: true, techGroup: true, period: true },
  });
  if (!pool) return 0;
  return checkBudgetAlertsForGroup(
    pool.team,
    pool.techGroup,
    pool.period,
    context,
  );
}

async function resolveBudgetAlertRecipients(
  team: string,
  techGroup: string,
): Promise<string[]> {
  const [teamAdmins, techAdmins] = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", { team, techGroup: "" }),
    getOpenIdsByRole("TECH_GROUP_ADMIN", { team: "", techGroup }),
  ]);
  return [...new Set([...teamAdmins, ...techAdmins])];
}

export async function checkBudgetAlertsForOrder(
  team: string,
  techGroup: string,
  context?: NotificationContext,
): Promise<number> {
  return checkBudgetAlertsForGroup(
    team,
    techGroup,
    currentBudgetPeriod(),
    context,
  );
}

export async function runProcurementBudgetAlerts(
  context?: NotificationContext,
): Promise<number> {
  const views = await listBudgetPoolViews();
  const seen = new Set<string>();
  let total = 0;
  for (const view of views) {
    const key = `${view.team}\0${view.techGroup}\0${view.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += await checkBudgetAlertsForGroup(
      view.team,
      view.techGroup,
      view.period,
      context,
    );
  }
  return total;
}
