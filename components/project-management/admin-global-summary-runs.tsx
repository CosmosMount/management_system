"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listAdminGlobalSummaryRuns } from "@/app/actions/project-management/notifications";
import { Button } from "@/components/ui/button";

type SummaryRun = Extract<Awaited<ReturnType<typeof listAdminGlobalSummaryRuns>>, { ok: true }>["data"][number];

function formatTime(value: Date | string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium",
  }).format(date);
}

export function AdminGlobalSummaryRuns({ refreshKey, running }: { refreshKey: number; running: boolean }) {
  const [runs, setRuns] = useState<SummaryRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const loadVersion = useRef(0);

  const loadRuns = useCallback(() => {
    const version = ++loadVersion.current;
    return listAdminGlobalSummaryRuns().then((result) => {
      if (version !== loadVersion.current) return;
      if (result.ok) {
        setRuns(result.data);
        setLoadError("");
      }
      else setLoadError(result.error.message || "执行记录加载失败，请重试。");
    }).catch(() => {
      if (version === loadVersion.current) setLoadError("执行记录加载失败，请重试。");
    }).finally(() => {
      if (version === loadVersion.current) setLoading(false);
    });
  }, []);

  useEffect(() => {
    void loadRuns();
    return () => { loadVersion.current += 1; };
  }, [loadRuns, refreshKey]);

  return (
    <section className="min-w-0 space-y-4 border-t border-slate-200 p-5 sm:p-6" aria-label="管理员全局总结执行记录" aria-busy={running || loading}>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={loading || running} onClick={() => { setLoading(true); setLoadError(""); void loadRuns(); }}>刷新执行记录</Button>
        <p className="text-sm text-slate-500">定时总结禁用时也可立即执行；时间均为上海时间。</p>
      </div>
      <h4 className="font-semibold">执行记录</h4>
      {loadError && <p role="alert" className="break-words text-sm text-destructive">{loadError}</p>}
      {loading && <p role="status" className="text-sm text-slate-500">正在加载执行记录…</p>}
      {!loading && !loadError && runs.length === 0 && <p className="text-sm text-slate-500">暂无执行记录。</p>}
      {runs.map((run) => (
        <article key={run.id} className="min-w-0 space-y-3 rounded-lg border border-slate-200 p-4">
          <div className="flex flex-wrap gap-x-5 gap-y-2 break-words text-sm">
            <strong>{run.status === "SUCCEEDED" ? "已生成并入队（不代表已送达）" : "执行失败"}</strong>
            <span>开始：{formatTime(run.startedAt)}</span>
            <span>结束：{formatTime(run.finishedAt)}</span>
            <span>接收人数：{run.recipientCount}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">触发方式：{run.trigger === "MANUAL" ? "手动" : run.trigger === "SCHEDULED" ? "自动" : "未知"}</span>
          </div>
          {run.errorMessage && <p className="text-sm text-destructive [overflow-wrap:anywhere]">{run.errorMessage}</p>}
          {run.markdown ? <details><summary className="cursor-pointer rounded-sm text-sm focus-visible:outline-2">查看完整 Markdown</summary><pre className="mt-3 max-w-full whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm [overflow-wrap:anywhere]" aria-label="完整总结内容">{run.markdown}</pre></details> : <p className="text-sm text-slate-500">无总结内容。</p>}
        </article>
      ))}
    </section>
  );
}
