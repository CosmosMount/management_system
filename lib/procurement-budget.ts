import { procurementSummaryWhere } from "@/lib/procurement-visibility";
import {
  formatBudgetPoolLabel,
  currentBudgetPeriod,
} from "@/lib/import-procurement-budget";
import { prisma } from "@/lib/prisma";

export const BUDGET_ALERT_THRESHOLDS = [70, 80, 90, 100] as const;

export type BudgetPoolView = {
  id: string;
  description: string;
  team: string;
  techGroup: string;
  label: string;
  period: string;
  budgetAmount: number;
  usedAmount: number;
  usagePercent: number;
  lastAlertThreshold: number;
};

export async function getBudgetUsage(
  team: string,
  techGroup: string,
): Promise<number> {
  const result = await prisma.purchaseOrder.aggregate({
    where: {
      ...procurementSummaryWhere(),
      team,
      techGroup,
    },
    _sum: { totalPrice: true },
  });

  return result._sum.totalPrice ?? 0;
}

export function computeUsagePercent(
  usedAmount: number,
  budgetAmount: number,
): number {
  if (budgetAmount <= 0) return 0;
  return (usedAmount / budgetAmount) * 100;
}

export function crossedAlertThresholds(
  usagePercent: number,
  lastAlertThreshold: number,
): number[] {
  return BUDGET_ALERT_THRESHOLDS.filter(
    (threshold) => usagePercent >= threshold && threshold > lastAlertThreshold,
  );
}

function toBudgetPoolView(pool: {
  id: string;
  description: string;
  team: string;
  techGroup: string;
  period: string;
  budgetAmount: number;
  lastAlertThreshold: number;
  usedAmount: number;
}): BudgetPoolView {
  return {
    id: pool.id,
    description: pool.description,
    team: pool.team,
    techGroup: pool.techGroup,
    label: formatBudgetPoolLabel(pool.team, pool.techGroup),
    period: pool.period,
    budgetAmount: pool.budgetAmount,
    usedAmount: pool.usedAmount,
    usagePercent: computeUsagePercent(pool.usedAmount, pool.budgetAmount),
    lastAlertThreshold: pool.lastAlertThreshold,
  };
}

export async function listBudgetPoolViews(
  period?: string,
): Promise<BudgetPoolView[]> {
  const resolvedPeriod = period ?? currentBudgetPeriod();
  const pools = await prisma.procurementBudgetPool.findMany({
    where: { period: resolvedPeriod },
    orderBy: [{ team: "asc" }, { techGroup: "asc" }],
  });

  const views: BudgetPoolView[] = [];
  for (const pool of pools) {
    const usedAmount = await getBudgetUsage(pool.team, pool.techGroup);
    views.push(toBudgetPoolView({ ...pool, usedAmount }));
  }

  return views;
}

export async function getBudgetPoolView(
  poolId: string,
): Promise<BudgetPoolView | null> {
  const pool = await prisma.procurementBudgetPool.findUnique({
    where: { id: poolId },
  });
  if (!pool) return null;

  const usedAmount = await getBudgetUsage(pool.team, pool.techGroup);
  return toBudgetPoolView({ ...pool, usedAmount });
}

export async function getBudgetPoolForOrder(
  team: string,
  techGroup: string,
  period?: string,
): Promise<BudgetPoolView | null> {
  const resolvedPeriod = period ?? currentBudgetPeriod();
  const pool = await prisma.procurementBudgetPool.findUnique({
    where: {
      team_techGroup_period: {
        team,
        techGroup,
        period: resolvedPeriod,
      },
    },
  });
  if (!pool) return null;

  const usedAmount = await getBudgetUsage(pool.team, pool.techGroup);
  return toBudgetPoolView({ ...pool, usedAmount });
}
