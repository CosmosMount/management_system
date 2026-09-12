"use client";

import { useRef, useState, useTransition } from "react";
import { CalendarDays, CircleAlert, FileCheck2, Play, Plus, Pencil, Trash2, Clock3 } from "lucide-react";
import { createReminderSetting, deleteReminderSetting, updateReminderSetting, listReminderSettings, runReminderNow } from "@/app/actions/project-management/notifications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminGlobalSummaryRuns } from "./admin-global-summary-runs";

type Setting = { id: string; kind: string; timeOfDay: string; enabled: boolean };
const definitions = [
  ["PERSONAL_SUMMARY", "个人总结", "按人生成个人总结并通知每个人，而非仅通知触发执行的管理员。", FileCheck2, "blue"],
  ["MILESTONE_DUE", "里程碑当天到期", "在里程碑到期当天，按设定时间提醒管理员。", CalendarDays, "blue"],
  ["MILESTONE_OVERDUE", "里程碑逾期", "在里程碑逾期后，按设定时间提醒管理员。", CircleAlert, "indigo"],
  ["TASK_ACTIVATION_OVERDUE", "任务启动后未激活", "在任务启动后仍未激活时，按设定时间提醒管理员。", Play, "teal"],
  ["TASK_APPROVAL_PENDING", "Task 审批未完成", "在 Task 审批未完成时，按设定时间提醒管理员。", FileCheck2, "amber"],
  ["ADMIN_GLOBAL_SUMMARY", "管理员全局总结", "按设定时间生成管理员全局总结；立即执行独立于定时开关。", FileCheck2, "blue"],
] as const;
const iconStyles: Record<string, string> = { blue: "bg-blue-100 text-blue-600", indigo: "bg-indigo-100 text-indigo-600", teal: "bg-teal-100 text-teal-600", amber: "bg-amber-100 text-amber-600" };

