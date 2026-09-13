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
    techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }),
    idempotencyKey: z.string().uuid("登记请求标识无效"),
  })
  .strict();

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
export const materialQrTokenSchema = z.string().uuid();
