import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  absoluteDateTimeSchema,
  idSchema,
  revisionApprovalModeValues,
  s2MilestoneDraftSchema,
  s2TerminationDraftSchema,
  taskMemberInputSchema,
  taskPriorityValues,
  validatePlanChronology,
} from "@/lib/project-management/validations/lifecycle";
import { z } from "zod";

export const expectedTaskLockVersionSchema = z
  .number({ message: "锁版本不正确" })
  .int("锁版本不正确")
  .min(0, "锁版本不正确");

const requiredText = (message: string, max: number) =>
  z.string({ message }).trim().min(1, message).max(max, "内容过长");

const optionalText = (max: number) =>
  z
    .string({ message: "内容格式不正确" })
    .trim()
    .max(max, "内容过长")
    .optional()
    .default("");

const tagIdsSchema = z
  .array(idSchema, { message: "Tag 列表格式不正确" })
  .max(50, "Tag 数量不能超过 50 个")
  .superRefine((tagIds, ctx) => {
    if (new Set(tagIds).size !== tagIds.length) {
      ctx.addIssue({ code: "custom", message: "不能重复选择同一个 Tag" });
    }
  });

const taskMemberMutationInputSchema = taskMemberInputSchema.strict();

const taskMetadataFields = {
  title: requiredText("请输入 Task 名称", 200),
  description: optionalText(8_000),
  team: z.enum(TEAM_OPTIONS, { message: "请选择有效车组" }),
  techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }),
  priority: z.enum(taskPriorityValues, { message: "优先级不正确" }),
  revisionApprovalMode: z.enum(revisionApprovalModeValues, {
    message: "修订审批策略不正确",
  }),
  allowSelfReview: z.boolean({ message: "自审设置不正确" }),
  relatedTaskId: z.union([idSchema, z.null()]),
} as const;

export const updateTaskDraftMetadataInputSchema = z
  .object({
    taskId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    ...taskMetadataFields,
    tagIds: tagIdsSchema,
  })
  .strict();

export const updateTaskMetadataInputSchema = z
  .object({
    taskId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    ...taskMetadataFields,
  })
  .strict();

const replaceTaskMembersBaseInputSchema = z
  .object({
    taskId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    members: z
      .array(taskMemberMutationInputSchema, { message: "成员列表格式不正确" })
      .min(1, "至少添加一名 Task 成员"),
  })
  .strict()
  .superRefine((input, ctx) => {
    const personRoles = input.members.map(
      (member) => `${member.personId}:${member.role}`,
    );
    if (new Set(personRoles).size !== personRoles.length) {
      ctx.addIssue({
        code: "custom",
        path: ["members"],
        message: "同一成员不能重复添加相同角色",
      });
    }
    if (
      input.members.filter((member) => member.role === "OWNER").length !== 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["members"],
        message: "必须且只能有一名 OWNER",
      });
    }
  });

export const replaceTaskDraftMembersInputSchema =
  replaceTaskMembersBaseInputSchema;
export const replaceTaskMembersInputSchema = replaceTaskMembersBaseInputSchema;

const clientKeySchema = requiredText("缺少新节点 clientKey", 120);

function validateNodeIdentity(
  input: { nodeId?: string; clientKey?: string },
  ctx: z.RefinementCtx,
) {
  if (Boolean(input.nodeId) === Boolean(input.clientKey)) {
    ctx.addIssue({
      code: "custom",
      message: "已有节点必须提供 nodeId，新节点必须提供 clientKey",
    });
  }
}

export const draftMilestoneReplacementSchema = s2MilestoneDraftSchema
  .extend({
    nodeId: idSchema.optional(),
    clientKey: clientKeySchema.optional(),
  })
  .strict()
  .superRefine(validateNodeIdentity);

export const draftTerminationReplacementSchema = s2TerminationDraftSchema
  .extend({
    nodeId: idSchema.optional(),
    clientKey: clientKeySchema.optional(),
  })
  .strict()
  .superRefine(validateNodeIdentity);

export const replaceTaskDraftPlanInputSchema = z
  .object({
    taskId: idSchema,
    planVersionId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    plannedStartAt: absoluteDateTimeSchema("请选择带时区的有效计划开始时间"),
    milestones: z
      .array(draftMilestoneReplacementSchema, {
        message: "Milestone 列表格式不正确",
      })
      .min(1, "至少添加一个 Milestone")
      .max(200, "单个计划最多 200 个节点"),
    termination: draftTerminationReplacementSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    // Persistence must additionally reject omission of any node referenced by a Segment.
    validatePlanChronology(input, ctx);
    const nodeIds = [
      ...input.milestones.map((node) => node.nodeId),
      input.termination.nodeId,
    ].filter((value): value is string => Boolean(value));
    const clientKeys = [
      ...input.milestones.map((node) => node.clientKey),
      input.termination.clientKey,
    ].filter((value): value is string => Boolean(value));
    if (new Set(nodeIds).size !== nodeIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["milestones"],
        message: "计划中不能重复使用同一个 nodeId",
      });
    }
    if (new Set(clientKeys).size !== clientKeys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["milestones"],
        message: "计划中不能重复使用同一个 clientKey",
      });
    }
  });

export const replaceTaskTagsInputSchema = z
  .object({
    taskId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    tagIds: tagIdsSchema,
  })
  .strict();

export type UpdateTaskDraftMetadataInput = z.infer<
  typeof updateTaskDraftMetadataInputSchema
>;
export type UpdateTaskMetadataInput = z.infer<
  typeof updateTaskMetadataInputSchema
>;
export type ReplaceTaskDraftMembersInput = z.infer<
  typeof replaceTaskDraftMembersInputSchema
>;
export type ReplaceTaskMembersInput = z.infer<
  typeof replaceTaskMembersInputSchema
>;
export type ReplaceTaskDraftPlanInput = z.infer<
  typeof replaceTaskDraftPlanInputSchema
>;
export type ReplaceTaskTagsInput = z.infer<typeof replaceTaskTagsInputSchema>;
