"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getMeetingFilterPeopleAction } from "@/app/actions/project-management/meetings";
import { searchVisibleProjectOptions, resolveVisibleProjectOptions } from "@/app/actions/project-management/projects";
import { AsyncCombobox } from "@/components/entity-picker/async-combobox";
import { TaskSelect } from "@/components/project-management/task-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { routes } from "@/lib/routes";

async function loadPeople(input: { query: string; cursor?: string }) {
  const result = await getMeetingFilterPeopleAction(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

async function resolvePeople(ids: string[]) {
  const result = await getMeetingFilterPeopleAction({ ids });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.items;
}

async function loadProjects({ query, cursor }: { query: string; cursor?: string }) {
  const result = await searchVisibleProjectOptions({ query, cursor: cursor ?? null, limit: 50 });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

async function resolveProjects(ids: string[]) {
  const result = await resolveVisibleProjectOptions({ ids });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

const selectClass = "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm";

export function MeetingFilterForm({ initialValues }: { initialValues: Record<string, string> }) {
  const [values, setValues] = useState(initialValues);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const router = useRouter();
  function update(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setError("");
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (values.period === "custom" && !values.dateFrom && !values.dateTo) {
      setError("请至少选择一个日期");
      event.currentTarget.querySelector<HTMLInputElement>("#meeting-date-from")?.focus();
      return;
    }
    if (values.period === "custom" && values.dateFrom && values.dateTo && values.dateFrom > values.dateTo) {
      setError("结束日期不能早于开始日期");
      event.currentTarget.querySelector<HTMLInputElement>("#meeting-date-to")?.focus();
      return;
    }
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) {
      if (!value || (values.period !== "custom" && ["dateFrom", "dateTo"].includes(name))) continue;
      search.set(name, value);
    }
    startTransition(() => router.push(`${routes.progress.meetings}?${search}`));
  }
  return <form action={routes.progress.meetings} method="get" aria-label="会议筛选" aria-busy={pending} onSubmit={submit} className="space-y-4 rounded-xl border bg-card p-4">
    <fieldset disabled={pending} className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-search">搜索会议主题</Label><Input id="meeting-search" name="q" value={values.q ?? ""} onChange={(event) => update("q", event.target.value)} maxLength={200} /></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-person">参与人</Label><AsyncCombobox scopeKey="meeting-filter-people" ariaLabel="参与人" inputId="meeting-person" value={values.personId || null} onValueChange={(value) => update("personId", value ?? "")} loadOptions={loadPeople} resolveOptions={resolvePeople} getOptionLabel={(option) => option.displayName} getOptionDescription={(option) => option.status === "INACTIVE" ? "已停用" : "在职"} renderOption={(option) => <span className="break-all">{option.displayName}{option.status === "INACTIVE" ? "（已停用）" : ""}</span>} placeholder="全部参与人" disabled={pending} /></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-mine">创建人</Label><select id="meeting-mine" className={selectClass} value={values.mine ?? ""} onChange={(event) => update("mine", event.target.value)}><option value="">全部会议</option><option value="1">我创建的会议</option></select></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-sort">排序</Label><select id="meeting-sort" className={selectClass} value={values.sort ?? "createdAt"} onChange={(event) => update("sort", event.target.value)}><option value="createdAt">创建时间：最新优先</option><option value="updatedAt">最近更新</option><option value="rangeStart">工作区间开始：最新优先</option></select></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-period">工作区间</Label><select id="meeting-period" className={selectClass} value={values.period ?? "all"} onChange={(event) => update("period", event.target.value)}><option value="all">全部时间</option><option value="7">最近 7 天开始</option><option value="30">最近 30 天开始</option><option value="90">最近 90 天开始</option><option value="custom">自定义相交区间</option></select></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-date-from">开始日期（北京时间）</Label><Input id="meeting-date-from" type="date" disabled={values.period !== "custom"} value={values.dateFrom ?? ""} onChange={(event) => update("dateFrom", event.target.value)} /></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-date-to">结束日期（北京时间）</Label><Input id="meeting-date-to" type="date" disabled={values.period !== "custom"} value={values.dateTo ?? ""} onChange={(event) => update("dateTo", event.target.value)} aria-invalid={!!error} aria-describedby={error ? "meeting-filter-error" : undefined} /></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-project-mode">关联项目</Label><select id="meeting-project-mode" className={selectClass} value={values.projectId === "none" ? "none" : "all"} onChange={(event) => update("projectId", event.target.value === "none" ? "none" : "")}><option value="all">全部 / 选择项目</option><option value="none">未关联项目</option></select><AsyncCombobox scopeKey="meeting-filter-projects" inputId="meeting-project" ariaLabel="选择关联项目" value={values.projectId && values.projectId !== "none" ? values.projectId : null} onValueChange={(value) => update("projectId", value ?? "")} loadOptions={loadProjects} resolveOptions={resolveProjects} getOptionLabel={(option) => option.name} renderOption={(option) => <span className="break-all">{option.name}</span>} disabled={pending || values.projectId === "none"} placeholder="搜索关联项目" /></div>
      <div className="min-w-0 space-y-2"><Label htmlFor="meeting-task-mode">关联任务</Label><select id="meeting-task-mode" className={selectClass} value={values.taskId === "none" ? "none" : "all"} onChange={(event) => update("taskId", event.target.value === "none" ? "none" : "")}><option value="all">全部 / 选择任务</option><option value="none">未关联任务</option></select><TaskSelect inputId="meeting-task" ariaLabel="选择关联任务" value={values.taskId && values.taskId !== "none" ? values.taskId : null} onValueChange={(value) => update("taskId", value ?? "")} disabled={pending || values.taskId === "none"} placeholder="搜索关联任务" /></div>
    </fieldset>
    {error && <p id="meeting-filter-error" role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={pending}>{pending ? "筛选中…" : "筛选"}</Button><Link href={routes.progress.meetings} className="text-sm text-primary hover:underline" onClick={(event) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        setValues({});
        setError("");
      }
    }}>重置</Link><p className="text-xs text-muted-foreground">自定义日期按工作区间相交筛选；项目和任务按会议直接选择的展示对象筛选。</p></div>
  </form>;
}
