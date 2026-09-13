"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { FileText, Users } from "lucide-react";
import { deleteMeetingTemplateAction, getMeetingTemplateAction, listMeetingTemplatesAction } from "@/app/actions/project-management/meeting-templates";
import { Button, buttonVariants } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import type { MeetingTemplateList, MeetingTemplateSelection } from "@/lib/project-management/meetings/template-service";

export function MeetingTemplateBrowser({ initialData, initialError = "", onSelect, onSelecting }: {
  initialData: MeetingTemplateList | null;
  initialError?: string;
  onSelect?: (selection: MeetingTemplateSelection) => void;
  onSelecting?: (selecting: boolean) => void;
}) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [pending, startTransition] = useTransition();
  const cursors = useRef<Array<MeetingTemplateList["nextCursor"]>>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  function load(index: number) {
    setError("");
    startTransition(async () => {
      try {
        const cursor = cursors.current[index];
        const result = await listMeetingTemplatesAction(cursor ? { cursor } : {});
        if (!result.ok) { setError(result.error.message); return; }
        cursors.current[index + 1] = result.data.nextCursor;
        setData(result.data);
        setPageIndex(index);
      } catch { setError("模板加载失败，请检查网络后重试"); }
    });
  }

  function select(id: string) {
    setError("");
    onSelecting?.(true);
    startTransition(async () => {
      try {
        const result = await getMeetingTemplateAction({ templateId: id });
        if (!result.ok) { setError(result.error.message); return; }
        onSelect?.(result.data);
      } catch { setError("模板加载失败，已填内容未改变，请重试"); }
      finally { onSelecting?.(false); }
    });
  }

  function remove(template: MeetingTemplateList["items"][number]) {
    if (!window.confirm(`确定删除模板“${template.name}”吗？不会影响已创建的会议。`)) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await deleteMeetingTemplateAction({ templateId: template.id, expectedVersion: template.version });
        if (!result.ok) { setError(result.error.message); return; }
        const refreshed = await listMeetingTemplatesAction({});
        if (!refreshed.ok) { setData(null); setError(`模板已删除，${refreshed.error.message}`); return; }
        cursors.current = [null, refreshed.data.nextCursor];
        setPageIndex(0);
        setData(refreshed.data);
      } catch { setError("删除结果暂时无法确认，请重新加载模板列表"); }
    });
  }

  return <section aria-label="会议模板" className="min-w-0 space-y-3 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">会议模板</h2>{!onSelect && <Link href={routes.progress.meetingTemplateNew} className={buttonVariants({ size: "sm" })}>创建模板</Link>}</div>
    <p className="text-sm text-muted-foreground">模板仅预填非时间信息。填充后可自由修改，与原模板互不影响。</p>
    {error && <div role="alert" className="space-y-2 break-words text-sm text-destructive"><p>{error}</p><Button type="button" variant="outline" disabled={pending} onClick={() => load(pageIndex)}>重新加载模板</Button></div>}
    {pending && <p role="status" className="text-sm text-muted-foreground">正在处理模板…</p>}
    {data?.items.length === 0 && <p role="status" className="py-8 text-center text-muted-foreground">暂无会议模板</p>}
    <div className="space-y-3">{data?.items.map((template) => <article key={template.id} aria-label={template.name} className="min-w-0 space-y-3 rounded-lg border p-3">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <FileText aria-hidden className="size-9 shrink-0 rounded-lg bg-primary/10 p-2 text-primary" />
        <div className="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]"><h3 className="font-semibold">{template.name}</h3>
          {template.description.length > 100 ? <details className="text-sm text-muted-foreground"><summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">{template.description.slice(0, 60)}…（展开说明）</summary><p className="mt-2 whitespace-pre-wrap">{template.description}</p></details> : <p className="text-sm text-muted-foreground">{template.description || "暂无模板说明"}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {onSelect ? <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => select(template.id)}>使用模板</Button> : <>
            <Link className={buttonVariants({ size: "sm", variant: "outline" })} href={routes.progress.meetingFromTemplate(template.id)}>使用模板</Link>
            <Link className={buttonVariants({ size: "sm", variant: "outline" })} href={routes.progress.meetingTemplateEdit(template.id)}>编辑</Link>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => remove(template)}>删除</Button>
          </>}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap gap-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {template.participantNames.join("、").length > 100 || template.participantNames.length > 3
          ? <details className="min-w-0 rounded bg-muted px-2 py-1"><summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring"><Users aria-hidden className="mr-1 inline size-3" />参与人：共 {template.participantNames.length} 人（展开查看）</summary><p className="mt-2">{template.participantNames.join("、")}</p></details>
          : <span className="min-w-0 rounded bg-muted px-2 py-1"><Users aria-hidden className="mr-1 inline size-3" />参与人：{template.participantNames.join("、")}</span>}
        <span className="rounded bg-muted px-2 py-1">展示：{template.projectCount} 个项目、{template.taskCount} 个任务</span>
        <span className="rounded bg-muted px-2 py-1">{template.hasMinutes ? "包含纪要内容" : "无预填纪要"}</span>
      </div>
    </article>)}</div>
    <div className="flex flex-wrap gap-2">
      {pageIndex > 0 && <Button type="button" variant="outline" disabled={pending} onClick={() => load(pageIndex - 1)}>上一页模板</Button>}
      {data?.nextCursor && <Button type="button" variant="outline" disabled={pending} onClick={() => { cursors.current[pageIndex + 1] = data.nextCursor; load(pageIndex + 1); }}>下一页模板</Button>}
    </div>
  </section>;
}
