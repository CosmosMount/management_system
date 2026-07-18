"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { notifyProcurementApprover } from "@/app/actions/notifyProcurementApprover";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { getActionErrorMessage } from "@/lib/action-error-message";

type Props = {
  orderId: string;
  currentHandler?: string;
  /** 待上传凭证：催促采购人；其他环节：催促审批人 */
  targetLabel?: "approver" | "applicant";
};

export function ProcurementNotifyApproverButton({
  orderId,
  currentHandler,
  targetLabel = "approver",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const isApplicant = targetLabel === "applicant";

  async function handleSend() {
    setLoading(true);
    try {
      const result = await notifyProcurementApprover({ orderId, message });
      if (result.ok) {
        toast.success(result.message);
        setOpen(false);
        setMessage("");
        router.refresh();
        return;
      }
      toast.message(result.message);
    } catch (err) {
      toast.error(getActionErrorMessage(err, "催促失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <BellRing className="h-4 w-4" />
        催促
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isApplicant ? "催促采购人上传凭证" : "催促当前审批人"}
            </DialogTitle>
            <DialogDescription>
              {isApplicant
                ? "系统将通过飞书私信提醒采购人尽快上传报销凭证。"
                : "系统将通过飞书私信提醒当前环节处理人。"}
              {currentHandler ? `当前处理人：${currentHandler}` : ""}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="可选：补充本次催促说明"
            className="min-h-28"
            maxLength={500}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={loading} onClick={handleSend}>
              {loading ? "发送中..." : "发送催促"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
