"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { sendManualProgressReminder } from "@/app/actions/progress/reminders";
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
  targetType: "PROJECT" | "TASK";
  targetId: string;
  label?: string;
};

export function ManualReminderButton({
  targetType,
  targetId,
  label = "催促",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSend() {
    setLoading(true);
    try {
      await sendManualProgressReminder({
        targetType,
        targetId,
        message,
      });
      toast.success("催促提醒已入队发送");
      setOpen(false);
      setMessage("");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "发送催促失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <BellRing className="h-4 w-4" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              系统会自动生成当前进度摘要，并发送给责任人与相关管理角色。
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
              {loading ? "发送中..." : "发送提醒"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
