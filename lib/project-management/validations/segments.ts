import { z } from "zod";

const MAX_SEGMENT_DAYS = 31;
const idSchema = z.string({ message: "对象 ID 格式不正确" }).trim().uuid("对象 ID 格式不正确");
const requiredText = (message: string) => z.string({ message }).trim().min(1, message).max(2_000, "内容过长");
const nullableIdSchema = z.union([idSchema, z.null()]).optional();

const strictDateStringPattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

function parseStrictDateString(value: string): Date | null {
  const match = strictDateStringPattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function isValidCalendarDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const requiredDate = (message: string) =>
  z.union(
    [
      z
        .date({ message })
        .refine((value) => !Number.isNaN(value.getTime()), message),
      z
        .string({ message })
        .trim()
        .min(1, message)
        .transform((value, ctx) => {
          const parsed = parseStrictDateString(value);
          if (!parsed) {
            ctx.addIssue({ code: "custom", message });
            return z.NEVER;
          }
          return parsed;
        }),
    ],
    { error: message },
  );

const segmentTimeRangeSchema = z
  .object({
    startAt: requiredDate("请选择有效的开始时间"),
    endAt: requiredDate("请选择有效的结束时间"),
  })
  .superRefine((input, ctx) => {
    if (input.endAt <= input.startAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "结束时间必须晚于开始时间",
      });
      return;
    }
    if (input.endAt.getTime() - input.startAt.getTime() > maxSegmentMs()) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "单条投入记录最长 31 天",
      });
    }
  });

export const createWorkSegmentInputSchema = segmentTimeRangeSchema.safeExtend({
  personId: idSchema,
  content: requiredText("请输入工作内容"),
  taskId: nullableIdSchema,
}).strict();

export const updateWorkSegmentInputSchema = z
  .object({
    segmentId: idSchema,
    expectedUpdatedAt: requiredDate("记录版本不正确"),
    startAt: requiredDate("请选择有效的开始时间").optional(),
    endAt: requiredDate("请选择有效的结束时间").optional(),
    content: requiredText("请输入工作内容").optional(),
    taskId: nullableIdSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.startAt && input.endAt && input.endAt <= input.startAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "结束时间必须晚于开始时间",
      });
    }
    if (
      input.startAt &&
      input.endAt &&
      input.endAt.getTime() - input.startAt.getTime() > maxSegmentMs()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "单条投入记录最长 31 天",
      });
    }
  });

export const softDeleteWorkSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
}).strict();

export const listWorkSegmentsInputSchema = z
  .object({
    personId: idSchema.optional(),
    taskId: idSchema.optional(),
    startAt: requiredDate("请选择有效的开始时间").optional(),
    endAt: requiredDate("请选择有效的结束时间").optional(),
    cursor: idSchema.optional(),
    limit: z
      .number({ message: "分页大小不正确" })
      .int("分页大小不正确")
      .min(1, "分页大小不正确")
      .max(100, "分页大小不能超过 100")
      .optional()
      .default(50),
  })
  .strict();

export const getWorkSegmentInputSchema = z.object({ segmentId: idSchema });
export const listWorkSegmentChangesInputSchema = z.object({
  segmentId: idSchema,
  cursor: idSchema.optional(),
  limit: z
    .number({ message: "分页大小不正确" })
    .int("分页大小不正确")
    .min(1, "分页大小不正确")
    .max(100, "分页大小不能超过 100")
    .optional()
    .default(50),
});

export type CreateWorkSegmentInput = z.infer<typeof createWorkSegmentInputSchema>;
export type UpdateWorkSegmentInput = z.infer<typeof updateWorkSegmentInputSchema>;
export type SoftDeleteWorkSegmentInput = z.infer<typeof softDeleteWorkSegmentInputSchema>;

function maxSegmentMs() {
  return MAX_SEGMENT_DAYS * 24 * 60 * 60 * 1_000;
}
