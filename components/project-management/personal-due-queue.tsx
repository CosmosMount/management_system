"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  cancelPlannedSegment,
  confirmPlannedSegment,
  partiallyConfirmSegment,
} from "@/app/actions/project-management/segments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import { cn } from "@/lib/utils";

type DueSegment = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  versionToken: string;
  canConfirm: boolean;
  canCancel: boolean;
};

export function PersonalDueQueue({
  segments,
  truncated = false,
}: {
  segments: DueSegment[];
  truncated?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [partialId, setPartialId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const run = (action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>, message: string) => {
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setNotice({ kind: "error", message: result.error.message });
          return;
        }
        setPartialId(null);
        setNotice({ kind: "success", message });
        router.refresh();
      } catch {
        setNotice({ kind: "error", message: "网络异常，操作未完成，请刷新后重试。" });
      }
    });
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="personal-due-heading">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="personal-due-heading" className="font-semibold">到期计划与确认队列</h2>
          <p className="text-sm text-muted-foreground">明确选择完整确认、部分区间或未执行；所有动作仍由服务端校验。</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-sm">{segments.length}{truncated ? "+" : ""} 项</span>
      </div>
      {notice && (
        <p className={cn("rounded-lg px-3 py-2 text-sm", notice.kind === "error" ? "bg-destructive/10 text-destructive" : "bg-emerald-50 text-emerald-800")} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.message}
        </p>
      )}
      {segments.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">当前没有到期且待确认的 Planned。</p>
      ) : (
        <ul className="space-y-3">
          {segments.map((segment) => (
            <li key={segment.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="break-words font-medium">{segment.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{formatRange(segment.startAt, segment.endAt)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {segment.canConfirm && (
                    <>
                      <Button type="button" size="sm" disabled={isPending} onClick={() => run(() => confirmPlannedSegment({ segmentId: segment.id, expectedUpdatedAt: segment.versionToken, reason: "个人时间线完整确认" }), "已完整确认并生成 Actual")}>与计划一致</Button>
                      <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => setPartialId(partialId === segment.id ? null : segment.id)}>部分完成</Button>
                    </>
                  )}
                  {segment.canCancel && (
                    <Button type="button" size="sm" variant="destructive" disabled={isPending} onClick={() => run(() => cancelPlannedSegment({ segmentId: segment.id, expectedUpdatedAt: segment.versionToken, reason: "个人时间线标记未执行" }), "已标记为未执行并取消 Planned")}>未执行</Button>
                  )}
                </div>
              </div>
              {partialId === segment.id && (
                <form className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]" aria-label={`部分确认 ${segment.title}`} onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  run(
                    () => partiallyConfirmSegment({
                      segmentId: segment.id,
                      expectedUpdatedAt: segment.versionToken,
                      coveredStartAt: shanghaiDateTimeLocalToIso(String(form.get("coveredStartAt") ?? "")),
                      coveredEndAt: shanghaiDateTimeLocalToIso(String(form.get("coveredEndAt") ?? "")),
                      reason: String(form.get("reason") ?? "个人时间线部分确认"),
                    }),
                    "已按所选区间部分确认",
                  );
                }}>
                  <Input name="coveredStartAt" type="datetime-local" aria-label="部分完成开始" defaultValue={isoToShanghaiDateTimeLocal(segment.startAt)} required />
                  <Input name="coveredEndAt" type="datetime-local" aria-label="部分完成结束" defaultValue={isoToShanghaiDateTimeLocal(segment.endAt)} required />
                  <Input name="reason" aria-label="部分完成说明" defaultValue="个人时间线部分确认" required />
                  <Button type="submit" variant="outline" disabled={isPending}>确认区间</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
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
