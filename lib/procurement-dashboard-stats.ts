import type { OrderStatus } from "@prisma/client";
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

export type DashboardChartsData = {
  teamSpending: ChartSlice[];
  statusDistribution: ChartSlice[];
  initiatorRanking: BarRow[];
  delayRanking: BarRow[];
  completedTotal: number;
  activeOrderCount: number;
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

/** 已完成订单计入支出；活跃单计入状态与拖延统计 */
export function buildDashboardChartsData(
  orders: OrderForStats[],
): DashboardChartsData {
  const completed = orders.filter((o) => o.status === "COMPLETED");
  const active = orders.filter(
    (o) =>
      o.status !== "COMPLETED" &&
      o.status !== "REJECTED" &&
      o.status !== "DRAFT",
  );

  const teamTotals = new Map<string, number>();
  for (const order of completed) {
    teamTotals.set(
      order.team,
      (teamTotals.get(order.team) ?? 0) + order.totalPrice,
    );
  }

  const statusCounts = new Map<string, number>();
  for (const order of active) {
    statusCounts.set(
      order.status,
      (statusCounts.get(order.status) ?? 0) + 1,
    );
  }

  const initiatorTotals = new Map<string, number>();
  for (const order of completed) {
    initiatorTotals.set(
      order.initiatorName,
      (initiatorTotals.get(order.initiatorName) ?? 0) + order.totalPrice,
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

  const teamSpending = toSlices(
    [...teamTotals.entries()].sort((a, b) => b[1] - a[1]),
  );

  const statusDistribution = toSlices(
    [...statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => [statusLabels[status as OrderStatus], count]),
  );

  const initiatorRanking = [...initiatorTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, value]) => ({ label, value }));

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
      return {
        label: order.orderNo,
        sublabel: `${statusLabels[order.status]} · ${order.initiatorName}`,
        value: daysSince(order.statusEnteredAt),
        href: `${routes.procurement.detail(order.id)}?focus=${focus}&from=notify#${focus}`,
      };
    });

  return {
    teamSpending,
    statusDistribution,
    initiatorRanking,
    delayRanking,
    completedTotal: completed.reduce((s, o) => s + o.totalPrice, 0),
    activeOrderCount: active.length,
  };
}

export { CHART_COLORS };
