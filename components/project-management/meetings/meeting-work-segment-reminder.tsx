"use client";

import { useRef, useState } from "react";
import { listMeetingMissingPeopleAction, urgeMeetingWorkSegmentsAction } from "@/app/actions/project-management/meetings";
import { formatDateTime } from "@/lib/project-management/labels";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ReminderData = Extract<Awaited<ReturnType<typeof listMeetingMissingPeopleAction>>, { ok: true }>["data"];

export function MeetingWorkSegmentReminder({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReminderData | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const request = useRef<{ id: string; key: string } | null>(null);

  async function load() {
    const token = ++generation.current;
    setData(null);
    setSelected([]);
    setError("");
    setLoading(true);
    try {
      const result = await listMeetingMissingPeopleAction({ meetingId });
      if (generation.current !== token) return;
      if (!result.ok) { setError(result.error.message); return; }
      setData(result.data);
      setSelected(result.data.participants.filter((person) => person.missing && person.eligible).map((person) => person.id));
    } catch {
      if (generation.current === token) setError("未能加载参会人员，请重试");
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }

  function changeOpen(nextOpen: boolean) {
    if (pending.current) return;
    setOpen(nextOpen);
    if (nextOpen) { setSuccess(""); void load(); }
    else generation.current += 1;
  }

  async function submit() {
    if (pending.current || !data || loading || !selected.length) return;
    pending.current = true;
    setSending(true);
    setError("");
    const key = JSON.stringify({ meetingId, version: data.version, selected: [...selected].sort() });
    if (request.current?.key !== key) request.current = { id: crypto.randomUUID(), key };
    try {
      const result = await urgeMeetingWorkSegmentsAction({ meetingId, expectedVersion: data.version, recipientPersonIds: selected, requestId: request.current.id });
      if (!result.ok) { setError(result.error.message); return; }
      request.current = null;
      setSuccess(`已为 ${result.data.recipientCount} 人创建站内通知并提交飞书提醒队列；实际投递受身份绑定和投递保护限制。`);
      setOpen(false);
    } catch {
      setError("发送结果暂时无法确认，请重试；同一请求不会重复发送。");
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  const missing = data?.participants.filter((person) => person.missing) ?? [];
  return <div className="min-w-0 max-w-full">
    <Button type="button" variant="outline" onClick={() => changeOpen(true)}>提醒填写投入</Button>
    {success && <p role="status" className="mt-2 max-w-lg break-words text-sm">{success}</p>}
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>提醒填写投入</DialogTitle>
          <DialogDescription>仅提醒本会议参会人员。默认选择未填写者，也可补选已填写者；通过站内通知和普通通知机器人发送。</DialogDescription>
        </DialogHeader>
        {loading && <p role="status">正在加载参会人员…</p>}
        {data && <fieldset disabled={sending || loading} className="min-w-0 space-y-3">
          <p className="break-words [overflow-wrap:anywhere]">会议：{data.topic}</p>
          <p>工作区间：{formatDateTime(data.rangeStart)} 至 {formatDateTime(data.rangeEnd)}（北京时间）</p>
          <p>未填写 {missing.length} 人，已选 {selected.length} 人</p>
          {missing.length === 0 && <p role="status">所有参会人员在该区间均已有投入记录，可手动选择需要补充投入的人员。</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setSelected(missing.filter((person) => person.eligible).map((person) => person.id))}>选择未填写人员</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])}>清空</Button>
          </div>
          <div className="max-h-60 space-y-2 overflow-y-auto">
            {data.participants.map((person) => <label key={person.id} className="flex items-start gap-2 break-words text-sm [overflow-wrap:anywhere]">
              <input type="checkbox" className="mt-1 shrink-0" disabled={!person.eligible} checked={selected.includes(person.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))} />
              <span className="min-w-0">{person.displayName}{person.missing ? "（未填写）" : "（已填写）"}{!person.eligible && "（已停用或未绑定账号，不可发送）"}</span>
            </label>)}
          </div>
        </fieldset>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {!loading && !data && <Button type="button" variant="outline" onClick={() => void load()}>重新加载</Button>}
          <Button type="button" variant="outline" disabled={sending} onClick={() => changeOpen(false)}>取消</Button>
          <Button type="button" disabled={loading || sending || !data || selected.length === 0} onClick={() => void submit()}>{sending ? "正在提交…" : "发送提醒"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
