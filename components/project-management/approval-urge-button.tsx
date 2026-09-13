"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { urgeApproval, loadApprovalUrgeTargetsAction } from "@/app/actions/project-management/tasks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ApprovalUrgeButton({ kind, approvalId, disabled }: { kind: "MILESTONE_REVIEW" | "REVISION" | "TERMINATION_REVIEW"; approvalId: string; disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Array<{ accountId: string; displayName: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function openDialog() {
    setError("");
    const result = await loadApprovalUrgeTargetsAction();
    if (!result.ok) { setError(result.error.message); return; }
    setTargets(result.data);
    setSelected(result.data.map((target) => target.accountId));
    setOpen(true);
  }
  async function submit() {
    if (selected.length === 0) { setError("至少选择一名审批人"); return; }
    setBusy(true); setError("");
    const result = await urgeApproval({ kind, approvalId, recipientAccountIds: selected, requestId: crypto.randomUUID() });
    if (!result.ok) setError(result.error.message);
    else { setOpen(false); router.refresh(); }
    setBusy(false);
  }
  return <>
    <Button type="button" variant="outline" disabled={disabled || busy} onClick={openDialog}>催促审批</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>催促审批</DialogTitle><DialogDescription>默认通知全部当前有效审批人，可取消部分目标。</DialogDescription></DialogHeader>
        <div className="space-y-2">
          {targets.map((target) => <label key={target.accountId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(target.accountId)} disabled={busy} onChange={() => setSelected((current) => current.includes(target.accountId) ? current.filter((id) => id !== target.accountId) : [...current, target.accountId])} />{target.displayName}</label>)}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button type="button" disabled={busy} onClick={submit}>{busy ? "正在提交…" : "发送催促"}</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
