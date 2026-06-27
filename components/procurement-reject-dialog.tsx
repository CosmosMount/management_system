"use client";

import { useState } from "react";
import { Ban, RotateCcw } from "lucide-react";
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
import {
  procurementDialogContentClass,
  procurementDialogDescriptionClass,
  procurementDialogHeaderClass,
  procurementDialogTitleClass,
} from "@/components/procurement/procurement-dialog-styles";
import {
  procurementRejectOutcomeLabels,
  type ProcurementRejectOutcome,
  type ProcurementRejectStage,
} from "@/lib/procurement-reject-outcome";
import { cn } from "@/lib/utils";

type Props = {
  triggerLabel?: string;
  title: string;
  stage: ProcurementRejectStage;
  reasonLabel?: string;
  disabled?: boolean;
  onConfirm: (
    reason: string,
    outcome: ProcurementRejectOutcome,
  ) => Promise<void>;
};

export function ProcurementRejectDialog({
  triggerLabel = "驳回",
  title,
  stage,
  reasonLabel = "说明",
  disabled,
  onConfirm,
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<ProcurementRejectOutcome>("resubmit");
  const [loading, setLoading] = useState(false);
  const labels = procurementRejectOutcomeLabels(stage);

  async function handleConfirm() {
    if (!reason.trim()) return;
    setLoading(true);
    try {
      await onConfirm(reason.trim(), outcome);
      setReason("");
      setOutcome("resubmit");
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
            variant="outline"
            size="sm"
            disabled={disabled}
          >
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className={`${procurementDialogContentClass} sm:max-w-md`}>
        <DialogHeader className={procurementDialogHeaderClass}>
          <DialogTitle className={procurementDialogTitleClass}>{title}</DialogTitle>
          <DialogDescription className={procurementDialogDescriptionClass}>
            请选择驳回方式并填写说明，将通知采购人。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              Object.entries(labels) as [
                ProcurementRejectOutcome,
                (typeof labels)[ProcurementRejectOutcome],
              ][]
            ).map(([key, option]) => (
              <button
                key={key}
                type="button"
                className={cn(
                  "rounded-lg border p-3 text-left text-sm transition-colors",
                  outcome === key
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:bg-muted/50",
                )}
                onClick={() => setOutcome(key)}
              >
                <p className="flex items-center gap-1.5 font-medium">
                  {key === "resubmit" ? (
                    <RotateCcw className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <Ban className="h-3.5 w-3.5 text-destructive" />
                  )}
                  {option.title}
                </p>
                <p className="mt-1 text-muted-foreground">{option.description}</p>
              </button>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="procurement-reject-reason">{reasonLabel}</Label>
            <Textarea
              id="procurement-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请填写具体原因，将通知相关人员"
              rows={4}
            />
          </div>
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
            variant={outcome === "terminate" ? "destructive" : "default"}
            disabled={loading || !reason.trim()}
            onClick={handleConfirm}
          >
            {loading ? "提交中…" : labels[outcome].confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
