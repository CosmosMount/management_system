"use client";

import {
  useFieldArray,
  useForm,
  useWatch,
  Controller,
  type Resolver,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2, FileSpreadsheet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createOrder } from "@/app/actions/createOrder";
import { updateOrder } from "@/app/actions/updateOrder";
import { ProcurementItemsImportDialog } from "@/components/procurement-items-import-dialog";
import { FilePreviewImage } from "@/components/file-preview-image";
import { SignatureRequiredDialog } from "@/components/signature-required-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { getActionErrorMessage } from "@/lib/action-error-message";
import {
  itemKindNeedsImage,
  itemKindNeedsLink,
  formatPurchaseItemKind,
  purchaseItemKindLabels,
  type PurchaseItemKind,
} from "@/lib/purchase-item-kind";
import { IMAGE_UPLOAD_ACCEPT } from "@/lib/upload-accept";
import { ProcessingVendorSelect } from "@/components/processing-vendor-select";
import { useProcessingVendors } from "@/components/use-processing-vendors";
import { routes } from "@/lib/routes";
import {
  createOrderSchema,
  type CreateOrderInput,
  type PurchaseItemInput,
} from "@/lib/validations/order";

type ApplyFormValues = Omit<CreateOrderInput, "team" | "techGroup"> & {
  team: CreateOrderInput["team"] | "";
  techGroup: CreateOrderInput["techGroup"] | "";
};

type OrderFormPayload = CreateOrderInput & {
  orderId?: string;
  expectedUpdatedAt?: string;
};

type Props = {
  orderId?: string;
  expectedUpdatedAt?: string;
  initialValues?: Omit<CreateOrderInput, "submit">;
  hasSignature?: boolean;
};

