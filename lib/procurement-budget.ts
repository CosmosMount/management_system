import { procurementSummaryWhere } from "@/lib/procurement-visibility";
import { currentBudgetPeriod } from "@/lib/procurement-budget-period";
import { prisma } from "@/lib/prisma";

export const BUDGET_ALERT_THRESHOLDS = [70, 80, 90, 100] as const;

export type BudgetPoolView = {
  id: string;
  description: string;
  projects: string[];
  team: string;
  label: string;
  period: string;
  budgetAmount: number;
  usedAmount: number;
  usagePercent: number;
  lastAlertThreshold: number;
  poolIds: string[];
};

export async function getBudgetUsage(team: string): Promise<number> {
  const result = await prisma.purchaseOrder.aggregate({
    where: {
      ...procurementSummaryWhere(),
      team,
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

type StoredBudgetPool = {
  id: string;
  description: string;
  team: string;
  techGroup: string;
  period: string;
  budgetAmount: number;
  lastAlertThreshold: number;
};

export function selectEffectiveBudgetPools<
  T extends Pick<StoredBudgetPool, "description" | "techGroup">,
>(pools: T[]): T[] {
  const canonicalDescriptions = new Set(
    pools
      .filter((pool) => pool.techGroup.trim() === "")
      .map((pool) => pool.description),
  );
  return pools.filter(
    (pool) =>
      pool.techGroup.trim() === "" ||
      !canonicalDescriptions.has(pool.description),
  );
}

async function toTeamBudgetView(
  pools: StoredBudgetPool[],
): Promise<BudgetPoolView> {
  const sample = pools[0];
  if (!sample) throw new Error("预算池分组不能为空");
  const projects = [
    ...new Set(
      pools.flatMap((pool) => {
        const project = pool.description.trim();
        return project ? [project] : [];
      }),
    ),
  ];
  const effectivePools = selectEffectiveBudgetPools(pools);
  const budgetAmount = effectivePools.reduce(
    (sum, pool) => sum + pool.budgetAmount,
    0,
  );
  const usedAmount = await getBudgetUsage(sample.team);

  return {
    id: `${sample.team}:${sample.period}`,
    description: projects.join("；"),
    projects,
    team: sample.team,
    label: sample.team,
    period: sample.period,
    budgetAmount,
    usedAmount,
    usagePercent: computeUsagePercent(usedAmount, budgetAmount),
    lastAlertThreshold: await resolveBudgetGroupLastAlertThreshold(
      sample.team,
      sample.period,
      pools,
    ),
    poolIds: pools.map((pool) => pool.id),
  };
}

/**
 * 旧技术方向行上的阈值属于旧子组语义，不能直接提升为兵种组阈值。
 * 对含旧行的组，以当前兵种组 eventKey 事实恢复已提醒阈值；这样首次迁移
 * 仍会重新计算告警，成功入队后后续定时任务和管理页都能稳定显示该阈值。
 */
export async function resolveBudgetGroupLastAlertThreshold(
  team: string,
  period: string,
  pools: Array<Pick<StoredBudgetPool, "lastAlertThreshold" | "techGroup">>,
): Promise<number> {
  if (!pools.some((pool) => pool.techGroup.trim() !== "")) {
    return Math.max(0, ...pools.map((pool) => pool.lastAlertThreshold));
  }
  const keys = new Map(
    BUDGET_ALERT_THRESHOLDS.map((threshold) => [
      `procurement:budget:${team}:${threshold}:${period}`,
      threshold,
    ]),
  );
  const outboxRows = await prisma.notificationOutbox.findMany({
    where: { eventKey: { in: [...keys.keys()] } },
    select: { eventKey: true },
  });
  return Math.max(
    0,
    ...outboxRows.map((row) => keys.get(row.eventKey) ?? 0),
  );
}

/** 当前周期预算按兵种组汇总；项目名仅作为该兵种组的明细展示。 */
export async function listBudgetPoolViews(
  period?: string,
): Promise<BudgetPoolView[]> {
  const resolvedPeriod = period ?? currentBudgetPeriod();
  const pools = await prisma.procurementBudgetPool.findMany({
    where: { period: resolvedPeriod },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const poolsByTeam = new Map<string, StoredBudgetPool[]>();
  for (const pool of pools) {
    const teamPools = poolsByTeam.get(pool.team) ?? [];
    teamPools.push(pool);
    poolsByTeam.set(pool.team, teamPools);
  }

  return Promise.all(
    [...poolsByTeam.values()].map((teamPools) =>
      toTeamBudgetView(teamPools),
    ),
  );
}

export async function getBudgetPoolView(
  poolId: string,
): Promise<BudgetPoolView | null> {
  const pool = await prisma.procurementBudgetPool.findUnique({
    where: { id: poolId },
  });
  if (!pool) return null;

  const teamPools = await prisma.procurementBudgetPool.findMany({
    where: {
      team: pool.team,
      period: pool.period,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return toTeamBudgetView(teamPools);
}

export type BudgetGroupView = BudgetPoolView;

export async function getBudgetGroupForOrder(
  team: string,
  period?: string,
): Promise<BudgetGroupView | null> {
  const resolvedPeriod = period ?? currentBudgetPeriod();
  const pools = await prisma.procurementBudgetPool.findMany({
    where: { team, period: resolvedPeriod },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (pools.length === 0) return null;
  return toTeamBudgetView(pools);
}
