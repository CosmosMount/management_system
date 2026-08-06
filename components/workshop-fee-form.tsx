"use client";

import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type Resolver,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2, FileSpreadsheet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IMAGE_UPLOAD_ACCEPT } from "@/lib/upload-accept";
import { createWorkshopFeeOrder } from "@/app/actions/createWorkshopFeeOrder";
import { ProcurementItemsImportDialog } from "@/components/procurement-items-import-dialog";
import { FilePreviewImage } from "@/components/file-preview-image";
import { ProcessingVendorSelect } from "@/components/processing-vendor-select";
import { useProcessingVendors } from "@/components/use-processing-vendors";
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
import { routes } from "@/lib/routes";
import {
  createWorkshopFeeSchema,
  type CreateWorkshopFeeInput,
} from "@/lib/validations/workshop-fee";
import type { PurchaseItemInput } from "@/lib/validations/order";

type FormValues = Omit<CreateWorkshopFeeInput, "team" | "techGroup"> & {
  team: CreateWorkshopFeeInput["team"] | "";
  techGroup: CreateWorkshopFeeInput["techGroup"] | "";
};

const defaultItem = {
  name: "",
  spec: "",
  processingVendor: "",
  quantity: 1,
  lineTotal: 0,
};

export function WorkshopFeeForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [itemImageFiles, setItemImageFiles] = useState<
    Record<number, File | undefined>
  >({});
  const [itemImageErrors, setItemImageErrors] = useState<Record<number, string>>(
    {},
  );
  const processingVendors = useProcessingVendors();

  const form = useForm<FormValues>({
    resolver: zodResolver(createWorkshopFeeSchema) as Resolver<FormValues>,
    defaultValues: {
      team: "",
      techGroup: "机械",
      items: [defaultItem],
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

  async function onSubmit(data: CreateWorkshopFeeInput) {
    const missingImageIndex = data.items.findIndex(
      (_, index) => !itemImageFiles[index],
    );
    if (missingImageIndex >= 0) {
      setItemImageErrors({ [missingImageIndex]: "请上传加工费图片" });
      requestAnimationFrame(() => {
        document.getElementById(`workshop-item-${missingImageIndex}-image`)?.focus();
      });
      return;
    }
    setItemImageErrors({});
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.set("payload", JSON.stringify(data));
      for (const [index, file] of Object.entries(itemImageFiles)) {
        if (file) {
          formData.set(`itemImage-${index}`, file);
        }
      }
      const order = await createWorkshopFeeOrder(formData);
      toast.success("工坊加工费已录入");
      router.push(routes.procurement.detail(order.id));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  function handleImportItems(
    imported: PurchaseItemInput[],
    mode: "replace" | "append",
  ) {
    const mapped = imported.map((item) => ({
      name: item.name,
      spec: item.spec,
      processingVendor: item.processingVendor,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    }));
    const current = form.getValues("items");
    const merged = mode === "append" ? [...current, ...mapped] : mapped;
    form.setValue("items", merged, { shouldValidate: true });
    setItemImageFiles({});
    setItemImageErrors({});
    toast.success(`已导入 ${mapped.length} 条加工费明细`);
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
            <Label htmlFor="workshop-team">车组</Label>
            <Controller
              control={form.control}
              name="team"
              render={({ field }) => (
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
                  <SelectTrigger
                    id="workshop-team"
                    className="w-full"
                    aria-invalid={Boolean(form.formState.errors.team)}
                    aria-describedby={form.formState.errors.team ? "workshop-team-error" : undefined}
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
              <p id="workshop-team-error" className="text-sm text-destructive" role="alert">
                {form.formState.errors.team.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="workshop-tech-group">技术组</Label>
            <Controller
              control={form.control}
              name="techGroup"
              render={({ field }) => (
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
                  <SelectTrigger
                    id="workshop-tech-group"
                    className="w-full"
                    aria-invalid={Boolean(form.formState.errors.techGroup)}
                    aria-describedby={form.formState.errors.techGroup ? "workshop-tech-group-error" : undefined}
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
              <p id="workshop-tech-group-error" className="text-sm text-destructive" role="alert">
                {form.formState.errors.techGroup.message}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>加工费明细</CardTitle>
            <CardDescription>
              种类固定为加工费，每条须上传对应图片，提交后直接计入采购汇总
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
            const itemPrefix = `workshop-item-${index}`;
            const previewFile = itemImageFiles[index];
            const itemErrors = form.formState.errors.items?.[index];

            return (
              <div
                key={field.id}
                className="grid gap-3 rounded-lg border border-border/60 bg-muted/30 p-4 sm:grid-cols-6"
              >
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${itemPrefix}-name`}>费用名称</Label>
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
                  <Label htmlFor={`${itemPrefix}-spec`}>说明</Label>
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
                  <Label htmlFor={`${itemPrefix}-kind`}>种类</Label>
                  <Input id={`${itemPrefix}-kind`} value="加工费" disabled className="bg-muted" />
                </div>
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
                          form.formState.errors.items?.[index]?.processingVendor
                            ?.message
                        }
                        vendors={processingVendors.vendors}
                        loading={processingVendors.loading}
                        onAddVendor={processingVendors.addVendor}
                      />
                    )}
                  />
                </div>
                <div className="space-y-2 sm:col-span-6">
                  <Label htmlFor={`${itemPrefix}-image`}>图片</Label>
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
                  {previewFile && (
                    <FilePreviewImage
                      file={previewFile}
                      alt="加工费图片预览"
                      className="mt-2 max-h-32 rounded-md border object-contain"
                    />
                  )}
                </div>
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
                  <Label htmlFor={`${itemPrefix}-line-total`}>金额</Label>
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
          <p className="text-right text-lg font-medium">
            合计：¥{totalPrice.toFixed(2)}
          </p>
        </CardContent>
      </Card>

      <Button
        type="button"
        disabled={submitting}
        onClick={form.handleSubmit((data) =>
          onSubmit(data as CreateWorkshopFeeInput),
        )}
      >
        {submitting ? "提交中…" : "提交并计入汇总"}
      </Button>
      <ProcurementItemsImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        existingItemCount={fields.length}
        processingFeeOnly
        onConfirm={handleImportItems}
      />
    </form>
  );
}
