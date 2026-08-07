import { z } from "zod";
import { idSchema } from "@/lib/project-management/validations/lifecycle";

const cursorSchema = z.string().trim().min(1).max(500).nullable().optional();

export const collaborationTargetSchema = z.discriminatedUnion("targetType", [
  z.object({ targetType: z.literal("PROJECT"), targetId: idSchema }).strict(),
  z.object({ targetType: z.literal("TASK"), targetId: idSchema }).strict(),
]);

export const createRiskInputSchema = z
  .object({
    targetType: z.enum(["PROJECT", "TASK"]),
    targetId: idSchema,
    content: z
      .string({ message: "请输入风险内容" })
      .trim()
      .min(1, "请输入风险内容")
      .max(2_000, "风险内容不能超过 2000 字"),
  })
  .strict();

export const resolveRiskInputSchema = z
  .object({
    riskId: idSchema,
    resolveNote: z
      .string({ message: "请输入解决说明" })
      .trim()
      .min(1, "请输入解决说明")
      .max(500, "解决说明不能超过 500 字")
      .refine((value) => !/[\r\n]/.test(value), "解决说明只能填写一行"),
  })
  .strict();

export const createCommentInputSchema = z
  .object({
    targetType: z.enum(["PROJECT", "TASK"]),
    targetId: idSchema,
    content: z
      .string({ message: "请输入评论内容" })
      .trim()
      .min(1, "请输入评论内容")
      .max(1_000, "评论内容不能超过 1000 字"),
  })
  .strict();

export const deleteCommentInputSchema = z
  .object({ commentId: idSchema })
  .strict();

export const riskPageInputSchema = z
  .object({
    targetType: z.enum(["PROJECT", "TASK"]),
    targetId: idSchema,
    status: z.enum(["ACTIVE", "RESOLVED"]),
    source: z.enum(["DIRECT", "TASKS"]).default("DIRECT"),
    cursor: cursorSchema.default(null),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const commentPageInputSchema = z
  .object({
    targetType: z.enum(["PROJECT", "TASK"]),
    targetId: idSchema,
    cursor: cursorSchema.default(null),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const recentActivityPageInputSchema = z
  .object({
    targetType: z.enum(["PROJECT", "TASK"]),
    targetId: idSchema,
    category: z
      .enum(["ALL", "PROJECT", "TASK", "PLAN_NODE", "RISK", "COMMENT", "REVIEW"])
      .default("ALL"),
    cursor: cursorSchema.default(null),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const activityVersionInputSchema = collaborationTargetSchema;
