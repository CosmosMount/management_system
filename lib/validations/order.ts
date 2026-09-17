import {
  itemKindNeedsImage,
  itemKindNeedsLink,
  PURCHASE_ITEM_KINDS,
} from "@/lib/purchase-item-kind";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS, MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";
import {
  resolveItemReferenceImagePaths,
  serializeItemReferenceImagePaths,
} from "@/lib/purchase-item-images";
import {
  ITEM_REFERENCE_IMAGE_TOTAL_SIZE_LABEL,
  MAX_ITEM_REFERENCE_IMAGE_COUNT,
  MAX_ITEM_REFERENCE_IMAGE_TOTAL_SIZE,
} from "@/lib/upload-accept";
import { z } from "zod";

export const purchaseItemSchema = z
  .object({
    name: z.string().min(1, "请输入物品名称"),
    spec: z.string().min(1, "请输入规格"),
    itemKind: z.enum(PURCHASE_ITEM_KINDS, { message: "请选择物品种类" }),
    purchaseLink: z.string().optional().default(""),
    referenceImagePaths: z
      .array(z.string().min(1, "图片路径无效"))
      .max(
        MAX_ITEM_REFERENCE_IMAGE_COUNT,
        `参考图片最多 ${MAX_ITEM_REFERENCE_IMAGE_COUNT} 张`,
      )
      .default([]),
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
    if (new Set(item.referenceImagePaths).size !== item.referenceImagePaths.length) {
      ctx.addIssue({
        code: "custom",
        message: "参考图片路径重复，请刷新后重试",
        path: ["referenceImagePaths"],
      });
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
      ? (item.referenceImagePaths[0] ?? null)
      : null,
    referenceImagePaths: serializeItemReferenceImagePaths(
      itemKindNeedsImage(item.itemKind) ? item.referenceImagePaths : [],
    ),
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
  expectedUpdatedAt: z.iso.datetime({ message: "订单版本无效，请刷新后重试" }),
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
    referenceImagePaths: string;
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
      referenceImagePaths: resolveItemReferenceImagePaths(
        item.referenceImagePaths,
        item.referenceImagePath,
      ),
      processingVendor: item.processingVendor,
      quantity: item.quantity,
      lineTotal: item.quantity * item.unitPrice,
    })),
  };
}

export function parseOrderFormData(formData: FormData): {
  itemImages: Map<number, File[]>;
} {
  const itemImages = new Map<number, File[]>();
  for (const [key, value] of formData.entries()) {
    const match = key.match(/^itemImage-(\d+)(?:-\d+)?$/);
    if (match && value instanceof File && value.size > 0) {
      const itemIndex = Number(match[1]);
      itemImages.set(itemIndex, [...(itemImages.get(itemIndex) ?? []), value]);
    }
  }
  return { itemImages };
}

export function assertItemImagesPresent(
  items: PurchaseItemInput[],
  itemImages: Map<number, File[]>,
): void {
  items.forEach((item, index) => {
    if (!itemKindNeedsImage(item.itemKind)) return;
    const files = itemImages.get(index) ?? [];
    const imageCount = item.referenceImagePaths.length + files.length;
    const hasFile = files.length > 0;
    const hasExisting = item.referenceImagePaths.length > 0;
    if (!hasFile && !hasExisting) {
      throw new Error(`请为「${item.name || `第 ${index + 1} 条明细`}」上传图片`);
    }
    if (imageCount > MAX_ITEM_REFERENCE_IMAGE_COUNT) {
      throw new Error(
        `「${item.name || `第 ${index + 1} 条明细`}」的参考图片最多 ${MAX_ITEM_REFERENCE_IMAGE_COUNT} 张`,
      );
    }
    const uploadSize = files.reduce((sum, file) => sum + file.size, 0);
    if (uploadSize > MAX_ITEM_REFERENCE_IMAGE_TOTAL_SIZE) {
      throw new Error(
        `「${item.name || `第 ${index + 1} 条明细`}」本次新增图片总大小不能超过 ${ITEM_REFERENCE_IMAGE_TOTAL_SIZE_LABEL}`,
      );
    }
  });
}
