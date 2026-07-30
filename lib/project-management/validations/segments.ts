import {
  resourceConflictKindValues,
  resourceConflictSeverityValues,
  resourceConflictStatusValues,
  taskPriorityValues,
  workSegmentRoleValues,
  workSegmentStatusValues,
  workSegmentTypeValues,
} from "@/lib/project-management/types/contract-values";
import { z } from "zod";

export {
  resourceConflictKindValues,
  resourceConflictSeverityValues,
  resourceConflictStatusValues,
  taskPriorityValues,
  workSegmentRoleValues,
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

const allocationSchema = z
  .number({ message: "投入比例格式不正确" })
  .gt(0, "投入比例必须大于 0")
  .max(100, "投入比例不能超过 100")
  .nullable()
  .optional();

const completionPercentSchema = z
  .number({ message: "完成比例格式不正确" })
  .min(0, "完成比例不能小于 0")
  .max(100, "完成比例不能超过 100")
  .nullable()
  .optional();

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
    allocation: allocationSchema,
    role: z
      .enum(workSegmentRoleValues, { message: "人员职责不正确" })
      .optional()
      .default("DEVELOPER"),
    customRole: optionalText(100),
    priority: z
      .enum(taskPriorityValues, { message: "优先级不正确" })
      .optional()
      .default("MEDIUM"),
    expectedOutput: optionalText(2_000),
    actualOutput: optionalText(2_000),
    completionPercent: completionPercentSchema,
    taskId: nullableIdSchema,
    nodeId: nullableIdSchema,
    tagIds: z
      .array(idSchema, { message: "Tag 列表格式不正确" })
      .max(50, "Tag 数量过多")
      .optional()
      .default([]),
  })
  .superRefine((input, ctx) => {
    validateEditableFields(input, ctx);
  });

const segmentOverrideFieldsSchema = z
  .object({
    content: requiredText("请输入工作内容", 2_000).optional(),
    allocation: allocationSchema,
    role: z.enum(workSegmentRoleValues, { message: "人员职责不正确" }).optional(),
    customRole: optionalTextField(100),
    priority: z.enum(taskPriorityValues, { message: "优先级不正确" }).optional(),
    expectedOutput: optionalTextField(2_000),
    actualOutput: optionalTextField(2_000),
    completionPercent: completionPercentSchema,
    taskId: nullableIdSchema,
    nodeId: nullableIdSchema,
    tagIds: z
      .array(idSchema, { message: "Tag 列表格式不正确" })
      .max(50, "Tag 数量过多")
      .optional(),
  })
  .superRefine((input, ctx) => {
    validateOverrideFields(input, ctx);
  });

export const createWorkSegmentInputSchema = segmentTimeRangeSchema
  .safeExtend(segmentEditableFieldsSchema.shape)
  .safeExtend({
    personId: idSchema,
    type: z.enum(workSegmentTypeValues, { message: "投入类型不正确" }),
  })
  .superRefine((input, ctx) => {
    validateEditableFields(input, ctx);
    if (input.type === "PLANNED" && input.completionPercent != null) {
      ctx.addIssue({
        code: "custom",
        path: ["completionPercent"],
        message: "Planned Segment 不能填写完成比例",
      });
    }
  });

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
  .superRefine((input, ctx) => {
    validateEditableFields(input, ctx);
  });

