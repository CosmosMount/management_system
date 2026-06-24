import { TEAM_OPTIONS, TECH_GROUP_OPTIONS, MAX_REIMBURSEMENT_LIST_ROWS } from "@/lib/constants";
import { z } from "zod";

export const workshopFeeItemSchema = z.object({
  name: z.string().min(1, "请输入费用名称"),
  spec: z.string().min(1, "请输入说明"),
  quantity: z.number().int().min(1, "数量至少为 1"),
  lineTotal: z.number().min(0, "金额不能为负"),
});

export const createWorkshopFeeSchema = z.object({
  team: z.enum(TEAM_OPTIONS, { message: "请选择车组" }),
  techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择技术组" }),
  items: z
    .array(workshopFeeItemSchema)
    .min(1, "至少添加一条加工费")
    .max(
      MAX_REIMBURSEMENT_LIST_ROWS,
      `明细最多 ${MAX_REIMBURSEMENT_LIST_ROWS} 行`,
    ),
});

export type CreateWorkshopFeeInput = z.infer<typeof createWorkshopFeeSchema>;
export type WorkshopFeeItemInput = z.infer<typeof workshopFeeItemSchema>;

export function parseWorkshopFeeFormData(formData: FormData): {
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

export function assertWorkshopFeeImages(
  items: WorkshopFeeItemInput[],
  itemImages: Map<number, File>,
): void {
  items.forEach((item, index) => {
    if (!itemImages.has(index)) {
      throw new Error(`请为「${item.name || `第 ${index + 1} 条`}」上传图片`);
    }
  });
}
