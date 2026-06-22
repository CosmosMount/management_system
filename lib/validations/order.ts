import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { z } from "zod";

export const purchaseItemSchema = z.object({
  name: z.string().min(1, "请输入物品名称"),
  spec: z.string().min(1, "请输入规格"),
  purchaseLink: z.string().min(1, "请输入购买链接"),
  quantity: z.number().int().min(1, "数量至少为 1"),
  lineTotal: z.number().min(0, "总价不能为负"),
});

export function toStoredPurchaseItem(item: PurchaseItemInput) {
  return {
    name: item.name,
    spec: item.spec,
    purchaseLink: item.purchaseLink,
    quantity: item.quantity,
    unitPrice: item.lineTotal / item.quantity,
  };
}

export const createOrderSchema = z.object({
  team: z.enum(TEAM_OPTIONS, { message: "请选择车组" }),
  techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择技术组" }),
  items: z.array(purchaseItemSchema).min(1, "至少添加一条明细"),
  submit: z.boolean(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type PurchaseItemInput = z.infer<typeof purchaseItemSchema>;
