import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  milestoneReviewDecisionValues,
  taskMemberRoleValues,
  taskPriorityValues,
  terminationOutcomeValues,
} from "@/lib/project-management/types/contract-values";
import { addStructuredProjectManagementIssue } from "@/lib/project-management/validations/issues";
import { z } from "zod";

export {
  milestoneReviewDecisionValues,
  taskMemberRoleValues,
  taskPriorityValues,
  terminationOutcomeValues,
};

export const idSchema = z
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
export const requiredDate = (message: string) =>
  z
    .union(
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

export const absoluteDateTimeSchema = (message: string) =>
  z
    .string({ message })
    .trim()
    .datetime({ offset: true, message })
    .transform((value) => new Date(value));

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

export const milestoneDraftSchema = z.object({
  goal: requiredText("请输入 Milestone 目标"),
  completionCriteria: requiredText("请输入完成条件"),
  expectedCompletedAt: requiredDate("请选择有效的预期完成时间"),
  reviewRequirements: requiredText("请输入验收要求"),
  businessDescription: optionalText(2_000),
});

export const terminationDraftSchema = z.object({
  plannedOutcomeCriteria: requiredText("请输入结束条件"),
  plannedAt: requiredDate("请选择有效的计划结束时间"),
  businessDescription: optionalText(2_000),
});

export const s2MilestoneDraftSchema = milestoneDraftSchema.extend({
  expectedCompletedAt: absoluteDateTimeSchema(
    "请选择带时区的有效预期完成时间",
  ),
});

export const s2TerminationDraftSchema = terminationDraftSchema.extend({
  plannedAt: absoluteDateTimeSchema("请选择带时区的有效计划结束时间"),
});

export const taskMemberInputSchema = z.object({
  personId: idSchema,
  role: z.enum(taskMemberRoleValues, { message: "成员角色不正确" }),
});

export const createTaskDraftInputSchema = z
  .object({
    title: requiredText("请输入 Task 名称", 200),
    description: optionalText(8_000),
    team: z.enum(TEAM_OPTIONS, { message: "请选择有效车组" }),
    techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }),
    priority: z
      .enum(taskPriorityValues, { message: "优先级不正确" })
      .optional()
      .default("MEDIUM"),
    tagIds: z
      .array(idSchema, { message: "Tag 列表格式不正确" })
      .max(50, "Tag 数量不能超过 50 个")
      .optional()
      .default([]),
    members: z
      .array(taskMemberInputSchema, { message: "成员列表格式不正确" })
      .min(1, "至少添加一名 Task 成员"),
    milestones: z
      .array(s2MilestoneDraftSchema, { message: "Milestone 列表格式不正确" })
      .min(1, "至少添加一个 Milestone")
      .max(200, "单个计划最多 200 个节点"),
    termination: s2TerminationDraftSchema,
    plannedStartAt: absoluteDateTimeSchema("请选择带时区的有效计划开始时间"),
    relatedTaskId: z.union([idSchema, z.null()]).optional().default(null),
    idempotencyKey: requiredText("缺少请求幂等键", 120),
  })
  .strict()
  .superRefine((input, ctx) => {
    ensureUniqueValues(
      input.tagIds,
      "tagIds",
      "不能重复选择同一个 Tag",
      ctx,
    );
    ensureUniqueValues(
      input.members.map((member) => member.personId),
      "members",
      "同一成员只能有一个角色",
      ctx,
    );
    if (input.members.every((member) => member.role !== "OWNER")) {
      ctx.addIssue({
        code: "custom",
        path: ["members"],
        message: "至少需要一名负责人",
      });
    }
    validatePlanChronology(input, ctx);
  });

export const activateTaskInputSchema = z.object({
  taskId: idSchema,
  expectedLockVersion: z
    .number({ message: "锁版本不正确" })
    .int("锁版本不正确")
    .min(0, "锁版本不正确"),
});

