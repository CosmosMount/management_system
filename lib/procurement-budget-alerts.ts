import { getOpenIdsByRole } from "@/lib/permissions";
import {
  crossedAlertThresholds,
  getBudgetGroupForOrder,
  listBudgetPoolViews,
} from "@/lib/procurement-budget";
import {
  enqueueBudgetThresholdNotification,
} from "@/lib/notification-producers/procurement";
import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";
import { prisma } from "@/lib/prisma";
import { currentBudgetPeriod } from "@/lib/procurement-budget-period";
import type { NotificationContext } from "@/lib/app-origin";

export async function checkBudgetAlertsForGroup(
  team: string,
  period: string,
  context?: NotificationContext,
): Promise<number> {
  const group = await getBudgetGroupForOrder(team, period);
  if (!group) return 0;

  const thresholds = crossedAlertThresholds(
    group.usagePercent,
    group.lastAlertThreshold,
  );
  if (thresholds.length === 0) return 0;

  const recipientOpenIds = await resolveBudgetAlertRecipients(team);
  if (recipientOpenIds.length === 0) return 0;

  let queued = 0;
  for (const threshold of thresholds) {
    const result = await enqueueBudgetThresholdNotification(
      `procurement:budget:${team}:${threshold}:${period}`,
      {
        description: group.description,
        team: group.team,
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
    select: { team: true, period: true },
  });
  if (!pool) return 0;
  return checkBudgetAlertsForGroup(
    pool.team,
    pool.period,
    context,
  );
}

async function resolveBudgetAlertRecipients(
  team: string,
): Promise<string[]> {
  return getOpenIdsByRole("TEAM_ADMIN", { team, techGroup: "" });
}

export async function checkBudgetAlertsForOrder(
  team: string,
  _techGroup: string,
  context?: NotificationContext,
): Promise<number> {
  return checkBudgetAlertsForGroup(
    team,
    currentBudgetPeriod(),
    context,
  );
}

export async function runProcurementBudgetAlerts(
  context?: NotificationContext,
): Promise<number> {
  const views = await listBudgetPoolViews();
  let total = 0;
  for (const view of views) {
    total += await checkBudgetAlertsForGroup(
      view.team,
      view.period,
      context,
    );
  }
  return total;
}
