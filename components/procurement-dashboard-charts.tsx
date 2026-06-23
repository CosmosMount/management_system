"use client";

import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  BarRow,
  ChartSlice,
  DashboardChartsData,
} from "@/lib/procurement-dashboard-stats";

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
      <p className="flex h-44 items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  let cursor = 0;
  const gradientParts = slices.map((slice) => {
    const pct = (slice.value / total) * 100;
    const start = cursor;
    cursor += pct;
    return `${slice.color} ${start}% ${cursor}%`;
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
      <p className="flex h-44 items-center justify-center text-sm text-muted-foreground">
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

export function ProcurementDashboardCharts({ data }: Props) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>已完成支出</CardDescription>
            <CardTitle className="text-2xl">
              {formatMoney(data.completedTotal)}
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">车组支出占比</CardTitle>
            <CardDescription>已完成报销订单，按车组汇总</CardDescription>
          </CardHeader>
          <CardContent>
            <DonutChart
              slices={data.teamSpending}
              emptyLabel="暂无已完成订单"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">在途状态分布</CardTitle>
            <CardDescription>未完结订单各环节数量</CardDescription>
          </CardHeader>
          <CardContent>
            <DonutChart
              slices={data.statusDistribution}
              emptyLabel="暂无在途订单"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">采购人支出排行</CardTitle>
            <CardDescription>已完成订单金额 Top 8</CardDescription>
          </CardHeader>
          <CardContent>
            <HorizontalBarChart
              rows={data.initiatorRanking}
              valueFormatter={formatMoney}
              emptyLabel="暂无已完成订单"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">处理拖延排行</CardTitle>
            <CardDescription>当前环节停留天数 Top 8（越久越靠前）</CardDescription>
          </CardHeader>
          <CardContent>
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
