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

function groupKey(team: string, techGroup: string): string {
  return `${team}\0${techGroup}`;
}

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
  usagePercent: number;
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
    usagePercent: pool.usagePercent,
    lastAlertThreshold: pool.lastAlertThreshold,
  };
}

/** 同组别多项目共享订单占用：按各项目预算占比分摊已用金额 */
function allocateGroupUsage(args: {
  pools: Array<{
    id: string;
    description: string;
    team: string;
    techGroup: string;
    period: string;
    budgetAmount: number;
    lastAlertThreshold: number;
  }>;
  groupUsed: number;
}): BudgetPoolView[] {
  const groupBudget = args.pools.reduce(
    (sum, pool) => sum + pool.budgetAmount,
    0,
  );
  const usagePercent = computeUsagePercent(args.groupUsed, groupBudget);

  return args.pools.map((pool) => {
    const usedAmount =
      groupBudget > 0
        ? (args.groupUsed * pool.budgetAmount) / groupBudget
        : 0;
    return toBudgetPoolView({
      ...pool,
      usedAmount,
      usagePercent,
    });
  });
}

export async function listBudgetPoolViews(
  period?: string,
): Promise<BudgetPoolView[]> {
  const resolvedPeriod = period ?? currentBudgetPeriod();
  const pools = await prisma.procurementBudgetPool.findMany({
    where: { period: resolvedPeriod },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const usageByGroup = new Map<string, number>();
  const poolsByGroup = new Map<string, typeof pools>();
  for (const pool of pools) {
    const key = groupKey(pool.team, pool.techGroup);
    const list = poolsByGroup.get(key) ?? [];
    list.push(pool);
    poolsByGroup.set(key, list);
  }

  for (const [key, groupPools] of poolsByGroup) {
    const sample = groupPools[0]!;
    usageByGroup.set(
      key,
      await getBudgetUsage(sample.team, sample.techGroup),
    );
  }

  const views: BudgetPoolView[] = [];
  for (const pool of pools) {
    const key = groupKey(pool.team, pool.techGroup);
    const groupPools = poolsByGroup.get(key) ?? [pool];
    const groupUsed = usageByGroup.get(key) ?? 0;
    const allocated = allocateGroupUsage({ pools: groupPools, groupUsed });
    const view = allocated.find((item) => item.id === pool.id);
    if (view) views.push(view);
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

  const groupPools = await prisma.procurementBudgetPool.findMany({
    where: {
      team: pool.team,
      techGroup: pool.techGroup,
      period: pool.period,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const groupUsed = await getBudgetUsage(pool.team, pool.techGroup);
  return (
    allocateGroupUsage({ pools: groupPools, groupUsed }).find(
      (item) => item.id === poolId,
    ) ?? null
  );
}

export type BudgetGroupView = {
  team: string;
  techGroup: string;
  label: string;
  period: string;
  description: string;
  budgetAmount: number;
  usedAmount: number;
  usagePercent: number;
  lastAlertThreshold: number;
  poolIds: string[];
};

export async function getBudgetGroupForOrder(
  team: string,
  techGroup: string,
  period?: string,
): Promise<BudgetGroupView | null> {
  const resolvedPeriod = period ?? currentBudgetPeriod();
  const pools = await prisma.procurementBudgetPool.findMany({
    where: { team, techGroup, period: resolvedPeriod },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (pools.length === 0) return null;

  const budgetAmount = pools.reduce((sum, pool) => sum + pool.budgetAmount, 0);
  const usedAmount = await getBudgetUsage(team, techGroup);
  const lastAlertThreshold = Math.max(
    ...pools.map((pool) => pool.lastAlertThreshold),
  );

  return {
    team,
    techGroup,
    label: formatBudgetPoolLabel(team, techGroup),
    period: resolvedPeriod,
    description: pools
      .map((pool) => pool.description)
      .filter(Boolean)
      .join("；"),
    budgetAmount,
    usedAmount,
    usagePercent: computeUsagePercent(usedAmount, budgetAmount),
    lastAlertThreshold,
    poolIds: pools.map((pool) => pool.id),
  };
}

/** @deprecated 使用 getBudgetGroupForOrder；同组别可能有多个项目 */
export async function getBudgetPoolForOrder(
  team: string,
  techGroup: string,
  period?: string,
): Promise<BudgetPoolView | null> {
  const group = await getBudgetGroupForOrder(team, techGroup, period);
  if (!group || group.poolIds.length === 0) return null;
  return {
    id: group.poolIds[0]!,
    description: group.description,
    team: group.team,
    techGroup: group.techGroup,
    label: group.label,
    period: group.period,
    budgetAmount: group.budgetAmount,
    usedAmount: group.usedAmount,
    usagePercent: group.usagePercent,
    lastAlertThreshold: group.lastAlertThreshold,
  };
}
