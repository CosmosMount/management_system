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
import { AttachmentFileLink } from "@/components/attachment-file-link";
import { OrderRejectionNotice } from "@/components/procurement/order-rejection-notice";
import { ProcurementRejectDialog } from "@/components/procurement-reject-dialog";
import {
  procurementDialogContentClass,
  procurementDialogDescriptionClass,
  procurementDialogHeaderClass,
  procurementDialogTitleClass,
  procurementVoucherDialogContentClass,
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
  canSupplementApplicantDocs,
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
  const showSupplement = canSupplementApplicantDocs(
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

  if (
    !showApplicant &&
    !showSupplement &&
    !showFinance &&
    !showFinanceResubmit &&
    !showConfirm
  ) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {(showApplicant || showSupplement) && (
        <div id="upload">
          <ApplicantDocsDialog
            orderId={orderId}
            items={items}
            savedInvoices={attachments.invoices}
            mode={showApplicant ? "submit" : "supplement"}
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
  savedInvoices,
  mode,
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
  savedInvoices: string[];
  mode: "submit" | "supplement";
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
  const hasSavedDocs =
    savedInvoices.length > 0 || items.some((item) => item.photoPath);
  const isSupplement = mode === "supplement";
  const triggerLabel = isSupplement
    ? "修改凭证"
    : hasSavedDocs
      ? "修改凭证"
      : "上传凭证";
  const title = isSupplement
    ? "修改 / 补充报销凭证"
    : hasSavedDocs
      ? "修改报销凭证"
      : "上传报销凭证";
  const description = isSupplement
    ? "可增删整行、修改名称/规格/数量/价格，并补充发票；每项仅一张实物照片。不会重新走审批"
    : hasSavedDocs
      ? "可增删整行并修改物品条目；已有照片每项仅一张，选择新文件将替换"
      : "可增删整行，核对明细后为每行上传一张实物照片；系统将自动生成 Word 验收清单";
  const submitLabel = isSupplement ? "保存修改" : "提交给报销员";
  const successMessage = isSupplement
    ? "凭证已更新"
    : "凭证已提交，验收清单已自动生成";

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setConfirmedItems(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        spec: item.spec,
        quantity: item.quantity,
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
      toast.error("请至少保留一行采购明细");
      return;
    }

    for (const item of confirmedItems) {
      if (!item.name.trim()) {
        toast.error("物品名称不能为空");
        return;
      }
      if (!item.spec.trim()) {
        toast.error(`「${item.name || "未命名物品"}」规格不能为空`);
        return;
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        toast.error(`「${item.name}」数量至少为 1`);
        return;
      }
    }

    const invoiceInput = form.querySelector(
      'input[name="invoices"]',
    ) as HTMLInputElement | null;
    const hasNewInvoices = (invoiceInput?.files?.length ?? 0) > 0;
    if (!hasNewInvoices && savedInvoices.length === 0) {
      toast.error("请至少上传一张发票");
      return;
    }

    const existingById = new Map(items.map((item) => [item.id, item]));
    for (const item of confirmedItems) {
      const existing = existingById.get(item.id);
      const photoInput = form.querySelector(
        `input[name="photo-${item.id}"]`,
      ) as HTMLInputElement | null;
      const hasNewPhoto = (photoInput?.files?.length ?? 0) > 0;
      if (!hasNewPhoto && !existing?.photoPath) {
        toast.error(`请为「${item.name}」上传一张实物照片`);
        return;
      }
    }

    setLoading(true);
    try {
      const formData = new FormData(form);
      formData.set("orderId", orderId);
      formData.set("confirmedItems", JSON.stringify(confirmedItems));
      await uploadApplicantDocs(formData);
      toast.success(successMessage);
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
      toast.error("请先确认采购明细");
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
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className={procurementVoucherDialogContentClass}>
        <DialogHeader className={procurementDialogHeaderClass}>
          <DialogTitle className={procurementDialogTitleClass}>
            {title}
          </DialogTitle>
          <DialogDescription className={procurementDialogDescriptionClass}>
            {description}
          </DialogDescription>
        </DialogHeader>
        <form id={`applicant-docs-${orderId}`} className="w-fit max-w-full space-y-3">
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
            allowRowEdit
            onChange={setConfirmedItems}
          />
          <div className="space-y-2">
            <Label htmlFor={`invoices-${orderId}`}>
              发票（可多选
              {savedInvoices.length > 0
                ? isSupplement
                  ? "，新增将追加到已上传发票后"
                  : "，不选则保留已上传"
                : ""}
              ）
            </Label>
            {savedInvoices.length > 0 ? (
              <ul className="space-y-1 rounded-md border bg-muted/30 p-2">
                {savedInvoices.map((filePath) => (
                  <li key={filePath}>
                    <AttachmentFileLink filePath={filePath} />
                  </li>
                ))}
              </ul>
            ) : null}
            <Input
              id={`invoices-${orderId}`}
              name="invoices"
              type="file"
              accept={INVOICE_UPLOAD_ACCEPT}
              multiple
              required={savedInvoices.length === 0}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={loading} onClick={handlePreview}>
              预览清单（不含照片）
            </Button>
            <Button type="button" disabled={loading} onClick={handleSubmit}>
              {submitLabel}
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