export function ReminderSettingsClient({ initial }: { initial: Setting[] }) {
  const [items, setItems] = useState(initial); const [pending, startTransition] = useTransition(); const [message, setMessage] = useState("");
  const executions = useRef(new Map<string, { requestId: string; running: boolean }>());
  const [executionStates, setExecutionStates] = useState<Record<string, { running: boolean; message: string; failed: boolean }>>({});
  const [summaryRefreshKey, setSummaryRefreshKey] = useState(0);
  const runNow = async (kind: typeof definitions[number][0], title: string, enabled: boolean) => {
    const previous = executions.current.get(kind);
    if (previous?.running) return;
    const storageKey = `pm.reminder.run-now.pending:${kind}`;
    let requestId: string | null;
    try {
      requestId = sessionStorage.getItem(storageKey) ?? previous?.requestId ?? null;
      if (requestId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new Error("Invalid stored request ID");
      }
    } catch {
      setExecutionStates((current) => ({ ...current, [kind]: { running: false, message: "无法读取或保存安全重试标识，未发起执行请求。请恢复浏览器会话存储后重试。", failed: true } }));
      return;
    }
    const context = kind === "PERSONAL_SUMMARY" ? "将按人生成个人总结并通知每个人，不只通知当前管理员。" : `将执行“${title}”并按服务端规则生成通知。`;
    if (!window.confirm(`${enabled ? "" : "定时提醒当前未启用。"}${context}不会改变定时配置。${requestId ? "上次请求结果尚未确认，将使用同一请求标识重试。" : ""}确定继续吗？`)) return;
    setExecutionStates((current) => ({ ...current, [kind]: { running: true, message: "", failed: false } }));
    try {
      const execution = { requestId: requestId ?? crypto.randomUUID(), running: true };
      executions.current.set(kind, execution);
      try {
        sessionStorage.setItem(storageKey, execution.requestId);
        if (sessionStorage.getItem(storageKey) !== execution.requestId) throw new Error("Request ID was not persisted");
      } catch {
        setExecutionStates((current) => ({ ...current, [kind]: { running: false, message: "无法保存安全重试标识，未发起执行请求。请恢复浏览器会话存储后重试。", failed: true } }));
        return;
      }
      const result = await runReminderNow({ kind, requestId: execution.requestId });
      if (!result.ok) {
        setExecutionStates((current) => ({ ...current, [kind]: { running: false, message: `${result.error.message || "执行请求失败。"}再次点击将使用同一请求重试。`, failed: true } }));
        return;
      }
      try {
        sessionStorage.removeItem(storageKey);
        if (sessionStorage.getItem(storageKey) !== null) throw new Error("Request ID was not removed");
      } catch {
        setExecutionStates((current) => ({ ...current, [kind]: { running: false, message: "执行请求已完成，但无法清除安全重试标识。请恢复浏览器会话存储后重试，仍将复用同一请求标识，避免重复执行。", failed: true } }));
        return;
      }
      executions.current.delete(kind);
      setExecutionStates((current) => ({ ...current, [kind]: { running: false, message: "执行请求已完成，请查看执行结果；通知入队不代表已送达。", failed: false } }));
    } catch {
      setExecutionStates((current) => ({ ...current, [kind]: { running: false, message: "执行结果尚未确认，请稍后重试；重试将复用本次请求标识。", failed: true } }));
    } finally {
      const execution = executions.current.get(kind);
      if (execution) execution.running = false;
      if (kind === "ADMIN_GLOBAL_SUMMARY") setSummaryRefreshKey((current) => current + 1);
    }
  };
  const grouped = new Map(definitions.map(([kind]) => [kind, items.filter((item) => item.kind === kind)]));
  type SaveResult = { ok: true; data: unknown } | { ok: false; error: { message: string } };
  const run = (action: () => Promise<SaveResult | SaveResult[]>) => startTransition(async () => {
    setMessage("");
    try {
      const result = await action();
      const results = Array.isArray(result) ? result : [result];
      const failed = results.find((item) => !item.ok);
      if (failed && !failed.ok) {
        setMessage(failed.error.message || "保存失败，请稍后重试");
        return;
      }
      const refreshed = await listReminderSettings();
      if (!refreshed.ok) {
        setMessage("配置已保存，但列表刷新失败，请刷新页面确认。");
        return;
      }
      setItems(refreshed.data);
      setMessage("提醒配置已保存");
    } catch {
      setMessage("保存请求未完成，部分操作可能已保存，请刷新确认后重试。");
    }
  });
  return <section className="min-w-0 bg-transparent" aria-labelledby="reminder-settings-title">
    <div className="mb-5 px-1"><h2 id="reminder-settings-title" className="text-2xl font-bold tracking-tight text-slate-900">管理员提醒时间</h2><p className="mt-2 text-sm text-slate-500">使用上海时间；同一种提醒可以配置多个时间点。</p></div>
    <div className="space-y-4">{definitions.map(([kind, title, description, Icon, color]) => { const rows = grouped.get(kind) ?? []; const enabled = rows.some((row) => row.enabled); return <article key={kind} className="relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 sm:px-6"><div className="flex min-w-0 items-start gap-4"><div className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${iconStyles[color]}`}><Icon className="size-6" strokeWidth={2} /></div><div className="min-w-0"><h3 className="text-base font-semibold text-slate-900">{title}</h3><p className="mt-1 text-sm text-slate-500">{description}</p></div></div><div className="flex max-w-full flex-wrap items-center gap-4"><Button type="button" variant="outline" className="h-10 gap-2 rounded-lg border-slate-200 bg-white px-4 text-slate-800 shadow-sm hover:bg-slate-50" disabled={executionStates[kind]?.running ?? false} onClick={() => void runNow(kind, title, enabled)}><Play aria-hidden="true" className="size-4 text-blue-600" />{executionStates[kind]?.running ? "执行中…" : "立即执行"}</Button><label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700"><input type="checkbox" className="peer sr-only" checked={enabled} disabled={pending || rows.length === 0} aria-label={`${title}总开关`} onChange={(event) => { const next = event.target.checked; run(() => Promise.all(rows.map((row) => updateReminderSetting({ id: row.id, enabled: next })))); }} /><span className="relative h-7 w-12 rounded-full bg-slate-300 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-600 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:absolute after:left-1 after:top-1 after:size-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" /><span>{enabled ? "启用" : "禁用"}</span></label></div></div>
      <div className="flex flex-wrap items-center gap-3 bg-slate-50/80 px-5 py-3 sm:px-6"><div className="flex items-center gap-2 text-sm font-medium text-slate-700"><Clock3 className="size-4 text-slate-600" />提醒时间点（{rows.length}）</div>{rows.map((row) => <div key={row.id} className="flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1 shadow-sm"><Input className="h-8 w-36 min-w-36 border-0 p-1 text-center font-medium shadow-none focus-visible:ring-0" type="time" value={row.timeOfDay} disabled={pending} aria-label={`${title}时间`} onChange={(event) => setItems((current) => current.map((item) => item.id === row.id ? { ...item, timeOfDay: event.target.value } : item))} /><Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-blue-600 hover:bg-blue-50 hover:text-blue-700" disabled={pending || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.timeOfDay)} onClick={() => run(() => updateReminderSetting(row))}><Pencil className="size-3.5" />编辑</Button><Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-red-500 hover:bg-red-50 hover:text-red-600" disabled={pending} onClick={() => { if (window.confirm("确定删除这个提醒时间点吗？")) run(() => deleteReminderSetting({ id: row.id })); }}><Trash2 className="size-3.5" />删除</Button></div>)}<form className="flex max-w-full flex-wrap items-center gap-2" action={(data) => run(() => createReminderSetting({ kind, timeOfDay: String(data.get("timeOfDay")), enabled: true }))}><Input name="timeOfDay" className="h-10 w-36 min-w-36" type="time" disabled={pending} required aria-label={`新增${title}时间`} /><Button type="submit" size="sm" variant="outline" className="h-10 gap-1.5 border-dashed border-blue-300 px-4 text-blue-600 hover:bg-blue-50" disabled={pending}><Plus className="size-4" />新增时间点</Button></form></div>
      {executionStates[kind]?.message && <p role={executionStates[kind].failed ? "alert" : "status"} className={`px-5 py-3 text-sm [overflow-wrap:anywhere] sm:px-6 ${executionStates[kind].failed ? "text-destructive" : "text-slate-600"}`}>{executionStates[kind].message}</p>}
      {kind === "ADMIN_GLOBAL_SUMMARY" && <AdminGlobalSummaryRuns refreshKey={summaryRefreshKey} running={executionStates[kind]?.running ?? false} />}
    </article>; })}</div>{message && <p role="status" className="mt-3 break-words px-1 text-sm text-slate-600">{message}</p>}
  </section>;
}
