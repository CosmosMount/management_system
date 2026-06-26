import {
  itemKindNeedsImage,
  itemKindNeedsLink,
  PURCHASE_ITEM_KINDS,
} from "@/lib/purchase-item-kind";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS, MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";
import { z } from "zod";

export const purchaseItemSchema = z
  .object({
    name: z.string().min(1, "请输入物品名称"),
    spec: z.string().min(1, "请输入规格"),
    itemKind: z.enum(PURCHASE_ITEM_KINDS, { message: "请选择物品种类" }),
    purchaseLink: z.string().optional().default(""),
    referenceImagePath: z.string().nullable().optional(),
    processingVendor: z.string().optional().default(""),
    quantity: z.number().int().min(1, "数量至少为 1"),
    lineTotal: z.number().min(0, "总价不能为负"),
  })
  .superRefine((item, ctx) => {
    if (itemKindNeedsLink(item.itemKind)) {
      const link = item.purchaseLink?.trim() ?? "";
      if (!link) {
        ctx.addIssue({
          code: "custom",
          message: "请输入采购链接",
          path: ["purchaseLink"],
        });
      } else if (!/^https?:\/\//i.test(link)) {
        ctx.addIssue({
          code: "custom",
          message: "请输入以 http:// 或 https:// 开头的链接",
          path: ["purchaseLink"],
        });
      }
    }
    if (item.itemKind === "PROCESSING_FEE") {
      const vendor = item.processingVendor?.trim() ?? "";
      if (!vendor) {
        ctx.addIssue({
          code: "custom",
          message: "请选择加工商",
          path: ["processingVendor"],
        });
      }
    }
  });

export function toStoredPurchaseItem(item: PurchaseItemInput) {
  return {
    name: item.name,
    spec: item.spec,
    itemKind: item.itemKind,
    purchaseLink: itemKindNeedsLink(item.itemKind)
      ? (item.purchaseLink?.trim() ?? "")
      : "",
    referenceImagePath: itemKindNeedsImage(item.itemKind)
      ? (item.referenceImagePath ?? null)
      : null,
    processingVendor:
      item.itemKind === "PROCESSING_FEE"
        ? (item.processingVendor?.trim() ?? "")
        : "",
    quantity: item.quantity,
    unitPrice: item.lineTotal / item.quantity,
  };
}

export const createOrderSchema = z.object({
  team: z.enum(TEAM_OPTIONS, { message: "请选择车组" }),
  techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择技术组" }),
  items: z
    .array(purchaseItemSchema)
    .min(1, "至少添加一条明细")
    .max(
      MAX_REIMBURSEMENT_LIST_ROWS,
      `明细最多 ${MAX_REIMBURSEMENT_LIST_ROWS} 行（验收清单上限）`,
    ),
  submit: z.boolean(),
});

export const updateOrderSchema = createOrderSchema.extend({
  orderId: z.string().min(1, "订单不存在"),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type PurchaseItemInput = z.infer<typeof purchaseItemSchema>;

export function toOrderFormInput(order: {
  team: string;
  techGroup: string;
  items: {
    name: string;
    spec: string;
    itemKind: PurchaseItemInput["itemKind"];
    purchaseLink: string;
    referenceImagePath: string | null;
    processingVendor: string;
    quantity: number;
    unitPrice: number;
  }[];
}): Omit<CreateOrderInput, "submit"> {
  return {
    team: order.team as CreateOrderInput["team"],
    techGroup: order.techGroup as CreateOrderInput["techGroup"],
    items: order.items.map((item) => ({
      name: item.name,
      spec: item.spec,
      itemKind: item.itemKind,
      purchaseLink: item.purchaseLink,
      referenceImagePath: item.referenceImagePath,
      processingVendor: item.processingVendor,
      quantity: item.quantity,
      lineTotal: item.quantity * item.unitPrice,
    })),
  };
}

export function parseOrderFormData(formData: FormData): {
  itemImages: Map<number, File>;
} {
  const itemImages = new Map<number, File>();
  for (const [key, value] of formData.entries()) {
    const match = key.match(/^itemImage-(\d+)$/);
    if (match && value instanceof File && value.size > 0) {
      itemImages.set(Number(match[1]), value);
    }
  }
  return { itemImages };
}

export function assertItemImagesPresent(
  items: PurchaseItemInput[],
  itemImages: Map<number, File>,
): void {
  items.forEach((item, index) => {
    if (!itemKindNeedsImage(item.itemKind)) return;
    const hasFile = itemImages.has(index);
    const hasExisting = !!item.referenceImagePath;
    if (!hasFile && !hasExisting) {
      throw new Error(`请为「${item.name || `第 ${index + 1} 条明细`}」上传图片`);
    }
  });
}
