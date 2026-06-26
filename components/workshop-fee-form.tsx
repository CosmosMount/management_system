"use client";

import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type Resolver,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createWorkshopFeeOrder } from "@/app/actions/createWorkshopFeeOrder";
import { ProcessingVendorSelect } from "@/components/processing-vendor-select";
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
  const [itemImageFiles, setItemImageFiles] = useState<
    Record<number, File | undefined>
  >({});

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
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
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
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
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
            <CardTitle>加工费明细</CardTitle>
            <CardDescription>
              种类固定为加工费，每条须上传对应图片，提交后直接计入采购汇总
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
            const previewFile = itemImageFiles[index];
            const previewUrl = previewFile
              ? URL.createObjectURL(previewFile)
              : null;

            return (
              <div
                key={field.id}
                className="grid gap-3 rounded-lg border border-border/60 bg-muted/30 p-4 sm:grid-cols-6"
              >
                <div className="space-y-2 sm:col-span-2">
                  <Label>费用名称</Label>
                  <Input {...form.register(`items.${index}.name`)} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>说明</Label>
                  <Input {...form.register(`items.${index}.spec`)} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>种类</Label>
                  <Input value="加工费" disabled className="bg-muted" />
                </div>
                <div className="space-y-2 sm:col-span-6">
                  <Label>加工商</Label>
                  <Controller
                    control={form.control}
                    name={`items.${index}.processingVendor`}
                    render={({ field }) => (
                      <ProcessingVendorSelect
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        error={
                          form.formState.errors.items?.[index]?.processingVendor
                            ?.message
                        }
                      />
                    )}
                  />
                </div>
                <div className="space-y-2 sm:col-span-6">
                  <Label>图片</Label>
                  <Input
                    type="file"
                    accept="image/png,image/jpeg,image/jpg"
                    required
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      setItemImageFiles((prev) => ({
                        ...prev,
                        [index]: file,
                      }));
                    }}
                  />
                  {previewUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previewUrl}
                      alt="加工费图片预览"
                      className="mt-2 max-h-32 rounded-md border object-contain"
                    />
                  )}
                </div>
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
                  <Label>金额</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    {...form.register(`items.${index}.lineTotal`, {
                      valueAsNumber: true,
                    })}
                  />
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
    </form>
  );
}
