"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { urgeTask } from "@/app/actions/project-management/tasks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export function TaskUrgeButton({ taskId, taskTitle, disabled, onSubmitted }: {
  taskId: string;
  taskTitle: string;
  disabled: boolean;
  onSubmitted: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [nextAllowedAt, setNextAllowedAt] = useState(0);
  const [now, setNow] = useState(0);
  const pending = useRef(false);
  const request = useRef<{ id: string; message: string } | null>(null);
  const seconds = Math.max(0, Math.ceil((nextAllowedAt - now) / 1000));

  useEffect(() => {
    if (!nextAllowedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [nextAllowedAt]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const trimmed = message.trim();
    if (trimmed.length > 500) {
      setError("催促信息最多 500 字");
      return;
    }
    pending.current = true;
    setSending(true);
    setError("");
    if (!request.current || request.current.message !== trimmed) {
      request.current = { id: crypto.randomUUID(), message: trimmed };
    }
    try {
      const result = await urgeTask({ taskId, message: trimmed, requestId: request.current.id });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNow(Date.now());
      setNextAllowedAt(Date.parse(result.data.nextAllowedAt));
      setOpen(false);
      onSubmitted();
      router.refresh();
    } catch {
      setError("暂时无法确认催促结果，请重试；同一请求不会重复发送。");
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" disabled={disabled || sending || seconds > 0} onClick={() => {
        setMessage("");
        setError("");
        request.current = null;
        setOpen(true);
      }}>
        {seconds > 0 ? `催促任务（${seconds} 秒后可重试）` : "催促任务"}
      </Button>
      <Dialog open={open} onOpenChange={(value) => { if (!pending.current) setOpen(value); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>催促任务</DialogTitle>
            <DialogDescription className="break-words">
              将通知本任务的有效负责人、参与人、全局管理员及你本人，不受 TASK 飞书通知偏好关闭影响。同一任务每 5 分钟可催促一次。
            </DialogDescription>
          </DialogHeader>
          <p className="break-all text-sm">任务：{taskTitle}</p>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="task-urge-message" className="text-sm font-medium">催促信息（可选）</label>
              <Textarea id="task-urge-message" value={message} maxLength={500} rows={5} disabled={sending}
                aria-describedby="task-urge-message-help" aria-invalid={Boolean(error)}
                onChange={(event) => setMessage(event.target.value)} placeholder="请填写需要大家关注或跟进的事项" />
              <p id="task-urge-message-help" className="text-xs text-muted-foreground">{message.length}/500 字；不填写时发送默认跟进提醒。</p>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={sending} onClick={() => setOpen(false)}>取消</Button>
              <Button type="submit" disabled={sending || disabled}>{sending ? "正在提交…" : "发送催促"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
