"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { loadActionInboxPage } from "@/app/actions/project-management/action-inbox";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  List,
  ListActions,
  ListContent,
  ListEmpty,
  ListItem,
} from "@/components/ui/list";
import { formatDateTime } from "@/lib/project-management/labels";
import type {
  ActionInboxItem,
  ActionInboxKind,
  ActionInboxPage,
  ActionInboxSeverity,
} from "@/lib/project-management/queries/action-inbox-queries";

const kindLabels: Record<ActionInboxKind, string> = {
  SEGMENT_CONFIRMATION: "投入确认",
  TASK_NEXT_NODE: "下一个节点",
  MILESTONE_REVIEW: "里程碑验收",
  REVISION_REVIEW: "计划修订审核",
  PROJECT_ESTABLISHMENT: "项目立项",
  TERMINATION_REVIEW: "任务结束审批",
};

const severityLabels: Record<ActionInboxSeverity, string> = {
  CRITICAL: "紧急",
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

const nodeTypeLabels = {
  MILESTONE: "里程碑",
  REVISION: "修订节点",
  TERMINATION: "结束节点",
} as const;

const nodeStatusLabels = {
  PENDING: "待开始",
  ACTIVE: "进行中",
  COMPLETED: "已完成",
  REVISED: "已修订",
  CANCELLED: "已取消",
} as const;

export function ActionInbox({
  initialPage,
  compact = false,
}: {
  initialPage: ActionInboxPage;
  compact?: boolean;
}) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function loadMore() {
    if (!nextCursor || isPending || compact) return;
    const requestedCursor = nextCursor;
    startTransition(async () => {
      let result;
      try {
        result = await loadActionInboxPage({
          cursor: requestedCursor,
          limit: 50,
        });
      } catch {
        setError("网络异常，请稍后重试。");
        return;
      }
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setItems((current) => mergeUniqueItems(current, result.data.items));
      setNextCursor(result.data.nextCursor);
      setError("");
    });
  }

  if (items.length === 0 && !error) {
    return <ListEmpty>当前没有需要你处理的事项。</ListEmpty>;
  }

  return (
    <div className="min-w-0 space-y-3" data-testid="action-inbox">
      {!compact && (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground"
          aria-label="待办统计"
        >
          <span>全部 {initialPage.totalCount} 项</span>
          <span>紧急 {initialPage.criticalCount} 项</span>
          <span>
            已加载 {items.length} / {initialPage.totalCount}
          </span>
        </div>
      )}
      {error && (
        <p
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          加载失败：{error}
        </p>
      )}
      {items.length > 0 && (
        <List aria-label="待办与审批列表">
          {items.map((item) => (
            <ActionInboxRow key={item.id} item={item} compact={compact} />
          ))}
        </List>
      )}
      {!compact && nextCursor && (
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={loadMore}
        >
          {isPending ? "正在加载…" : error ? "重试加载" : "加载更多"}
        </Button>
      )}
      {!compact && items.length > 0 && !nextCursor && !error && (
        <p className="text-center text-sm text-muted-foreground" role="status">
          已加载全部 {items.length} 项
        </p>
      )}
    </div>
  );
}

function ActionInboxRow({
  item,
  compact,
}: {
  item: ActionInboxItem;
  compact: boolean;
}) {
  return (
    <ListItem data-testid="action-inbox-item">
      <ListContent>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline">{kindLabels[item.kind]}</Badge>
          <Badge
            variant={item.severity === "CRITICAL" ? "destructive" : "secondary"}
          >
            {severityLabels[item.severity]}
          </Badge>
          <span className="min-w-0 flex-1 break-words font-medium">
            {item.title}
          </span>
        </div>
        {!compact && (
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {item.summary}
          </p>
        )}
        <div className="mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {item.projectName && (
            <span className="min-w-0 break-words">
              项目：{item.projectName}
            </span>
          )}
          {item.taskTitle && (
            <span className="min-w-0 break-words">Task：{item.taskTitle}</span>
          )}
          {item.nodeType && item.nodeStatus && (
            <span>
              节点：{nodeTypeLabels[item.nodeType]} ·{" "}
              {nodeStatusLabels[item.nodeStatus]}
            </span>
          )}
          <span>
            {item.timeLabel}：{formatDateTime(item.relevantAt)}
          </span>
        </div>
      </ListContent>
      <ListActions className="max-sm:w-full">
        <Link
          href={item.href}
          aria-label={`${item.actionLabel}：${item.title}`}
          className={buttonVariants({
            size: "sm",
            className: "max-sm:w-full",
          })}
        >
          {item.actionLabel}
        </Link>
      </ListActions>
    </ListItem>
  );
}

function mergeUniqueItems(
  current: ActionInboxItem[],
  incoming: ActionInboxItem[],
) {
  const seen = new Set(current.map((item) => item.id));
  const added = incoming.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return [...current, ...added];
}
