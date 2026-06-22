"use client";

import { useFieldArray, useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createOrder } from "@/app/actions/createOrder";
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
  createOrderSchema,
  type CreateOrderInput,
} from "@/lib/validations/order";

export function ApplyForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      team: undefined,
      techGroup: undefined,
      items: [{ name: "", spec: "", quantity: 1, unitPrice: 0 }],
      submit: true,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const items = form.watch("items");
  const totalPrice = items.reduce(
    (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0),
    0,
  );

  async function onSubmit(data: CreateOrderInput, submit: boolean) {
    setSubmitting(true);
    try {
      const order = await createOrder({ ...data, submit });
      toast.success(submit ? "申请已提交" : "草稿已保存");
      router.push(`/orders/${order.id}`);
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
                <Select
                  value={field.value}
                  onValueChange={(v) => field.onChange(v ?? undefined)}
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
                  value={field.value}
                  onValueChange={(v) => field.onChange(v ?? undefined)}
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
            <CardDescription>可动态添加或删除条目</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              append({ name: "", spec: "", quantity: 1, unitPrice: 0 })
            }
          >
            <Plus className="mr-1 h-4 w-4" />
            添加条目
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.map((field, index) => (
            <div
              key={field.id}
              className="grid gap-3 rounded-lg border p-4 sm:grid-cols-5"
            >
              <div className="space-y-2 sm:col-span-2">
                <Label>物品名称</Label>
                <Input {...form.register(`items.${index}.name`)} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>规格</Label>
                <Input {...form.register(`items.${index}.spec`)} />
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
                <Label>单价</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  {...form.register(`items.${index}.unitPrice`, {
                    valueAsNumber: true,
                  })}
                />
              </div>
              <div className="flex items-end sm:col-span-5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={fields.length <= 1}
                  onClick={() => remove(index)}
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  删除
                </Button>
              </div>
            </div>
          ))}
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
          onClick={form.handleSubmit((data) => onSubmit(data, true))}
        >
          提交申请
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={form.handleSubmit((data) => onSubmit(data, false))}
        >
          保存草稿
        </Button>
      </div>
    </form>
  );
}
