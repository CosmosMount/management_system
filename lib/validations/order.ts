import { z } from "zod";

export const purchaseItemSchema = z.object({
  name: z.string().min(1, "请输入物品名称"),
  spec: z.string().min(1, "请输入规格"),
  quantity: z.number().int().min(1, "数量至少为 1"),
  unitPrice: z.number().min(0, "单价不能为负"),
});

export const createOrderSchema = z.object({
  team: z.string().min(1, "请输入车组"),
  techGroup: z.string().min(1, "请输入技术组"),
  items: z.array(purchaseItemSchema).min(1, "至少添加一条明细"),
  submit: z.boolean(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type PurchaseItemInput = z.infer<typeof purchaseItemSchema>;
