import { z } from "zod";

export const actionInboxPageInputSchema = z
  .object(
    {
      cursor: z
        .string({ message: "分页游标格式不正确" })
        .trim()
        .min(1, "分页游标格式不正确")
        .max(8_000, "分页游标格式不正确")
        .optional(),
      limit: z
        .number({ message: "分页大小不正确" })
        .int("分页大小不正确")
        .min(1, "分页大小不正确")
        .max(100, "分页大小不能超过 100")
        .optional()
        .default(50),
    },
    { error: "请求包含不支持的字段" },
  )
  .strict();

export type ActionInboxPageInput = z.infer<typeof actionInboxPageInputSchema>;
