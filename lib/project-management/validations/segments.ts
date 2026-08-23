import {
  taskPriorityValues,
  workSegmentStatusValues,
  workSegmentTypeValues,
} from "@/lib/project-management/types/contract-values";
import { z } from "zod";

export {
  taskPriorityValues,
  workSegmentStatusValues,
  workSegmentTypeValues,
};

const MAX_SEGMENT_DAYS = 31;

const idSchema = z
  .string({ message: "对象 ID 格式不正确" })
  .trim()
  .uuid("对象 ID 格式不正确");

const requiredText = (message: string, max = 2_000) =>
  z.string({ message }).trim().min(1, message).max(max, "内容过长");

const optionalText = (max = 4_000) =>
  z
    .string({ message: "内容格式不正确" })
    .trim()
    .max(max, "内容过长")
    .optional()
    .default("");

const optionalTextField = (max = 4_000) =>
  z.string({ message: "内容格式不正确" }).trim().max(max, "内容过长").optional();

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

const optionalSegmentTimeRangeSchema = z
  .object({
    startAt: requiredDate("请选择有效的开始时间").optional(),
    endAt: requiredDate("请选择有效的结束时间").optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.startAt || !input.endAt) return;
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

const segmentEditableFieldsSchema = z
  .object({
    content: requiredText("请输入工作内容", 2_000),
    priority: z
      .enum(taskPriorityValues, { message: "优先级不正确" })
      .optional()
      .default("MEDIUM"),
    expectedOutput: optionalText(2_000),
    actualOutput: optionalText(2_000),
    taskId: nullableIdSchema,
  });

const segmentOverrideFieldsSchema = z
  .object({
    content: requiredText("请输入工作内容", 2_000).optional(),
    priority: z.enum(taskPriorityValues, { message: "优先级不正确" }).optional(),
    expectedOutput: optionalTextField(2_000),
    actualOutput: optionalTextField(2_000),
    taskId: nullableIdSchema,
  });

export const createWorkSegmentInputSchema = segmentTimeRangeSchema
  .safeExtend(segmentEditableFieldsSchema.shape)
  .safeExtend({
    personId: idSchema,
    type: z.enum(workSegmentTypeValues, { message: "投入类型不正确" }),
  })
  .strict();

export const createActualSegmentInputSchema = segmentTimeRangeSchema
  .safeExtend(segmentEditableFieldsSchema.shape)
  .safeExtend({
    personId: idSchema,
    sources: z
      .array(
        z
          .object({
            plannedSegmentId: idSchema,
            coveredStartAt: requiredDate("请选择有效的来源开始时间"),
            coveredEndAt: requiredDate("请选择有效的来源结束时间"),
            expectedUpdatedAt: requiredDate("来源版本不正确").optional(),
          })
          .superRefine((input, ctx) => {
            if (input.coveredEndAt <= input.coveredStartAt) {
              ctx.addIssue({
                code: "custom",
                path: ["coveredEndAt"],
                message: "来源覆盖结束时间必须晚于开始时间",
              });
            }
          }),
        { message: "来源关系格式不正确" },
      )
      .max(100, "来源关系过多")
      .optional()
      .default([]),
  })
  .strict();

export const batchCreatePlannedSegmentsInputSchema = z.object({
  segments: z
    .array(
      segmentTimeRangeSchema
        .safeExtend(segmentEditableFieldsSchema.shape)
        .safeExtend({
          personId: idSchema,
          type: z.literal("PLANNED").optional(),
        })
        .strict(),
      { message: "投入记录列表格式不正确" },
    )
    .min(1, "至少需要一条 Planned Segment")
    .max(100, "单次最多创建 100 条 Planned Segment"),
});

export const updateWorkSegmentInputSchema = z
  .object({
    segmentId: idSchema,
    expectedUpdatedAt: requiredDate("记录版本不正确"),
    reason: optionalText(1_000),
    startAt: requiredDate("请选择有效的开始时间").optional(),
    endAt: requiredDate("请选择有效的结束时间").optional(),
    ...segmentOverrideFieldsSchema.shape,
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

export const movePlannedSegmentsInputSchema = z.object({
  moves: z
    .array(
      z
        .object({
          segmentId: idSchema,
          expectedUpdatedAt: requiredDate("记录版本不正确"),
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
          }
          if (input.endAt.getTime() - input.startAt.getTime() > maxSegmentMs()) {
            ctx.addIssue({
              code: "custom",
              path: ["endAt"],
              message: "单条投入记录最长 31 天",
            });
          }
        }),
      { message: "移动列表格式不正确" },
    )
    .min(1, "至少选择一条 Planned Segment")
    .max(100, "单次最多移动 100 条 Planned Segment"),
  reason: optionalText(1_000),
});

export const mergePlannedSegmentsInputSchema = z.object({
  segments: z
    .array(
      z.object({
        segmentId: idSchema,
        expectedUpdatedAt: requiredDate("记录版本不正确"),
      }),
      { message: "合并列表格式不正确" },
    )
    .min(2, "至少选择两条 Planned Segment")
    .max(100, "单次最多合并 100 条 Planned Segment"),
  reason: requiredText("请输入合并原因", 1_000),
});

export const cancelPlannedSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  reason: requiredText("请输入取消原因", 1_000),
});

