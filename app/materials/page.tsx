import Link from "next/link";
import { PackageCheck, PackageOpen, PackageSearch } from "lucide-react";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  List,
  ListActions,
  ListContent,
  ListEmpty,
  ListItem,
} from "@/components/ui/list";
import { TECH_GROUP_OPTIONS } from "@/lib/constants";
import { listMaterials } from "@/lib/material-management/queries";
import {
  formatMaterialDateTime,
  formatMaterialPrice,
} from "@/lib/material-management/presentation";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { getMaterialActorOrRedirect } from "./_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getMaterialActorOrRedirect();
  const params = (await searchParams) ?? {};
  const query = firstParam(params.q).slice(0, 200);
  const requestedTechGroup = firstParam(params.techGroup);
  const techGroup = TECH_GROUP_OPTIONS.includes(
    requestedTechGroup as (typeof TECH_GROUP_OPTIONS)[number],
  )
    ? (requestedTechGroup as (typeof TECH_GROUP_OPTIONS)[number])
    : undefined;
  const requestedStatus = firstParam(params.status);
  const status =
    requestedStatus === "AVAILABLE" || requestedStatus === "IN_USE"
      ? requestedStatus
      : undefined;
  const result = await listMaterials({ query, techGroup, status });

  return (
    <>
      <PageCommandBar
        title="物资台账"
        description="查看每件物资当前由谁使用，并通过专属二维码完成领用与归还。"
        sectionLabel="物资管理"
        testId="material-management-command-bar"
        actions={
          actor.isActive ? (
            <Link
              href={routes.materials.new}
              className={cn(buttonVariants())}
            >
              登记物资
            </Link>
          ) : null
        }
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {!actor.isActive && (
          <p
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            当前账号已停用，只能查看物资台账，不能登记、领用或归还。
          </p>
        )}

        <section
          aria-label="物资状态概览"
          className="grid gap-3 sm:grid-cols-3"
        >
          <MetricCard
            label="全部物资"
            value={result.totalCount}
            icon={PackageSearch}
          />
          <MetricCard
            label="正在使用"
            value={result.inUseCount}
            icon={PackageOpen}
          />
          <MetricCard
            label="当前可用"
            value={result.availableCount}
            icon={PackageCheck}
          />
        </section>

        <form className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_160px_140px_auto]">
          <Input
            name="q"
            defaultValue={query}
            maxLength={200}
            placeholder="搜索物资名称"
            aria-label="搜索物资名称"
          />
          <select
            name="techGroup"
            defaultValue={techGroup ?? ""}
            aria-label="所属技术组"
            className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value="">全部技术组</option>
            {TECH_GROUP_OPTIONS.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={status ?? ""}
            aria-label="使用状态"
            className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value="">全部状态</option>
            <option value="AVAILABLE">可领用</option>
            <option value="IN_USE">使用中</option>
          </select>
          <Button type="submit">筛选</Button>
        </form>

        {result.items.length === 0 ? (
          <ListEmpty>
            {query || techGroup || status
              ? "当前筛选条件下暂无物资"
              : "尚未登记物资"}
          </ListEmpty>
        ) : (
          <List aria-label="物资列表">
            {result.items.map((material) => (
              <ListItem key={material.id}>
                <ListContent>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link
                      href={routes.materials.detail(material.id)}
                      className="min-w-0 break-words text-base font-medium hover:text-primary hover:underline"
                    >
                      {material.name}
                    </Link>
                    <Badge variant="outline">{material.techGroup}</Badge>
                    <Badge
                      variant={material.activeLoan ? "secondary" : "default"}
                    >
                      {material.activeLoan ? "使用中" : "可领用"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatMaterialPrice(material.price)}
                    <span aria-hidden="true"> · </span>
                    登记于 {formatMaterialDateTime(material.createdAt)}
                  </p>
                  <p className="mt-2 break-words text-sm">
                    {material.activeLoan ? (
                      <>
                        当前使用人：
                        <span className="font-medium">
                          {material.activeLoan.borrowerName}
                          {material.activeLoan.borrowerAccountId ===
                          actor.accountId
                            ? "（我）"
                            : ""}
                        </span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {formatMaterialDateTime(
                            material.activeLoan.checkedOutAt,
                          )} 领用
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        当前无人使用，可扫描二维码领用
                      </span>
                    )}
                  </p>
                </ListContent>
                <ListActions>
                  <Link
                    href={routes.materials.detail(material.id)}
                    className={cn(buttonVariants({ variant: "outline" }))}
                  >
                    查看二维码
                  </Link>
                </ListActions>
              </ListItem>
            ))}
          </List>
        )}
        {result.hasMore && (
          <p role="status" className="text-sm text-amber-700">
            当前最多显示 100 件物资，请使用名称或技术组筛选缩小范围。
          </p>
        )}
      </div>
    </>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof PackageSearch;
}) {
  return (
    <Card>
      <CardHeader className="grid grid-cols-[1fr_auto] items-center">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <CardTitle className="mt-1 text-2xl tabular-nums">{value}</CardTitle>
        </div>
        <Icon className="size-5 text-primary" aria-hidden="true" />
      </CardHeader>
      <CardContent className="sr-only">{label}共 {value} 件</CardContent>
    </Card>
  );
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
