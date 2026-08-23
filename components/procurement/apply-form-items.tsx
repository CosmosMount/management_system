"use client";

import type { Dispatch, SetStateAction } from "react";
import {
  Controller,
  type FieldArrayWithId,
  type UseFormReturn,
} from "react-hook-form";
import { FileSpreadsheet, Plus, Trash2 } from "lucide-react";
import { FilePreviewImage } from "@/components/file-preview-image";
import { ProcessingVendorSelect } from "@/components/processing-vendor-select";
import {
  defaultPurchaseItem,
  removeIndexedEntry,
  type ApplyFormValues,
  type ItemImageErrors,
  type ItemImageFiles,
} from "@/components/procurement/apply-form-contract";
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
import type { useProcessingVendors } from "@/components/use-processing-vendors";
import {
  formatPurchaseItemKind,
  itemKindNeedsImage,
  itemKindNeedsLink,
  purchaseItemKindLabels,
  type PurchaseItemKind,
} from "@/lib/purchase-item-kind";
import { IMAGE_UPLOAD_ACCEPT } from "@/lib/upload-accept";

export function ApplyFormItems({
  form,
  fields,
  items,
  append,
  remove,
  itemImageFiles,
  setItemImageFiles,
  itemImageErrors,
  setItemImageErrors,
  processingVendors,
  onItemKindChange,
  onOpenImport,
}: {
  form: UseFormReturn<ApplyFormValues>;
  fields: FieldArrayWithId<ApplyFormValues, "items", "id">[];
  items: ApplyFormValues["items"];
  append: (item: ApplyFormValues["items"][number]) => void;
  remove: (index: number) => void;
  itemImageFiles: ItemImageFiles;
  setItemImageFiles: Dispatch<SetStateAction<ItemImageFiles>>;
  itemImageErrors: ItemImageErrors;
  setItemImageErrors: Dispatch<SetStateAction<ItemImageErrors>>;
  processingVendors: ReturnType<typeof useProcessingVendors>;
  onItemKindChange: (index: number, kind: PurchaseItemKind) => void;
  onOpenImport: () => void;
}) {
  const totalPrice = items.reduce(
    (sum, item) => sum + (Number(item.lineTotal) || 0),
    0,
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>采购明细</CardTitle>
          <CardDescription>
            元器件与标准件填写采购链接；加工费须选择加工商并上传图片
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onOpenImport}>
            <FileSpreadsheet className="mr-1 h-4 w-4" />
            从 Excel 导入
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append(defaultPurchaseItem)}
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
                        onItemKindChange(index, value as PurchaseItemKind)
                      }
                    >
                      <SelectTrigger
                        ref={kindField.ref}
                        id={`${itemPrefix}-kind`}
                        className="w-full"
                        aria-invalid={Boolean(itemErrors?.itemKind)}
                        aria-describedby={itemErrors?.itemKind ? `${itemPrefix}-kind-error` : undefined}
                      >
                        <SelectValue placeholder="请选择种类">
                          {(value) =>
                            value ? formatPurchaseItemKind(value as PurchaseItemKind) : null
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
                          <SelectItem key={value} value={value}>{label}</SelectItem>
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
                  {itemErrors?.purchaseLink && (
                    <p id={`${itemPrefix}-link-error`} className="text-sm text-destructive" role="alert">
                      {itemErrors.purchaseLink.message}
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
                    render={({ field: vendorField }) => (
                      <ProcessingVendorSelect
                        id={`${itemPrefix}-vendor`}
                        triggerRef={vendorField.ref}
                        value={vendorField.value ?? ""}
                        onChange={vendorField.onChange}
                        error={itemErrors?.processingVendor?.message}
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
                      setItemImageFiles((previous) => ({ ...previous, [index]: file }));
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
                  {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
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
                  {...form.register(`items.${index}.lineTotal`, { valueAsNumber: true })}
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
                    const quantity = Number(items[index]?.quantity) || 0;
                    const lineTotal = Number(items[index]?.lineTotal) || 0;
                    return quantity > 0 ? (lineTotal / quantity).toFixed(2) : "0.00";
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
                    setItemImageFiles((previous) => removeIndexedEntry(previous, index));
                    setItemImageErrors((current) => removeIndexedEntry(current, index));
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
  );
}
