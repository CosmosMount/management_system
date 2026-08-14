import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/project-management/labels";
import type {
  ActionInboxItem,
  ActionInboxKind,
} from "@/lib/project-management/queries/action-inbox-queries";

const kindLabels: Record<ActionInboxKind, string> = {
  SEGMENT_CONFIRMATION: "投入确认",
  MILESTONE_REVIEW: "里程碑验收",
  REVISION_REVIEW: "计划修订审核",
  PROJECT_ESTABLISHMENT: "项目立项",
  TERMINATION: "任务结束确认",
};

const severityLabels = {
  CRITICAL: "紧急",
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
} as const;

export function ActionInbox({
  items,
  compact = false,
}: {
  items: ActionInboxItem[];
  compact?: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        当前没有需要你处理的事项。
      </div>
    );
  }
  const visible = compact ? items.slice(0, 8) : items;
  return (
    <div className="grid gap-2" data-testid="action-inbox">
      {visible.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          className="min-w-0 rounded-lg border border-border bg-background p-3 outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline">{kindLabels[item.kind]}</Badge>
            <Badge variant={item.severity === "CRITICAL" ? "destructive" : "secondary"}>
              {severityLabels[item.severity]}
            </Badge>
            <span className="min-w-0 flex-1 break-words font-medium">{item.title}</span>
          </div>
          <p className="mt-2 break-words text-sm text-muted-foreground">{item.summary}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {item.taskTitle ? `${item.taskTitle} · ` : ""}
            {item.dueAt ? `相关时间 ${formatDateTime(item.dueAt)}` : "请尽快处理"}
          </p>
        </Link>
      ))}
    </div>
  );
}
