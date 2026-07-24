"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  BarRow,
  BudgetPoolRow,
  ChartSlice,
  DashboardChartsData,
} from "@/lib/procurement-dashboard-stats";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";

const ALL_TEAMS_VALUE = "__all_teams__";
const ALL_TECH_GROUPS_VALUE = "__all_tech_groups__";

type SpendScope = "completed" | "all";

type Props = {
  data: DashboardChartsData;
};

function formatMoney(value: number): string {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function DonutChart({
  slices,
  emptyLabel,
}: {
  slices: ChartSlice[];
  emptyLabel: string;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) {
    return (
      <p className="flex min-h-44 flex-1 items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  const gradientParts = slices.map((slice, index) => {
    const start = slices
      .slice(0, index)
      .reduce((sum, item) => sum + (item.value / total) * 100, 0);
    const pct = (slice.value / total) * 100;
    const end = start + pct;
    return `${slice.color} ${start}% ${end}%`;
  });

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div
        className="relative h-40 w-40 shrink-0 rounded-full"
        style={{
          background: `conic-gradient(${gradientParts.join(", ")})`,
        }}
      >
        <div className="absolute inset-[22%] flex flex-col items-center justify-center rounded-full bg-card text-center">
          <span className="text-xs text-muted-foreground">合计</span>
          <span className="text-sm font-semibold">
            {total >= 10000
              ? `${(total / 10000).toFixed(1)}万`
              : total.toLocaleString("zh-CN")}
          </span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-2 text-sm">
        {slices.map((slice) => (
          <li key={slice.label} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: slice.color }}
            />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="shrink-0 text-muted-foreground">
              {((slice.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HorizontalBarChart({
  rows,
  valueFormatter,
  emptyLabel,
}: {
  rows: BarRow[];
  valueFormatter: (v: number) => string;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="flex min-h-44 flex-1 items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const width = Math.max(4, (row.value / max) * 100);
        const inner = (
          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-medium">{row.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {valueFormatter(row.value)}
              </span>
            </div>
            {row.sublabel && (
              <p className="truncate text-xs text-muted-foreground">
                {row.sublabel}
              </p>
            )}
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/80 transition-all"
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
        return (
          <li key={`${row.label}-${row.sublabel ?? ""}`}>
            {row.href ? (
              <Link href={row.href} className="block hover:opacity-80">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

function usageBarColor(usagePercent: number): string {
  if (usagePercent >= 100) return "bg-destructive";
  if (usagePercent >= 90) return "bg-orange-500";
  if (usagePercent >= 70) return "bg-amber-500";
  return "bg-primary/80";
}

function BudgetPoolChart({
  rows,
  emptyLabel,
}: {
  rows: BudgetPoolRow[];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="flex min-h-44 flex-1 items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  const totalBudget = rows.reduce((sum, row) => sum + row.budget, 0);
  const totalUsed = rows.reduce((sum, row) => sum + row.used, 0);
  const totalUsagePercent =
    totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0;

  return (
    <div className="space-y-4">
      <div
        className="rounded-lg border bg-muted/30 px-3 py-2 text-sm"
        data-testid="procurement-budget-pool-totals"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium">预算池总量</span>
          <span
            className={
              totalUsagePercent >= 70
                ? "font-medium text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            }
          >
            {formatMoney(totalUsed)} / {formatMoney(totalBudget)}（
            {totalUsagePercent.toFixed(1)}%）
          </span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${usageBarColor(totalUsagePercent)}`}
            style={{ width: `${Math.min(100, Math.max(0, totalUsagePercent))}%` }}
          />
        </div>
      </div>
      <ul className="space-y-4">
        {rows.map((row) => {
          const width = Math.min(100, Math.max(0, row.usagePercent));
          return (
            <li
              key={`${row.name}-${row.team}-${row.techGroup}`}
              className="space-y-1"
              data-testid="procurement-budget-pool-row"
            >
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <span className="truncate font-medium">{row.name}</span>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.groupLabel}
                  </p>
                </div>
                <span
                  className={`shrink-0 ${
                    row.usagePercent >= 70
                      ? "font-medium text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground"
                  }`}
                >
                  {formatMoney(row.used)} / {formatMoney(row.budget)} (
                  {row.usagePercent.toFixed(1)}%)
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${usageBarColor(row.usagePercent)}`}
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ProcurementDashboardCharts({ data }: Props) {
  const [teamFilter, setTeamFilter] = useState(ALL_TEAMS_VALUE);
  const [techGroupFilter, setTechGroupFilter] = useState(ALL_TECH_GROUPS_VALUE);
  const [spendScope, setSpendScope] = useState<SpendScope>("completed");

  const spend = data.spendByScope[spendScope];
  const spendScopeLabel =
    spendScope === "completed" ? "仅已完成" : "全部已提交";
  const spendTotalLabel =
    spendScope === "completed" ? "已完成支出" : "全部支出";
  const spendEmptyLabel =
    spendScope === "completed" ? "暂无已完成订单" : "暂无已提交订单";

  const filteredBudgetPools = useMemo(() => {
    return data.budgetPools.filter((row) => {
      if (teamFilter !== ALL_TEAMS_VALUE && row.team !== teamFilter) {
        return false;
      }
      if (
        techGroupFilter !== ALL_TECH_GROUPS_VALUE &&
        row.techGroup !== techGroupFilter
      ) {
        return false;
      }
      return true;
    });
  }, [data.budgetPools, teamFilter, techGroupFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          支出统计口径：{spendScopeLabel}
          {spendScope === "all" ? "（含在途，不含草稿/驳回）" : ""}
        </p>
        <Select
          value={spendScope}
          onValueChange={(value) =>
            setSpendScope((value as SpendScope | null) ?? "completed")
          }
        >
          <SelectTrigger
            className="w-40"
            data-testid="procurement-spend-scope"
            aria-label="支出统计口径"
          >
            <SelectValue>
              {(value) =>
                value === "all" ? "全部已提交" : "仅已完成"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="completed">仅已完成</SelectItem>
            <SelectItem value="all">全部已提交</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription data-testid="procurement-spend-total-label">
              {spendTotalLabel}
            </CardDescription>
            <CardTitle
              className="text-2xl"
              data-testid="procurement-spend-total"
            >
              {formatMoney(spend.total)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>在途订单</CardDescription>
            <CardTitle className="text-2xl">{data.activeOrderCount}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">预算池使用率</CardTitle>
            <CardDescription>
              {data.budgetPeriod
                ? `${data.budgetPeriod} 周期 · 按项目展示，顺序与导入表一致`
                : "按项目展示，顺序与导入表一致"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={teamFilter}
              onValueChange={(value) => setTeamFilter(value ?? ALL_TEAMS_VALUE)}
            >
              <SelectTrigger className="w-36">
                <SelectValue>
                  {(value) =>
                    value === ALL_TEAMS_VALUE ? "全部车组" : String(value ?? "")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TEAMS_VALUE}>全部车组</SelectItem>
                {TEAM_OPTIONS.map((team) => (
                  <SelectItem key={team} value={team}>
                    {team}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={techGroupFilter}
              onValueChange={(value) =>
                setTechGroupFilter(value ?? ALL_TECH_GROUPS_VALUE)
              }
            >
              <SelectTrigger className="w-36">
                <SelectValue>
                  {(value) =>
                    value === ALL_TECH_GROUPS_VALUE
                      ? "全部技术组"
                      : String(value ?? "")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TECH_GROUPS_VALUE}>全部技术组</SelectItem>
                {TECH_GROUP_OPTIONS.map((group) => (
                  <SelectItem key={group} value={group}>
                    {group}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <BudgetPoolChart
            rows={filteredBudgetPools}
            emptyLabel="暂无预算池，请由超级管理员导入"
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="text-base">车组支出占比</CardTitle>
            <CardDescription>
              {spendScope === "completed"
                ? "已完成报销订单，按车组汇总"
                : "全部已提交订单，按车组汇总"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-52 flex-1 flex-col">
            <DonutChart
              slices={spend.teamSpending}
              emptyLabel={spendEmptyLabel}
            />
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="text-base">在途状态分布</CardTitle>
            <CardDescription>未完结订单各环节数量</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-52 flex-1 flex-col">
            <DonutChart
              slices={data.statusDistribution}
              emptyLabel="暂无在途订单"
            />
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="text-base">采购人支出排行</CardTitle>
            <CardDescription>
              {spendScope === "completed"
                ? "已完成订单金额 Top 8"
                : "全部已提交订单金额 Top 8"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-52 flex-1 flex-col">
            <HorizontalBarChart
              rows={spend.initiatorRanking}
              valueFormatter={formatMoney}
              emptyLabel={spendEmptyLabel}
            />
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="text-base">处理拖延排行</CardTitle>
            <CardDescription>当前环节停留天数 Top 8（越久越靠前）</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-52 flex-1 flex-col">
            <HorizontalBarChart
              rows={data.delayRanking}
              valueFormatter={(d) => `${d} 天`}
              emptyLabel="暂无在途订单"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
