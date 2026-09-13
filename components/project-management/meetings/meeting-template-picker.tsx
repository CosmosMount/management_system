"use client";

import { useState, useTransition } from "react";
import { listMeetingTemplatesAction } from "@/app/actions/project-management/meeting-templates";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { MeetingTemplateList, MeetingTemplateSelection } from "@/lib/project-management/meetings/template-service";
import { MeetingTemplateBrowser } from "./meeting-template-browser";

export function MeetingTemplatePicker({ onSelect, disabled, label = "使用模板" }: {
  onSelect: (selection: MeetingTemplateSelection) => void;
  disabled: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MeetingTemplateList | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [selecting, setSelecting] = useState(false);
  function show() {
    setData(null);
    setError("");
    setOpen(true);
    startTransition(async () => {
      try {
        const result = await listMeetingTemplatesAction({});
        if (result.ok) setData(result.data);
        else setError(result.error.message);
      } catch { setError("模板加载失败，请重试"); }
    });
  }
  return <>
    <Button type="button" variant="outline" disabled={disabled} onClick={show}>{label}</Button>
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!pending && !selecting) setOpen(nextOpen); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl" showCloseButton={!pending && !selecting}>
        <DialogHeader><DialogTitle>选择会议模板</DialogTitle><DialogDescription>只替换非时间信息，保留当前工作时间范围。</DialogDescription></DialogHeader>
        {pending ? <p role="status">正在加载模板…</p> : <MeetingTemplateBrowser initialData={data} initialError={error} onSelecting={setSelecting} onSelect={(selection) => { onSelect(selection); setOpen(false); }} />}
      </DialogContent>
    </Dialog>
  </>;
}
