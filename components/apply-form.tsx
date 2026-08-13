"use client";

import {
  useFieldArray,
  useForm,
  useWatch,
  type Resolver,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createOrder } from "@/app/actions/createOrder";
import { updateOrder } from "@/app/actions/updateOrder";
import { ProcurementItemsImportDialog } from "@/components/procurement-items-import-dialog";
import { ApplyFormBasics } from "@/components/procurement/apply-form-basics";
import { ApplyFormItems } from "@/components/procurement/apply-form-items";
import {
  buildOrderFormData,
  defaultPurchaseItem,
  type ApplyFormValues,
  type ItemImageErrors,
  type ItemImageFiles,
  type OrderFormPayload,
} from "@/components/procurement/apply-form-contract";
import { SignatureRequiredDialog } from "@/components/signature-required-dialog";
import { Button } from "@/components/ui/button";
import { getActionErrorMessage } from "@/lib/action-error-message";
import {
  itemKindNeedsImage,
  itemKindNeedsLink,
  type PurchaseItemKind,
} from "@/lib/purchase-item-kind";
import { useProcessingVendors } from "@/components/use-processing-vendors";
import { routes } from "@/lib/routes";
import {
  createOrderSchema,
  type CreateOrderInput,
  type PurchaseItemInput,
} from "@/lib/validations/order";

type Props = {
  orderId?: string;
  expectedUpdatedAt?: string;
  initialValues?: Omit<CreateOrderInput, "submit">;
  hasSignature?: boolean;
};

export function ApplyForm({
  orderId,
  expectedUpdatedAt,
  initialValues,
  hasSignature = true,
}: Props = {}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [signatureDialogOpen, setSignatureDialogOpen] = useState(false);
  const [itemImageFiles, setItemImageFiles] = useState<ItemImageFiles>({});
  const [itemImageErrors, setItemImageErrors] = useState<ItemImageErrors>({});
  const editing = !!orderId;
  const processingVendors = useProcessingVendors();

  const form = useForm<ApplyFormValues>({
    resolver: zodResolver(createOrderSchema) as Resolver<ApplyFormValues>,
    defaultValues: {
      team: "",
      techGroup: "",
      items: [defaultPurchaseItem],
      submit: true,
      ...initialValues,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const items = useWatch({ control: form.control, name: "items" }) ?? [];
  async function onSubmit(data: CreateOrderInput, submit: boolean) {
    if (!hasSignature && submit) {
      setSignatureDialogOpen(true);
      return;
    }

    const missingImageIndex = data.items.findIndex(
      (item, index) =>
        itemKindNeedsImage(item.itemKind) &&
        !itemImageFiles[index] &&
        !item.referenceImagePath,
    );
    if (missingImageIndex >= 0) {
      setItemImageErrors({
        [missingImageIndex]: "请为加工费条目上传参考图片",
      });
      requestAnimationFrame(() => {
        document.getElementById(`purchase-item-${missingImageIndex}-image`)?.focus();
      });
      return;
    }
    setItemImageErrors({});

    setSubmitting(true);
    try {
      const payload: OrderFormPayload = editing
        ? { ...data, submit, orderId, expectedUpdatedAt }
        : { ...data, submit };
      const formData = buildOrderFormData(payload, itemImageFiles);
      const order = editing
        ? await updateOrder(formData)
        : await createOrder(formData);
      toast.success(submit ? "申请已提交" : "草稿已保存");
      if (submit) {
        router.replace(
          `${routes.procurement.detail(order.id)}?focus=approval&from=submit#approval`,
        );
      } else {
        router.push(`${routes.procurement.detail(order.id)}`);
      }
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交失败"));
    } finally {
      setSubmitting(false);
    }
  }

  function handleItemKindChange(index: number, kind: PurchaseItemKind) {
    form.setValue(`items.${index}.itemKind`, kind);
    if (itemKindNeedsLink(kind)) {
      form.setValue(`items.${index}.referenceImagePath`, null);
      form.setValue(`items.${index}.processingVendor`, "");
      setItemImageFiles((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      setItemImageErrors((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });
    } else if (kind === "PROCESSING_FEE") {
      form.setValue(`items.${index}.purchaseLink`, "");
    } else {
      form.setValue(`items.${index}.purchaseLink`, "");
      form.setValue(`items.${index}.processingVendor`, "");
      form.setValue(`items.${index}.referenceImagePath`, null);
      setItemImageFiles((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      setItemImageErrors((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });
    }
  }

  function handleImportItems(
    imported: PurchaseItemInput[],
    mode: "replace" | "append",
  ) {
    const current = form.getValues("items");
    const merged =
      mode === "append"
        ? [...current, ...imported]
        : imported;

    form.setValue("items", merged, { shouldValidate: true });
    setItemImageFiles({});
    setItemImageErrors({});
    toast.success(`已导入 ${imported.length} 条明细`);
  }

  return (
    <form className="space-y-6">
      <ApplyFormBasics form={form} />

      <ApplyFormItems
        form={form}
        fields={fields}
        items={items}
        append={append}
        remove={remove}
        itemImageFiles={itemImageFiles}
        setItemImageFiles={setItemImageFiles}
        itemImageErrors={itemImageErrors}
        setItemImageErrors={setItemImageErrors}
        processingVendors={processingVendors}
        onItemKindChange={handleItemKindChange}
        onOpenImport={() => setImportDialogOpen(true)}
      />

      <div className="flex gap-3">
        <Button
          type="button"
          disabled={submitting}
          onClick={form.handleSubmit((data) =>
            onSubmit(data as CreateOrderInput, true),
          )}
        >
          提交申请
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={form.handleSubmit((data) =>
            onSubmit(data as CreateOrderInput, false),
          )}
        >
          保存草稿
        </Button>
      </div>
      <SignatureRequiredDialog
        open={signatureDialogOpen}
        onOpenChange={setSignatureDialogOpen}
        purpose="initiate"
      />
      <ProcurementItemsImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        existingItemCount={fields.length}
        onConfirm={handleImportItems}
      />
    </form>
  );
}
