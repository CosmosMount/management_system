import { z } from "zod";
import { TECH_GROUP_OPTIONS } from "@/lib/constants";

const priceSchema = z
  .string({ message: "请输入物资价格" })
  .trim()
  .regex(
    /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/,
    "价格应为 0 至 9999999999.99，最多保留两位小数",
  );

export const createMaterialSchema = z
  .object({
    name: z
      .string({ message: "请输入物资名称" })
      .trim()
      .min(1, "请输入物资名称")
      .max(200, "物资名称不能超过 200 个字符"),
    price: priceSchema,
    quantity: z
      .number({ message: "数量须为 1 至 100 的整数" })
      .int("数量须为整数")
      .min(1, "数量至少为 1")
      .max(100, "单次最多登记 100 件物资")
      .default(1),
    paired: z.boolean().default(false),
    companionName: z.string().trim().max(200, "配套物品名称不能超过 200 个字符").optional(),
    companionPrice: priceSchema.optional(),
    companionTechGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择配套物品的有效技术组" }).optional(),
    techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }),
    idempotencyKey: z.string().uuid("登记请求标识无效"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quantity > 1 && `${value.name}-${value.quantity}`.length > 200) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "物资名称加编号后不能超过 200 个字符",
      });
    }
    if (!value.paired) return;
    if (!value.companionName) {
      context.addIssue({ code: "custom", path: ["companionName"], message: "请输入配套物品名称" });
    } else {
      if (value.companionName === value.name) {
        context.addIssue({ code: "custom", path: ["companionName"], message: "两种配套物品名称不能相同" });
      }
      if (value.quantity > 1 && `${value.companionName}-${value.quantity}`.length > 200) {
        context.addIssue({ code: "custom", path: ["companionName"], message: "配套物品名称加编号后不能超过 200 个字符" });
      }
    }
    if (!value.companionPrice) {
      context.addIssue({ code: "custom", path: ["companionPrice"], message: "请输入配套物品价格" });
    }
    if (!value.companionTechGroup) {
      context.addIssue({ code: "custom", path: ["companionTechGroup"], message: "请选择配套物品所属技术组" });
    }
  });

export const materialScanSchema = z
  .object({
    qrToken: z.string().uuid("二维码无效"),
    operation: z.enum(["CHECKOUT", "RETURN"]),
    expectedActiveLoanId: z.string().uuid("领用记录无效").nullable(),
    idempotencyKey: z.string().uuid("扫码请求标识无效"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "CHECKOUT" && value.expectedActiveLoanId !== null) {
      context.addIssue({
        code: "custom",
        path: ["expectedActiveLoanId"],
        message: "物资状态已变化，请刷新后重试",
      });
    }
    if (value.operation === "RETURN" && value.expectedActiveLoanId === null) {
      context.addIssue({
        code: "custom",
        path: ["expectedActiveLoanId"],
        message: "领用记录无效",
      });
    }
  });

export const materialListSchema = z
  .object({
    query: z.string().trim().max(200).default(""),
    techGroup: z.enum(TECH_GROUP_OPTIONS).optional(),
    status: z.enum(["AVAILABLE", "IN_USE"]).optional(),
  })
  .strict();

export const materialIdSchema = z.string().uuid();
export const deleteMaterialSchema = z.object({
  materialId: z.string().uuid("物资标识无效"),
}).strict();
export const materialQrTokenSchema = z.string().uuid();
