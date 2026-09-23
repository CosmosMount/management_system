"use client";

import { useMemo, useRef, useState } from "react";
import {
  listMeetingMissingPeopleAction,
  urgeMeetingWorkSegmentsAction,
} from "@/app/actions/project-management/meetings";
import { ReminderDialog } from "@/components/project-management/reminder-dialog";
import {
  ReminderRecipientPicker,
  REMINDER_RECIPIENT_LIMIT,
  type ReminderRecipientOption,
} from "@/components/project-management/reminder-recipient-picker";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/project-management/labels";

type ReminderData = Extract<
  Awaited<ReturnType<typeof listMeetingMissingPeopleAction>>,
  { ok: true }
>["data"];

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

  const options = useMemo<ReminderRecipientOption[]>(
    () =>
      (data?.participants ?? []).map((person) => ({
        id: person.id,
        displayName: person.displayName,
        avatar: person.avatar,
        description: person.missing ? "未填写" : "已填写",
        disabled: !person.eligible,
        disabledReason: !person.eligible
          ? "已停用或未绑定账号，不可发送"
          : undefined,
      })),
    [data],
  );

  async function load() {
    const token = ++generation.current;
    setData(null);
    setSelected([]);
    setError("");
    setLoading(true);
    try {
      const result = await listMeetingMissingPeopleAction({ meetingId });
      if (generation.current !== token) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setData(result.data);
      setSelected(
        result.data.participants
          .filter((person) => person.missing && person.eligible)
          .slice(0, REMINDER_RECIPIENT_LIMIT)
          .map((person) => person.id),
      );
    } catch {
      if (generation.current === token) setError("未能加载参会人员，请重试");
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }

  function changeOpen(nextOpen: boolean) {
    if (pending.current) return;
    setOpen(nextOpen);
    if (nextOpen) {
      setSuccess("");
      void load();
    } else {
      generation.current += 1;
      setLoading(false);
    }
  }

  async function submit() {
    if (pending.current || !data || loading || !selected.length) return;
    pending.current = true;
    setSending(true);
    setError("");
    const key = JSON.stringify({
      meetingId,
      version: data.version,
      selected: [...selected].sort(),
    });
    if (request.current?.key !== key) {
      request.current = { id: crypto.randomUUID(), key };
    }
    try {
      const result = await urgeMeetingWorkSegmentsAction({
        meetingId,
        expectedVersion: data.version,
        recipientPersonIds: selected,
        requestId: request.current.id,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      request.current = null;
      setSuccess(
        `已为 ${result.data.recipientCount} 人创建站内通知并提交飞书提醒队列；实际投递受身份绑定和投递保护限制。`,
      );
      setOpen(false);
    } catch {
      setError("发送结果暂时无法确认，请重试；同一请求不会重复发送。");
    } finally {
      pending.current = false;
      setSending(false);
    }
  }

  const missing = data?.participants.filter((person) => person.missing) ?? [];

  return (
    <div className="min-w-0 max-w-full">
      <Button type="button" variant="outline" onClick={() => changeOpen(true)}>
        提醒填写投入
      </Button>
      {success && (
        <p role="status" className="mt-2 max-w-lg break-words text-sm">
          {success}
        </p>
      )}
      <ReminderDialog
        open={open}
        onOpenChange={changeOpen}
        busy={sending}
        title="提醒填写投入"
        description="仅提醒本会议参会人员。默认选择未填写者，也可补选已填写者；通过站内通知和普通通知机器人发送。"
        error={error}
        footer={
          <>
            {!loading && !data && (
              <Button type="button" variant="outline" onClick={() => void load()}>
                重新加载
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() => changeOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={loading || sending || !data || selected.length === 0}
              onClick={() => void submit()}
            >
              {sending ? "正在提交…" : "发送提醒"}
            </Button>
          </>
        }
      >
        {loading && <p role="status">正在加载参会人员…</p>}
        {data && (
          <fieldset disabled={sending || loading} className="min-w-0 space-y-4">
            <div className="rounded-xl border border-primary/15 bg-primary/[0.04] p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                会议提醒范围
              </p>
              <p className="mt-1 break-words text-sm font-medium">{data.topic}</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {formatDateTime(data.rangeStart)} 至 {formatDateTime(data.rangeEnd)}（北京时间）
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">未填写 {missing.length} 人</span>
              <span className="text-muted-foreground">已选 {selected.length} 人</span>
            </div>
            {missing.length === 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                所有参会人员在该区间均已有投入记录，可手动选择需要补充投入的人员。
              </p>
            )}
            <div className="space-y-2">
              <label
                htmlFor={`meeting-reminder-recipients-${meetingId}`}
                className="text-sm font-medium"
              >
                提醒对象
              </label>
              <ReminderRecipientPicker
                inputId={`meeting-reminder-recipients-${meetingId}`}
                ariaLabel="会议投入提醒对象"
                options={options}
                value={selected}
                onValueChange={setSelected}
                scopeKey={`meeting-reminder:${meetingId}:${data.version}`}
                placeholder="搜索参会人姓名或拼音首字母"
                disabled={sending || loading}
              />
              <p className="text-xs text-muted-foreground">
                输入姓名或拼音首字母后点击候选项加入；已填写人员也可以补选。
              </p>
              {missing.filter((person) => person.eligible).length > REMINDER_RECIPIENT_LIMIT && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  未填写人员超过 {REMINDER_RECIPIENT_LIMIT} 人，已默认选择前 {REMINDER_RECIPIENT_LIMIT} 人；可移除后再添加其他人员。
                </p>
              )}
              {selected.length === 0 && (
                <p className="text-xs text-destructive">
                  至少选择一名参会人员才能发送提醒。
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setSelected(
                    missing
                      .filter((person) => person.eligible)
                      .slice(0, REMINDER_RECIPIENT_LIMIT)
                      .map((person) => person.id),
                  )
                }
              >
                选择未填写人员
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setSelected([])}
              >
                清空
              </Button>
            </div>
          </fieldset>
        )}
      </ReminderDialog>
    </div>
  );
}
