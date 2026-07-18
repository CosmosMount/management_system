"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  FilterX,
} from "lucide-react";
import { RequestApprovalReminderButton } from "@/components/progress/request-approval-reminder-button";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  ProgressApprovalKind,
  ProgressApprovalListItem,
  ProgressApprovalStatus,
} from "@/lib/progress-approval-domain";
import { cn } from "@/lib/utils";

type SortKey = "kind" | "project" | "status" | "submittedAt";
type SortDirection = "asc" | "desc";

type FilterState = {
  kind: string;
  project: string;
  status: string;
  from: string;
  to: string;
  sort: SortKey;
  direction: SortDirection;
};

type Props = {
  items: ProgressApprovalListItem[];
};

const PAGE_SIZE = 20;

const kindOrder: ProgressApprovalKind[] = [
  "PROJECT_ESTABLISHMENT",
  "STAGE_ACCEPTANCE",
  "PROJECT_BATCH_DDL",
  "PROJECT_STAGE_DDL",
  "TASK_CREATION",
  "TASK_DELETION",
  "TASK_DDL",
  "TASK_ACCEPTANCE",
];

const statusOrder: ProgressApprovalStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
];

export function MyApprovalSubmissionsList({ items }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryKey = searchParams.toString();
  const parsed = useMemo(
    () => readFilters(new URLSearchParams(queryKey)),
    [queryKey],
  );
  const [draftState, setDraftState] = useState({
    queryKey,
    value: parsed.filters,
  });
  const draft =
    draftState.queryKey === queryKey ? draftState.value : parsed.filters;

  function setDraft(update: FilterState | ((value: FilterState) => FilterState)) {
    setDraftState((current) => {
      const currentValue =
        current.queryKey === queryKey ? current.value : parsed.filters;
      return {
        queryKey,
        value: typeof update === "function" ? update(currentValue) : update,
      };
    });
  }

  const kinds = useMemo(
    () =>
      kindOrder
        .map((kind) => items.find((item) => item.kind === kind))
        .filter((item): item is ProgressApprovalListItem => Boolean(item))
        .map((item) => ({ value: item.kind, label: item.kindLabel })),
    [items],
  );
  const projects = useMemo(
    () =>
      Array.from(
        new Map(items.map((item) => [item.projectId, item.projectName])).entries(),
      )
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
    [items],
  );

  const filtered = useMemo(() => {
    const from = parsed.filters.from
      ? startOfShanghaiDay(parsed.filters.from)
      : null;
    const to = parsed.filters.to ? endOfShanghaiDay(parsed.filters.to) : null;
    return items
      .filter((item) => {
        const submittedAt = new Date(item.submittedAt).getTime();
        return (
          (!parsed.filters.kind || item.kind === parsed.filters.kind) &&
          (!parsed.filters.project ||
            item.projectId === parsed.filters.project) &&
          (!parsed.filters.status || item.status === parsed.filters.status) &&
          (from === null || submittedAt >= from) &&
          (to === null || submittedAt <= to)
        );
      })
      .sort((a, b) => compareItems(a, b, parsed.filters));
  }, [items, parsed.filters]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(parsed.page, pageCount);
  const visibleItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  function updateUrl(next: FilterState, nextPage = 1) {
    const params = new URLSearchParams();
    params.set("view", "submitted");
    setOptional(params, "type", next.kind);
    setOptional(params, "project", next.project);
    if (!next.status) {
      params.set("status", "ALL");
    } else if (next.status !== "PENDING") {
      params.set("status", next.status);
    }
    setOptional(params, "from", next.from);
    setOptional(params, "to", next.to);
    if (next.sort !== "submittedAt") params.set("sort", next.sort);
    if (next.direction !== "desc") params.set("direction", next.direction);
    if (nextPage > 1) params.set("page", String(nextPage));
    router.push(`/progress/approvals?${params.toString()}`);
  }

  function clearFilters() {
    const next: FilterState = {
      kind: "",
      project: "",
      status: "PENDING",
      from: "",
      to: "",
      sort: "submittedAt",
      direction: "desc",
    };
    setDraft(next);
    updateUrl(next);
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="暂无审批申请"
        description="你在项目管理中提交的审批会集中显示在这里。"
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              updateUrl(draft);
            }}
          >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <FilterSelect
                id="approval-kind-filter"
                label="审批类型"
                value={draft.kind}
                onChange={(kind) => setDraft((value) => ({ ...value, kind }))}
                options={kinds}
              />
              <FilterSelect
                id="approval-project-filter"
                label="项目"
                value={draft.project}
                onChange={(project) =>
                  setDraft((value) => ({ ...value, project }))
                }
                options={projects}
              />
              <FilterSelect
                id="approval-status-filter"
                label="状态"
                value={draft.status}
                onChange={(status) =>
                  setDraft((value) => ({ ...value, status }))
                }
                options={statusOrder.map((value) => ({
                  value,
                  label: statusLabel(value),
                }))}
              />
              <div className="space-y-2">
                <Label htmlFor="approval-date-from">开始日期</Label>
                <Input
                  id="approval-date-from"
                  type="date"
                  value={draft.from}
                  max={draft.to || undefined}
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, from: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="approval-date-to">结束日期</Label>
                <Input
                  id="approval-date-to"
                  type="date"
                  value={draft.to}
                  min={draft.from || undefined}
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, to: event.target.value }))
                  }
                />
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">
                <FilterSelect
                  id="approval-sort-filter"
                  label="排序字段"
                  value={draft.sort}
                  onChange={(sort) =>
                    setDraft((value) => ({ ...value, sort: sort as SortKey }))
                  }
                  options={[
                    { value: "submittedAt", label: "提交时间" },
                    { value: "kind", label: "审批类型" },
                    { value: "project", label: "项目" },
                    { value: "status", label: "状态" },
                  ]}
                  className="min-w-36"
                />
                <div className="space-y-2">
                  <Label htmlFor="approval-sort-direction">排序方向</Label>
                  <select
                    id="approval-sort-direction"
                    value={draft.direction}
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        direction: event.target.value as SortDirection,
                      }))
                    }
                    className={selectClassName}
                  >
                    <option value="desc">降序</option>
                    <option value="asc">升序</option>
                  </select>
                </div>
                <Button type="submit">应用筛选</Button>
                <Button type="button" variant="ghost" onClick={clearFilters}>
                  <FilterX />
                  清除筛选
                </Button>
              </div>
              <p className="shrink-0 text-sm text-muted-foreground">
                共 {filtered.length} 条结果
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          title="没有符合条件的审批申请"
          description="请调整筛选条件后再试。"
          action={<Button onClick={clearFilters}>清除筛选</Button>}
        />
      ) : (
        <>
          <ul className="space-y-3" aria-label="我的审批申请">
            {visibleItems.map((item) => (
              <li key={`${item.reference.kind}-${item.reference.id}`}>
                <Card className="border-border/70">
                  <CardContent className="p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{item.kindLabel}</Badge>
                          <StatusBadge status={item.status} label={item.statusLabel} />
                          <p className="break-words font-medium">{item.subject}</p>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          项目：{item.projectName}
                        </p>
                        <p className="break-words text-sm">{item.summary}</p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>提交人：{item.submitterName}</span>
                          <span>提交时间：{formatDateTime(item.submittedAt)}</span>
                          {item.processedAt ? (
                            <span>处理时间：{formatDateTime(item.processedAt)}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {item.canRequestReminder && item.status === "PENDING" ? (
                          <RequestApprovalReminderButton
                            reference={item.reference}
                            compact
                            subject={`${item.kindLabel}：${item.subject}`}
                          />
                        ) : null}
                        <Link
                          href={item.href}
                          className={buttonVariants({ size: "sm" })}
                        >
                          查看详情
                          <ExternalLink />
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>

          {pageCount > 1 ? (
            <nav
              aria-label="我的审批申请分页"
              className="flex items-center justify-between gap-3"
            >
              <Button
                type="button"
                variant="outline"
                disabled={page <= 1}
                onClick={() => updateUrl(parsed.filters, page - 1)}
              >
                <ChevronLeft />
                上一页
              </Button>
              <span className="text-sm text-muted-foreground">
                第 {page} / {pageCount} 页
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={page >= pageCount}
                onClick={() => updateUrl(parsed.filters, page + 1)}
              >
                下一页
                <ChevronRight />
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={selectClassName}
      >
        <option value="">全部</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatusBadge({
  status,
  label,
}: {
  status: ProgressApprovalStatus;
  label: string;
}) {
  return (
    <Badge
      variant={
        status === "APPROVED"
          ? "secondary"
          : status === "REJECTED"
            ? "destructive"
            : "outline"
      }
      className={cn(status === "PENDING" && "border-amber-400 text-amber-700")}
    >
      {label}
    </Badge>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-52 flex-col items-center justify-center gap-3 p-6 text-center">
        <ClipboardList className="h-10 w-10 text-muted-foreground" />
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

function readFilters(searchParams: URLSearchParams): {
  filters: FilterState;
  page: number;
} {
  const sort = searchParams.get("sort");
  const direction = searchParams.get("direction");
  const rawPage = Number(searchParams.get("page"));
  return {
    filters: {
      kind: searchParams.get("type") ?? "",
      project: searchParams.get("project") ?? "",
      status:
        searchParams.get("status") === "ALL"
          ? ""
          : searchParams.get("status") ?? "PENDING",
      from: validDateInput(searchParams.get("from")),
      to: validDateInput(searchParams.get("to")),
      sort:
        sort === "kind" || sort === "project" || sort === "status"
          ? sort
          : "submittedAt",
      direction: direction === "asc" ? "asc" : "desc",
    },
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

function compareItems(
  a: ProgressApprovalListItem,
  b: ProgressApprovalListItem,
  filters: FilterState,
): number {
  let result: number;
  if (filters.sort === "kind") {
    result = kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind);
  } else if (filters.sort === "project") {
    result = a.projectName.localeCompare(b.projectName, "zh-CN");
  } else if (filters.sort === "status") {
    result = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
  } else {
    result = new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
  }
  if (result === 0) result = a.reference.id.localeCompare(b.reference.id);
  return filters.direction === "asc" ? result : -result;
}

function startOfShanghaiDay(value: string): number {
  return new Date(`${value}T00:00:00+08:00`).getTime();
}

function endOfShanghaiDay(value: string): number {
  return new Date(`${value}T23:59:59.999+08:00`).getTime();
}

function validDateInput(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function setOptional(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
}

function statusLabel(status: ProgressApprovalStatus): string {
  if (status === "PENDING") return "待审批";
  if (status === "APPROVED") return "已通过";
  if (status === "REJECTED") return "已驳回";
  return "已失效";
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const selectClassName =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