export const batchCancelPlannedSegmentsInputSchema = z.object({
  segments: z
    .array(
      z.object({
        segmentId: idSchema,
        expectedUpdatedAt: requiredDate("记录版本不正确"),
      }),
      { message: "取消列表格式不正确" },
    )
    .min(1, "至少选择一条 Planned Segment")
    .max(100, "单次最多取消 100 条 Planned Segment"),
  reason: requiredText("请输入取消原因", 1_000),
});

export const confirmPlannedSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  reason: optionalText(1_000),
  actual: optionalSegmentTimeRangeSchema
    .safeExtend(
      segmentOverrideFieldsSchema.omit({
        expectedOutput: true,
        actualOutput: true,
      }).shape,
    )
    .safeExtend({
      actualOutput: requiredText("请输入实际输出", 2_000),
    })
    .strict(),
});

export const batchConfirmPlannedSegmentsInputSchema = z.object({
  segments: z
    .array(
      z.object({
        segmentId: idSchema,
        expectedUpdatedAt: requiredDate("记录版本不正确"),
        actualOutput: requiredText("请输入实际输出", 2_000),
      }),
      { message: "确认列表格式不正确" },
    )
    .min(1, "至少选择一条 Planned Segment")
    .max(100, "单次最多确认 100 条 Planned Segment"),
  reason: optionalText(1_000),
});

export const partiallyConfirmSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  coveredStartAt: requiredDate("请选择有效的确认开始时间"),
  coveredEndAt: requiredDate("请选择有效的确认结束时间"),
  reason: optionalText(1_000),
  actual: z
    .object({
      content: requiredText("请输入实际投入内容", 2_000),
      actualOutput: requiredText("请输入实际输出", 2_000),
    })
    .strict(),
}).superRefine((input, ctx) => {
  if (input.coveredEndAt <= input.coveredStartAt) {
    ctx.addIssue({
      code: "custom",
      path: ["coveredEndAt"],
      message: "确认结束时间必须晚于开始时间",
    });
  }
});

export const softDeleteActualSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  reason: requiredText("请输入删除原因", 1_000),
});

export const listWorkSegmentsInputSchema = z
  .object({
    personId: idSchema.optional(),
    taskId: idSchema.optional(),
    type: z.enum(workSegmentTypeValues, { message: "投入类型不正确" }).optional(),
    status: z
      .enum(workSegmentStatusValues, { message: "投入状态不正确" })
      .optional(),
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

export const listPersonalDueSegmentsInputSchema = z
  .object({
    cursor: z
      .string({ message: "分页游标格式不正确" })
      .trim()
      .min(1, "分页游标格式不正确")
      .max(1_000, "分页游标格式不正确")
      .optional(),
    limit: z.number().int().min(1).max(100).optional().default(50),
  })
  .strict();

export type CreateWorkSegmentInput = z.infer<typeof createWorkSegmentInputSchema>;
export type CreateActualSegmentInput = z.infer<
  typeof createActualSegmentInputSchema
>;
export type BatchCreatePlannedSegmentsInput = z.infer<
  typeof batchCreatePlannedSegmentsInputSchema
>;
export type UpdateWorkSegmentInput = z.infer<typeof updateWorkSegmentInputSchema>;
export type MovePlannedSegmentsInput = z.infer<
  typeof movePlannedSegmentsInputSchema
>;
export type MergePlannedSegmentsInput = z.infer<
  typeof mergePlannedSegmentsInputSchema
>;
export type ConfirmPlannedSegmentInput = z.infer<
  typeof confirmPlannedSegmentInputSchema
>;
export type BatchCancelPlannedSegmentsInput = z.infer<
  typeof batchCancelPlannedSegmentsInputSchema
>;
export type BatchConfirmPlannedSegmentsInput = z.infer<
  typeof batchConfirmPlannedSegmentsInputSchema
>;
export type PartiallyConfirmSegmentInput = z.infer<
  typeof partiallyConfirmSegmentInputSchema
>;
function maxSegmentMs() {
  return MAX_SEGMENT_DAYS * 24 * 60 * 60 * 1_000;
}