const defaultItem = {
  name: "",
  spec: "",
  itemKind: "COMPONENT" as PurchaseItemKind,
  purchaseLink: "",
  referenceImagePath: null as string | null,
  processingVendor: "",
  quantity: 1,
  lineTotal: 0,
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
  const [itemImageFiles, setItemImageFiles] = useState<
    Record<number, File | undefined>
  >({});
  const [itemImageErrors, setItemImageErrors] = useState<Record<number, string>>(
    {},
  );
  const editing = !!orderId;
  const processingVendors = useProcessingVendors();

  const form = useForm<ApplyFormValues>({
    resolver: zodResolver(createOrderSchema) as Resolver<ApplyFormValues>,
    defaultValues: {
      team: "",
      techGroup: "",
      items: [defaultItem],
      submit: true,
      ...initialValues,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const items = useWatch({ control: form.control, name: "items" }) ?? [];
  const totalPrice = items.reduce(
    (sum, item) => sum + (Number(item.lineTotal) || 0),
    0,
  );

  function buildFormData(data: OrderFormPayload): FormData {
    const formData = new FormData();
    formData.set("payload", JSON.stringify(data));
    for (const [index, file] of Object.entries(itemImageFiles)) {
      if (file) {
        formData.set(`itemImage-${index}`, file);
      }
    }
    return formData;
  }

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
      const formData = buildFormData(payload);
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
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
          <CardDescription>选择车组与技术组</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="purchase-team">车组</Label>
            <Controller
              control={form.control}
              name="team"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger
                    id="purchase-team"
                    className="w-full"
                    aria-invalid={Boolean(form.formState.errors.team)}
                    aria-describedby={form.formState.errors.team ? "purchase-team-error" : undefined}
                  >
                    <SelectValue placeholder="请选择车组" />
                  </SelectTrigger>
                  <SelectContent>
                    {TEAM_OPTIONS.map((team) => (
                      <SelectItem key={team} value={team}>
                        {team}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {form.formState.errors.team && (
              <p id="purchase-team-error" className="text-sm text-destructive" role="alert">
                {form.formState.errors.team.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="purchase-tech-group">技术组</Label>
            <Controller
              control={form.control}
              name="techGroup"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger
                    id="purchase-tech-group"
                    className="w-full"
                    aria-invalid={Boolean(form.formState.errors.techGroup)}
                    aria-describedby={form.formState.errors.techGroup ? "purchase-tech-group-error" : undefined}
                  >
                    <SelectValue placeholder="请选择技术组" />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_GROUP_OPTIONS.map((group) => (
                      <SelectItem key={group} value={group}>
                        {group}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {form.formState.errors.techGroup && (
              <p id="purchase-tech-group-error" className="text-sm text-destructive" role="alert">
                {form.formState.errors.techGroup.message}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>采购明细</CardTitle>
            <CardDescription>
              元器件与标准件填写采购链接；加工费须选择加工商并上传图片
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setImportDialogOpen(true)}
            >
              <FileSpreadsheet className="mr-1 h-4 w-4" />
              从 Excel 导入
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append(defaultItem)}
            >
              <Plus className="mr-1 h-4 w-4" />
              添加条目
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.map((field, index) => {
            const itemPrefix = `purchase-item-${index}`;
            const itemKind = items[index]?.itemKind ?? "COMPONENT";
            const existingImage = items[index]?.referenceImagePath;
            const previewFile = itemImageFiles[index];
            const hasPreview = Boolean(previewFile || existingImage);
            const itemErrors = form.formState.errors.items?.[index];

            return (
              <div
                key={field.id}
                className={`grid gap-3 rounded-lg border p-4 sm:grid-cols-6 ${
                  itemKindNeedsImage(itemKind) && !hasPreview
                    ? "border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20"
                    : "border-border/60 bg-muted/30"
                }`}
              >
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${itemPrefix}-name`}>物品名称</Label>
                  <Input
                    id={`${itemPrefix}-name`}
                    aria-invalid={Boolean(itemErrors?.name)}
                    aria-describedby={itemErrors?.name ? `${itemPrefix}-name-error` : undefined}
                    {...form.register(`items.${index}.name`)}
                  />
                  {itemErrors?.name && (
                    <p id={`${itemPrefix}-name-error`} className="text-sm text-destructive" role="alert">
                      {itemErrors.name.message}
                    </p>
                  )}
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${itemPrefix}-spec`}>规格</Label>
                  <Input
                    id={`${itemPrefix}-spec`}
                    aria-invalid={Boolean(itemErrors?.spec)}
                    aria-describedby={itemErrors?.spec ? `${itemPrefix}-spec-error` : undefined}
                    {...form.register(`items.${index}.spec`)}
                  />
                  {itemErrors?.spec && (
                    <p id={`${itemPrefix}-spec-error`} className="text-sm text-destructive" role="alert">
                      {itemErrors.spec.message}
                    </p>
                  )}
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${itemPrefix}-kind`}>物品种类</Label>
                  <Controller
                    control={form.control}
                    name={`items.${index}.itemKind`}
                    render={({ field: kindField }) => (
                      <Select
                        value={kindField.value}
                        onValueChange={(value) =>
                          handleItemKindChange(index, value as PurchaseItemKind)
                        }
                      >
                        <SelectTrigger
                          id={`${itemPrefix}-kind`}
                          className="w-full"
                          aria-invalid={Boolean(itemErrors?.itemKind)}
                          aria-describedby={itemErrors?.itemKind ? `${itemPrefix}-kind-error` : undefined}
                        >
                          <SelectValue placeholder="请选择种类">
                            {(value) =>
                              value
                                ? formatPurchaseItemKind(value as PurchaseItemKind)
                                : null
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {(
                            Object.entries(purchaseItemKindLabels) as [
                              PurchaseItemKind,
                              string,
                            ][]
                          ).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {itemErrors?.itemKind && (
                    <p id={`${itemPrefix}-kind-error`} className="text-sm text-destructive" role="alert">
                      {itemErrors.itemKind.message}
                    </p>
                  )}
                </div>

                {itemKindNeedsLink(itemKind) ? (
                  <div className="space-y-2 sm:col-span-6">
                    <Label htmlFor={`${itemPrefix}-link`}>采购链接</Label>
                    <Input
                      id={`${itemPrefix}-link`}
                      placeholder="https://"
                      aria-invalid={Boolean(itemErrors?.purchaseLink)}
                      aria-describedby={itemErrors?.purchaseLink ? `${itemPrefix}-link-error` : undefined}
                      {...form.register(`items.${index}.purchaseLink`)}
                    />
                    {form.formState.errors.items?.[index]?.purchaseLink && (
                      <p id={`${itemPrefix}-link-error`} className="text-sm text-destructive" role="alert">
                        {
                          form.formState.errors.items[index]?.purchaseLink
                            ?.message
                        }
                      </p>
                    )}
                  </div>
                ) : null}

                {itemKind === "PROCESSING_FEE" ? (
                  <div className="space-y-2 sm:col-span-6">
                    <Label htmlFor={`${itemPrefix}-vendor`}>加工商</Label>
                    <Controller
                      control={form.control}
                      name={`items.${index}.processingVendor`}
                      render={({ field }) => (
                        <ProcessingVendorSelect
                          id={`${itemPrefix}-vendor`}
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          error={
                            form.formState.errors.items?.[index]
                              ?.processingVendor?.message
                          }
                          vendors={processingVendors.vendors}
                          loading={processingVendors.loading}
                          onAddVendor={processingVendors.addVendor}
                        />
                      )}
                    />
                  </div>
                ) : null}

                {itemKindNeedsImage(itemKind) ? (
                  <div className="space-y-2 sm:col-span-6">
                    <Label htmlFor={`${itemPrefix}-image`}>参考图片</Label>
                    <Input
                      id={`${itemPrefix}-image`}
                      type="file"
                      accept={IMAGE_UPLOAD_ACCEPT}
                      aria-invalid={Boolean(itemImageErrors[index])}
                      aria-describedby={itemImageErrors[index] ? `${itemPrefix}-image-error` : undefined}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        setItemImageFiles((prev) => ({
                          ...prev,
                          [index]: file,
                        }));
                        if (file) {
                          setItemImageErrors((current) => {
                            const next = { ...current };
                            delete next[index];
                            return next;
                          });
                        }
                      }}
                    />
                    {itemImageErrors[index] && (
                      <p id={`${itemPrefix}-image-error`} className="text-sm text-destructive" role="alert">
                        {itemImageErrors[index]}
                      </p>
                    )}
                    {hasPreview && (
                      <div className="mt-2">
                        <FilePreviewImage
                          file={previewFile}
                          fallbackSrc={existingImage}
                          alt="参考图片预览"
                          className="max-h-32 rounded-md border object-contain"
                        />
                      </div>
                    )}
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor={`${itemPrefix}-quantity`}>数量</Label>
                  <Input
                    id={`${itemPrefix}-quantity`}
                    type="number"
                    min={1}
                    aria-invalid={Boolean(itemErrors?.quantity)}
                    aria-describedby={itemErrors?.quantity ? `${itemPrefix}-quantity-error` : undefined}
                    {...form.register(`items.${index}.quantity`, {
                      valueAsNumber: true,
                    })}
                  />
                  {itemErrors?.quantity && (
                    <p id={`${itemPrefix}-quantity-error`} className="text-sm text-destructive" role="alert">
                      {itemErrors.quantity.message}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${itemPrefix}-line-total`}>行总价</Label>
                  <Input
                    id={`${itemPrefix}-line-total`}
                    type="number"
                    min={0}
                    step="0.01"
                    aria-invalid={Boolean(itemErrors?.lineTotal)}
                    aria-describedby={itemErrors?.lineTotal ? `${itemPrefix}-line-total-error` : undefined}
                    {...form.register(`items.${index}.lineTotal`, {
                      valueAsNumber: true,
                    })}
                  />
                  {itemErrors?.lineTotal && (
                    <p id={`${itemPrefix}-line-total-error`} className="text-sm text-destructive" role="alert">
                      {itemErrors.lineTotal.message}
                    </p>
                  )}
                </div>
                <div className="space-y-2 sm:col-span-6">
                  <p className="text-sm text-muted-foreground">
                    单价（自动计算）：¥
                    {(() => {
                      const qty = Number(items[index]?.quantity) || 0;
                      const total = Number(items[index]?.lineTotal) || 0;
                      return qty > 0 ? (total / qty).toFixed(2) : "0.00";
                    })()}
                  </p>
                </div>
                <div className="flex items-end sm:col-span-6">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={fields.length <= 1}
                    onClick={() => {
                      remove(index);
                      setItemImageFiles((prev) => {
                        const next: Record<number, File | undefined> = {};
                        Object.entries(prev).forEach(([key, file]) => {
                          const i = Number(key);
                          if (i < index) next[i] = file;
                          if (i > index) next[i - 1] = file;
                        });
                        return next;
                      });
                      setItemImageErrors((current) => {
                        const next: Record<number, string> = {};
                        Object.entries(current).forEach(([key, error]) => {
                          const i = Number(key);
                          if (i < index) next[i] = error;
                          if (i > index) next[i - 1] = error;
                        });
                        return next;
                      });
                    }}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    删除
                  </Button>
                </div>
              </div>
            );
          })}
          {form.formState.errors.items?.message && (
            <p className="text-sm text-destructive">
              {form.formState.errors.items.message}
            </p>
          )}
          <p className="text-right text-lg font-medium">
            合计：¥{totalPrice.toFixed(2)}
          </p>
        </CardContent>
      </Card>

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
