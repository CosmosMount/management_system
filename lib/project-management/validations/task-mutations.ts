import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import {
  absoluteDateTimeSchema,
  idSchema,
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

const taskMemberMutationInputSchema = taskMemberInputSchema.strict();

const taskMembersMutationSchema = z
  .array(taskMemberMutationInputSchema, { message: "成员列表格式不正确" })
  .min(1, "至少添加一名 Task 成员");

function validateTaskMembers(
  members: z.infer<typeof taskMembersMutationSchema>,
  ctx: z.RefinementCtx,
) {
  const personIds = members.map((member) => member.personId);
  if (new Set(personIds).size !== personIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["members"],
      message: "同一成员只能有一个角色",
    });
  }
  if (members.every((member) => member.role !== "OWNER")) {
    ctx.addIssue({
      code: "custom",
      path: ["members"],
      message: "至少需要一名负责人",
    });
  }
}

const taskMetadataFields = {
  title: requiredText("请输入 Task 名称", 200),
  description: optionalText(8_000),
  team: z.enum(TEAM_OPTIONS, { message: "请选择有效车组" }),
  techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }),
  priority: z.enum(taskPriorityValues, { message: "优先级不正确" }),
  relatedTaskId: z.union([idSchema, z.null()]),
  projectId: z.union([idSchema, z.null()]).optional(),
} as const;

export const updateTaskDraftMetadataInputSchema = z
  .object({
    taskId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    ...taskMetadataFields,
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
    members: taskMembersMutationSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    validateTaskMembers(input.members, ctx);
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

function validateDraftPlanReplacement(
  input: {
    plannedStartAt: Date;
    milestones: Array<{ nodeId?: string; clientKey?: string; expectedCompletedAt: Date }>;
    termination: { nodeId?: string; clientKey?: string; plannedAt: Date };
  },
  ctx: z.RefinementCtx,
) {
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
}

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
      .max(200, "单个计划最多 200 个节点"),
    termination: draftTerminationReplacementSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    validateDraftPlanReplacement(input, ctx);
  });

export const updateTaskDraftInputSchema = z
  .object({
    taskId: idSchema,
    planVersionId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    ...taskMetadataFields,
    members: taskMembersMutationSchema.optional(),
    plannedStartAt: absoluteDateTimeSchema(
      "请选择带时区的有效计划开始时间",
    ),
    milestones: z
      .array(draftMilestoneReplacementSchema, {
        message: "Milestone 列表格式不正确",
      })
      .max(200, "单个计划最多 200 个节点"),
    termination: draftTerminationReplacementSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.members) validateTaskMembers(input.members, ctx);
    validateDraftPlanReplacement(input, ctx);
  });

export const updateActiveTaskInputSchema = z
  .object({
    taskId: idSchema,
    expectedLockVersion: expectedTaskLockVersionSchema,
    metadata: z.object(taskMetadataFields).strict().optional(),
    members: taskMembersMutationSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.metadata && !input.members) {
      ctx.addIssue({ code: "custom", message: "没有需要保存的 Task 修改" });
    }
    if (input.members) validateTaskMembers(input.members, ctx);
  });

export type UpdateTaskDraftMetadataInput = z.infer<
  typeof updateTaskDraftMetadataInputSchema
>;
export type UpdateTaskDraftInput = z.infer<typeof updateTaskDraftInputSchema>;
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
export type UpdateActiveTaskInput = z.infer<typeof updateActiveTaskInputSchema>;
