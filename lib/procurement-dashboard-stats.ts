import type { OrderStatus } from "@prisma/client";
import type { BudgetPoolView } from "@/lib/procurement-budget";
import { routes } from "@/lib/routes";

export type ChartSlice = {
  label: string;
  value: number;
  color: string;
};

export type BarRow = {
  label: string;
  sublabel?: string;
  value: number;
  href?: string;
};

export type BudgetPoolRow = {
  name: string;
  description: string;
  team: string;
  techGroup: string;
  /** 展示用组别标签，如「英雄 · 电控」 */
  groupLabel: string;
  budget: number;
  used: number;
  usagePercent: number;
};

export type SpendSeries = {
  total: number;
  teamSpending: ChartSlice[];
  initiatorRanking: BarRow[];
};

export type DashboardChartsData = {
  teamSpending: ChartSlice[];
  statusDistribution: ChartSlice[];
  initiatorRanking: BarRow[];
  delayRanking: BarRow[];
  completedTotal: number;
  activeOrderCount: number;
  budgetPools: BudgetPoolRow[];
  budgetPeriod: string;
  /** 支出口径：已完成 / 全部已提交（非草稿、非驳回） */
  spendByScope: {
    completed: SpendSeries;
    all: SpendSeries;
  };
};

const CHART_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#6366f1",
  "#14b8a6",
];

type OrderForStats = {
  id: string;
  orderNo: string;
  initiatorName: string;
  team: string;
  techGroup: string;
  status: OrderStatus;
  totalPrice: number;
  statusEnteredAt: Date;
};

function colorAt(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

function toSlices(
  entries: [string, number][],
  minShare = 0,
): ChartSlice[] {
  const filtered = entries.filter(([, v]) => v > minShare);
  return filtered.map(([label, value], i) => ({
    label,
    value,
    color: colorAt(i),
  }));
}

function daysSince(date: Date): number {
  return Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)),
  );
}

function buildSpendSeries(orders: OrderForStats[]): SpendSeries {
  const teamTotals = new Map<string, number>();
  const initiatorTotals = new Map<string, number>();
  let total = 0;

  for (const order of orders) {
    total += order.totalPrice;
    teamTotals.set(
      order.team,
      (teamTotals.get(order.team) ?? 0) + order.totalPrice,
    );
    initiatorTotals.set(
      order.initiatorName,
      (initiatorTotals.get(order.initiatorName) ?? 0) + order.totalPrice,
    );
  }

  return {
    total,
    teamSpending: toSlices(
      [...teamTotals.entries()].sort((a, b) => b[1] - a[1]),
    ),
    initiatorRanking: [...initiatorTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value })),
  };
}

/** 支出可按已完成 / 全部已提交切换；活跃单计入状态与拖延统计 */
export function buildDashboardChartsData(
  orders: OrderForStats[],
  poolViews: BudgetPoolView[] = [],
  budgetPeriod = "",
  handlerNamesByOrderId: ReadonlyMap<string, string> = new Map(),
): DashboardChartsData {
  const completed = orders.filter((o) => o.status === "COMPLETED");
  const submitted = orders.filter(
    (o) => o.status !== "REJECTED" && o.status !== "DRAFT",
  );
  const active = orders.filter(
    (o) =>
      o.status !== "COMPLETED" &&
      o.status !== "REJECTED" &&
      o.status !== "DRAFT",
  );

  const statusCounts = new Map<string, number>();
  for (const order of active) {
    statusCounts.set(
      order.status,
      (statusCounts.get(order.status) ?? 0) + 1,
    );
  }

  const statusLabels: Record<OrderStatus, string> = {
    DRAFT: "草稿",
    MANAGEMENT_REVIEW: "管理审核",
    TEACHER_REVIEW: "老师审核",
    PENDING_APPLICANT_DOCS: "待上传凭证",
    PENDING_FINANCE_REVIEW: "待报销截图",
    PENDING_APPLICANT_CONFIRM: "待确认",
    COMPLETED: "已完成",
    REJECTED: "已驳回",
  };

  const completedSpend = buildSpendSeries(completed);
  const allSpend = buildSpendSeries(submitted);

  const statusDistribution = toSlices(
    [...statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => [statusLabels[status as OrderStatus], count]),
  );

  const delayRanking = [...active]
    .sort(
      (a, b) => a.statusEnteredAt.getTime() - b.statusEnteredAt.getTime(),
    )
    .slice(0, 8)
    .map((order) => {
      const focus =
        order.status === "PENDING_APPLICANT_DOCS"
          ? "upload"
          : order.status === "PENDING_APPLICANT_CONFIRM"
            ? "confirm"
            : "approval";
      const handlerName = handlerNamesByOrderId.get(order.id) ?? "—";
      return {
        label: order.orderNo,
        sublabel: `${statusLabels[order.status]} · 处理人：${handlerName} · 采购人：${order.initiatorName}`,
        value: daysSince(order.statusEnteredAt),
        href: `${routes.procurement.detail(order.id)}?focus=${focus}&from=notify#${focus}`,
      };
    });

  const budgetPools = poolViews.map((pool) => {
    const groupLabel = pool.label;
    const projectName = pool.description.trim() || groupLabel;
    return {
      name: projectName,
      description: pool.description,
      team: pool.team,
      techGroup: pool.techGroup,
      groupLabel,
      budget: pool.budgetAmount,
      used: pool.usedAmount,
      usagePercent: pool.usagePercent,
    };
  });

  return {
    teamSpending: completedSpend.teamSpending,
    statusDistribution,
    initiatorRanking: completedSpend.initiatorRanking,
    delayRanking,
    completedTotal: completedSpend.total,
    activeOrderCount: active.length,
    budgetPools,
    budgetPeriod,
    spendByScope: {
      completed: completedSpend,
      all: allSpend,
    },
  };
}

export { CHART_COLORS };
