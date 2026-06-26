import { getOpenIdsByRole } from "@/lib/permissions";
import {
  crossedAlertThresholds,
  getBudgetPoolView,
  listBudgetPoolViews,
} from "@/lib/procurement-budget";
import {
  drainNotificationOutboxSoon,
  enqueueBudgetThresholdNotification,
} from "@/lib/notification-outbox";
import { prisma } from "@/lib/prisma";
import { currentBudgetPeriod } from "@/lib/import-procurement-budget";
import type { NotificationContext } from "@/lib/app-origin";

export async function checkBudgetAlertsForPool(
  poolId: string,
  context?: NotificationContext,
): Promise<number> {
  const view = await getBudgetPoolView(poolId);
  if (!view) return 0;

  const thresholds = crossedAlertThresholds(
    view.usagePercent,
    view.lastAlertThreshold,
  );
  if (thresholds.length === 0) return 0;

  const recipientOpenIds = await resolveBudgetAlertRecipients(
    view.team,
    view.techGroup,
  );
  if (recipientOpenIds.length === 0) return 0;

  let queued = 0;
  for (const threshold of thresholds) {
    const result = await enqueueBudgetThresholdNotification(
      `procurement:budget:${view.id}:${threshold}:${view.period}`,
      {
        description: view.description,
        team: view.team,
        techGroup: view.techGroup,
        period: view.period,
        budgetAmount: view.budgetAmount,
        usedAmount: view.usedAmount,
        usagePercent: view.usagePercent,
        threshold,
        recipientOpenIds,
      },
      context,
    );
    if (result.created) queued++;
  }

  if (queued > 0) {
    await prisma.procurementBudgetPool.update({
      where: { id: poolId },
      data: { lastAlertThreshold: Math.max(...thresholds) },
    });
    drainNotificationOutboxSoon();
  }

  return queued;
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
  const pool = await prisma.procurementBudgetPool.findUnique({
    where: {
      team_techGroup_period: {
        team,
        techGroup,
        period: currentBudgetPeriod(),
      },
    },
  });
  if (!pool) return 0;
  return checkBudgetAlertsForPool(pool.id, context);
}

export async function runProcurementBudgetAlerts(
  context?: NotificationContext,
): Promise<number> {
  const views = await listBudgetPoolViews();
  let total = 0;
  for (const view of views) {
    total += await checkBudgetAlertsForPool(view.id, context);
  }
  return total;
}
