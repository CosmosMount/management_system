"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  urgeApproval,
  loadApprovalUrgeTargetsAction,
} from "@/app/actions/project-management/tasks";
import { ReminderDialog } from "@/components/project-management/reminder-dialog";
import {
  ReminderRecipientPicker,
  REMINDER_RECIPIENT_LIMIT,
  type ReminderRecipientOption,
} from "@/components/project-management/reminder-recipient-picker";
import { Button } from "@/components/ui/button";

type ApprovalTarget = Extract<
  Awaited<ReturnType<typeof loadApprovalUrgeTargetsAction>>,
  { ok: true }
>["data"][number];

export function ApprovalUrgeButton({
  kind,
  approvalId,
  disabled,
}: {
  kind: "MILESTONE_REVIEW" | "REVISION" | "TERMINATION_REVIEW";
  approvalId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<ApprovalTarget[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadGeneration = useRef(0);
  const request = useRef<{ id: string; key: string } | null>(null);

  const options = useMemo<ReminderRecipientOption[]>(
    () =>
      targets.map((target) => ({
        id: target.accountId,
        displayName: target.displayName,
        avatar: target.avatar,
        description: "审批管理员",
      })),
    [targets],
  );

  async function openDialog() {
    if (loading || busy) return;
    const generation = ++loadGeneration.current;
    setOpen(true);
    setError("");
    setTargets([]);
    setSelected([]);
    request.current = null;
    setLoading(true);
    try {
      const result = await loadApprovalUrgeTargetsAction();
      if (loadGeneration.current !== generation) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setTargets(result.data);
      setSelected(
        result.data
          .slice(0, REMINDER_RECIPIENT_LIMIT)
          .map((target) => target.accountId),
      );
    } catch {
      if (loadGeneration.current === generation) {
        setError("未能加载审批人，请重试");
      }
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }

  function changeOpen(nextOpen: boolean) {
    if (busy) return;
    if (!nextOpen) {
      loadGeneration.current += 1;
      setLoading(false);
    }
    setOpen(nextOpen);
  }

  function closeAfterSuccess() {
    loadGeneration.current += 1;
    setOpen(false);
  }

  async function submit() {
    if (loading || busy) return;
    if (selected.length === 0) {
      setError("至少选择一名审批人");
      return;
    }
    setBusy(true);
    setError("");
    const key = JSON.stringify({
      kind,
      approvalId,
      recipientAccountIds: [...selected].sort(),
    });
    if (request.current?.key !== key) {
      request.current = { id: crypto.randomUUID(), key };
    }
    try {
      const result = await urgeApproval({
        kind,
        approvalId,
        recipientAccountIds: selected,
        requestId: request.current.id,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      request.current = null;
      closeAfterSuccess();
      router.refresh();
    } catch {
      setError("暂时无法确认催促结果，请重试；同一请求不会重复发送。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy || loading}
        onClick={() => void openDialog()}
      >
        {loading ? "加载审批人…" : "催促审批"}
      </Button>
      <ReminderDialog
        open={open}
        onOpenChange={changeOpen}
        busy={busy}
        title="催促审批"
        description="选择需要收到本次提醒的当前有效审批管理员。默认已选中全部人员（最多 50 人），可搜索姓名后添加或移除。"
        error={error}
        footer={
          <>
            {!loading && error && targets.length === 0 && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void openDialog()}
              >
                重新加载
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => changeOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={loading || busy || selected.length === 0}
              onClick={() => void submit()}
            >
              {busy ? "正在提交…" : "发送催促"}
            </Button>
          </>
        }
      >
        {loading && <p role="status">正在加载审批人…</p>}
        {!loading && (
          <div className="space-y-4">
            <div className="rounded-xl border border-primary/15 bg-primary/[0.04] p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                当前提醒范围
              </p>
              <p className="mt-1 break-words text-sm font-medium">
                当前待审批事项 · 已选 {selected.length} 人
              </p>
            </div>
            <div className="space-y-2">
              <label
                htmlFor={`approval-urge-recipients-${approvalId}`}
                className="text-sm font-medium"
              >
                提醒对象
              </label>
              <ReminderRecipientPicker
                inputId={`approval-urge-recipients-${approvalId}`}
                ariaLabel="审批催促提醒对象"
                options={options}
                value={selected}
                onValueChange={setSelected}
                scopeKey={`approval-urge:${approvalId}:${options
                  .map((option) => option.id)
                  .join(",")}`}
                placeholder="搜索审批人姓名或拼音首字母"
                disabled={busy}
              />
              {options.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  当前没有可提醒的审批管理员。
                </p>
              )}
              {options.length > REMINDER_RECIPIENT_LIMIT && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  当前共有 {options.length} 名审批管理员，已默认选择前 {REMINDER_RECIPIENT_LIMIT} 人；可移除后再添加其他人员。
                </p>
              )}
              {selected.length === 0 && options.length > 0 && (
                <p className="text-xs text-destructive">
                  至少选择一名审批人才能发送催促。
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                可直接输入姓名或拼音首字母，点击候选项加入提醒名单。
              </p>
            </div>
          </div>
        )}
      </ReminderDialog>
    </>
  );
}
