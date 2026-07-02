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
};

export function ProcurementNotifyApproverButton({
  orderId,
  currentHandler,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSend() {
    setLoading(true);
    try {
      await notifyProcurementApprover({ orderId, message });
      toast.success("已通知当前审批人");
      setOpen(false);
      setMessage("");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "通知失败"));
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
        通知审批人
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>通知当前审批人</DialogTitle>
            <DialogDescription>
              系统将通过飞书私信提醒当前环节处理人。
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
              {loading ? "发送中..." : "发送通知"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