export const batchCreatePlannedSegmentsInputSchema = z.object({
  segments: z
    .array(
      segmentTimeRangeSchema
        .safeExtend(segmentEditableFieldsSchema.shape)
        .safeExtend({
          personId: idSchema,
          type: z.literal("PLANNED").optional(),
          completionPercent: z.never().optional(),
        })
        .superRefine((input, ctx) => {
          validateEditableFields(input, ctx);
        }),
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
  .superRefine((input, ctx) => {
    validateOverrideFields(input, ctx);
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

export const splitPlannedSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  reason: requiredText("请输入拆分原因", 1_000),
  parts: z
    .array(
      segmentTimeRangeSchema
        .safeExtend(segmentOverrideFieldsSchema.shape)
        .safeExtend({ tagIds: z.array(idSchema).max(50).optional() })
        .superRefine((input, ctx) => {
          validateOverrideFields(input, ctx);
        }),
      { message: "拆分列表格式不正确" },
    )
    .min(2, "至少拆分为两段")
    .max(100, "单次最多拆分为 100 段"),
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

export const confirmPlannedSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  reason: optionalText(1_000),
  actual: optionalSegmentTimeRangeSchema
    .safeExtend(segmentOverrideFieldsSchema.shape)
    .safeExtend({ tagIds: z.array(idSchema).max(50).optional() })
    .superRefine((input, ctx) => {
      validateOverrideFields(input, ctx);
    })
    .optional()
    .default({}),
});

export const partiallyConfirmSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  coveredStartAt: requiredDate("请选择有效的确认开始时间"),
  coveredEndAt: requiredDate("请选择有效的确认结束时间"),
  reason: optionalText(1_000),
  actual: optionalSegmentTimeRangeSchema
    .safeExtend(segmentOverrideFieldsSchema.shape)
    .safeExtend({ tagIds: z.array(idSchema).max(50).optional() })
    .superRefine((input, ctx) => {
      validateOverrideFields(input, ctx);
    })
    .optional()
    .default({}),
}).superRefine((input, ctx) => {
  if (input.coveredEndAt <= input.coveredStartAt) {
    ctx.addIssue({
      code: "custom",
      path: ["coveredEndAt"],
      message: "确认结束时间必须晚于开始时间",
    });
  }
});

export const relinkPlannedSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  taskId: nullableIdSchema,
  nodeId: nullableIdSchema,
  reason: requiredText("请输入重关联原因", 1_000),
});

export const softDeleteActualSegmentInputSchema = z.object({
  segmentId: idSchema,
  expectedUpdatedAt: requiredDate("记录版本不正确"),
  reason: requiredText("请输入删除原因", 1_000),
});

export const listWorkSegmentsInputSchema = z.object({
  personId: idSchema.optional(),
  taskId: idSchema.optional(),
  nodeId: idSchema.optional(),
  type: z.enum(workSegmentTypeValues, { message: "投入类型不正确" }).optional(),
  status: z
    .enum(workSegmentStatusValues, { message: "投入状态不正确" })
    .optional(),
  associationNeedsReview: z.boolean().optional(),
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
});

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

export const scanConflictsForPersonInputSchema = z
  .object({
    personId: idSchema,
    startAt: requiredDate("请选择有效的扫描开始时间"),
    endAt: requiredDate("请选择有效的扫描结束时间"),
  })
  .superRefine((input, ctx) => {
    if (input.endAt <= input.startAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "扫描结束时间必须晚于开始时间",
      });
    }
  });

export const scanResourceConflictsInputSchema = z
  .object({
    startAt: requiredDate("请选择有效的扫描开始时间"),
    endAt: requiredDate("请选择有效的扫描结束时间"),
    personIds: z.array(idSchema).max(500).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.endAt <= input.startAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "扫描结束时间必须晚于开始时间",
      });
    }
  });

export const listResourceConflictsInputSchema = z.object({
  personId: idSchema.optional(),
  status: z
    .enum(resourceConflictStatusValues, { message: "冲突状态不正确" })
    .optional(),
  kind: z
    .enum(resourceConflictKindValues, { message: "冲突类型不正确" })
    .optional(),
  severity: z
    .enum(resourceConflictSeverityValues, { message: "冲突严重度不正确" })
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
});

export const getResourceConflictInputSchema = z.object({ conflictId: idSchema });

export const acknowledgeConflictInputSchema = z.object({
  conflictId: idSchema,
  note: optionalText(1_000),
});

