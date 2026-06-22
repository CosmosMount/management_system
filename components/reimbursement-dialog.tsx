"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { uploadReimbursementFiles } from "@/app/actions/uploadReimbursementFiles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  orderId: string;
  totalPrice: number;
  canOperate: boolean;
};

export function ReimbursementDialog({
  orderId,
  totalPrice,
  canOperate,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [price, setPrice] = useState(totalPrice);

  if (!canOperate) return null;

  async function handleSubmit(complete: boolean) {
    const form = document.getElementById(
      `reimburse-form-${orderId}`,
    ) as HTMLFormElement | null;
    if (!form) return;

    setLoading(true);
    try {
      const formData = new FormData(form);
      formData.set("orderId", orderId);
      formData.set("totalPrice", String(price));
      formData.set("complete", String(complete));
      await uploadReimbursementFiles(formData);
      toast.success(complete ? "报销已完成" : "已保存报销信息");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="secondary">
            报销操作
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>报销操作</DialogTitle>
          <DialogDescription>
            上传发票与系统截图，可修改总价后完成报销
          </DialogDescription>
        </DialogHeader>
        <form id={`reimburse-form-${orderId}`} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`price-${orderId}`}>总价</Label>
            <Input
              id={`price-${orderId}`}
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(Number(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`invoice-${orderId}`}>发票文件</Label>
            <Input
              id={`invoice-${orderId}`}
              name="invoice"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`screenshot-${orderId}`}>系统截图</Label>
            <Input
              id={`screenshot-${orderId}`}
              name="screenshot"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => handleSubmit(false)}
            >
              保存
            </Button>
            <Button
              type="button"
              disabled={loading}
              onClick={() => handleSubmit(true)}
            >
              完成报销
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
