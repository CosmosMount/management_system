"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmReimbursement } from "@/app/actions/confirmReimbursement";
import {
  previewReimbursementListDoc,
  uploadApplicantDocs,
} from "@/app/actions/uploadApplicantDocs";
import { rejectProcurementOrder } from "@/app/actions/rejectOrder";
import { uploadFinanceScreenshot } from "@/app/actions/uploadFinanceScreenshot";
import { InlineAttachments } from "@/components/order-attachments";
import { OrderRejectionNotice } from "@/components/procurement/order-rejection-notice";
import { ProcurementRejectDialog } from "@/components/procurement-reject-dialog";
import {
  procurementDialogContentClass,
  procurementDialogDescriptionClass,
  procurementDialogHeaderClass,
  procurementDialogTitleClass,
} from "@/components/procurement/procurement-dialog-styles";
import {
  PurchaseLineConfirm,
  type ConfirmedLineItem,
  type PurchaseLineItem,
} from "@/components/purchase-line-confirm";
import {
  IMAGE_UPLOAD_ACCEPT,
  INVOICE_UPLOAD_ACCEPT,
} from "@/lib/upload-accept";
import { shouldShowProcurementRejectionNotice } from "@/lib/procurement-rejection";
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
  canRequestApplicantResubmit,
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
  rejectionReason?: string | null;
  orderStatus?: OrderStatus;
  rejectedByName?: string | null;
  rejectedAt?: Date | null;
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
  rejectionReason,
  orderStatus,
  rejectedByName,
  rejectedAt,
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
  const showFinanceResubmit = canRequestApplicantResubmit(
    status,
    userRoles,
    orderScope,
  );
  const showConfirm = canConfirmReimbursement(
    status,
    userOpenId,
    initiatorOpenId,
  );

  if (!showApplicant && !showFinance && !showFinanceResubmit && !showConfirm) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {showApplicant && (
        <div id="upload">
          <ApplicantDocsDialog
            orderId={orderId}
            items={items}
            loading={loading}
            setLoading={setLoading}
            onDone={() => router.refresh()}
            rejectionReason={rejectionReason}
            orderStatus={orderStatus}
            rejectedByName={rejectedByName}
            rejectedAt={rejectedAt}
          />
        </div>
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
      {showFinanceResubmit && (
        <ProcurementRejectDialog
          stage="finance"
          title="驳回报销资料"
          reasonLabel="说明"
          disabled={loading}
          onConfirm={async (reason, outcome) => {
            setLoading(true);
            try {
              await rejectProcurementOrder({ orderId, reason, outcome });
              toast.success(
                outcome === "terminate"
                  ? "已终止报销流程"
                  : "已通知采购人重新提交资料",
              );
              router.refresh();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "操作失败");
              throw err;
            } finally {
              setLoading(false);
            }
          }}
        />
      )}
      {showConfirm && (
        <div id="confirm">
          <ConfirmReimbursementDialog
          orderId={orderId}
          items={items}
          loading={loading}
          setLoading={setLoading}
          onDone={() => router.refresh()}
        />
        </div>
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
  rejectionReason,
  orderStatus,
  rejectedByName,
  rejectedAt,
}: {
  orderId: string;
  items: PurchaseLineItem[];
  loading: boolean;
  setLoading: (v: boolean) => void;
  onDone: () => void;
  rejectionReason?: string | null;
  orderStatus?: OrderStatus;
  rejectedByName?: string | null;
  rejectedAt?: Date | null;
}) {
  const [open, setOpen] = useState(false);
  const [confirmedItems, setConfirmedItems] = useState<ConfirmedLineItem[]>(
    [],
  );

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setConfirmedItems(
      items.map((item) => ({
        id: item.id,
        lineTotal: Math.round(item.quantity * item.unitPrice * 100) / 100,
      })),
    );
  }

  async function handleSubmit() {
    const form = document.getElementById(
      `applicant-docs-${orderId}`,
    ) as HTMLFormElement | null;
    if (!form) return;

    if (confirmedItems.length === 0) {
      toast.error("请确认采购明细价格");
      return;
    }

    const invoiceInput = form.querySelector(
      'input[name="invoices"]',
    ) as HTMLInputElement | null;
    if (!invoiceInput?.files?.length) {
      toast.error("请至少上传一张发票");
      return;
    }

    for (const item of items) {
      const photoInput = form.querySelector(
        `input[name="photo-${item.id}"]`,
      ) as HTMLInputElement | null;
      if (!photoInput?.files?.length) {
        toast.error(`请为「${item.name}」上传实物照片`);
        return;
      }
    }

    setLoading(true);
    try {
      const formData = new FormData(form);
      formData.set("orderId", orderId);
      formData.set("confirmedItems", JSON.stringify(confirmedItems));
      await uploadApplicantDocs(formData);
      toast.success("凭证已提交，验收清单已自动生成");
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  async function handlePreview() {
    if (confirmedItems.length === 0) {
      toast.error("请先确认采购明细价格");
      return;
    }
    setLoading(true);
    try {
      const result = await previewReimbursementListDoc({
        orderId,
        confirmedItems,
      });
      const blob = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(
        new Blob([blob], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("预览文件已下载（不含照片，提交后将嵌入照片）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "生成失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="secondary">
            上传凭证
          </Button>
        }
      />
      <DialogContent className={procurementDialogContentClass}>
        <DialogHeader className={procurementDialogHeaderClass}>
          <DialogTitle className={procurementDialogTitleClass}>
            上传报销凭证
          </DialogTitle>
          <DialogDescription className={procurementDialogDescriptionClass}>
            核对采购明细价格，为每行上传实物照片；系统将按学校模板自动生成 Word 验收清单
          </DialogDescription>
        </DialogHeader>
        <form id={`applicant-docs-${orderId}`} className="space-y-3">
          {orderStatus &&
          shouldShowProcurementRejectionNotice(orderStatus, rejectionReason) ? (
            <OrderRejectionNotice
              variant="inline"
              reason={rejectionReason!}
              status={orderStatus}
              rejectedByName={rejectedByName}
              rejectedAt={rejectedAt}
            />
          ) : null}
          <PurchaseLineConfirm
            items={items}
            editable
            showPhotoUpload
            onChange={setConfirmedItems}
          />
          <div className="space-y-2">
            <Label htmlFor={`invoices-${orderId}`}>发票（可多选）</Label>
            <Input
              id={`invoices-${orderId}`}
              name="invoices"
              type="file"
              accept={INVOICE_UPLOAD_ACCEPT}
              multiple
              required
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={loading} onClick={handlePreview}>
              预览清单（不含照片）
            </Button>
            <Button type="button" disabled={loading} onClick={handleSubmit}>
              提交给报销员
            </Button>
          </div>
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
      <DialogContent className={procurementDialogContentClass}>
        <DialogHeader className={procurementDialogHeaderClass}>
          <DialogTitle className={procurementDialogTitleClass}>
            确认报销
          </DialogTitle>
          <DialogDescription className={procurementDialogDescriptionClass}>
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
      <DialogContent className={procurementDialogContentClass}>
        <DialogHeader className={procurementDialogHeaderClass}>
          <DialogTitle className={procurementDialogTitleClass}>
            报销截图
          </DialogTitle>
          <DialogDescription className={procurementDialogDescriptionClass}>
            请先查看采购人上传的发票与清单，再上传报销截图或文件（图片/PDF）
          </DialogDescription>
        </DialogHeader>
        {canViewAttachments && (
          <InlineAttachments groups={attachments} />
        )}
        <form id={`finance-shot-${orderId}`} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={`screenshot-${orderId}`}>报销截图或文件</Label>
            <Input
              id={`screenshot-${orderId}`}
              name="screenshot"
              type="file"
              accept={`${INVOICE_UPLOAD_ACCEPT},${IMAGE_UPLOAD_ACCEPT}`}
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
