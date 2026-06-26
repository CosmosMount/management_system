"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  triggerLabel: string;
  title: string;
  description: string;
  reasonLabel: string;
  confirmLabel: string;
  variant?: "default" | "destructive" | "outline" | "secondary";
  disabled?: boolean;
  triggerClassName?: string;
  triggerSize?: "default" | "sm";
  onConfirm: (reason: string) => Promise<void>;
};

export function ReasonConfirmDialog({
  triggerLabel,
  title,
  description,
  reasonLabel,
  confirmLabel,
  variant = "destructive",
  disabled,
  triggerClassName,
  triggerSize = "sm",
  onConfirm,
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    if (!reason.trim()) return;
    setLoading(true);
    try {
      await onConfirm(reason.trim());
      setReason("");
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant={variant}
            size={triggerSize}
            className={triggerClassName}
            disabled={disabled}
          >
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">{reasonLabel}</Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="请填写具体原因，将通知相关人员"
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            type="button"
            variant={variant === "destructive" ? "destructive" : "default"}
            disabled={loading || !reason.trim()}
            onClick={handleConfirm}
          >
            {loading ? "提交中…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
