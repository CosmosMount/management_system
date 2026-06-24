"use client";

import { useFieldArray, useForm, Controller, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createOrder } from "@/app/actions/createOrder";
import { updateOrder } from "@/app/actions/updateOrder";
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
import {
  itemKindNeedsImage,
  itemKindNeedsLink,
  formatPurchaseItemKind,
  purchaseItemKindLabels,
  type PurchaseItemKind,
} from "@/lib/purchase-item-kind";
import { routes } from "@/lib/routes";
import {
  createOrderSchema,
  type CreateOrderInput,
} from "@/lib/validations/order";

type ApplyFormValues = Omit<CreateOrderInput, "team" | "techGroup"> & {
  team: CreateOrderInput["team"] | "";
  techGroup: CreateOrderInput["techGroup"] | "";
};

type Props = {
  orderId?: string;
  initialValues?: Omit<CreateOrderInput, "submit">;
};

const defaultItem = {
  name: "",
  spec: "",
  itemKind: "COMPONENT" as PurchaseItemKind,
  purchaseLink: "",
  referenceImagePath: null as string | null,
  quantity: 1,
  lineTotal: 0,
};

export function ApplyForm({ orderId, initialValues }: Props = {}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [itemImageFiles, setItemImageFiles] = useState<
    Record<number, File | undefined>
  >({});
  const editing = !!orderId;

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

  const items = form.watch("items");
  const totalPrice = items.reduce(
    (sum, item) => sum + (Number(item.lineTotal) || 0),
    0,
  );

  function buildFormData(data: CreateOrderInput): FormData {
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
    setSubmitting(true);
    try {
      const payload = { ...data, submit };
      const formData = buildFormData(payload);
      const order = editing
        ? await updateOrder(formData)
        : await createOrder(formData);
      toast.success(submit ? "申请已提交" : "草稿已保存");
      router.push(`${routes.procurement.detail(order.id)}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  function handleItemKindChange(index: number, kind: PurchaseItemKind) {
    form.setValue(`items.${index}.itemKind`, kind);
    if (itemKindNeedsLink(kind)) {
      form.setValue(`items.${index}.referenceImagePath`, null);
      setItemImageFiles((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    } else {
      form.setValue(`items.${index}.purchaseLink`, "");
    }
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
            <Label>车组</Label>
            <Controller
              control={form.control}
              name="team"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger className="w-full">
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
              <p className="text-sm text-destructive">
                {form.formState.errors.team.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>技术组</Label>
            <Controller
              control={form.control}
              name="techGroup"
              render={({ field }) => (
                <Select
                  value={field.value ?? ""}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger className="w-full">
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
              <p className="text-sm text-destructive">
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
              选择物品种类后填写采购链接或上传图片
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => append(defaultItem)}
          >
            <Plus className="mr-1 h-4 w-4" />
            添加条目
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.map((field, index) => {
            const itemKind = items[index]?.itemKind ?? "COMPONENT";
            const existingImage = items[index]?.referenceImagePath;
            const previewFile = itemImageFiles[index];
            const previewUrl = previewFile
              ? URL.createObjectURL(previewFile)
              : existingImage;

            return (
              <div
                key={field.id}
                className="grid gap-3 rounded-lg border border-border/60 bg-muted/30 p-4 sm:grid-cols-6"
              >
                <div className="space-y-2 sm:col-span-2">
                  <Label>物品名称</Label>
                  <Input {...form.register(`items.${index}.name`)} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>规格</Label>
                  <Input {...form.register(`items.${index}.spec`)} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>物品种类</Label>
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
                        <SelectTrigger className="w-full">
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
                </div>

                {itemKindNeedsLink(itemKind) ? (
                  <div className="space-y-2 sm:col-span-6">
                    <Label>采购链接</Label>
                    <Input
                      placeholder="https://"
                      {...form.register(`items.${index}.purchaseLink`)}
                    />
                    {form.formState.errors.items?.[index]?.purchaseLink && (
                      <p className="text-sm text-destructive">
                        {
                          form.formState.errors.items[index]?.purchaseLink
                            ?.message
                        }
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2 sm:col-span-6">
                    <Label>参考图片</Label>
                    <Input
                      type="file"
                      accept="image/png,image/jpeg,image/jpg"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        setItemImageFiles((prev) => ({
                          ...prev,
                          [index]: file,
                        }));
                      }}
                    />
                    {previewUrl && (
                      <div className="mt-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={previewUrl}
                          alt="参考图片预览"
                          className="max-h-32 rounded-md border object-contain"
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <Label>数量</Label>
                  <Input
                    type="number"
                    min={1}
                    {...form.register(`items.${index}.quantity`, {
                      valueAsNumber: true,
                    })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>行总价</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    {...form.register(`items.${index}.lineTotal`, {
                      valueAsNumber: true,
                    })}
                  />
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
    </form>
  );
}
