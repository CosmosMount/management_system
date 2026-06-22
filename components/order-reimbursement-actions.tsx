"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmReimbursement } from "@/app/actions/confirmReimbursement";
import { uploadApplicantDocs } from "@/app/actions/uploadApplicantDocs";
import { uploadFinanceScreenshot } from "@/app/actions/uploadFinanceScreenshot";
import { InlineAttachments } from "@/components/order-attachments";
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
import type { OrderStatus } from "@prisma/client";
import type { OrderAttachmentGroups } from "@/lib/order-attachments";
import {
  canConfirmReimbursement,
  canUploadApplicantDocs,
  canUploadFinanceScreenshot,
  type OrderScope,
  type UserRoleRecord,
} from "@/lib/permissions-client";

type Props = {
  orderId: string;
  totalPrice: number;
  status: OrderStatus;
  orderScope: OrderScope;
  userRoles: UserRoleRecord[];
  userOpenId?: string;
  initiatorOpenId: string;
  attachments: OrderAttachmentGroups;
  canViewAttachments: boolean;
};

export function OrderReimbursementActions({
  orderId,
  totalPrice,
  status,
  orderScope,
  userRoles,
  userOpenId,
  initiatorOpenId,
  attachments,
  canViewAttachments,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const showApplicant = canUploadApplicantDocs(
    status,
    userOpenId,
    initiatorOpenId,
  );
  const showFinance = canUploadFinanceScreenshot(
    status,
    userRoles,
    orderScope,
  );
  const showConfirm = canConfirmReimbursement(
    status,
    userOpenId,
    initiatorOpenId,
  );

  if (!showApplicant && !showFinance && !showConfirm) return null;

  async function handleConfirm() {
    setLoading(true);
    try {
      await confirmReimbursement(orderId);
      toast.success("已确认，报销流程完成");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {showApplicant && (
        <ApplicantDocsDialog
          orderId={orderId}
          totalPrice={totalPrice}
          loading={loading}
          setLoading={setLoading}
          onDone={() => router.refresh()}
        />
      )}
      {showFinance && (
        <FinanceScreenshotDialog
          orderId={orderId}
          attachments={attachments}
          canViewAttachments={canViewAttachments}
          loading={loading}
          setLoading={setLoading}
          onDone={() => router.refresh()}
        />
      )}
      {showConfirm && (
        <Button size="sm" disabled={loading} onClick={handleConfirm}>
          确认报销
        </Button>
      )}
    </div>
  );
}

function ApplicantDocsDialog({
  orderId,
  totalPrice,
  loading,
  setLoading,
  onDone,
}: {
  orderId: string;
  totalPrice: number;
  loading: boolean;
  setLoading: (v: boolean) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(totalPrice);

  async function handleSubmit() {
    const form = document.getElementById(
      `applicant-docs-${orderId}`,
    ) as HTMLFormElement | null;
    if (!form) return;

    setLoading(true);
    try {
      const formData = new FormData(form);
      formData.set("orderId", orderId);
      formData.set("totalPrice", String(price));
      await uploadApplicantDocs(formData);
      toast.success("凭证已提交，已通知报销员");
      setOpen(false);
      onDone();
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
            上传凭证
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>上传报销凭证</DialogTitle>
          <DialogDescription>
            可上传多张发票（每张不超过 20MB）与一份 Word 清单，提交后由报销员处理
          </DialogDescription>
        </DialogHeader>
        <form id={`applicant-docs-${orderId}`} className="space-y-4">
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
            <Label htmlFor={`invoices-${orderId}`}>发票（可多选）</Label>
            <Input
              id={`invoices-${orderId}`}
              name="invoices"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              multiple
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`list-${orderId}`}>Word 清单</Label>
            <Input
              id={`list-${orderId}`}
              name="listDoc"
              type="file"
              accept=".doc,.docx,.pdf"
              required
            />
          </div>
          <Button type="button" disabled={loading} onClick={handleSubmit}>
            提交给报销员
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FinanceScreenshotDialog({
  orderId,
  attachments,
  canViewAttachments,
  loading,
  setLoading,
  onDone,
}: {
  orderId: string;
  attachments: OrderAttachmentGroups;
  canViewAttachments: boolean;
  loading: boolean;
  setLoading: (v: boolean) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);

  async function handleSubmit() {
    const form = document.getElementById(
      `finance-shot-${orderId}`,
    ) as HTMLFormElement | null;
    if (!form) return;

    setLoading(true);
    try {
      const formData = new FormData(form);
      formData.set("orderId", orderId);
      await uploadFinanceScreenshot(formData);
      toast.success("截图已上传，已通知采购人确认");
      setOpen(false);
      onDone();
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
            上传截图
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>报销截图</DialogTitle>
          <DialogDescription>
            请先查看采购人上传的发票与清单，再上传报销系统截图
          </DialogDescription>
        </DialogHeader>
        {canViewAttachments && (
          <InlineAttachments groups={attachments} />
        )}
        <form id={`finance-shot-${orderId}`} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`screenshot-${orderId}`}>报销截图</Label>
            <Input
              id={`screenshot-${orderId}`}
              name="screenshot"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              required
            />
          </div>
          <Button type="button" disabled={loading} onClick={handleSubmit}>
            提交
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