export const revisionDraftInputSchema = z.object({
  taskId: idSchema,
  basePlanVersionId: idSchema,
  baseTaskLockVersion: z
    .number({ message: "基线锁版本不正确" })
    .int("基线锁版本不正确")
    .min(0, "基线锁版本不正确"),
  revisedFromNodeId: idSchema,
  reason: requiredText("请输入修订原因", 2_000),
  replacementMilestones: z
    .array(s2MilestoneDraftSchema, { message: "替换 Milestone 列表格式不正确" })
    .max(200, "单个计划最多 200 个节点")
    .optional()
    .default([]),
  plannedStartAt: absoluteDateTimeSchema("请选择带时区的有效计划开始时间"),
  termination: s2TerminationDraftSchema,
  idempotencyKey: requiredText("缺少请求幂等键", 120),
}).superRefine((input, ctx) => {
  validatePlanChronology(
    {
      plannedStartAt: input.plannedStartAt,
      milestones: input.replacementMilestones,
      termination: input.termination,
    },
    ctx,
    "replacementMilestones",
  );
});

export const updateRevisionDraftInputSchema = z
  .object({
    reason: requiredText("请输入修订原因", 2_000),
    replacementMilestones: z
      .array(s2MilestoneDraftSchema, { message: "替换 Milestone 列表格式不正确" })
      .max(200, "单个计划最多 200 个节点")
      .optional()
      .default([]),
    plannedStartAt: absoluteDateTimeSchema("请选择带时区的有效计划开始时间"),
    termination: s2TerminationDraftSchema,
    revisionNodeId: idSchema,
    expectedTargetPlanUpdatedAt: absoluteDateTimeSchema(
      "Revision 候选计划版本令牌不正确",
    ),
  })
  .superRefine((input, ctx) => {
    validatePlanChronology(
      {
        plannedStartAt: input.plannedStartAt,
        milestones: input.replacementMilestones,
        termination: input.termination,
      },
      ctx,
      "replacementMilestones",
    );
  });

const reviewEvidenceBaseSchema = z.object({
  sortOrder: z
    .number({ message: "证据排序不正确" })
    .int("证据排序不正确")
    .min(0, "证据排序不正确")
    .max(10_000, "证据排序不正确")
    .optional()
    .default(0),
});

export const milestoneReviewEvidenceSchema = z
  .discriminatedUnion(
    "kind",
    [
      reviewEvidenceBaseSchema.extend({
        kind: z.literal("TEXT"),
        note: requiredText("请输入文本证据", 4_000),
      }),
      reviewEvidenceBaseSchema.extend({
        kind: z.literal("LINK"),
        externalUrl: z
          .string({ message: "请输入有效链接" })
          .trim()
          .url("请输入有效链接"),
        note: optionalText(1_000),
      }),
      reviewEvidenceBaseSchema.extend({
        kind: z.literal("FILE"),
        fileAssetId: z.unknown().optional(),
        note: optionalText(1_000),
      }),
    ],
    { error: "证据类型不正确" },
  )
  .superRefine((evidence, ctx) => {
    if (evidence.kind === "FILE") {
      ctx.addIssue({
        code: "custom",
        message: "文件证据暂未启用，请先提交文本或链接证据",
      });
    }
  });

export const submitMilestoneReviewInputSchema = z.object({
  milestoneNodeId: idSchema,
  idempotencyKey: requiredText("缺少请求幂等键", 120),
  evidences: z
    .array(milestoneReviewEvidenceSchema, { message: "证据列表格式不正确" })
    .max(20, "证据最多 20 条")
    .optional()
    .default([]),
});

export const reviewMilestoneDecisionInputSchema = z
  .object({
    reviewId: idSchema,
    result: z.enum(milestoneReviewDecisionValues, {
      message: "验收结果不正确",
    }),
    comment: optionalText(2_000),
  })
  .superRefine((input, ctx) => {
    if (
      input.result !== "APPROVED" &&
      input.comment.trim().length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "驳回或要求修订时必须填写说明",
      });
    }
  });

export const revisionDecisionInputSchema = z
  .object({
    revisionNodeId: idSchema,
    comment: optionalText(2_000),
  });

export const rejectRevisionInputSchema = revisionDecisionInputSchema.superRefine(
  (input, ctx) => {
    if (input.comment.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "驳回修订时必须填写说明",
      });
    }
  },
);

export const cancelRevisionInputSchema = revisionDecisionInputSchema;

export const submitRevisionInputSchema = revisionDecisionInputSchema;

