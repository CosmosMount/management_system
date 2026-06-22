"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmReimbursement } from "@/app/actions/confirmReimbursement";
import { uploadApplicantDocs } from "@/app/actions/uploadApplicantDocs";
import { uploadFinanceScreenshot } from "@/app/actions/uploadFinanceScreenshot";
import { InlineAttachments } from "@/components/order-attachments";
import {
  PurchaseLineConfirm,
  type ConfirmedLineItem,
  type PurchaseLineItem,
} from "@/components/purchase-line-confirm";
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
  items: PurchaseLineItem[];
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
  items,
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

  return (
    <div className="flex flex-wrap gap-2">
      {showApplicant && (
        <ApplicantDocsDialog
          orderId={orderId}
          items={items}
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
        <ConfirmReimbursementDialog
          orderId={orderId}
          items={items}
          loading={loading}
          setLoading={setLoading}
          onDone={() => router.refresh()}
        />
      )}
    </div>
  );
}

function ApplicantDocsDialog({
  orderId,
  items,
  loading,
  setLoading,
  onDone,
}: {
  orderId: string;
  items: PurchaseLineItem[];
  loading: boolean;
  setLoading: (v: boolean) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmedItems, setConfirmedItems] = useState<ConfirmedLineItem[]>(
    [],
  );

  useEffect(() => {
    if (open) {
      setConfirmedItems(
        items.map((item) => ({
          id: item.id,
          lineTotal:
            Math.round(item.quantity * item.unitPrice * 100) / 100,
        })),
      );
    }
  }, [open, items]);

  async function handleSubmit() {
    const form = document.getElementById(
      `applicant-docs-${orderId}`,
    ) as HTMLFormElement | null;
    if (!form) return;

    if (confirmedItems.length === 0) {
      toast.error("请确认采购明细价格");
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData(form);
      formData.set("orderId", orderId);
      formData.set("confirmedItems", JSON.stringify(confirmedItems));
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>上传报销凭证</DialogTitle>
          <DialogDescription>
            请核对采购明细价格后上传发票与 Word 清单
          </DialogDescription>
        </DialogHeader>
        <form id={`applicant-docs-${orderId}`} className="space-y-4">
          <PurchaseLineConfirm
            items={items}
            editable
            onChange={setConfirmedItems}
          />
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

function ConfirmReimbursementDialog({
  orderId,
  items,
  loading,
  setLoading,
  onDone,
}: {
  orderId: string;
  items: PurchaseLineItem[];
  loading: boolean;
  setLoading: (v: boolean) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await confirmReimbursement(orderId);
      toast.success("已确认，报销流程完成");
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
        render={<Button size="sm">确认报销</Button>}
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>确认报销</DialogTitle>
          <DialogDescription>
            请核对以下采购明细价格，确认无误后完成报销
          </DialogDescription>
        </DialogHeader>
        <PurchaseLineConfirm items={items} />
        <Button disabled={loading} onClick={handleConfirm}>
          确认无误，完成报销
        </Button>
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
