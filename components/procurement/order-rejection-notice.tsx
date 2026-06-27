import { MessageSquareWarning } from "lucide-react";
import type { OrderStatus } from "@prisma/client";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Props = {
  reason: string;
  status?: OrderStatus;
  rejectedByName?: string | null;
  rejectedAt?: Date | string | null;
  /** card：详情页；inline：弹窗内紧凑条 */
  variant?: "card" | "inline";
  className?: string;
};

export function OrderRejectionNotice({
  reason,
  status,
  rejectedByName,
  rejectedAt,
  variant = "card",
  className,
}: Props) {
  const title = status === "REJECTED" ? "驳回说明" : "退回补充说明";

  const metaLabel =
    rejectedByName || rejectedAt
      ? `${rejectedByName ?? ""}${
          rejectedAt
            ? `${rejectedByName ? " · " : ""}${new Date(rejectedAt).toLocaleString("zh-CN")}`
            : ""
        }`
      : null;

  const meta = metaLabel ? (
    <p className="text-sm text-muted-foreground">{metaLabel}</p>
  ) : null;

  if (variant === "inline") {
    return (
      <div
        className={cn(
          "flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30",
          className,
        )}
      >
        <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 space-y-1">
          <p className="text-base font-semibold text-amber-900 dark:text-amber-100">
            {title}
          </p>
          <p className="text-base leading-relaxed text-amber-950 dark:text-amber-50">
            {reason}
          </p>
          {meta}
        </div>
      </div>
    );
  }

  return (
    <Card
      className={cn(
        "gap-0 border-amber-200 bg-amber-50/80 py-0 dark:border-amber-900 dark:bg-amber-950/30",
        className,
      )}
    >
      <CardContent className="flex gap-2.5 py-3">
        <MessageSquareWarning className="mt-1 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 space-y-1.5">
          <p className="text-base font-semibold text-amber-900 dark:text-amber-100">
            {title}
          </p>
          <p className="text-base leading-relaxed text-amber-950 dark:text-amber-50">
            {reason}
          </p>
          {meta}
        </div>
      </CardContent>
    </Card>
  );
}