export const confirmTerminationInputSchema = z
  .object({
    taskId: idSchema,
    terminationNodeId: idSchema,
    outcome: z.enum(terminationOutcomeValues, { message: "结束结果不正确" }),
    reason: optionalText(2_000),
    summary: optionalText(4_000),
    expectedLockVersion: z
      .number({ message: "锁版本不正确" })
      .int("锁版本不正确")
      .min(0, "锁版本不正确"),
  })
  .superRefine((input, ctx) => {
    if (
      input.outcome !== "SUCCESS" &&
      input.reason.trim().length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "提前结束或超时时必须填写原因",
      });
    }
  });

export type CreateTaskDraftInput = z.infer<
  typeof createTaskDraftInputSchema
>;
export type ActivateTaskInput = z.infer<typeof activateTaskInputSchema>;
export type RevisionDraftInput = z.infer<typeof revisionDraftInputSchema>;
export type UpdateRevisionDraftInput = z.infer<
  typeof updateRevisionDraftInputSchema
>;
export type SubmitMilestoneReviewInput = z.infer<
  typeof submitMilestoneReviewInputSchema
>;
export type ReviewMilestoneDecisionInput = z.infer<
  typeof reviewMilestoneDecisionInputSchema
>;
export type ConfirmTerminationInput = z.infer<
  typeof confirmTerminationInputSchema
>;
export type RevisionDecisionInput = z.infer<typeof revisionDecisionInputSchema>;

export const taskWorkspaceQueryInputSchema = z.object({
  taskId: idSchema,
});

export const taskLifecycleViewsInputSchema = z
  .object({
    taskId: idSchema,
    reviewCursor: idSchema.optional(),
    reviewLimit: z.number().int().min(1).max(100).optional().default(50),
    revisionCursor: idSchema.optional(),
    revisionLimit: z.number().int().min(1).max(100).optional().default(50),
    auditCursor: idSchema.optional(),
    auditLimit: z.number().int().min(1).max(100).optional().default(50),
    auditEventTypes: z
      .array(z.string().trim().min(1).max(120))
      .max(20)
      .optional()
      .default([]),
    auditActor: z.union([idSchema, z.literal("SYSTEM")]).optional(),
  })
  .strict();

export const planVersionQueryInputSchema = z.object({
  planVersionId: idSchema,
});

export const comparePlanVersionsInputSchema = z.object({
  fromPlanVersionId: idSchema,
  toPlanVersionId: idSchema,
});

function ensureUniqueValues(
  values: string[],
  path: string,
  message: string,
  ctx: z.RefinementCtx,
) {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path: [path], message });
  }
}

export function validatePlanChronology(
  input: {
    plannedStartAt: Date;
    milestones: Array<{ expectedCompletedAt: Date }>;
    termination: { plannedAt: Date };
  },
  ctx: z.RefinementCtx,
  milestonesPath = "milestones",
) {
  if (
    !(input.plannedStartAt instanceof Date) ||
    !(input.termination.plannedAt instanceof Date) ||
    input.milestones.some(
      (milestone) => !(milestone.expectedCompletedAt instanceof Date),
    )
  ) {
    return;
  }
  let previousAt: Date | null = null;
  input.milestones.forEach((milestone, index) => {
    if (milestone.expectedCompletedAt < input.plannedStartAt) {
      addStructuredProjectManagementIssue({
        ctx,
        code: "PLAN_CHRONOLOGY_INVALID",
        path: [milestonesPath, index, "expectedCompletedAt"],
        message: "Milestone 不得早于计划开始时间",
      });
    }
    if (previousAt && milestone.expectedCompletedAt < previousAt) {
      addStructuredProjectManagementIssue({
        ctx,
        code: "PLAN_CHRONOLOGY_INVALID",
        path: [milestonesPath, index, "expectedCompletedAt"],
        message: "Milestone 时间必须按顺序非递减",
      });
    }
    previousAt = milestone.expectedCompletedAt;
  });

  const finalBoundary = previousAt ?? input.plannedStartAt;
  if (input.termination.plannedAt < finalBoundary) {
    addStructuredProjectManagementIssue({
      ctx,
      code: "PLAN_CHRONOLOGY_INVALID",
      path: ["termination", "plannedAt"],
      message: "计划结束时间不得早于最后一个 Milestone",
    });
  }
}
