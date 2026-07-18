"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { withdrawProgressApproval } from "@/app/actions/progress/withdrawApproval";
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
import type { ProgressApprovalReference } from "@/lib/progress-approval-domain";

type Props = {
  reference: ProgressApprovalReference;
  subject?: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
};

export function WithdrawProgressApprovalButton({
  reference,
  subject,
  disabled = false,
  compact = false,
  className,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  async function handleWithdraw() {
    setWithdrawing(true);
    try {
      await withdrawProgressApproval(reference);
      toast.success("审批申请已撤回");
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "撤回审批失败"));
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={compact ? "sm" : "default"}
        className={className}
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid="withdraw-progress-approval"
      >
        <RotateCcw />
        撤回审批
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认撤回审批申请</DialogTitle>
            <DialogDescription>
              撤回后，本次提交将不再进入审批流程。
              {subject ? `当前审批：${subject}。` : ""}
              如仍需审批，请修改后重新提交。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={withdrawing}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={withdrawing}
              onClick={handleWithdraw}
            >
              <RotateCcw />
              {withdrawing ? "撤回中..." : "确认撤回"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
