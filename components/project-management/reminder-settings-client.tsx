"use client";

import { useState, useTransition } from "react";
import { CalendarDays, CircleAlert, FileCheck2, Play, Plus, Pencil, Trash2, Clock3 } from "lucide-react";
import { createReminderSetting, deleteReminderSetting, updateReminderSetting } from "@/app/actions/project-management/notifications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Setting = { id: string; kind: string; timeOfDay: string; enabled: boolean };
const definitions = [
  ["MILESTONE_DUE", "里程碑当天到期", "在里程碑到期当天，按设定时间提醒管理员。", CalendarDays, "blue"],
  ["MILESTONE_OVERDUE", "里程碑逾期", "在里程碑逾期后，按设定时间提醒管理员。", CircleAlert, "indigo"],
  ["TASK_ACTIVATION_OVERDUE", "任务启动后未激活", "在任务启动后仍未激活时，按设定时间提醒管理员。", Play, "teal"],
  ["TASK_APPROVAL_PENDING", "Task 审批未完成", "在 Task 审批未完成时，按设定时间提醒管理员。", FileCheck2, "amber"],
] as const;
const iconStyles: Record<string, string> = { blue: "bg-blue-100 text-blue-600", indigo: "bg-indigo-100 text-indigo-600", teal: "bg-teal-100 text-teal-600", amber: "bg-amber-100 text-amber-600" };

export function ReminderSettingsClient({ initial }: { initial: Setting[] }) {
  const [items, setItems] = useState(initial); const [pending, startTransition] = useTransition(); const [message, setMessage] = useState("");
  const grouped = new Map(definitions.map(([kind]) => [kind, items.filter((item) => item.kind === kind)]));
  const run = (action: () => Promise<any>) => startTransition(async () => {
    const result = await action();
    const results = Array.isArray(result) ? result : [result];
    const failed = results.find((item) => !item?.ok);
    if (failed) {
      setMessage(failed.error?.message ?? "保存失败，请稍后重试");
      return;
    }
    setMessage("提醒配置已保存");
    window.location.reload();
  });
  return <section className="min-w-0 bg-transparent" aria-labelledby="reminder-settings-title">
    <div className="mb-5 px-1"><h2 id="reminder-settings-title" className="text-2xl font-bold tracking-tight text-slate-900">管理员提醒时间</h2><p className="mt-2 text-sm text-slate-500">使用上海时间；同一种提醒可以配置多个时间点。</p></div>
    <div className="space-y-4">{definitions.map(([kind, title, description, Icon, color]) => { const rows = grouped.get(kind) ?? []; const enabled = rows.some((row) => row.enabled); return <article key={kind} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 sm:px-6"><div className="flex min-w-0 items-start gap-4"><div className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${iconStyles[color]}`}><Icon className="size-6" strokeWidth={2} /></div><div className="min-w-0"><h3 className="text-base font-semibold text-slate-900">{title}</h3><p className="mt-1 text-sm text-slate-500">{description}</p></div></div><label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700"><input type="checkbox" className="peer sr-only" checked={enabled} disabled={pending || rows.length === 0} aria-label={`${title}总开关`} onChange={(event) => { const next = event.target.checked; run(() => Promise.all(rows.map((row) => updateReminderSetting({ id: row.id, enabled: next })))); }} /><span className="relative h-7 w-12 rounded-full bg-slate-300 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-600 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:absolute after:left-1 after:top-1 after:size-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" /><span>{enabled ? "启用" : "禁用"}</span></label></div>
      <div className="flex flex-wrap items-center gap-3 bg-slate-50/80 px-5 py-3 sm:px-6"><div className="flex items-center gap-2 text-sm font-medium text-slate-700"><Clock3 className="size-4 text-slate-600" />提醒时间点（{rows.length}）</div>{rows.map((row) => <div key={row.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1 shadow-sm"><Input className="h-8 w-[76px] border-0 p-1 text-center font-medium shadow-none focus-visible:ring-0" type="time" value={row.timeOfDay} disabled={pending} aria-label={`${title}时间`} onChange={(event) => setItems((current) => current.map((item) => item.id === row.id ? { ...item, timeOfDay: event.target.value } : item))} /><Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-blue-600 hover:bg-blue-50 hover:text-blue-700" disabled={pending} onClick={() => run(() => updateReminderSetting(row))}><Pencil className="size-3.5" />编辑</Button><Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-red-500 hover:bg-red-50 hover:text-red-600" disabled={pending} onClick={() => { if (window.confirm("确定删除这个提醒时间点吗？")) run(() => deleteReminderSetting({ id: row.id })); }}><Trash2 className="size-3.5" />删除</Button></div>)}<form className="flex items-center" action={(data) => run(() => createReminderSetting({ kind, timeOfDay: String(data.get("timeOfDay")), enabled: true }))}><Input name="timeOfDay" className="sr-only" type="time" defaultValue="09:00" required aria-label={`新增${title}时间`} /><Button size="sm" variant="outline" className="h-10 gap-1.5 border-dashed border-blue-300 px-4 text-blue-600 hover:bg-blue-50" disabled={pending}><Plus className="size-4" />新增时间点</Button></form></div>
    </article>; })}</div>{message && <p role="status" className="mt-3 px-1 text-sm text-slate-600">{message}</p>}
  </section>;
}
