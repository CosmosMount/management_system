"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { exportMeetingMinutesAction } from "@/app/actions/project-management/meetings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const copiedMessage = "会议纪要已复制，可粘贴到飞书文档中。";

export function MeetingExportButton({ meetingId }: { meetingId: string }) {
  const pending = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");

  async function exportMinutes() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await exportMeetingMinutesAction({ meetingId });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setMarkdown(result.data.markdown);
      try {
        await navigator.clipboard.writeText(result.data.markdown);
        toast.success(copiedMessage);
      } catch {
        setError("无法自动复制，请再次复制，或全选文本后手动复制。");
        setOpen(true);
      }
    } catch {
      toast.error("生成会议纪要失败，请稍后重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function retryCopy() {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success(copiedMessage);
      setOpen(false);
    } catch {
      setError("浏览器未允许复制，请全选文本后手动复制。");
      textarea.current?.focus();
      textarea.current?.select();
    } finally {
      setCopying(false);
    }
  }

  return <>
    <Button type="button" disabled={busy} onClick={() => void exportMinutes()}>{busy ? "正在生成…" : "导出会议纪要"}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>复制会议纪要</DialogTitle>
          <DialogDescription>以下为 Markdown 文本，复制后可粘贴到飞书文档中继续填写。</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <label htmlFor="meeting-export-markdown" className="text-sm font-medium">会议纪要文本</label>
        <Textarea id="meeting-export-markdown" ref={textarea} readOnly value={markdown} className="h-80 min-w-0 whitespace-pre-wrap break-words" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={copying} onClick={() => void retryCopy()}>{copying ? "正在复制…" : "再次复制"}</Button>
          <Button type="button" variant="outline" onClick={() => { textarea.current?.focus(); textarea.current?.select(); }}>全选文本</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