export const resolveConflictInputSchema = z.object({
  conflictId: idSchema,
  resolutionNote: requiredText("请输入解决说明", 1_000),
  changedSegmentIds: z
    .array(idSchema, { message: "调整记录列表格式不正确" })
    .max(100, "调整记录过多")
    .optional()
    .default([]),
});

export const ignoreConflictInputSchema = z.object({
  conflictId: idSchema,
  reason: requiredText("请输入忽略原因", 1_000),
  ignoredUntil: requiredDate("请选择有效的忽略截止时间"),
});

export const previewConflictSuggestionInputSchema = z.object({
  conflictId: idSchema,
});

export const applyConflictSuggestionInputSchema = z.object({
  conflictId: idSchema,
  confirmApply: z.literal(true, {
    message: "应用建议前必须明确确认",
  }),
  proposal: z.object({
    proposalId: requiredText("建议 ID 不正确", 120),
    moves: z.array(
      z.object({
        segmentId: idSchema,
        expectedUpdatedAt: requiredDate("记录版本不正确"),
        startAt: requiredDate("请选择有效的开始时间"),
        endAt: requiredDate("请选择有效的结束时间"),
      }),
    ),
  }),
});

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
export type SplitPlannedSegmentInput = z.infer<
  typeof splitPlannedSegmentInputSchema
>;
export type MergePlannedSegmentsInput = z.infer<
  typeof mergePlannedSegmentsInputSchema
>;
export type ConfirmPlannedSegmentInput = z.infer<
  typeof confirmPlannedSegmentInputSchema
>;
export type PartiallyConfirmSegmentInput = z.infer<
  typeof partiallyConfirmSegmentInputSchema
>;
export type RelinkPlannedSegmentInput = z.infer<
  typeof relinkPlannedSegmentInputSchema
>;
export type ScanConflictsForPersonInput = z.infer<
  typeof scanConflictsForPersonInputSchema
>;
export type ScanResourceConflictsInput = z.infer<
  typeof scanResourceConflictsInputSchema
>;
export type ApplyConflictSuggestionInput = z.infer<
  typeof applyConflictSuggestionInputSchema
>;

function maxSegmentMs() {
  return MAX_SEGMENT_DAYS * 24 * 60 * 60 * 1_000;
}

function validateEditableFields(
  input: {
    role?: string;
    customRole?: string;
    taskId?: string | null;
    nodeId?: string | null;
    tagIds?: string[];
  },
  ctx: z.RefinementCtx,
) {
  if (input.role === "CUSTOM" && !input.customRole?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["customRole"],
      message: "自定义职责不能为空",
    });
  }
  if (input.nodeId && !input.taskId) {
    ctx.addIssue({
      code: "custom",
      path: ["taskId"],
      message: "关联节点时必须同时关联 Task",
    });
  }
  if (input.tagIds) {
    ensureUniqueValues(input.tagIds, "tagIds", "不能重复选择同一个 Tag", ctx);
  }
}

function validateOverrideFields(
  input: {
    role?: string;
    customRole?: string;
    taskId?: string | null;
    nodeId?: string | null;
    tagIds?: string[];
  },
  ctx: z.RefinementCtx,
) {
  if (input.role === "CUSTOM" && !input.customRole?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["customRole"],
      message: "自定义职责不能为空",
    });
  }
  if (input.nodeId && input.taskId === null) {
    ctx.addIssue({
      code: "custom",
      path: ["taskId"],
      message: "关联节点时必须同时关联 Task",
    });
  }
  if (input.tagIds) {
    ensureUniqueValues(input.tagIds, "tagIds", "不能重复选择同一个 Tag", ctx);
  }
}

function ensureUniqueValues(
  values: string[],
  path: string,
  message: string,
  ctx: z.RefinementCtx,
) {
  if (new Set(values).size === values.length) return;
  ctx.addIssue({ code: "custom", path: [path], message });
}
