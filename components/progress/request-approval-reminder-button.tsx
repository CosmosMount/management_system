"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Send } from "lucide-react";
import { toast } from "sonner";
import {
  getProgressApprovalReminderCandidates,
  requestProgressApprovalReminder,
} from "@/app/actions/progress/approvalReminders";
import { UserMultiSearchSelect } from "@/components/user-search-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getActionErrorMessage } from "@/lib/action-error-message";
import type {
  ProgressApprovalCandidate,
  ProgressApprovalReference,
} from "@/lib/progress-approval-domain";

type Props = {
  reference: ProgressApprovalReference;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  subject?: string;
};

export function RequestApprovalReminderButton({
  reference,
  disabled = false,
  compact = false,
  className,
  subject,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [sending, setSending] = useState(false);
  const [candidates, setCandidates] = useState<ProgressApprovalCandidate[]>([]);
  const [recipientOpenIds, setRecipientOpenIds] = useState<string[]>([]);

  async function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setRecipientOpenIds([]);
      return;
    }

    setRecipientOpenIds([]);
    setLoadingCandidates(true);
    try {
      const result = await getProgressApprovalReminderCandidates(reference);
      setCandidates(result);
    } catch (error) {
      setOpen(false);
      toast.error(getActionErrorMessage(error, "加载可选审批人失败"));
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function handleSend() {
    if (recipientOpenIds.length === 0) {
      toast.error("请至少选择一位审批人");
      return;
    }

    setSending(true);
    try {
      const result = await requestProgressApprovalReminder({
        reference,
        recipientOpenIds,
      });
      const skippedCount = result.skippedCount ?? 0;
      toast.success(
        skippedCount > 0
          ? `已提醒 ${result.sentCount} 人，另有 ${skippedCount} 人仍在提醒间隔内`
          : `已向 ${result.sentCount} 位审批人发送提醒`,
      );
      setOpen(false);
      setRecipientOpenIds([]);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "请求审批失败"));
    } finally {
      setSending(false);
    }
  }

  const users = candidates.map((candidate) => {
    const roleText = candidate.identityLabels.join("、");
    return {
      openId: candidate.openId,
      name: roleText ? `${candidate.name}（${roleText}）` : candidate.name,
      avatar: candidate.avatar,
    };
  });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={compact ? "sm" : "default"}
        className={className}
        disabled={disabled}
        onClick={() => void handleOpenChange(true)}
        data-testid="request-progress-approval-reminder"
      >
        <BellRing />
        请求审批
      </Button>
      <Dialog open={open} onOpenChange={(value) => void handleOpenChange(value)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>请求审批</DialogTitle>
            <DialogDescription>
              选择需要提醒的审批人，系统将向他们发送飞书消息。
              {subject ? `当前审批：${subject}` : ""}
            </DialogDescription>
          </DialogHeader>

          {loadingCandidates ? (
            <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
              正在加载可选审批人...
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              当前没有可提醒的审批人
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">审批人</p>
              <UserMultiSearchSelect
                users={users}
                value={recipientOpenIds}
                onChange={setRecipientOpenIds}
                disabled={sending}
                placeholder="搜索并选择审批人"
                inputProps={{ "aria-describedby": "approval-reminder-help" }}
              />
              <p id="approval-reminder-help" className="text-xs text-muted-foreground">
                仅显示当前有权限处理这项审批的人员，默认不选择任何人。
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() => void handleOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={
                sending || loadingCandidates || recipientOpenIds.length === 0
              }
              onClick={handleSend}
            >
              <Send />
              {sending ? "发送中..." : "发送提醒"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
