"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { getPersonalDueSegments } from "@/app/actions/project-management/canvas";
import { Button, buttonVariants } from "@/components/ui/button";

type DueSegment = {
  id: string;
  title: string;
  taskTitle: string | null;
  startAt: string;
  endAt: string;
  canHandle: boolean;
};

export function PersonalDueQueue({
  segments: initialSegments,
  initialNextCursor,
  initialError = "",
}: {
  segments: DueSegment[];
  initialNextCursor: string | null;
  initialError?: string;
}) {
  const [segments, setSegments] = useState(initialSegments);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [error, setError] = useState(initialError);
  const [isPending, startTransition] = useTransition();

  function loadMore() {
    if ((!nextCursor && !error) || isPending) return;
    const requestedCursor = nextCursor;
    startTransition(async () => {
      let result;
      try {
        result = await getPersonalDueSegments({
          ...(requestedCursor ? { cursor: requestedCursor } : {}),
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
      setSegments((current) => {
        const base = requestedCursor ? current : [];
        const seen = new Set(base.map((segment) => segment.id));
        return [
          ...base,
          ...result.data.items.flatMap((segment) =>
            seen.has(segment.id)
              ? []
              : [{
                  id: segment.id,
                  title: segment.content,
                  taskTitle: segment.taskTitle,
                  startAt: segment.startAt,
                  endAt: segment.endAt,
                  canHandle:
                    segment.permissions.canConfirm || segment.permissions.canCancel,
                }],
          ),
        ];
      });
      setNextCursor(result.data.nextCursor);
      setError("");
    });
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="personal-due-heading">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="personal-due-heading" className="font-semibold">到期计划与确认队列</h2>
          <p className="text-sm text-muted-foreground">从统一投入详情中确认完整、部分或未执行。</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-sm">{segments.length}{nextCursor ? "+" : ""} 项</span>
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">加载失败：{error}</p>}
      {segments.length === 0 && !error ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">当前没有到期且待确认的 Planned。</p>
      ) : segments.length > 0 ? (
        <ul className="space-y-3">
          {segments.map((segment) => (
            <li key={segment.id} className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="break-words font-medium">{segment.title}</p>
                <p className="mt-1 break-words text-sm text-muted-foreground">
                  {segment.taskTitle ?? "独立投入"} · {formatRange(segment.startAt, segment.endAt)} · 已到期
                </p>
              </div>
              {segment.canHandle ? (
                <Link className={buttonVariants({ size: "sm", className: "shrink-0" })} href={`/progress?focus=${segment.id}`}>处理</Link>
              ) : (
                <span className="shrink-0 text-sm text-muted-foreground">无可执行权限</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {(nextCursor || (error && segments.length === 0)) && (
        <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={loadMore}>
          {isPending ? "正在加载…" : nextCursor ? "加载更多" : "重试队列"}
        </Button>
      )}
    </section>
  );
}

function formatRange(startAt: string, endAt: string) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${formatter.format(new Date(startAt))} – ${formatter.format(new Date(endAt))}`;
}
